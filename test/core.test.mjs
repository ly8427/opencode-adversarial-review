// =============================================================================
// core.test.mjs — 共享核心单测（粗筛 / 哈希 / 结果规范化 / 状态机 / 冷却 / transcript）
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG, loadConfig, localFilter, compilePatterns, shouldSkipByPattern,
  answerHash, hash8, normalizeFindings, extractJsonBlock,
  stateDirFor, loadState, saveStateAtomic, createTask, finishTask, shouldReview,
  appendHistory, readHistory, formatFindings,
  lastUserQuestionFromTranscript, lastAssistantFromTranscript,
} from "../src/core.mjs";

const mktmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "adv-core-"));

// ---------- localFilter（与 OpenCode 插件同语义） ----------
test("localFilter: 短且无结论词 → 跳过", () => {
  const r = localFilter("你好，谢谢你的帮助。");
  assert.equal(r.pass, false);
  assert.match(r.reason, /too short/);
});

test("localFilter: 短且是确认语 → 跳过", () => {
  const r = localFilter("已完成，已提交。");
  assert.equal(r.pass, false);
  assert.match(r.reason, /short\+ack/);
});

test("localFilter: 短但含结论词 → 放行（recall-bias）", () => {
  assert.equal(localFilter("建议采用方案B。").pass, true);
  assert.equal(localFilter("The conclusion is wrong here.").pass, true);
});

test("localFilter: 长文本无论有无结论词 → 放行", () => {
  const long = "这是一段很长的技术分析。".repeat(20); // 无结论词、长度足够
  assert.equal(localFilter(long).pass, true);
});

