// =============================================================================
// hook.test.mjs — 收尾钩子集成测试（真实 spawn node src/hook-stop.mjs）
// -----------------------------------------------------------------------------
// 覆盖：manual 默认零开销放行 / stop_hook_active 硬闸 / L1 粗筛 / 正则门 /
// 有发现 → block JSON / 哈希去重与内容变更重审 / 审阅失败与超时不阻断 /
// transcript 兜底读取。审阅器用假进程（ADV_REVIEWER_CMD 逃生门注入）。
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerHash, hash8, loadState } from "../src/core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "src", "hook-stop.mjs");
const FAKE = path.join(ROOT, "fixtures", "fake-reviewer.mjs");

const mktmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "adv-hook-"));

// 必须过 L1 粗筛的回答（长度 >=60 且含结论词）
const ANSWER = "最终方案：采用双阶段数据库迁移。第一阶段先加新列并双写，第二阶段切读流量后下线旧列。" +
  "整个过程中如出现写入失败，回滚脚本会恢复到旧表结构。建议在生产低峰窗口执行，预计零停机。";
const USER_Q = "帮我把用户表迁移到新结构，不能停机";

function writeConfig(dir, obj) {
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ enabled: true, mode: "auto", ...obj }));
  return file;
}

function writeTranscript(dir, entries) {
  const file = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

function baseEnv({ config, stateDir, reviewerCase, touchFile = null, extra = {} }) {
  return {
    ...process.env,
    ADV_REVIEW_CONFIG: config,
    ADV_STATE_DIR: stateDir,
    ADV_REVIEWER_CMD: `node "${FAKE}" --case ${reviewerCase}${touchFile ? ` --touch "${touchFile}"` : ""}`,
    ...extra,
  };
}

function runHook(input, env, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

function stdInput({ transcriptPath, answer = ANSWER, sessionId = "sess-1", stopHookActive = false, hookEvent = "Stop", cwd = null }) {
  const input = {
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd: cwd || path.dirname(transcriptPath),
    hook_event_name: hookEvent,
    stop_hook_active: stopHookActive,
    permission_mode: "default",
  };
  if (answer !== undefined) input.last_assistant_message = answer;
  return input;
}

function transcriptFixture(dir, userText = USER_Q, assistantText = ANSWER) {
  return writeTranscript(dir, [
    { type: "user", message: { role: "user", content: userText } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: assistantText }] } },
  ]);
}

test("manual 默认模式：钩子零开销放行，审阅器不被调用", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, { mode: "manual" });
  const stateDir = mktmp();
  const touch = path.join(dir, "touch.txt");
  const transcript = transcriptFixture(dir);
  const r = await runHook(stdInput({ transcriptPath: transcript }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings", touchFile: touch }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
  assert.ok(!fs.existsSync(touch), "manual 模式不应调用审阅器");
});

test("enabled=false：放行", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, { enabled: false });
  const stateDir = mktmp();
  const touch = path.join(dir, "touch.txt");
  const transcript = transcriptFixture(dir);
  const r = await runHook(stdInput({ transcriptPath: transcript }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings", touchFile: touch }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
  assert.ok(!fs.existsSync(touch));
});

test("stop_hook_active=true：硬闸放行，审阅器不被调用（反馈固定 1 轮）", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, {});
  const stateDir = mktmp();
  const touch = path.join(dir, "touch.txt");
  const transcript = transcriptFixture(dir);
  const r = await runHook(stdInput({ transcriptPath: transcript, stopHookActive: true }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings", touchFile: touch }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
  assert.ok(!fs.existsSync(touch));
});

test("L1 粗筛：短且无结论词的回答被跳过", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, {});
  const stateDir = mktmp();
  const touch = path.join(dir, "touch.txt");
  const transcript = transcriptFixture(dir, USER_Q, "你好，已收到。");
  const r = await runHook(stdInput({ transcriptPath: transcript, answer: "你好，已收到。" }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings", touchFile: touch }));
  assert.equal(r.stdout.trim(), "");
  assert.ok(!fs.existsSync(touch));
});

test("skip 标记：本轮用户提词含 [noreview] → 跳过", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, {});
  const stateDir = mktmp();
  const touch = path.join(dir, "touch.txt");
  const transcript = transcriptFixture(dir, "快速看下这个bug [noreview]", ANSWER);
  const r = await runHook(stdInput({ transcriptPath: transcript }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings", touchFile: touch }));
  assert.equal(r.stdout.trim(), "");
  assert.ok(!fs.existsSync(touch));
});

