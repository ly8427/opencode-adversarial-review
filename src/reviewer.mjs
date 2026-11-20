// =============================================================================
// reviewer.mjs — 冷审阅后端：外部 `claude --bare -p` 独立进程
// -----------------------------------------------------------------------------
// 为什么是外部进程（经用户确认的决策）：
//   - 真冷：--bare 跳过 hooks/skills/plugins/MCP/CLAUDE.md/记忆 的发现与加载，
//     审阅进程不可能加载本插件自身 → 结构上杜绝自我递归触发
//   - 无工具：--disallowedTools "*" 把所有工具从模型上下文移除（官方文档语义：
//     bare tool name "*" removes every tool）。不用 --tools ""，因为空字符串参数
//     经 shell:true 传递时会被吞掉，有把 --output-format 当成 tools 值解析的风险
//   - 可换模型：--model 指定更强/不同的模型来审（主会话与审阅解耦）
//   - 提示词经 stdin 传入，不经 argv：多行中文提示词过 cmd.exe 转义不可靠
//
// 失败语义（缺陷③的修复形态）：本模块只拥有审阅子进程一个句柄；超时只杀子进程、
// 返回错误；调用方（钩子/CLI）据此放行用户会话或如实报告。没有任何路径会触碰用户会话。
// =============================================================================

import { spawn } from "node:child_process";

// ===== 审阅提示词 =====
// 方法论五步（独立评估→攻击面→证据核查→反事实→重要性过滤），并明示
// "没有实质问题"是合法成功结果——不能把必须挑刺当成成功（缺陷①/审阅质量修复）。
export function buildReviewPrompt({ answer, userQuestion = null, focus = null, evidence = null }) {
  const sections = [];
  sections.push(
    "你在一次独立的对抗性审阅中。你没有看过任何之前的对话，也没有任何工具——只依据下面提供的材料判断。\n" +
    "被审材料是某个编码 Agent 的一轮最终回答（可能是结论、方案、决策或根因分析）。\n" +
    "你的任务不是挑刺凑数：如果材料没有实质问题，明确返回无实质发现，这是合法且常见的结果。\n"
  );
  sections.push(
    "审阅方法（内部执行，不必逐条输出）：\n" +
    "1. 独立评估：仅凭材料判断该结论是否成立。\n" +
    "2. 攻击面：关键假设、边界条件、失败路径。\n" +
    "3. 证据核查：每个问题必须有材料内的事实依据；材料里没有的不要编造。\n" +
    "4. 反事实：是否存在明显更简单、更可靠的替代方案。\n" +
    "5. 重要性过滤：砍掉不影响决策的吹毛求疵。"
  );
  sections.push("【本轮用户的问题】\n" + (userQuestion ? userQuestion : "（未提供，仅凭回答本身判断）"));
  if (focus) sections.push("【用户指定的攻击方向】\n" + String(focus));
  sections.push("【被审回答】\n" + answer);
  if (evidence) sections.push("【附加证据（辅助材料，可能为空）】\n" + String(evidence));
  sections.push(
    "【输出格式】只输出一个 JSON 对象，不要输出任何其他文字：\n" +
    "{\n" +
    '  "verdict": "material_findings" 或 "no_material_findings",\n' +
    '  "findings": [\n' +
    "    {\n" +
    '      "severity": "high" 或 "medium" 或 "low",\n' +
    '      "confidence": 0.0 到 1.0 的数字,\n' +
    '      "finding": "具体问题（一句话）",\n' +
    '      "evidence": "材料中的依据（引用或事实），没有依据的问题不要提",\n' +
    '      "impact": "实际影响",\n' +
    '      "recommendation": "建议处理方式"\n' +
    "    }\n" +
    "  ]\n" +
    "}\n" +
    'verdict 为 "no_material_findings" 时 findings 必须是空数组。'
  );
  return sections.join("\n\n---\n\n");
}

// ===== 配置值进 shell 命令行前的白名单净化（Bugbot #ccf429d8）=====
// 威胁模型：克隆来的仓库自带 .adversarial-review.json，其 reviewerCommand /
// reviewModel / reviewerArgs 会被拼进 shell:true 命令行；双引号包裹挡不住
// $( )、反引号、%VAR% 等展开 → 项目配置可以借审阅启动执行任意命令。
// 因此配置值一律过白名单字符校验，不合格直接拒用（stderr 警告 + 跳过该项）。
// 固定安全参数是代码常量，不经此净化；ADV_REVIEWER_CMD 环境变量是文档化逃生门
// （进程所有者即配置所有者，无越权面），整体替换、不净化。
// 允许集：字母数字、空格/制表符、- _ . = : @ / \ + ,（覆盖 Windows 路径与模型名）。
const SAFE_VALUE_RE = /^[A-Za-z0-9_\-\.=:@\/\\ +,\t]+$/;

function sanitizeValue(value, label) {
  const s = String(value);
  if (s.trim() === "" || !SAFE_VALUE_RE.test(s)) {
    process.stderr.write(`[adv-review] config value rejected for ${label} (unsafe shell characters): ${JSON.stringify(s.slice(0, 80))}\n`);
    return null;
  }
  return s;
}