test("localFilter: 代码块多且无结论词 → 跳过", () => {
  const text = "看这段代码：\n```js\nconst a = 1;\n```\n还有这段：\n```js\nconst b = 2;\n```\n以上是参考实现，供你对照阅读。".repeat(1);
  const r = localFilter(text, { minAnswerLen: 60 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /code-heavy/);
});

test("localFilter: 空文本 → 跳过", () => {
  assert.equal(localFilter("").pass, false);
  assert.equal(localFilter(null).pass, false);
});

// ---------- answerHash ----------
test("answerHash: 稳定且区分内容", () => {
  const a = answerHash("结论：采用方案A");
  assert.equal(a, answerHash("结论：采用方案A"));
  assert.notEqual(a, answerHash("结论：采用方案B"));
});
test("answerHash: 忽略首尾空白（trim 后等价）", () => {
  assert.equal(answerHash("  内容  \n"), answerHash("内容"));
});
test("hash8: 取前 8 位", () => {
  const h = answerHash("x");
  assert.equal(hash8(h), h.slice(0, 8));
  assert.equal(hash8(h).length, 8);
});

// ---------- extractJsonBlock / normalizeFindings ----------
const FINDINGS_JSON = JSON.stringify({
  verdict: "material_findings",
  findings: [
    { severity: "HIGH", confidence: 0.8, finding: "问题一", evidence: "依据一", impact: "影响一", recommendation: "建议一" },
    { severity: "bogus", confidence: 1.5, finding: "问题二", evidence: "", impact: "", recommendation: "" },
    { severity: "low", confidence: "0.5", finding: "", evidence: "空 finding 应被过滤" },
  ],
});

test("normalizeFindings: 合法输出 → material_findings，字段归一", () => {
  const r = normalizeFindings(FINDINGS_JSON);
  assert.equal(r.verdict, "material_findings");
  assert.equal(r.findings.length, 2); // 空 finding 被过滤
  assert.equal(r.findings[0].severity, "high"); // 大写归一
  assert.equal(r.findings[1].severity, "medium"); // 非法 severity 退默认
  assert.equal(r.findings[1].confidence, 1); // 越界裁剪到 [0,1]
  assert.equal(r.findings[0].confidence, 0.8);
});

test("normalizeFindings: findings 非空但无 verdict → 推断 material_findings", () => {
  const r = normalizeFindings('{"findings":[{"finding":"x"}]}');
  assert.equal(r.verdict, "material_findings");
});

test("normalizeFindings: 空 findings 无 verdict → no_material_findings", () => {
  const r = normalizeFindings('{"findings":[]}');
  assert.equal(r.verdict, "no_material_findings");
  assert.equal(r.findings.length, 0);
});

test("normalizeFindings: 声明无发现却带 findings → 信 findings", () => {
  const r = normalizeFindings('{"verdict":"no_material_findings","findings":[{"finding":"真实问题"}]}');
  assert.equal(r.verdict, "material_findings");
});

test("normalizeFindings: 声明有发现却为空 → 归为无发现", () => {
  const r = normalizeFindings('{"verdict":"material_findings","findings":[]}');
  assert.equal(r.verdict, "no_material_findings");
});

test("normalizeFindings: 文本包裹的 JSON 也能提取", () => {
  const r = normalizeFindings("审阅结论如下：\n" + FINDINGS_JSON + "\n以上。");
  assert.equal(r.verdict, "material_findings");
  assert.equal(r.findings.length, 2);
});

test("normalizeFindings: 非法 JSON → parse_error（按无发现处理，不致命）", () => {
  const r = normalizeFindings("我认为整体没有问题。这段话不是 JSON。");
  assert.equal(r.verdict, "parse_error");
  assert.ok(r.parseError);
});

test("normalizeFindings: findings 不是数组 → parse_error", () => {
  const r = normalizeFindings('{"findings":"x"}');
  assert.equal(r.verdict, "parse_error");
});

test("extractJsonBlock: 直接 JSON 与空白包裹都能解析", () => {
  assert.deepEqual(extractJsonBlock('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonBlock('  \n{"a":1}\n '), { a: 1 });
  assert.equal(extractJsonBlock("no json"), null);
});

// ---------- 配置加载 ----------
test("loadConfig: 无配置文件 → 默认 manual 模式", () => {
  const absent = path.join(mktmp(), "absent.json");
  const cfg = loadConfig("C:\\nonexistent-adv-review", { ADV_REVIEW_CONFIG: absent });
  assert.equal(cfg.mode, "manual");
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.reviewerCommand, "claude");
  assert.equal(cfg.configFile, absent); // 显式指定时按指定路径返回（读不到=默认值）
});

test("loadConfig: 项目配置生效 + 非法值回退 + 未知键忽略", () => {
  const dir = mktmp();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({
    mode: "auto",
    reviewTimeoutMs: -5,          // 非法 → 保留默认
    reviewModel: "opus",
    unknownKey: 1,                // 未知 → 忽略（stderr 留痕）
  }));
  const cfg = loadConfig(dir, { ADV_REVIEW_CONFIG: file });
  assert.equal(cfg.mode, "auto");
  assert.equal(cfg.reviewTimeoutMs, DEFAULT_CONFIG.reviewTimeoutMs);
  assert.equal(cfg.reviewModel, "opus");
});

test("loadConfig: hybrid 是 auto 的别名；非法 mode 退 manual", () => {
  const dir = mktmp();
  const f1 = path.join(dir, "c1.json");
  fs.writeFileSync(f1, JSON.stringify({ mode: "hybrid" }));
  assert.equal(loadConfig(dir, { ADV_REVIEW_CONFIG: f1 }).mode, "auto");
  const f2 = path.join(dir, "c2.json");
  fs.writeFileSync(f2, JSON.stringify({ mode: "bogus" }));
  assert.equal(loadConfig(dir, { ADV_REVIEW_CONFIG: f2 }).mode, "manual");
});

test("loadConfig: 配置文件损坏 → 默认值 + 不抛错", () => {
  const dir = mktmp();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{not json");
  const cfg = loadConfig(dir, { ADV_REVIEW_CONFIG: file });
  assert.equal(cfg.mode, "manual");
});

// ---------- 正则门 ----------
test("shouldSkipByPattern: skip 标记优先", () => {
  const p = compilePatterns({ skipPattern: "\\[(skip|noreview|debug)\\]", reviewPattern: undefined });
  assert.deepEqual(shouldSkipByPattern({ userText: "快速看下 [noreview]" }, p).skip, true);
});
test("shouldSkipByPattern: 白名单未命中 → 跳过；命中 → 放行", () => {
  const p = compilePatterns({ skipPattern: "\\[(skip|noreview|debug)\\]", reviewPattern: "review|重要" });
  assert.equal(shouldSkipByPattern({ userText: "随便聊聊" }, p).skip, true);
  assert.equal(shouldSkipByPattern({ userText: "这个 review 一下" }, p).skip, false);
});
test("shouldSkipByPattern: 无白名单 → 全放行", () => {
  const p = compilePatterns({ skipPattern: "\\[x\\]", reviewPattern: undefined });
  assert.equal(shouldSkipByPattern({ userText: "任意内容" }, p).skip, false);
});

// ---------- 状态机 / 冷却 ----------
function freshSetup() {
  const dir = mktmp();
  const state = loadState(dir);
  return { dir, state };
}

test("状态机: create→finish(done) 记录 reviewedByHash；冷却期内不重审", () => {
  const { dir, state } = freshSetup();
  const cfg = { cooldownMs: 30 * 60 * 1000, failureCooldownMs: 300000 };
  const hash = answerHash("结论 X");
  const t = createTask(state, { sessionId: "s1", answerHash: hash, trigger: "hook" });
  assert.equal(t.status, "reviewing");
  assert.match(t.id, /^adv-/);
  // 同哈希在审 → 跳
  assert.equal(shouldReview(state, { answerHash: hash, sessionId: "s1" }, cfg).review, false);
  finishTask(state, t.id, { status: "done", findingsCount: 2 });
  saveStateAtomic(dir, state);
  // 完成后冷却期内 → 跳
  const sr = shouldReview(state, { answerHash: hash }, cfg);
  assert.equal(sr.review, false);
  assert.match(sr.reason, /cooldown/);
  // 冷却期过后 → 审
  state.reviewedByHash[hash].at = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  assert.equal(shouldReview(state, { answerHash: hash }, cfg).review, true);
});

test("状态机: 失败走更短的重试冷却", () => {
  const { state } = freshSetup();
  const cfg = { cooldownMs: 30 * 60 * 1000, failureCooldownMs: 300000 };
  const hash = answerHash("结论 Y");
  const t = createTask(state, { answerHash: hash });
  finishTask(state, t.id, { status: "failed", error: "boom" });
  // 失败后 4 分钟 → 仍在失败冷却
  state.reviewedByHash[hash].at = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  assert.equal(shouldReview(state, { answerHash: hash }, cfg).review, false);
  // 失败后 6 分钟 → 放行（成功冷却 30 分钟不适用）
  state.reviewedByHash[hash].at = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  assert.equal(shouldReview(state, { answerHash: hash }, cfg).review, true);
});

test("状态机: 每会话只保留最新活跃任务，旧的被 superseded", () => {
  const { state } = freshSetup();
  const t1 = createTask(state, { sessionId: "s1", answerHash: answerHash("a") });
  const t2 = createTask(state, { sessionId: "s1", answerHash: answerHash("b") });
  assert.equal(state.tasks[t1.id].status, "skipped");
  assert.equal(state.tasks[t1.id].skippedReason, "superseded-by-latest");
  assert.equal(t2.status, "reviewing");
});

test("状态存储: 原子写落盘且无临时文件残留；损坏恢复隔离坏文件", () => {
  const dir = mktmp();
  const state = loadState(dir);
  createTask(state, { answerHash: answerHash("k") });
  assert.equal(saveStateAtomic(dir, state), true);
  const files = fs.readdirSync(dir);
  assert.ok(files.includes("state.json"));
  assert.ok(!files.some((f) => f.startsWith("state.json.tmp-")));
  // 重读一致
  const reread = loadState(dir);
  assert.equal(Object.keys(reread.tasks).length, 1);
  // 损坏 → 隔离 + 全新状态
  fs.writeFileSync(path.join(dir, "state.json"), "{corrupt");
  const recovered = loadState(dir);
  assert.equal(Object.keys(recovered.tasks).length, 0);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-")));
});

// ---------- history ----------
test("history: 追加读取往返，坏行跳过", () => {
  const dir = mktmp();
  appendHistory(dir, { id: "t1", at: "2026-01-01T00:00:00Z", verdict: "material_findings", findingsCount: 1 });
  fs.appendFileSync(path.join(dir, "history.jsonl"), "{bad line\n");
  appendHistory(dir, { id: "t2", at: "2026-01-02T00:00:00Z", verdict: "no_material_findings", findingsCount: 0 });
  const recs = readHistory(dir, 10);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].id, "t1");
  assert.equal(recs[1].id, "t2");
  assert.deepEqual(readHistory(dir, 1).map((r) => r.id), ["t2"]);
});

