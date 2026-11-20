// =============================================================================
// cli.mjs — 手动命令入口（/adversarial-review 命令的实际执行面）
// -----------------------------------------------------------------------------
// 子命令：
//   review   [--focus <方向>] [--context <用户问题>] [--file <路径> | stdin]
//            对指定回答做对抗性审阅。手动 = 用户显式意图：跳过 L1 粗筛与冷却去重，
//            但照常记录任务与历史（版本绑定）。
//   status   查看当前任务状态（最近 10 条）
//   history  [--limit N] 查看最近审阅记录
//   config-check  显示生效配置、状态目录、审阅命令探活结果
//
// 退出码约定：review 审到实质发现=0 且带输出；无发现=0；审阅失败=0（输出如实说明）；
// 用法错误=2。status/history/config-check 恒 0。
// =============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  answerHash, hash8, loadConfig, stateDirFor, loadState, saveStateAtomic,
  createTask, finishTask, appendHistory, readHistory, normalizeFindings, formatFindings,
} from "./core.mjs";
import { buildReviewPrompt, runReviewer, parseReviewerOutput } from "./reviewer.mjs";

function usage() {
  return [
    "用法: node cli.mjs <子命令> [参数]",
    "",
    "  review   [--focus <方向>] [--context <用户问题>] [--file <路径> | stdin]",
    "           对一段回答做对抗性审阅（回答全文从 --file 或 stdin 读入）",
    "  status                查看任务状态",
    "  history [--limit N]   查看最近审阅记录（默认 20）",
    "  config-check          显示生效配置与审阅命令探活",
  ].join("\n");
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--focus") out.focus = argv[++i] ?? "";
    else if (a === "--context") out.context = argv[++i] ?? "";
    else if (a === "--file") out.file = argv[++i] ?? "";
    else if (a === "--limit") out.limit = parseInt(argv[++i] ?? "20", 10);
    else out._.push(a);
  }
  return out;
}

async function cmdReview(args) {
  let answer = "";
  if (args.file) {
    try {
      answer = fs.readFileSync(args.file, "utf8");
    } catch (e) {
      process.stderr.write(`无法读取 --file: ${e?.message || e}\n`);
      process.exit(2);
    }
  } else {
    answer = readStdinSync();
  }
  answer = (answer || "").trim();
  if (!answer) {
    process.stderr.write("review 需要被审文本：用 --file 或 stdin 传入回答全文\n" + usage() + "\n");
    process.exit(2);
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd, process.env);
  const dir = stateDirFor(cwd, process.env);
  const state = loadState(dir);
  const hash = answerHash(answer);
  const task = createTask(state, { sessionId: null, turn: null, answerHash: hash, trigger: "manual" });
  saveStateAtomic(dir, state);

  let review;
  try {
    const prompt = buildReviewPrompt({ answer, userQuestion: args.context || null, focus: args.focus || null, evidence: null });
    const run = await runReviewer({ prompt, config, env: process.env });
    review = parseReviewerOutput(run, normalizeFindings);
  } catch (e) {
    review = { ok: false, verdict: "parse_error", findings: [], error: String(e?.message || e), durationMs: null };
  }

  finishTask(state, task.id, {
    status: review.ok ? "done" : "failed",
    error: review.error || null,
    findingsCount: review.findings.length,
    durationMs: Number.isFinite(review.durationMs) ? review.durationMs : null,
  });
  saveStateAtomic(dir, state);
  appendHistory(dir, {
    id: task.id,
    at: new Date().toISOString(),
    trigger: "manual",
    answerHash: hash,
    verdict: review.verdict,
    findingsCount: review.findings.length,
    durationMs: Number.isFinite(review.durationMs) ? review.durationMs : null,
    error: review.error || null,
    cwd,
  });

  if (review.ok && review.verdict === "material_findings" && review.findings.length > 0) {
    process.stdout.write(formatFindings({ findings: review.findings, answerHash: hash, durationMs: review.durationMs }) + "\n");
    return process.exit(0);
  }
  if (review.ok && review.verdict === "no_material_findings") {
    const secs = Number.isFinite(review.durationMs) ? (review.durationMs / 1000).toFixed(1) : "?";
    process.stdout.write(`对抗性审阅完成：无实质问题（verdict=no_material_findings，用时 ${secs}s，版本 ${hash8(hash)}）。\n`);
    return process.exit(0);
  }
  process.stdout.write(`审阅未完成（verdict=${review.verdict}${review.error ? `，原因: ${review.error}` : ""}）。\n结果未产生有效审阅意见；请检查审阅命令后重试。\n`);
  return process.exit(0);
}

