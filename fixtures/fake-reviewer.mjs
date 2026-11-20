// =============================================================================
// fake-reviewer.mjs — 测试用假审阅器
// -----------------------------------------------------------------------------
// 模拟 `claude -p --output-format json` 的输出形状（外层 JSON 包模型文本），
// 支持 --case 选择返回内容、--touch 副作用文件（供测试断言"审阅器真的被调用了"）。
// 读取并丢弃 stdin（模拟真实 claude 从 stdin 收提示词）。
// =============================================================================
import fs from "node:fs";

const args = process.argv.slice(2);
const getArg = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const testCase = getArg("--case", "findings");
const touchFile = getArg("--touch", null);

// 消费 stdin（审阅提示词）
try { fs.readFileSync(0, "utf8"); } catch { /* ignore */ }

// 副作用登记：被调用了
if (touchFile) {
  try { fs.appendFileSync(touchFile, `${Date.now()}\n`); } catch { /* ignore */ }
}

const FINDINGS_INNER = JSON.stringify({
  verdict: "material_findings",
  findings: [
    {
      severity: "high",
      confidence: 0.8,
      finding: "回滚流程未处理部分索引创建失败的情况",
      evidence: "材料声称'支持失败回滚'但未提及部分失败时的补偿",
      impact: "迁移中断后可能留下不一致状态",
      recommendation: "为部分失败增加补偿步骤并补失败注入测试",
    },
    {
      severity: "low",
      confidence: 0.6,
      finding: "低严重度次要问题",
      evidence: "",
      impact: "",
      recommendation: "",
    },
  ],
});

const CASES = {
  findings: { type: "result", subtype: "success", is_error: false, result: FINDINGS_INNER },
  no_material: { type: "result", subtype: "success", is_error: false, result: JSON.stringify({ verdict: "no_material_findings", findings: [] }) },
  malformed: { type: "result", subtype: "success", is_error: false, result: "我认为整体没有问题。这段话不是 JSON。" },
  plain_wrapped: { type: "result", subtype: "success", is_error: false, result: "审阅结论如下：\n" + FINDINGS_INNER + "\n以上。" },
  claude_error: { type: "result", subtype: "error_during_execution", is_error: true, result: "model call failed" },
  crash: null, // 非零退出
  hang: null,  // 挂起不退（超时测试用）
};

if (testCase === "hang") {
  setTimeout(() => process.exit(0), 60000);
} else if (testCase === "crash") {
  process.stderr.write("fake reviewer crash\n");
  process.exit(3);
} else {
  process.stdout.write(JSON.stringify(CASES[testCase]));
  process.exit(0);
}
