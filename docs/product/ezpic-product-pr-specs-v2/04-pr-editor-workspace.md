# EzPic Product Contract Reference

> Read `00-global-contract.md` before this PR.

# PR 4：登录后 Prompt 图片编辑工作区与一次完整编辑

**建议标题：** `feat(editor): deliver the authenticated prompt image editing workflow`
**建议分支：** `codex/ezpic-pr4-editor-workspace`

## 4.1 业务目标

让登录用户从恢复草稿或直接上传开始，完成“上传 → Prompt → 报价 → 确认 → 异步编辑 → Before/After → 下载”的完整主流程。

## 4.2 依赖

PR 1、PR 2、PR 3。

## 4.3 复用现有能力

- `create/page.tsx` 的草稿、reuseJob 和 asset 恢复；
- `CreatorWorkspace`、`GenerationForm`、`CurrentGeneration`；
- `use-generation`、`use-job`；
- MediaUploader、AssetLibrary 和签名预览；
- Quote/Create/Cancel/GetJob ORPC；
- 现有异步任务、credits、审核、Provider 和转存链路。

## 4.4 主要文件

**修改：**

- `apps/saas/app/(authenticated)/(main)/(account)/create/page.tsx`
- `apps/saas/modules/media/components/CreatorWorkspace.tsx`
- `apps/saas/modules/media/components/GenerationForm.tsx`
- `apps/saas/modules/media/components/GenerationFields.tsx`
- `apps/saas/modules/media/components/CurrentGeneration.tsx`
- `apps/saas/modules/media/components/MediaUploader.tsx`
- `apps/saas/modules/media/hooks/use-generation.ts`
- `apps/saas/modules/media/hooks/use-job.ts`
- `apps/saas/modules/media/lib/form-schema.ts`
- `packages/i18n/translations/en/saas.json`

**新增：**

- `apps/saas/modules/media/components/editor/ImageEditorWorkspace.tsx`
- `apps/saas/modules/media/components/editor/ImageSourcePanel.tsx`
- `apps/saas/modules/media/components/editor/PromptPanel.tsx`
- `apps/saas/modules/media/components/editor/EditModeSelector.tsx`
- `apps/saas/modules/media/components/editor/BeforeAfterSlider.tsx`
- `apps/saas/modules/media/components/editor/EditorResultPanel.tsx`
- `apps/saas/modules/media/components/editor/SuggestedPrompts.tsx`
- 相关组件测试

## 4.5 编辑器合同

- source image 必填且必须属于当前用户、状态 READY、未删除；
- Prompt 必填，前后端均限制长度；
- product 仅可为 `image-fast` 或 `image-quality`；
- Form 始终构造 `image-to-image`；
- UI 显示 Standard/Quality，不显示内部 ID；
- 点击 Review 先创建服务端 Quote；
- Quote 显示 credits、模式和过期提示；
- 点击 Confirm 才创建真实 Job 和 Reservation；
- 切换图片、Prompt 或模式后旧 Quote 失效；
- 创建后锁定本次输入快照，不受表单后续修改影响。

## 4.6 结果区

空状态展示可用示例而不是旋转图标；任务开始后展示：

- 阶段文案；
- 进度（Provider 提供时）；
- credits reserved/charged/released 的用户友好摘要；
- 取消按钮只在现有状态机允许时显示；
- 成功后 Before/After；
- Download；
- Edit Again；
- New Edit；
- View Details。

Before/After：

- 左侧必须是本次 Job 实际输入资产；
- 右侧必须是审核通过的输出资产；
- 两端都通过短期签名 URL 获取；
- 不把 URL写入分析或日志；
- 键盘可操作，并提供“显示原图/显示结果”替代控件。

## 4.7 草稿恢复

- claimed draft 自动填充图片、Prompt 和模式；
- 若草稿请求 Quality 但当前 plan 无权使用，保留 Prompt 和图片，模式安全降级为 Standard，并显示升级选项；
- 草稿过期或图片无效时显示明确恢复错误，不创建空任务。

## 4.8 用户故事

- 作为注册用户，我能在一个页面完成完整编辑；
- 作为 Free 用户，我能看到 Quality 但不能绕过 entitlement；
- 作为任务失败用户，我知道 credits 是否退回及下一步；
- 作为手机用户，我能上传、输入、确认、比较和下载。

## 4.9 验收标准

- 没有输入图片时不能报价；
- 客户端篡改 product/model/provider/credits 不会绕过服务端；
- 同一个确认动作使用稳定 Idempotency Key；
- 成功、失败、取消和审核拒绝都有可理解 UI；
- 任务刷新页面后可恢复；
- Before/After 使用准确的输入和输出；
- 下载使用私有签名 URL；
- 其他用户无法查看 Job 或 Asset；
- text-to-image/video 分支不出现在 EzPic editor；
- 移动端完整通过。

## 4.10 测试范围

- form schema/unit；
- Quote invalidation；
- entitlement；
- 草稿恢复；
- Job 状态展示；
- signed preview/download；
- 多用户越权；
- Playwright 成功、失败、取消、刷新恢复、credits 不足；
- a11y；
- 标准 CI 与相关 integration。

## 4.11 数据库迁移

无。版本链在 PR 5 增加；本 PR 使用现有 Job/Asset 关系完成一次编辑。

## 4.12 不包含

- 多轮会话；
- 项目/版本历史；
- 真实匿名生成；
- 蒙版、批量、API。

---
