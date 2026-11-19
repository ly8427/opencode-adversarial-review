// =============================================================================
// hook-stop.mjs — Claude Code 收尾钩子（Stop Hook）入口
// -----------------------------------------------------------------------------
// 触发时机：主 Agent 每轮说完话、准备结束回合的那一刻。钩子是同步的——钩子不退出，
// 回合就不算结束。因此审阅结果只能落回"产生这个回答的同一轮"，结构上不可能像
// OpenCode 异步旁听那样把旧结论的审阅意见错位插进后续轮次。
//
// 输出契约（stdout 是决策通道，日志只走 stderr）：
//   - 有实质发现 → {"decision":"block","reason":"<审阅意见>"}（主 Agent 带着意见继续本轮）
//   - 其他一切情况（无发现/失败/超时/被打断/配置关）→ 无输出，放行结束
//
// 防循环：stop_hook_active=true（说明本回合已是审阅反馈触发的续写轮）→ 一律放行。
// 反馈轮次因此固定为 1，不做成配置——这是硬保证，不是可调参数。
//
// 失败语义（缺陷③修复形态）：本钩子从不触碰用户会话，超时/失败只丢弃自己的审阅
// 结果。用户按 Esc 打断时审阅子进程随之作废，结果永不事后补注。
// =============================================================================

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import {
  localFilter, loadConfig, compilePatterns, shouldSkipByPattern,
  answerHash, hash8, stateDirFor, loadState, saveStateAtomic,
  createTask, finishTask, shouldReview, appendHistory,
  normalizeFindings, formatFindings,
  lastUserQuestionFromTranscript, lastAssistantFromTranscript,
} from "./core.mjs";
import { buildReviewPrompt, runReviewer, parseReviewerOutput } from "./reviewer.mjs";

const debug = (msg) => {
  const line = `[adv-review] ${typeof msg === "string" ? msg : JSON.stringify(msg)}`;
  process.stderr.write(line + "\n");
  if (process.env.ADV_DEBUG_FILE) {
    try { fs.appendFileSync(process.env.ADV_DEBUG_FILE, line + "\n"); } catch { /* ignore */ }
  }
};

// stdout 写完再退（process.exit 会截断未刷出的缓冲，Windows 上尤其明显）
function writeStdoutThenExit(data, code = 0) {
  process.stdout.write(data, () => process.exit(code));
}

async function readStdinJson(timeoutMs = 15000) {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  const read = (async () => {
    for await (const chunk of process.stdin) chunks.push(chunk);
  })();
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error("stdin timeout")), timeoutMs));
  try {
    await Promise.race([read, timer]);
  } catch { /* 超时用已收到的部分 */ }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

// 可选 git 证据摘要（默认关；任何失败都静默放弃）
function gitEvidence(cwd) {
  try {
    const opts = { cwd, windowsHide: true, timeout: 5000, encoding: "utf8" };
    const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], opts);
    if (inside.status !== 0 || String(inside.stdout).trim() !== "true") return null;
    const stat = spawnSync("git", ["diff", "HEAD", "--stat"], opts);
    const status = spawnSync("git", ["status", "--porcelain"], { ...opts, timeout: 3000 });
    let text = "";
    if (stat.status === 0 && String(stat.stdout).trim()) text += "git diff --stat:\n" + String(stat.stdout);
    if (status.status === 0 && String(status.stdout).trim()) text += (text ? "\n" : "") + "git status --porcelain:\n" + String(status.stdout);
    return text ? text.slice(0, 4000) : null;
  } catch {
    return null;
  }
}

