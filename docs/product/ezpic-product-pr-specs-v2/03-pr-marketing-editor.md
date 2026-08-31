# EzPic Product Contract Reference

> Read `00-global-contract.md` before this PR.

# PR 3：Raphael 式营销首页、SEO 首屏编辑器与草稿接力

**建议标题：** `feat(marketing): launch the prompt image editor landing experience`
**建议分支：** `codex/ezpic-pr3-marketing-editor`

## 3.1 业务目标

把当前静态 Hero + 通用图片/视频生成器重做为一个首屏即可操作的 AI 图片编辑器。访客可上传图片、输入 Prompt、选择模式并安全接力到登录后工作台，但此 PR 不产生模型费用。

## 3.2 依赖

PR 1；建议在 PR 2 确认模式名称后合并。

## 3.3 复用现有能力

- `MarketingGenerator` 的匿名草稿创建、base64 小图上传和 handoff；
- `/api/media/drafts`、`/draft/continue`、claim token；
- 现有 Hero、Features、Pricing、FAQ 组件；
- consent、analytics provider 和 next-intl；
- Marketing/SaaS 跨域来源限制。

## 3.4 主要文件

**修改：**

- `apps/marketing/app/[locale]/(home)/page.tsx`
- `apps/marketing/modules/home/components/HeroSection.tsx`（可以替换为轻量标题容器）
- `apps/marketing/modules/generator/components/MarketingGenerator.tsx`
- `apps/marketing/modules/generator/lib/draft-client.ts`
- `apps/marketing/modules/generator/lib/draft-client.test.ts`
- `apps/marketing/modules/home/components/FeaturesSection.tsx`
- `apps/marketing/modules/home/components/PricingSection.tsx`
- `apps/marketing/modules/home/components/FaqSection.tsx`
- `packages/i18n/translations/en/marketing.json`
- 首页 metadata/schema 相关文件

**新增：**

- `apps/marketing/modules/image-editor/components/ImageEditorHero.tsx`
- `apps/marketing/modules/image-editor/components/ImageDropzone.tsx`
- `apps/marketing/modules/image-editor/components/SourcePreview.tsx`
- `apps/marketing/modules/image-editor/components/PromptSuggestions.tsx`
- `apps/marketing/modules/image-editor/components/BeforeAfterDemo.tsx`
- `apps/marketing/modules/image-editor/components/ShowcaseSection.tsx`
- `apps/marketing/modules/image-editor/components/NoRestrictionsSection.tsx`
- `apps/marketing/modules/image-editor/components/HowItWorksSection.tsx`
- `apps/marketing/public/examples/*`
- `apps/marketing/public/examples/PROVENANCE.md`

## 3.5 首页 SEO 合同

**Title**

```text
AI Image Editor No Restrictions — Edit Images with Prompts | EzPic
```

**H1**

```text
AI Image Editor With Prompts, Without the Usual Restrictions
```

**Meta Description**

```text
Upload an image and describe the change. Edit backgrounds, objects, colors, lighting and styles with private AI image editing and transparent credits. Start with free credits.
```

不写 `free forever`、`unlimited`、`uncensored`、`no usage limits`、未验证的 `4K`、未验证的 `watermark-free` 或未经法律确认的商用许可。

## 3.6 首屏结构

桌面：左侧输入，右侧 Before/After 示例或上传预览；移动端上下排列。

输入区必须包含：

- 图片上传，JPEG/PNG/WebP；
- 文件大小提示来自服务端配置；
- Prompt；
- Suggested Prompt chips；
- Standard/Quality 选择；
- 模式 credits 提示；
- `Continue to Edit` CTA；
- “真实生成在登录后开始”的明确说明。

营销草稿类型改为：

```ts
{
	productKey: "image-fast" | "image-quality";
	input: {
		kind: "image-to-image";
		prompt: string;
	}
	upload: {
		contentType;
		base64;
	}
}
```

图片和 Prompt 均为必填。营销端只创建草稿，不创建 Quote、Job 或 Reservation。

## 3.7 页面模块顺序

1. 导航；
2. H1 + 首屏编辑器；
3. 可拖动 Before/After 示例；
4. 五类真实编辑 Showcase；
5. What “No Restrictions” Means；
6. How It Works；
7. 隐私/透明 credits/安全说明；
8. 简版 Pricing；
9. FAQ；
10. 最终 CTA；
11. Footer。

Showcase 只使用拥有版权或自行生成的素材，并在 provenance 文件记录来源、生成日期和允许用途。

## 3.8 “No Restrictions”区块

必须准确解释：

- natural-language prompts；
- no template-only workflow；
- private uploads；
- transparent credits；
- fewer unnecessary steps；
- standard safety, legal, provider and usage limits still apply。

## 3.9 用户故事

- 作为访客，我不阅读长文也能在首屏理解产品并开始填写；
- 作为不懂 Prompt 的用户，我能点示例快速开始；
- 作为谨慎用户，我在上传前能看到隐私和文件限制；
- 作为搜索用户，我能确认 `no restrictions` 的实际含义，不会被“无限制”误导。

## 3.10 验收标准

- 首屏 LCP 不被巨大演示视频拖累；
- 图片和 Prompt 缺一不可提交；
- 只接受 JPEG/PNG/WebP 和配置允许大小；
- 示例 Prompt 点击后只填充，不自动提交；
- draft 请求为 `image-to-image` 且包含 upload；
- 成功后通过现有 POST handoff 跳转，不在 query string 暴露 claim token；
- 草稿创建不调用 Provider、不预扣 credits；
- 桌面、平板、手机可用；
- 键盘和屏幕阅读器可完成上传、模式选择和提交；
- 页面没有虚假社交证明和虚假能力；
- metadata、canonical 和 JSON-LD 与实际页面一致。

## 3.11 测试范围

- draft client 类型和错误测试；
- 文件类型/大小/缺 Prompt 测试；
- handoff POST 测试；
- Playwright：访客选择示例、上传、提交、跳转；
- metadata/canonical/schema 测试；
- responsive 截图测试；
- axe/a11y 基础测试；
- 标准 CI。

## 3.12 迁移与回滚

无数据库迁移。旧 Hero/MarketingGenerator 可以保留一个 commit 的可回滚版本；最终不同时渲染两套表单。

## 3.13 不包含

- 匿名真实生成；
- 登录后结果页；
- 多语言发布；
- 大规模 SEO 内页。

---
