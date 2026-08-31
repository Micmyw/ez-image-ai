# EzPic Prompt Image Editor：完整产品 Pull Request 实施规格 v2

> **用途：** 直接交给 Codex，基于公开仓库 `https://github.com/Micmyw/ez-image-ai` 的当前模板能力，完成一个聚焦的 AI 图片编辑订阅 SaaS。
> **日期：** 2026-08-23
> **目标分支：** 从 `main` 创建独立 worktree/branch，按 PR 1 → PR 8 顺序实施。
> **工作品牌：** EzPic；正式域名、支持邮箱和公司主体必须由环境变量或产品配置提供，禁止散落硬编码。
> **产品参考：** 学习 Raphael 的首屏工具、示例 Prompt、Before/After、credits 和免费转订阅路径；不得复制其品牌、代码、图片、评价或原文案。

---

## 0. 执行口径

这是一份**产品实施计划**，不是基座审计或基座修复计划。

Codex 应接受当前模板已经提供的积分、异步任务、Provider 抽象、私有存储、审核、支付、任务恢复和后台能力，并在其现有接口上开发 EzPic。除非当前 PR 的产品功能确实要求扩展公开接口，否则不得重写这些底层系统。

### 0.1 当前仓库中已确认可复用的入口

- 营销首页：`apps/marketing/app/[locale]/(home)/page.tsx`
- 营销 Hero：`apps/marketing/modules/home/components/HeroSection.tsx`
- 营销草稿生成器：`apps/marketing/modules/generator/components/MarketingGenerator.tsx`
- 营销草稿客户端：`apps/marketing/modules/generator/lib/draft-client.ts`
- 登录后创建页：`apps/saas/app/(authenticated)/(main)/(account)/create/page.tsx`
- 登录后工作区：`apps/saas/modules/media/components/CreatorWorkspace.tsx`
- 通用生成表单：`apps/saas/modules/media/components/GenerationForm.tsx`
- 当前任务结果：`apps/saas/modules/media/components/CurrentGeneration.tsx`
- 任务历史与资产库：`apps/saas/modules/media/components/JobHistory.tsx`、`AssetLibrary.tsx`
- 媒体 API：`packages/api/modules/media/`
- 模型目录和路由：`packages/ai/media/catalog/`
- Provider Registry：`packages/ai/media/registry.ts`
- 产品配置：`packages/config/product.ts`
- 套餐权益：`packages/config/plans.ts`
- Prisma 模型：`packages/database/prisma/schema.prisma`
- 国际化文案：`packages/i18n/translations/{en,de,es,fr}/`

### 0.2 冻结的产品决策

1. **首页主词：** `ai image editor no restrictions`
2. **首页次主词：** `ai image editor with prompt no restrictions`
3. **长期产品母词：** `ai image editor with prompt`
4. **产品本体：** 上传一张图片，用自然语言 Prompt 修改该图片。
5. **MVP 不提供：** 视频、文本生图、公共画廊、图层、画布、蒙版、批量、API、团队共享 credits。
6. **媒体始终私有。**
7. **所有真实 AI 编辑都走现有异步任务、审核、幂等、credits 和 Provider 路由。**
8. **内部稳定产品 ID 保持 `image-fast` 和 `image-quality`。** 不为营销命名大范围迁移 ID；公开名称改为 `Standard Edit` 与 `Quality Edit`。
9. `video-fast` 与 `video-quality` 可以保留在底层目录中，但不出现在 EzPic 的公开 catalog、套餐权益、导航和界面中。
10. **MVP 继续使用现有“匿名草稿 → 登录/注册 → 自动恢复”路径。** 不宣称无需登录即可真实生成。
11. `No Restrictions` 表示更灵活的 Prompt、较少模板锁定、私有上传和透明 credits，不表示 uncensored、无限免费或无安全规则。
12. 首发以英语为唯一可索引语言；现有德语、西语、法语基础设施保留，但语言入口隐藏，未完成产品级翻译的 URL 不进入 sitemap，并设置 `noindex, follow`。

### 0.3 全局工程约束

- PostgreSQL 继续是业务状态唯一真相源。
- 客户端不得提交 Provider ID、模型 ID、模型成本或任意远程 URL。
- 不创建第二套余额、任务或上传系统。
- 每次真实编辑先报价，再由用户确认，随后按既有事务创建 Job、Reservation、Asset 绑定与 Outbox。
- 所有任务异步执行；普通请求不得等待模型完成。
- 所有新功能有明确的未授权、越权、失败、取消、审核拒绝和 credits 不足行为。
- 所有分析事件不得包含 Prompt 原文、图片 URL、签名 URL、Cookie、密钥或 Provider 原始响应。
- 不把固定 KD、DR、外链数、关键词密度、停留时长作为代码验收标准。
- 每个 PR 都必须有业务目标、范围、验收、测试、迁移/回滚和“不包含内容”。
- 每次只实施一个 PR；完成后停止，提交测试证据，等待下一步指令。

### 0.4 目标用户旅程

```text
Google / Direct visit
  → 首页直接看到图片编辑器
  → 上传图片
  → 输入或选择 Prompt
  → 选择 Standard / Quality
  → 创建不产生模型费用的匿名草稿
  → 登录/注册
  → 草稿自动恢复到 /create
  → 查看服务端报价并确认
  → 异步编辑
  → Before/After
  → 下载或 Edit Again
  → 保存到版本历史
  → credits 不足或需要 Quality 时升级订阅
```

---
