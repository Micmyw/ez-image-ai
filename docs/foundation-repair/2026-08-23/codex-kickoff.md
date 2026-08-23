# Codex 启动指令：EzPic 基座修复计划

你正在本地仓库和 worktree 中工作：

```text
branch: codex/ezpic-pr1
worktree: D:\AIProject\Gefei\SaaSTool\ez-image-ai\.worktrees\ezpic-pr1
```

## 当前状态

仓库能力审计发现 FND-001 至 FND-007 阻断项。停止原 EzPic 产品 PR 1 是正确决定。现在不要实现首页，也不要开始原产品 PR 2–7。

## 必读

1. `agents.md` / `AGENTS.md`、README、架构文档和 Runbook；
2. `docs/product/2026-08-23-ezpic-ai-image-editor-spec.md`；
3. `docs/repository-capability-audit.md`；
4. `docs/foundation-repair/2026-08-23/README.md`；
5. 当前要执行的单个 PR spec。

## 执行顺序

```text
PR-F0 -> F1/F2/F3/F5 -> F4 -> F6 -> F7
```

一次只执行一个 PR。不要把多个 PR 静默合并，也不要把产品页面混入修复。

## 第一动作：PR-F0

先提交审计证据和本 spec 包。PR-F0 只能包含文档。

完成 PR-F0 后，输出：

- baseline commit SHA；
- 审计 revision；
- docs-only diff；
- FND-001 至 FND-007 的精确代码位置；
- 建议先执行 F1、F2、F3、F5 中哪一个及原因。

## 每个修复 PR 的强制流程

1. 从审计报告复制精确受影响文件、函数和行号；
2. 写一页 PR-local design note，说明现状、冻结不变量、数据迁移、锁顺序/状态机和回滚；
3. 先写能复现 blocker 的失败测试；
4. 运行测试，记录确实失败；
5. 实现最小、边界清晰的修复；
6. 运行该 PR 的 unit、contract、integration、concurrency 和 E2E 范围；
7. 只格式化 changed files；
8. 更新审计 finding 的修复引用，但在 F7 前不要宣称全基座通过；
9. 提交并输出 PR 描述草稿；
10. 停止，等待人类审查后再执行下一 PR。

## 代码约束

- PostgreSQL 继续作为内部业务真相源；
- 不重做积分账本、任务、Provider、存储、审核或 Stripe 整套架构；
- 不增加旁路余额；
- 不信任客户端 Provider、模型、价格或 URL；
- 所有外部操作幂等；
- 所有媒体默认私有；
- 不在日志/Sentry 中保存 Prompt、密钥、Cookie、原始 Provider 响应或签名 URL；
- 不为了通过 format 修改 781 个无关 CRLF 文件；
- 数据修复使用前向补偿和不可变流水，不直接篡改历史 Ledger；
- 不运行真实付费 Provider 调用，除非单独获得预算批准。

## PR 描述必须包含

- 业务目标；
- 对应 finding ID；
- 根因；
- 冻结的不变量；
- 修改文件；
- 数据库迁移和 backfill；
- 幂等与并发策略；
- 测试前失败证据；
- 测试后通过证据；
- 外部服务未验证边界；
- 风险和回滚；
- 不包含内容；
- 下一 PR 解锁状态。

## 不允许

- 先写首页“顺便等人类决定”；
- 一次修完全部 blocker；
- 用 UI 校验替代事务不变量；
- 把 unknown/异常 2xx 当 rejected；
- 把审核异常当 approved；
- 让旧 PUT URL 写最终资产；
- worker 失败后正常返回 FAILED；
- 用本地 DB 自我扫描冒充 Stripe reconciliation；
- 因 Docker 不可用而永久跳过 integration；
- 把 dry-run smoke 描述为真实 Provider 认证。

## 完成标准

只有 PR-F7 输出 Gate A = OPEN 后，才允许回到原 EzPic 产品 PR 1。Gate B 和 Gate C 必须按总纲独立开放。