// ---------- 反馈格式化 ----------
test("formatFindings: 钩子模式带逐条回应指令与版本标记", () => {
  const out = formatFindings({
    findings: [{ severity: "high", confidence: 0.9, finding: "F1", evidence: "E1", impact: "I1", recommendation: "R1" }],
    answerHash: answerHash("内容"),
    durationMs: 42000,
    forHook: true,
  });
  assert.ok(out.includes("【对抗性审阅】"));
  assert.ok(out.includes("接受") && out.includes("反驳") && out.includes("待验证"));
  assert.ok(out.includes("[high | 置信 0.9] F1"));
  assert.ok(out.includes("依据: E1"));
  assert.ok(out.includes(answerHash("内容").slice(0, 8)));
  // CLI 模式不带指令头
  const cliOut = formatFindings({ findings: [{ severity: "high", confidence: null, finding: "F1", evidence: "", impact: "", recommendation: "" }] });
  assert.ok(!cliOut.includes("逐条回应"));
  assert.ok(cliOut.includes("F1"));
});

// ---------- transcript 解析 ----------
function writeTranscript(entries) {
  const dir = mktmp();
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

test("transcript: 取最后一条用户原话；注入的审阅反馈被跳过", () => {
  const file = writeTranscript([
    { type: "user", message: { role: "user", content: "第一个问题" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "第一个回答" }] } },
    { type: "user", message: { role: "user", content: "【对抗性审阅】这是注入的反馈不算用户提词" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "续写回答" }] } },
    { type: "user", message: { role: "user", content: "最终方案是什么" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "最终方案：双阶段迁移" }] } },
  ]);
  assert.equal(lastUserQuestionFromTranscript(file), "最终方案是什么");
  assert.equal(lastAssistantFromTranscript(file), "最终方案：双阶段迁移");
});

test("transcript: 坏行与缺文件容忍", () => {
  const dir = mktmp();
  const bad = path.join(dir, "bad.jsonl");
  fs.writeFileSync(bad, "{broken\n{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"好问题\"}}\n");
  assert.equal(lastUserQuestionFromTranscript(bad), "好问题");
  assert.equal(lastUserQuestionFromTranscript(path.join(dir, "absent.jsonl")), null);
  assert.equal(lastAssistantFromTranscript(path.join(dir, "absent.jsonl")), null);
});

// ---------- 状态目录 ----------
test("stateDirFor: 环境覆盖优先，默认按项目路径哈希分目录", () => {
  const envDir = mktmp();
  assert.equal(stateDirFor("C:\\proj", { ADV_STATE_DIR: envDir }), envDir);
  const d = stateDirFor("C:\\proj", {});
  assert.ok(d.includes(".adv-review"));
  assert.notEqual(d, stateDirFor("C:\\other", {}));
});
