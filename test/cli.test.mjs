// =============================================================================
// cli.test.mjs — 手动命令入口集成测试（review / status / history / config-check）
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { answerHash, loadState } from "../src/core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "src", "cli.mjs");
const FAKE = path.join(ROOT, "fixtures", "fake-reviewer.mjs");

const mktmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "adv-cli-"));

const ANSWER = "最终方案：采用双阶段数据库迁移。第一阶段先加新列并双写，第二阶段切读流量后下线旧列。" +
  "整个过程中如出现写入失败，回滚脚本会恢复到旧表结构。建议在生产低峰窗口执行，预计零停机。";

function envFor({ stateDir, reviewerCase }) {
  return {
    ...process.env,
    ADV_STATE_DIR: stateDir,
    ADV_REVIEW_CONFIG: path.join(mktmp(), "absent.json"), // 用默认配置（config-check 断言用）
    ADV_REVIEWER_CMD: `node "${FAKE}" --case ${reviewerCase}`,
  };
}

function runCli(args, { input = "", env } = {}, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: env || process.env,
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
    child.stdin.write(input);
    child.stdin.end();
  });
}

test("review（stdin 传入）: 有发现 → 格式化输出 + state/history 落盘", async () => {
  const dir = mktmp();
  const stateDir = mktmp();
  const r = await runCli(["review"], { input: ANSWER, env: envFor({ stateDir, reviewerCase: "findings" }) });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("对抗性审阅结果"));
  assert.ok(r.stdout.includes("[high | 置信 0.8]"));
  assert.ok(r.stdout.includes(answerHash(ANSWER).slice(0, 8))); // 版本绑定
  const state = loadState(stateDir);
  const tasks = Object.values(state.tasks);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, "done");
  assert.equal(tasks[0].trigger, "manual");
  const hist = JSON.parse(fs.readFileSync(path.join(stateDir, "history.jsonl"), "utf8").trim());
  assert.equal(hist.verdict, "material_findings");
});

test("review: 无实质问题 → 明确告知，不算失败", async () => {
  const stateDir = mktmp();
  const r = await runCli(["review", "--file", path.join(ROOT, "README.md")], { env: envFor({ stateDir, reviewerCase: "no_material" }) });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("无实质问题"));
  assert.ok(r.stdout.includes("no_material_findings"));
});

test("review: 审阅器输出畸形 → 如实报告审阅未完成，不冒充通过", async () => {
  const stateDir = mktmp();
  const r = await runCli(["review"], { input: ANSWER, env: envFor({ stateDir, reviewerCase: "malformed" }) });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("审阅未完成"));
  const state = loadState(stateDir);
  assert.equal(Object.values(state.tasks)[0].status, "failed");
});

test("review: 无被审文本 → 用法错误退出码 2", async () => {
  const r = await runCli(["review"], { input: "", env: envFor({ stateDir: mktmp(), reviewerCase: "findings" }) });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("用法") || r.stderr.includes("review 需要被审文本"));
});

test("review: 支持 --focus 与 --context 透传", async () => {
  const stateDir = mktmp();
  const r = await runCli(
    ["review", "--focus", "重点检查并发安全", "--context", "给支付服务做迁移"],
    { input: ANSWER, env: envFor({ stateDir, reviewerCase: "findings" }) },
  );
  assert.equal(r.code, 0); // 透传是否生效由提示词构建测试覆盖（reviewer.test.mjs）；此处验证参数被接受
  assert.ok(r.stdout.includes("对抗性审阅结果"));
});

test("status: 打印任务记录", async () => {
  const stateDir = mktmp();
  await runCli(["review"], { input: ANSWER, env: envFor({ stateDir, reviewerCase: "no_material" }) });
  const r = await runCli(["status"], { env: { ...process.env, ADV_STATE_DIR: stateDir } });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("任务总数: 1"));
  assert.ok(r.stdout.includes("done"));
});

test("history: 打印审阅记录", async () => {
  const stateDir = mktmp();
  await runCli(["review"], { input: ANSWER, env: envFor({ stateDir, reviewerCase: "findings" }) });
  const r = await runCli(["history", "--limit", "5"], { env: { ...process.env, ADV_STATE_DIR: stateDir } });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("material_findings"));
});

test("config-check: 打印生效配置与探活结果", async () => {
  const r = await runCli(["config-check"], { env: envFor({ stateDir: mktmp(), reviewerCase: "findings" }) });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("mode"));
  assert.ok(r.stdout.includes("审阅命令探活"));
});

test("未知子命令 / 无参数 → 用法输出，退出码 2", async () => {
  const r1 = await runCli(["bogus"], {});
  assert.equal(r1.code, 2);
  assert.ok(r1.stderr.includes("用法"));
  const r2 = await runCli([], {});
  assert.equal(r2.code, 2);
});
