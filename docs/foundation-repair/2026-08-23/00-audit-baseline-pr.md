# PR-F0：固化仓库能力审计基线

## PR 标题

`docs: commit EzPic foundation audit baseline`

## 业务目标

在任何修复代码开始前，固化本轮审计使用的 revision、发现、测试证据和未运行测试，避免后续修改使原始证据丢失。

## 范围

只提交文档，不修改应用代码、数据库、迁移、lockfile、环境示例或格式基线。

必须包含：

- `docs/product/2026-08-23-ezpic-ai-image-editor-spec.md`；
- `docs/repository-capability-audit.md`；
- 本基座修复 spec 目录；
- 审计 revision 信息；
- 原始阻断项 FND-001 至 FND-007；
- 已运行和未运行测试；
- Git 状态与工作树说明。

## 审计文档补充要求

在不改变原结论的前提下，确保每个 blocker 至少包含：

- finding ID；
- 受影响子系统；
- 精确文件路径和行号；
- 入口函数或任务；
- 破坏的不变量；
- 可复现静态路径或测试缺口；
- 当前测试为什么没有捕获；
- 建议归属的修复 PR。

## 验收标准

- `git diff --cached` 只包含文档；
- 记录 `git rev-parse HEAD`、branch 和 worktree 路径；
- 原规格文件 SHA-256 仍为 `4677B0FC33D7DD8773C206DEA1CEA4389354D0CCD8BD0A1BBBAF2B138C670B24`；
- 审计结论逐项映射到 FND-001 至 FND-007；
- 文档中明确 PostgreSQL integration、MinIO、load/invariant 和 Playwright 未运行的原因；
- 不将未运行测试写成通过；
- 不修改 781 个既有 CRLF 文件。

## 测试范围

- 校验 Markdown 链接和文件存在；
- 对 changed Markdown 运行定向 Oxfmt；
- 校验规格 SHA-256；
- `git diff --check`。

## 不包含

- 任何 blocker 修复；
- 产品首页；
- 数据库迁移；
- 真实外部服务验证。

## 回滚

纯文档 PR，可通过 revert 单独回滚；但不建议删除审计历史，应以新附录覆盖旧结论。