test("白名单：用户提词未命中 reviewPattern → 跳过；命中 → 审", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, { reviewPattern: "审一下|review" });
  const stateDir = mktmp();
  const touch = path.join(dir, "touch.txt");
  const transcriptMiss = transcriptFixture(dir, "随便聊聊", ANSWER);
  const rMiss = await runHook(stdInput({ transcriptPath: transcriptMiss }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings", touchFile: touch }));
  assert.equal(rMiss.stdout.trim(), "");
  assert.ok(!fs.existsSync(touch), "白名单未命中不应审");

  const transcriptHit = transcriptFixture(dir, "帮我 review 这个方案", ANSWER);
  const rHit = await runHook(stdInput({ transcriptPath: transcriptHit, sessionId: "sess-2" }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings", touchFile: touch }));
  assert.ok(fs.existsSync(touch), "白名单命中应审");
  const decision = JSON.parse(rHit.stdout);
  assert.equal(decision.decision, "block");
});

test("有发现 → 输出 block JSON，state 与 history 落盘", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, {});
  const stateDir = mktmp();
  const touch = path.join(dir, "touch.txt");
  const transcript = transcriptFixture(dir);
  const r = await runHook(stdInput({ transcriptPath: transcript }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings", touchFile: touch }));
  assert.equal(r.code, 0);
  const decision = JSON.parse(r.stdout.trim().split("\n").filter((l) => l.trim())[0]);
  assert.equal(decision.decision, "block");
  assert.ok(decision.reason.includes("【对抗性审阅】"));
  assert.ok(decision.reason.includes("逐条回应"));
  assert.ok(decision.reason.includes("回滚流程未处理")); // 假审阅器的 finding
  assert.ok(decision.reason.includes(hash8(answerHash(ANSWER)))); // 版本绑定标记
  // 状态：done 任务 + reviewedByHash
  const state = loadState(stateDir);
  const tasks = Object.values(state.tasks);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "done");
  assert.equal(tasks[0].findingsCount, 2);
  assert.equal(state.reviewedByHash[answerHash(ANSWER)].ok, true);
  // 历史
  const hist = fs.readFileSync(path.join(stateDir, "history.jsonl"), "utf8").trim().split("\n");
  assert.equal(hist.length, 1);
  const rec = JSON.parse(hist[0]);
  assert.equal(rec.trigger, "hook");
  assert.equal(rec.verdict, "material_findings");
  assert.equal(rec.findingsCount, 2);
});

test("去重：同内容冷却期内不重审；内容变更立即视为新版本重审", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, {});
  const stateDir = mktmp();
  const touch = path.join(dir, "touch.txt");
  const transcript = transcriptFixture(dir);
  const env = baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings", touchFile: touch });

  const r1 = await runHook(stdInput({ transcriptPath: transcript }), env);
  assert.equal(JSON.parse(r1.stdout).decision, "block");
  const r2 = await runHook(stdInput({ transcriptPath: transcript }), env);
  assert.equal(r2.stdout.trim(), "", "同内容冷却期内应放行不重审");
  assert.equal(fs.readFileSync(touch, "utf8").trim().split("\n").length, 1, "审阅器只被调用一次");

  const changed = ANSWER + " 追加：回滚脚本已补充部分索引失败补偿。";
  const transcript2 = transcriptFixture(dir, USER_Q, changed);
  const r3 = await runHook(stdInput({ transcriptPath: transcript2, answer: changed }), env);
  assert.equal(JSON.parse(r3.stdout).decision, "block", "内容变更后应重审");
  assert.equal(fs.readFileSync(touch, "utf8").trim().split("\n").length, 2);
});

test("审阅器输出畸形 JSON → 不阻断（无 stdout），state 记 failed", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, {});
  const stateDir = mktmp();
  const transcript = transcriptFixture(dir);
  const r = await runHook(stdInput({ transcriptPath: transcript }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "malformed" }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "", "解析失败不得输出 block");
  const state = loadState(stateDir);
  const tasks = Object.values(state.tasks);
  assert.equal(tasks[0].status, "failed");
});

test("审阅器崩溃退出 → 不阻断", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, {});
  const stateDir = mktmp();
  const transcript = transcriptFixture(dir);
  const r = await runHook(stdInput({ transcriptPath: transcript }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "crash" }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("审阅器挂起 → 硬超时杀进程，不阻断（冷却防每轮重烧）", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, { reviewTimeoutMs: 1500 });
  const stateDir = mktmp();
  const transcript = transcriptFixture(dir);
  const started = Date.now();
  const r = await runHook(stdInput({ transcriptPath: transcript }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "hang" }), 30000);
  const elapsed = Date.now() - started;
  assert.equal(r.stdout.trim(), "");
  assert.ok(elapsed < 20000, `超时应快速返回（实际 ${elapsed}ms）`);
  const state = loadState(stateDir);
  const tasks = Object.values(state.tasks);
  assert.equal(tasks[0].status, "failed");
  // 失败冷却：立即重跑同内容不再触发
  const r2 = await runHook(stdInput({ transcriptPath: transcript }), baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings" }));
  assert.equal(r2.stdout.trim(), "");
});

test("无 last_assistant_message 字段时，退化读 transcript 最后一条 assistant 文本", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, {});
  const stateDir = mktmp();
  const transcript = transcriptFixture(dir);
  const input = stdInput({ transcriptPath: transcript });
  delete input.last_assistant_message;
  const r = await runHook(input, baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings" }));
  const decision = JSON.parse(r.stdout.trim().split("\n").filter((l) => l.trim())[0]);
  assert.equal(decision.decision, "block");
  assert.ok(decision.reason.includes(hash8(answerHash(ANSWER))));
});

test("非 Stop 事件 / 空 stdin / 坏 JSON：一律放行", async () => {
  const dir = mktmp();
  const cfgFile = writeConfig(dir, {});
  const stateDir = mktmp();
  const transcript = transcriptFixture(dir);
  const env = baseEnv({ config: cfgFile, stateDir, reviewerCase: "findings" });
  const r1 = await runHook(stdInput({ transcriptPath: transcript, hookEvent: "SubagentStop" }), env);
  assert.equal(r1.stdout.trim(), "");
  const r2 = await runHook("not json at all", env);
  assert.equal(r2.stdout.trim(), "");
  const r3 = await runHook("", env);
  assert.equal(r3.stdout.trim(), "");
});