async function main() {
  let input = null;
  try {
    input = await readStdinJson();
  } catch { /* ignore */ }

  // 任何解析/流程失败的兜底：放行
  if (!input || typeof input !== "object") return process.exit(0);
  // 只处理 Stop；SubagentStop 等（若被错误路由到这里）一律放行
  if (input.hook_event_name && input.hook_event_name !== "Stop") return process.exit(0);
  // 防循环硬闸：本回合已是审阅反馈触发的续写轮 → 放行（反馈固定 1 轮）
  if (input.stop_hook_active === true) return process.exit(0);

  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const config = loadConfig(cwd, process.env);
  if (!config.enabled) return process.exit(0);
  // 默认 manual：钩子零开销退出（不读回答、不跑粗筛、不起进程）
  if (config.mode !== "auto") return process.exit(0);

  // 被审回答：last_assistant_message 优先（官方推荐，transcript 可能滞后于内存会话）；
  // 老版本无此字段时退化读 transcript 最后一条 assistant 文本
  let answer = typeof input.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
  if (!answer && input.transcript_path) answer = lastAssistantFromTranscript(input.transcript_path) || "";
  if (!answer) return process.exit(0);

  // L1 粗筛（零成本；与 OpenCode 插件同语义）
  const fr = localFilter(answer, config);
  if (!fr.pass) {
    debug(`skip L1: ${fr.reason}`);
    return process.exit(0);
  }

  // 本轮用户原话（上下文包 + skip/白名单判定对象）
  const userQuestion = input.transcript_path ? lastUserQuestionFromTranscript(input.transcript_path) : null;
  const patterns = compilePatterns(config);
  const gate = shouldSkipByPattern({ userText: userQuestion || "" }, patterns);
  if (gate.skip) {
    debug(`skip pattern: ${gate.reason}`);
    return process.exit(0);
  }

  // 版本绑定去重：同内容冷却期内不重审（缺陷②/④修复）
  const hash = answerHash(answer);
  const dir = stateDirFor(cwd, process.env);
  const state = loadState(dir);
  const sr = shouldReview(state, { answerHash: hash, sessionId: input.session_id || null }, config);
  if (!sr.review) {
    debug(`skip dedupe (${hash8(hash)}): ${sr.reason}`);
    return process.exit(0);
  }

  const task = createTask(state, {
    sessionId: input.session_id || null,
    turn: null,
    answerHash: hash,
    trigger: "hook",
  });
  saveStateAtomic(dir, state);

  // ===== 冷审阅（同步，回合冻结在此）=====
  let review;
  try {
    const evidence = config.includeGitEvidence ? gitEvidence(cwd) : null;
    const prompt = buildReviewPrompt({ answer, userQuestion, focus: null, evidence });
    const run = await runReviewer({ prompt, config, env: process.env });
    review = parseReviewerOutput(run, normalizeFindings);
  } catch (e) {
    review = { ok: false, verdict: "parse_error", findings: [], error: String(e?.message || e), durationMs: null };
  }

  const status = review.ok ? "done" : "failed";
  finishTask(state, task.id, {
    status,
    error: review.error || null,
    findingsCount: review.findings.length,
    durationMs: Number.isFinite(review.durationMs) ? review.durationMs : null,
  });
  saveStateAtomic(dir, state);
  appendHistory(dir, {
    id: task.id,
    at: new Date().toISOString(),
    trigger: "hook",
    sessionId: input.session_id || null,
    answerHash: hash,
    verdict: review.verdict,
    findingsCount: review.findings.length,
    durationMs: Number.isFinite(review.durationMs) ? review.durationMs : null,
    error: review.error || null,
    cwd,
  });

  if (review.ok && review.verdict === "material_findings" && review.findings.length > 0) {
    debug(`review ${hash8(hash)}: ${review.findings.length} finding(s), ${Math.round((review.durationMs || 0) / 1000)}s`);
    const reason = formatFindings({ findings: review.findings, answerHash: hash, durationMs: review.durationMs, forHook: true });
    return writeStdoutThenExit(JSON.stringify({ decision: "block", reason }) + "\n");
  }
  debug(`review ${hash8(hash)}: no material findings or failed (${review.verdict}${review.error ? `: ${review.error}` : ""})`);
  return process.exit(0);
}

// 顶层兜底：钩子绝不以非零退出（非零+stderr 会被宿主当作错误展示；我们的一切失败都=放行）
main().catch((e) => {
  try { debug(`hook error: ${e?.message || e}`); } catch { /* ignore */ }
  process.exit(0);
});