function cmdStatus() {
  const dir = stateDirFor(process.cwd(), process.env);
  const state = loadState(dir);
  const tasks = Object.values(state.tasks).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const recent = tasks.slice(0, 10);
  process.stdout.write(`状态目录: ${dir}\n任务总数: ${tasks.length}\n`);
  for (const t of recent) {
    const extra = t.error ? ` err=${String(t.error).slice(0, 80)}` : "";
    process.stdout.write(`  ${t.id}  ${t.status.padEnd(9)}  ${t.trigger.padEnd(6)}  ${hash8(t.answerHash)}  ${t.startedAt}${t.skippedReason ? ` (${t.skippedReason})` : ""}${extra}\n`);
  }
  process.exit(0);
}

function cmdHistory(args) {
  const dir = stateDirFor(process.cwd(), process.env);
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? args.limit : 20;
  const records = readHistory(dir, limit);
  process.stdout.write(`最近 ${records.length} 条审阅记录（${dir}${path.sep}history.jsonl）：\n`);
  for (const r of records) {
    const dur = Number.isFinite(r.durationMs) ? `${(r.durationMs / 1000).toFixed(1)}s` : "-";
    process.stdout.write(`  ${r.at}  ${r.trigger.padEnd(6)}  ${r.verdict}  findings=${r.findingsCount}  ${dur}  ${hash8(r.answerHash)}${r.error ? `  err=${String(r.error).slice(0, 60)}` : ""}\n`);
  }
  process.exit(0);
}

function cmdConfigCheck() {
  const cwd = process.cwd();
  const config = loadConfig(cwd, process.env);
  const dir = stateDirFor(cwd, process.env);
  process.stdout.write(`配置来源: ${config.configFile || "（无配置文件，全部默认值）"}\n`);
  for (const key of ["enabled", "mode", "reviewerCommand", "reviewModel", "reviewTimeoutMs", "cooldownMs", "failureCooldownMs", "skipPattern", "reviewPattern", "minAnswerLen", "includeGitEvidence"]) {
    process.stdout.write(`  ${key}: ${config[key] === undefined ? "(undefined)" : JSON.stringify(config[key])}\n`);
  }
  process.stdout.write(`状态目录: ${dir}\n`);
  // 审阅命令探活（10 秒超时；不打印输出内容，只打印探活结果）
  const cmd = process.env.ADV_REVIEWER_CMD || config.reviewerCommand;
  const probe = spawnSync(cmd, ["--version"], { shell: true, windowsHide: true, timeout: 10000, encoding: "utf8" });
  if (probe.error) {
    process.stdout.write(`审阅命令探活: 失败（${cmd} 无法执行: ${probe.error.message}）\n`);
  } else if (probe.status !== 0) {
    process.stdout.write(`审阅命令探活: 失败（${cmd} --version 退出码 ${probe.status}）\n`);
  } else {
    const v = String(probe.stdout || "").trim().split("\n")[0].slice(0, 80);
    process.stdout.write(`审阅命令探活: 成功（${cmd} → ${v || "无版本输出"}）\n`);
  }
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));
  switch (sub) {
    case "review":
      return await cmdReview(args);
    case "status":
      return cmdStatus();
    case "history":
      return cmdHistory(args);
    case "config-check":
      return cmdConfigCheck();
    default:
      process.stderr.write(usage() + "\n");
      return process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(`cli error: ${e?.message || e}\n`);
  process.exit(1);
});