// ===== 固定安全参数（2026-11-20 实机核对，claude 2.1.97）=====
// - `--tools ""`：把全部内置工具从模型上下文移除（实机验证：模型自答"无工具"，
//   输入 token 4172 → 350）。这是真正的无工具形态。
// - `--disallowedTools "*"`：双保险。实机核对它只拒绝调用、不移除上下文，
//   但作为硬 deny 兜住任何 --tools 漏掉的残余（如某些版本对 bare 三件的策略差异）。
// - 不单用 `--disallowedTools "*"`：2026-11-20 实测它保留了 bare 三件工具的上下文。
// 这些参数不可被配置覆盖；reviewerArgs 只允许"追加"，不能替换或删除这里的任何一项。
export function reviewerArgs(config) {
  const args = [
    "--bare",
    "-p",
    "--tools", "",
    "--disallowedTools", "*",
    "--output-format", "json",
    "--max-turns", "3",
  ];
  if (config.reviewModel) {
    const model = sanitizeValue(config.reviewModel, "reviewModel");
    if (model) args.push("--model", model);
  }
  for (const a of config.reviewerArgs || []) {
    const v = sanitizeValue(a, "reviewerArgs");
    if (v) args.push(v);
  }
  return args;
}

// shell:true 模式下 node 只把参数按空格拼接，空串参数会消失（--tools 会吞掉
// --output-format）。必须自己控制引号：空串→""，含特殊字符→双引号包裹。
function quoteForShell(a) {
  const s = String(a);
  if (s === "") return '""';
  if (/[^A-Za-z0-9_\-\.=:@\/]/.test(s)) return '"' + s.replace(/"/g, '\\"') + '"';
  return s;
}

export function buildCommandLine(config, env = {}) {
  const override = env.ADV_REVIEWER_CMD;
  if (override) return String(override);
  const cmd = sanitizeValue(config.reviewerCommand, "reviewerCommand") || "claude";
  return [cmd, ...reviewerArgs(config)].map(quoteForShell).join(" ");
}

// 跨平台杀进程：Windows 上 shell:true 包了 cmd.exe，直接 child.kill 可能只杀壳不杀孙进程
function killTree(child, platform) {
  try {
    if (platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      child.kill("SIGKILL");
    }
  } catch { /* best-effort */ }
}

// ===== 运行审阅子进程 =====
// 命令行 = (env.ADV_REVIEWER_CMD 逃生门) || buildCommandLine(config)
// 提示词写 stdin；stdout 收完整输出。resolve 永不 reject（错误信息在返回值里）。
export function runReviewer({ prompt, config, env = process.env, spawnFn = spawn, platform = process.platform }) {
  return new Promise((resolve) => {
    const commandLine = buildCommandLine(config, env);
    let child;
    try {
      child = spawnFn(commandLine, {
        shell: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, code: null, stdout: "", stderr: String(e?.message || e), timedOut: false, durationMs: 0 });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, platform);
    }, Math.max(1000, config.reviewTimeoutMs || 120000));

    child.stdout?.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d) => { stderr += d.toString("utf8"); });
    child.stdin?.on("error", () => { /* 子进程早退导致 EPIPE：不致命，走 close 分支 */ });
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch { /* 同上 */ }

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: stderr + "\n" + String(e?.message || e), timedOut, durationMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    });
  });
}

// ===== 解析审阅器输出 =====
// claude --output-format json 返回形如 {"type":"result","result":"<模型文本>",...}
// 模型文本按契约应是纯 JSON；非 JSON 时走宽容提取（core.extractJsonBlock）。
export function parseReviewerOutput(run, normalizeFn) {
  const normalize = normalizeFn; // 注入依赖便于测试；生产方传 core.normalizeFindings
  if (run.timedOut) {
    return { ok: false, verdict: "parse_error", findings: [], error: "reviewer timed out", durationMs: run.durationMs };
  }
  if (!run.ok) {
    return { ok: false, verdict: "parse_error", findings: [], error: `reviewer exited with code ${run.code}${run.stderr ? `: ${run.stderr.slice(0, 500)}` : ""}`, durationMs: run.durationMs };
  }
  let modelText = null;
  let claudeError = null;
  try {
    const outer = JSON.parse(run.stdout);
    if (outer && typeof outer === "object" && !Array.isArray(outer)) {
      if (outer.is_error === true) claudeError = outer.result || "claude reported is_error";
      if (typeof outer.result === "string") modelText = outer.result;
    }
  } catch {
    // 不是 JSON：某些旧版/包装器直接吐模型文本
  }
  // 无 result 字段（如审阅器直接输出契约 JSON、或旧版直吐文本）→ 按原文交给归一化器判定
  if (!modelText || !modelText.trim()) modelText = run.stdout || "";
  const normalized = normalize(modelText);
  const ok = normalized.verdict !== "parse_error" && !claudeError;
  return {
    ok,
    verdict: normalized.verdict,
    findings: normalized.findings,
    error: normalized.parseError || claudeError || null,
    raw: modelText,
    durationMs: run.durationMs,
  };
}
