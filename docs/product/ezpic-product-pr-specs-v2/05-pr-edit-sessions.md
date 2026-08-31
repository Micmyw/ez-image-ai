# EzPic Product Contract Reference

> Read `00-global-contract.md` before this PR.

# PR 5：编辑会话、版本链、Prompt 历史与 Edit Again

**建议标题：** `feat(editor): add private edit sessions and version history`
**建议分支：** `codex/ezpic-pr5-edit-sessions`

## 5.1 业务目标

把单次模型调用升级为可持续使用的编辑工作流：用户可以对结果继续编辑、查看每一版 Prompt、回到旧版本并保持完整审计关系。

## 5.2 依赖

PR 4。

## 5.3 设计选择

新增轻量 `ImageEditSession` 聚合模型，不改变 GenerationJob、credits 或 Provider 状态机的职责。

建议 Prisma 模型：

```prisma
model ImageEditSession {
  id          String   @id @default(cuid())
  ownerType   OwnerType
  ownerId     String
  rootAssetId String
  title       String?
  createdAt   DateTime @default(now()) @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt @db.Timestamptz(3)
  jobs        GenerationJob[]

  @@index([ownerType, ownerId, updatedAt, id])
  @@index([rootAssetId])
  @@map("image_edit_session")
}
```

在 `GenerationJob` 增加：

```prisma
editSessionId String?
editSession   ImageEditSession? @relation(fields: [editSessionId], references: [id], onDelete: SetNull)
parentJobId   String?
parentJob     GenerationJob? @relation("ImageEditParent", fields: [parentJobId], references: [id], onDelete: SetNull)
childJobs     GenerationJob[] @relation("ImageEditParent")
```

实际迁移应遵循仓库 Prisma 生成和 migration 约定。`rootAssetId` 在应用层验证归属；若添加外键会导致多态 owner 复杂化，可保持普通 String 并使用事务检查，但必须有索引和删除合同。

## 5.4 主要文件

**修改：**

- `packages/database/prisma/schema.prisma`
- Prisma migration 与生成文件
- `packages/api/modules/media/types.ts`
- `packages/api/modules/media/router.ts`
- `packages/api/modules/media/procedures/create-generation.ts`
- Quote/Create 相关 procedure
- `apps/saas/app/(authenticated)/(main)/(account)/create/page.tsx`
- `apps/saas/modules/media/components/editor/EditorResultPanel.tsx`
- `apps/saas/modules/media/components/JobHistory.tsx`
- `apps/saas/modules/media/components/JobDetail.tsx`
- `apps/saas/modules/media/components/AssetCard.tsx`
- `packages/i18n/translations/en/saas.json`

**新增：**

- `packages/api/modules/media/procedures/list-edit-sessions.ts`
- `packages/api/modules/media/procedures/get-edit-session.ts`
- `packages/api/modules/media/procedures/rename-edit-session.ts`
- `packages/api/modules/media/lib/edit-session.ts`
- `apps/saas/app/(authenticated)/(main)/(account)/edits/page.tsx`
- `apps/saas/app/(authenticated)/(main)/(account)/edits/[sessionId]/page.tsx`
- `apps/saas/modules/media/components/editor/EditSessionList.tsx`
- `apps/saas/modules/media/components/editor/EditVersionTimeline.tsx`
- `apps/saas/modules/media/components/editor/PromptHistory.tsx`
- tests。

## 5.5 业务规则

### 新会话

首个已确认编辑在创建 Job 的同一事务中：

- 验证 root asset 属于用户且 READY；
- 创建 `ImageEditSession`；
- 将 Job 绑定到 session；
- `parentJobId = null`。

### Edit Again

- 只能从自己 session 中已成功且输出审核通过的 Job 开始；
- 新 Job 的 `sourceAssetId` 必须是所选父 Job 的输出；
- `editSessionId` 继承；
- `parentJobId` 指向所选版本；
- 仍重新创建 Quote、审核、Reservation 和异步任务；
- 不复用旧 Quote、旧审核决定或旧 Idempotency Key。

### 版本读取

- session 页面按创建时间展示版本；
- 每版显示缩略图、Prompt、模式、credits、状态和时间；
- 失败版本保留审计但不作为下一次输入；
- 任一成功版本都可成为新分支；
- 当前 MVP 可以线性展示，数据模型允许分支。

### 删除

- 删除输出资产继续使用现有软删除；
- 不删除 Job、Quote、credits ledger 或 session 审计记录；
- 被删除图片显示“asset deleted”，而不是破坏整个时间线；
- 删除 session 在 MVP 只允许隐藏/归档，不级联删除财务记录。

## 5.6 用户故事

- 作为重复编辑用户，我能一键继续修改上一版；
- 作为创作者，我能查看每一版 Prompt 和结果；
- 作为试错用户，我能从较早版本创建新分支；
- 作为隐私敏感用户，我只能访问自己的 session。

## 5.7 验收标准

- 至少连续编辑三轮无需重新上传；
- 每个版本能追溯 root asset、parent job、Prompt、模式和结果；
- 跨用户 session/job/asset 均返回 not found 或 forbidden；
- 父任务失败、未审核或无输出时不能 Edit Again；
- 重复请求不会创建重复 session 或 child job；
- 新版本完整走报价、审核、预扣、异步、结算；
- 历史和资产删除不改变 ledger；
- session 列表支持分页。

## 5.8 测试范围

- Prisma migration；
- session transaction/integration；
- parent/child 权限；
- branching；
- idempotency；
- deleted asset；
- history pagination；
- Playwright：创建、二次编辑、从旧版分支；
- 标准 CI、数据库 integration 和 invariant tests。

## 5.9 迁移与回滚

- 新字段均先 nullable；
- 旧 Job 不回填 session，历史页面继续可见；
- 若回滚代码，新增表和 nullable 字段可以保留，不影响旧流程；
- 不在本 PR 对旧任务执行推测性回填。

## 5.10 不包含

- 文件夹、协作、评论；
- 图层和画布；
- 批量；
- 公共分享链接。

---
