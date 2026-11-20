// =============================================================================
// plugin.test.mjs — OpenCode 插件单文件侧移植 helper 单测(DEBT #1 三处修复的插件面)
// 修法本体在 src/core.mjs(core.test.mjs 已覆盖);本文件验证移植到
// adversarial-review.js 的插件侧内存版语义一致。
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerHashOf, hash8, createTask, finishTask, decideReview,
} from "../adversarial-review.js";

const CFG = { cooldownMs: 30 * 60 * 1000, failureCooldownMs: 5 * 60 * 1000 };
const MIN = 60 * 1000;

// ---------- answerHashOf(版本绑定键) ----------
test("answerHashOf: 同内容同哈希,首尾空白不影响", () => {
  const a = answerHashOf("结论:采用方案B。");
  const b = answerHashOf("  结论:采用方案B。\n");
  assert.equal(a, b);
  assert.equal(a.length, 64); // sha256 hex
});

test("answerHashOf: 内容一变立即视为新版本", () => {
  assert.notEqual(answerHashOf("方案A"), answerHashOf("方案B"));
});

test("answerHashOf: null/undefined 退化为空串哈希(不抛)", () => {
  const h = answerHashOf(null);
  assert.equal(h, answerHashOf(""));
  assert.equal(h.length, 64);
});

test("hash8: 取前 8 位;空值给空串", () => {
  assert.equal(hash8("abcdef1234567890"), "abcdef12");
  assert.equal(hash8(undefined), "");
  assert.equal(hash8(null), "");
});

// ---------- createTask(独立 ID + superseded 语义) ----------
test("createTask: 独立 ID、reviewing 起步、绑定会话与回答哈希", () => {
  const tasks = new Map();
  const t = createTask(tasks, { sessionId: "s1", answerHash: "h1" });
  assert.equal(tasks.size, 1);
  assert.equal(t.status, "reviewing");
  assert.equal(t.sessionId, "s1");
  assert.equal(t.answerHash, "h1");
  assert.match(t.id, /^adv-/);
  const t2 = createTask(tasks, { sessionId: "s1", answerHash: "h2" });
  assert.notEqual(t2.id, t.id);
});

test("createTask: 同会话旧 reviewing 任务被标记 superseded-by-latest", () => {
  const tasks = new Map();
  const t1 = createTask(tasks, { sessionId: "s1", answerHash: "h1" });
  createTask(tasks, { sessionId: "s1", answerHash: "h2" });
  assert.equal(t1.status, "skipped");
  assert.equal(t1.skippedReason, "superseded-by-latest");
  assert.ok(t1.finishedAt);
});

test("createTask: 不同会话的任务互不干扰", () => {
  const tasks = new Map();
  const a = createTask(tasks, { sessionId: "s1", answerHash: "h1" });
  const b = createTask(tasks, { sessionId: "s2", answerHash: "h1" });
  assert.equal(a.status, "reviewing");
  assert.equal(b.status, "reviewing");
});

// ---------- 内存上限:超 200 清最旧已完结,reviewing 永不清 ----------
test("createTask: 超 200 条修剪最旧已完结任务,在途任务存活", () => {
  const tasks = new Map();
  const firstId = createTask(tasks, { sessionId: "s0", answerHash: "h0" }).id; // 最旧,将被清
  finishTask(tasks, new Map(), firstId, { status: "done" });
  for (let i = 1; i < 205; i++) {
    const t = createTask(tasks, { sessionId: `s${i}`, answerHash: `h${i}` });
    finishTask(tasks, new Map(), t.id, { status: "done" });
  }
  assert.ok(tasks.size <= 200, `after 205 creates size=${tasks.size}`); // 修剪在创建超限时即时生效
  assert.equal(tasks.has(firstId), false, "最旧已完结任务被清");
  const inFlightTask = createTask(tasks, { sessionId: "s-live", answerHash: "h-live" });
  assert.ok(tasks.size <= 200, `size=${tasks.size}`);
  assert.equal(inFlightTask.status, "reviewing");
  assert.ok(tasks.has(inFlightTask.id), "在途任务存活");
});

// ---------- finishTask(状态机 + 版本绑定记录) ----------
test("finishTask: done → reviewedByHash 记 ok:true;skipped → 不落记录", () => {
  const tasks = new Map();
  const recs = new Map();
  const t = createTask(tasks, { sessionId: "s1", answerHash: "h-done" });
  finishTask(tasks, recs, t.id, { status: "done" });
  assert.equal(recs.get("h-done").ok, true);
  assert.ok(recs.get("h-done").at);

  const t2 = createTask(tasks, { sessionId: "s2", answerHash: "h-skip" });
  finishTask(tasks, recs, t2.id, { status: "skipped", error: "stale-user-moved-on" });
  assert.equal(recs.has("h-skip"), false, "skipped 不落版本记录(新答案仍是全新审阅对象)");
});

test("finishTask: failed → reviewedByHash 记 ok:false", () => {
  const tasks = new Map();
  const recs = new Map();
  const t = createTask(tasks, { sessionId: "s1", answerHash: "h-fail" });
  finishTask(tasks, recs, t.id, { status: "failed", error: "timeout" });
  assert.equal(recs.get("h-fail").ok, false);
});

test("finishTask: 未知 id 返回 null 不抛", () => {
  assert.equal(finishTask(new Map(), new Map(), "nope", { status: "done" }), null);
});

// ---------- decideReview(去重/冷却门) ----------
test("decideReview: 同哈希在审 → 跳(in-flight)", () => {
  const tasks = new Map();
  createTask(tasks, { sessionId: "s1", answerHash: "h" });
  const r = decideReview(tasks, new Map(), "h", CFG);
  assert.equal(r.review, false);
  assert.match(r.reason, /in-flight/);
});

test("decideReview: 同哈希 recently done → 冷却跳;过期 → 放行且就地删除记录", () => {
  const tasks = new Map();
  const recs = new Map();
  recs.set("h", { at: new Date(Date.now() - 10 * MIN).toISOString(), ok: true });
  const r1 = decideReview(tasks, recs, "h", CFG);
  assert.equal(r1.review, false);
  assert.match(r1.reason, /cooldown/);
  // 31 分钟后:冷却过期,记录被删,放行
  const r2 = decideReview(tasks, recs, "h", CFG, Date.now() + 31 * MIN);
  assert.equal(r2.review, true);
  assert.equal(recs.has("h"), false);
});

test("decideReview: 同哈希 recently failed → 短冷却跳(5 分钟)", () => {
  const tasks = new Map();
  const recs = new Map();
  recs.set("h", { at: new Date(Date.now() - 2 * MIN).toISOString(), ok: false });
  const r1 = decideReview(tasks, recs, "h", CFG);
  assert.equal(r1.review, false);
  assert.match(r1.reason, /failure cooldown/);
  // 6 分钟后:失败冷却过期,放行
  const r2 = decideReview(tasks, recs, "h", CFG, Date.now() + 6 * MIN);
  assert.equal(r2.review, true);
});

test("decideReview: 损坏记录(非法时间)就地删除并放行", () => {
  const recs = new Map([["h", { at: "not-a-date", ok: true }]]);
  const r = decideReview(new Map(), recs, "h", CFG);
  assert.equal(r.review, true);
  assert.equal(recs.has("h"), false);
});

test("decideReview: 内容不同(新哈希)立即放行——版本绑定语义", () => {
  const recs = new Map([["h-old", { at: new Date().toISOString(), ok: true }]]);
  const r = decideReview(new Map(), recs, "h-new", CFG);
  assert.equal(r.review, true);
});
