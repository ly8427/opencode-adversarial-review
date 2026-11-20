# DEBT — 欠账清单（随发现随追加，完成一条销一条）

| # | 欠账 | 来源 | 状态 |
|---|---|---|---|
| 1 | **OpenCode 插件三处小修**（下一个 PR）：①注入失败/超时不再 `session.abort` 用户原会话；②审阅结果绑定回答内容哈希（现在只比对 user 消息 ID，不构成版本证明）；③独立任务 ID + 审阅窗口内新结论的漏审治理（每会话保留最新待审项）。修复形态已在 `src/core.mjs` 原生实现，移植回单文件插件即可 | Claude Code 适配 PR 评审 | 待开工 |
| 2 | **真实 Claude Code 实机 E2E**：插件加载发现 / Stop 钩子全链路（触发→block→续写一轮→停止）/ Esc 打断残留检查 / `last_assistant_message` 字段行为核对 / 卸载干净。本机已实证的只有 CLI 后端直连（README-CLAUDE.md 验证清单 #2/#3），hook 全链路未实机跑过 | 本 PR | 待实机 |
| 3 | **marketplace.json 打包**：让 `/plugin marketplace add ly8427/opencode-adversarial-review` 一键安装 | 本 PR | 暂缓 |
| 4 | **异步 Hook 模式**：已评估并**否决**——审阅结果迟到会错位插进后续轮次（用户明确不要这种体验，2026-11-20）。若未来重启，必须以"只提示不注回"形态做 | 本 PR 设计讨论 | 已否决，仅存档 |
| 5 | **OpenCode CLI 作为审阅后端**（跨模型审阅）：`tools: {"*": false}` 语义已在 OpenCode 源码侧核实（见 README-DEPLOY.md），但作为外部 CLI 进程的会话创建路径未验证 fail-closed；且用户当前选定 `claude --bare` 为唯一后端 | 本 PR 设计讨论 | 暂缓 |
| 6 | **单测无法覆盖的 Claude Code 版本漂移**：`--tools ""` / `--disallowedTools "*"` / `stop_hook_active` 的行为以 2.1.97 实机核对为准（2026-11-20）；升级后建议重跑 README-CLAUDE.md 验证清单 | 本 PR | 长期 |
