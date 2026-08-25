# EzPic AI Image Editor：Codex 产品规格与实施方案

> **文档用途：** 直接交给 Codex，在 `Micmyw/ez-image-ai` 基座上实施一个聚焦的 AI 图片编辑订阅 SaaS。  
> **文档日期：** 2026-08-23  
> **工作品牌：** EzPic  
> **生产域名：** 由环境变量配置；在站点所有权人确认域名前，禁止在业务代码中硬编码 `ezpic.ai`、`ezimageai.com` 或其他候选域名。  
> **产品参考：** Raphael 的用户路径、首屏工具结构、Before/After、示例 Prompt、展示案例、免费转付费机制；不得复制其品牌、文案、图片、评价、视觉素材或页面代码。  
> **目标仓库：** `https://github.com/Micmyw/ez-image-ai`

---

## 0. Codex 执行总指令

Codex 必须把本文件视为产品规格和业务验收合同，而不是要求重新设计 SaaS 底层架构的绿地项目。

### 0.1 信息优先级

发生冲突时按以下优先级处理：

1. 仓库中已经通过测试的安全与财务不变量；
2. 本文档中明确冻结的产品和业务要求；
3. 用户提供的“AI 图片/视频订阅 SaaS 基座功能说明”；
4. 现有代码风格、目录和组件惯例；
5. Raphael 仅作为产品路径参考；
6. 模型或 Provider 官方文档。

不得为了实现营销页面而破坏积分幂等、任务恢复、私有媒体、审核、支付或数据库真相源等既有原则。

### 0.2 三类能力标记

本文使用以下标记：

- **[现有]**：用户说明基座已经实现；Codex 必须先在代码中核实，再复用。
- **[配置]**：不应开发新体系，只需修改产品目录、路由、文案、套餐、环境变量或品牌配置。
- **[新开发]**：目标产品需要新增的用户体验或业务能力。

### 0.3 不允许做的事

- 不重新实现积分账本、Reservation、Allocation、Ledger、Refund 或 Debt。
- 不重新实现 Trigger.dev 任务基础设施。
- 不把客户端提交的 Provider、模型 ID、价格或远程 URL 当成可信输入。
- 不绕过 Prompt 审核和结果审核。
- 不把用户媒体改为公开对象。
- 不为首版启用视频生成、公共画廊、团队共享积分、API 或批量编辑。
- 不照抄 Raphael 的设计、文案、图片、评价、定价或源代码。
- 不声称 “unlimited”、“uncensored”、“free forever”、“no safety restrictions” 或 “no usage limits”。
- 不为 SEO 批量制造近重复页面。
- 不以固定关键词密度、固定外链数量、停留时间或第三方 DR/KD 作为代码验收标准。

### 0.4 仓库访问说明与首要验证门

生成本文件时，外部 GitHub 连接对目标仓库返回 404，因此本文件无法逐文件核验当前代码。Codex 开始任何业务改动前，必须完成“PR 1”中的仓库能力审计。

若以下任一基础能力实际不存在或核心不变量与用户说明明显不符，Codex 必须停止后续实现，在 PR 描述或审计文档中列出差异，不得静默补造一套新架构：

- 不可变积分账本与预扣/结算/退回；
- PostgreSQL 作为唯一业务真相源；
- Trigger.dev 异步任务与恢复/对账；
- Provider 抽象与服务端模型路由；
- 私有上传、输出转存和签名下载；
- Prompt 与输出审核；
- Stripe Webhook 幂等与订阅账期；
- 任务历史、后台诊断和运行时关闭开关。

---

# 1. 产品战略

## 1.1 一句话定位

**EzPic 是一款 Prompt-based AI Image Editor：用户上传图片，用自然语言描述修改要求，在安全边界内完成灵活、私密、可追溯的 AI 图片编辑。**

## 1.2 SEO 切入口、产品本体与订阅价值

必须区分三个层级：

| 层级 | 核心表达 | 作用 |
|---|---|---|
| SEO 冷启动入口 | `ai image editor no restrictions` | 获取正在增长且 SERP 存在弱页面的搜索流量 |
| 同词簇次主词 | `ai image editor with prompt no restrictions` | 强化“自然语言编辑 + 更少工作流障碍” |
| 长期产品母词 | `ai image editor with prompt` | 定义核心产品能力和后续纵向扩展 |
| 订阅留存价值 | History、Edit Again、HD、Premium Models、Batch、Consistency、API | 让用户持续付费，而不是只完成一次免费编辑 |

“no restrictions”只是获客语言，不是产品的法律或安全承诺。

## 1.3 “No Restrictions”的产品定义

页面必须有可见区块解释这一表达。

### 它表示

- 用户可以用自然语言自由描述编辑要求，而不是被固定模板锁死；
- 在生成前展示透明的积分报价；
- 可以先上传、输入 Prompt 和查看预计费用，再完成注册；
- 用户上传和结果默认私有；
- 不添加不必要的操作步骤；
- 若产品真实支持，则输出不附加产品品牌水印；
- 安全政策清晰、拒绝原因可理解，而不是模糊失败。

### 它不表示

- 没有内容安全政策；
- 支持违法、侵权或滥用内容；
- 无限免费生成；
- 没有积分、并发、速率或文件限制；
- Provider 条款不适用；
- 所有 Prompt 都保证成功。

建议页面英文说明：

> “No restrictions” means flexible prompt-based editing, private uploads, transparent credits, and fewer unnecessary workflow barriers. Standard safety, legal, provider, and usage limits still apply.

## 1.4 核心差异化

首版差异化不是“拥有最多模型”，而是：

1. **聚焦图片编辑**：首页、导航和产品都只围绕 AI Image Editor，不展示视频、音频或泛生成平台。
2. **Prompt-first**：上传图片后用一句自然语言完成编辑。
3. **结果优先**：首屏直接呈现可操作编辑器和 Before/After，而不是先阅读长篇营销文案。
4. **私有资产**：所有用户媒体默认私有，不以付费升级为条件。
5. **透明 credits**：生成前报价，失败按既有规则退回，账本可追溯。
6. **可持续编辑**：Edit Again、版本关系、Prompt 历史和资产历史形成续费基础。
7. **服务端路由**：用户选择“Standard / Quality”，不直接选择 Provider ID 或任意模型 ID。

## 1.5 目标用户

### Persona A：内容创作者与营销人员

- 每周需要修改封面、广告图、社交媒体素材；
- 不想学习 Photoshop；
- 关注生成速度、视觉质量、无额外品牌水印和可重复编辑。

### Persona B：电商卖家与独立站运营者

- 需要替换商品背景、颜色、场景和光线；
- 未来可能需要批量与商品一致性；
- 对商用条款、私密性和历史版本更敏感。

### Persona C：设计师与小型代理商

- 需要快速做初稿、多个版本和客户提案；
- 关注高质量模型、优先队列、编辑历史和长期资产保存。

### Persona D：搜索型轻度用户

- 从 `no restrictions`、`free`、`with prompt` 等词进入；
- 先完成一次简单编辑；
- 只有当结果满意且出现重复需求时，才可能注册或订阅。

## 1.6 核心使用场景

MVP 只承诺经过模型基准测试确认可用的场景：

- 替换背景；
- 移除或添加常见对象；
- 修改对象颜色或材质；
- 调整光线、天气和氛围；
- 风格转换；
- 对上一版结果继续用 Prompt 修改。

“精确局部擦除”“画笔蒙版”“扩图”“批量”“人物或商品强一致性”不属于 MVP 承诺。

---

# 2. 产品目标与非目标

## 2.1 MVP 目标

1. 让新用户在首页理解产品并开始上传图片；
2. 复用现有匿名草稿接力，注册后自动恢复并创建真实任务；
3. 完成一次安全、私有、异步、可计费的 Prompt 图片编辑；
4. 提供 Before/After、下载和 Edit Again；
5. 保存编辑历史、Prompt 和版本关系；
6. 建立 Free → Creator → Studio 的 credits 订阅路径；
7. 让首页具备 `ai image editor no restrictions` 词簇的完整搜索意图覆盖；
8. 完成真实 Provider、Stripe、Trigger.dev、存储、审核和 Sentry 的生产验证。

## 2.2 MVP 非目标

- 不做视频；
- 不做文本生成图片入口；
- 不做图层、画布、画笔、蒙版和 Photoshop 式编辑器；
- 不做批量上传、批量生成或批量下载；
- 不做 API；
- 不做团队共享积分和 Organization 媒体订阅；
- 不做公共作品社区；
- 不做 8–14 种语言；
- 不做模型市场；
- 不承诺匿名用户可以无限真实生成；
- 不以排名、外链数量或停留时间作为发布验收。

## 2.3 P1 范围

只有在 MVP 有真实激活与重复编辑后再开发：

- 一次真实匿名标准编辑，受全局预算、设备/IP 限流、CAPTCHA 和促销 credits 保护；
- 局部蒙版与画笔；
- 项目文件夹；
- 更完整的版本树；
- Prompt 收藏和模板；
- 多参考图；
- 商品或人物一致性模式；
- 付费优先队列；
- 批量编辑与批量下载。

## 2.4 P2 范围

- Image Editing API；
- Shopify 等平台集成；
- Organization 统一订阅；
- 团队共享 credits 和资产；
- Webhook 与工作流自动化；
- 企业套餐；
- 多语言 SEO；
- 视频生成；
- 联盟与推荐奖励。

---

# 3. 现有能力复用地图

| 能力 | 类型 | 本产品处理方式 |
|---|---|---|
| Better Auth、邮箱/社交登录 | [现有] | 直接复用 |
| 匿名营销草稿及登录恢复 | [现有] | 作为 MVP 首次接力，不虚假宣称“无需注册生成” |
| 积分 Account/Lot/Reservation/Ledger | [现有] | 直接复用，不增加旁路余额 |
| Stripe 订阅、退款、Debt | [现有] | 配置图片编辑套餐和 Price ID |
| Trigger.dev 异步任务 | [现有] | 复用 image-to-image 任务链路 |
| Provider Registry | [现有] | 新增或配置图片编辑产品路由，不让客户端选 Provider |
| 私有上传与资产库 | [现有] | 复用原图、结果和签名下载 |
| Prompt/结果审核 | [现有] | 配置本产品规则与用户可理解的错误文案 |
| 管理后台诊断 | [现有] | 增加本产品筛选、成本和版本链诊断 |
| 品牌、SEO、首页文案 | [配置] | 全面替换 Supastarter/demo 占位信息 |
| 视频与文本生图入口 | [配置] | 首版隐藏，不删除底层通用能力 |
| 产品目录和 credits | [配置] | 新建 `image-edit-standard`、`image-edit-quality` |
| Before/After | [新开发] | 首页与结果页核心组件 |
| Edit Again 与版本关系 | [新开发] | 复用资产和任务，增加父任务/来源资产关联 |
| Prompt 历史 | [新开发] | 在历史和再次编辑中展示 |
| 真实匿名首编 | [新开发/P1] | 仅 feature flag 和成本保护完备后启用 |
| 局部蒙版/批量/API | [新开发/P1/P2] | 不进入 MVP |

---

# 4. 产品数据流

## 4.1 MVP 主流程

```text
首页访问
  → 选择示例或上传私有图片
  → 输入自然语言 Prompt
  → 选择 Standard / Quality
  → 服务端报价
  → 匿名草稿持久化（不产生模型费用）
  → 登录/注册
  → 恢复草稿
  → Prompt 与输入审核
  → 在单个数据库事务内创建任务 + 预扣积分 + 绑定输入 + 写 Outbox
  → Trigger.dev 异步提交 Provider
  → Provider webhook/轮询恢复
  → 结果流式转存到自有私有存储
  → 输出审核
  → 成功结算或失败退回
  → Before/After + 下载 + Edit Again
  → 历史、版本链与订阅升级
```

## 4.2 状态真相

- PostgreSQL 是任务、账本、订阅和资产状态唯一真相来源；
- Trigger.dev 只执行，不拥有业务状态；
- Provider 是否接单不确定时，保持 Reservation 冻结；
- 不允许在不确定状态下自动切换 Provider 生成第二份结果；
- 失败重试必须通过稳定 Idempotency Key。

## 4.3 编辑版本关系

Codex 必须先检查现有 schema 是否已经能表达以下关系；只有缺失时才新增最小字段或关联表：

- 本次任务使用的输入资产；
- 本次任务生成的输出资产；
- 上一次编辑任务或父任务；
- 整条编辑链的根原图；
- 本次 Prompt 与产品路由；
- 用户点击 Edit Again 时默认使用哪一张资产。

建议概念接口，不强制具体表名：

```ts
type EditLineage = {
  generationId: string;
  parentGenerationId: string | null;
  rootAssetId: string;
  sourceAssetId: string;
  outputAssetIds: string[];
};
```

若现有任务输入/输出关系已经满足，不得重复建模。

---

# 5. 完整用户旅程

## 5.1 访客首次访问

1. 打开首页；
2. 首屏看到真实 Before/After 示例、上传区、Prompt 和示例 Chips；
3. 上传 JPG/PNG/WebP，前端显示预览；
4. 点击示例 Prompt 或自行输入；
5. 选择 Standard 或 Quality；
6. 查看预计 credits 和大致等待级别；
7. 点击 Edit Image；
8. 若未登录，保存匿名草稿并进入登录/注册；
9. 登录完成后自动回到编辑流程，不要求重新上传或输入；
10. 确认报价并创建任务。

### 验收

- 登录前不得产生 Provider 成本；
- 草稿恢复不得跨来源站点或跨会话泄露；
- 上传私有对象只能由草稿所有会话和登录后认领用户访问；
- 过期草稿和对象按既有机制清理。

## 5.2 生成中

1. 用户看到任务状态；
2. 页面轮询或订阅服务端状态；
3. 显示阶段性文案，不暴露 Provider 内部响应；
4. 用户可离开页面，稍后在历史中查看；
5. 只有处于安全可取消状态时显示 Cancel。

## 5.3 成功结果

1. 显示 Before/After 滑块；
2. 显示本次 Prompt、模式、消耗 credits 和时间；
3. 提供下载；
4. 提供 Edit Again；
5. Edit Again 自动把当前结果作为下一次输入，并保留可编辑 Prompt；
6. 历史页展示版本关系。

## 5.4 积分不足

1. 用户仍可保留草稿；
2. 显示需要 credits、当前余额和可选套餐；
3. 打开 Checkout；
4. 支付完成后返回原草稿/任务上下文；
5. Webhook 确认权益后才能创建任务，前端成功跳转不能作为发放依据。

## 5.5 付费用户

- 可使用 Quality 产品路由；
- 获得更多月度 credits；
- 并发和队列优先级按套餐配置；
- 获得更长历史保留期或其他已实现权益；
- 所有权益由服务端 entitlement 判断。

## 5.6 失败、取消与审核

详见第 11 节异常矩阵。

---

# 6. 页面与信息架构

## 6.1 可索引营销页面

| 路由 | 目的 | 首版索引 |
|---|---|---|
| `/` | 首页工具与主 SEO 页面 | 是 |
| `/pricing` | 套餐和 credits | 是 |
| `/privacy` | 隐私政策 | 是 |
| `/terms` | 服务条款 | 是 |
| `/content-policy` | 内容和可接受使用政策 | 是 |
| `/contact` | 联系支持 | 是 |
| `/blog/*` | 基座已有博客 | 首版可保留，但不得发布薄内容 |

首版不新增 `free`、`with-prompt`、`no-restrictions` 的近重复独立页面。

## 6.2 登录后页面

| 路由概念 | 目的 | 索引 |
|---|---|---|
| 工作台 | 新编辑任务 | `noindex` |
| 历史 | 任务筛选、状态和结果 | `noindex` |
| 任务详情 | Before/After、Prompt、错误、重试 | `noindex` |
| 资产库 | 私有输入和输出 | `noindex` |
| Billing/Credits | 套餐、余额、流水入口 | `noindex` |
| Settings | 账号、会话、通知 | `noindex` |
| Admin | 诊断与人工操作 | `noindex` + 权限保护 |

Codex 应复用仓库现有路由模式，不要求按上表字面命名。

---

# 7. 首页 SEO 合同与 Raphael 式产品结构

## 7.1 关键词角色

| 关键词 | 角色 | 页面策略 |
|---|---|---|
| `ai image editor no restrictions` | Primary | 首页核心搜索意图 |
| `ai image editor with prompt no restrictions` | Secondary | 首页自然覆盖 |
| `ai image editor free no restrictions` | Secondary | 文案中自然覆盖，不强调永久免费 |
| `ai image editor with prompt` | 长期产品母词 | H1、副标题、功能和工具 UI 自然覆盖 |
| `ai image editor with prompt free` | 同意图变体 | 不独立建页 |

## 7.2 Metadata

### Title

```text
AI Image Editor No Restrictions — Edit Images with Prompts | EzPic
```

### Meta Description

```text
Edit images with natural-language prompts. Replace backgrounds, remove or add objects, and keep your uploads private with transparent credit pricing. Start with free credits.
```

若真实能力未通过验证，不得加入 4K、无水印、无限、免注册生成或商用许可等声明。

### H1

```text
AI Image Editor With Prompts, Without the Usual Restrictions
```

### 首屏副标题

```text
Upload an image, describe the change, and get a private AI-edited result. Start with free credits, then unlock higher-quality models, faster processing, and editing history.
```

## 7.3 首屏结构

首屏必须让用户直接操作，而不是只有宣传图。

### 桌面布局

- 左侧：输入图片、拖拽上传、示例图；
- 右侧：结果空状态或默认 Before/After；
- 下方：Prompt textarea、示例 Prompt Chips、模式选择、报价、CTA；
- 默认案例必须展示真实模型生成的原图、结果和 Prompt；
- 结果出现后切换为可拖动 Before/After。

### 移动端

- 输入、Prompt、生成按钮、结果垂直排列；
- CTA 在键盘出现时仍可操作；
- 不依赖 hover；
- 大图加载不得阻塞首屏文案和输入。

## 7.4 示例 Prompt

首版五个：

```text
Replace the background with a sunset beach
Remove the person in the background
Change the jacket color to black
Turn this photo into a cinematic night scene
Convert this image into a clean editorial illustration
```

点击只填入 Prompt，不自动产生费用。

## 7.5 首页模块顺序

1. 极简导航；
2. H1、副标题和可操作编辑器；
3. 真实 Before/After；
4. 示例 Prompt；
5. Showcase 场景分类；
6. What “No Restrictions” Means；
7. 三步使用方式；
8. Private by Default / Transparent Credits / Async & Recoverable；
9. 简版 Pricing；
10. FAQ；
11. 最终 CTA；
12. Footer 与法律链接。

## 7.6 导航

首版只保留：

- Logo；
- Examples（锚点）；
- Pricing；
- FAQ（锚点）；
- Sign In；
- Start Editing。

不展示 Video、Audio、All Models 或十几个工具入口。

## 7.7 Showcase

用本产品真实模型生成并保存固定演示资产：

- Background Replacement；
- Object Removal or Addition；
- Color and Material Change；
- Lighting and Atmosphere；
- Style Transformation。

每组包含：

- 原图；
- 1–3 个结果；
- 对应 Prompt；
- “Try this prompt”按钮；
- 必要的授权和来源记录。

不得使用用户私有生成结果构建公共展示。

## 7.8 信任信息

上线时可使用的真实声明：

```text
Flexible Prompt Editing · Private Uploads · Transparent Credits · Free Starter Credits
```

只有真实实现并经测试后，才能增加：

```text
Watermark-Free Outputs · High-Resolution Results · Commercial Use on Paid Plans
```

不得伪造用户数量、评分、评价或客户 Logo。

## 7.9 结构化数据

首版使用：

- `WebSite`；
- `Organization`；
- `SoftwareApplication`；
- 合适页面的 `BreadcrumbList`。

要求：

- Offers、价格、币种和免费额度必须与页面真实内容一致；
- FAQ 内容可以存在，但不得把 FAQ Schema 或关键词出现次数作为排名手段；
- 不使用 Meta Keywords。

## 7.10 索引规则

- 首页必须有 self-canonical；
- 非生产环境全站 `noindex`；
- 登录后、历史、资产、任务和管理页面 `noindex`；
- 签名媒体 URL 不进入 sitemap；
- sitemap 只包含真实、可索引营销页；
- 多语言路由首版关闭或仅保留基座能力，不生成空翻译页。

---

# 8. 功能需求、用户故事与验收标准

## F-01：首页编辑器壳

**类型：** [配置] + [新开发]

**用户故事：** 作为首次访问者，我不阅读教程就能理解这是图片编辑工具，并开始上传和输入 Prompt。

**验收：**

- 首页首屏可上传一张图片；
- 有默认 Before/After 示例；
- 可点击示例 Prompt；
- Standard / Quality 的产品选项来自服务端产品目录；
- 不显示 Provider、真实模型 ID 或任意价格参数；
- 关键表单可键盘操作并有可访问标签；
- 支持移动端。

## F-02：私有图片上传

**类型：** [现有] + [配置]

**用户故事：** 作为用户，我上传的原图默认私有，并在生成、历史和删除流程中保持所有权一致。

**验收：**

- 支持的格式、大小和容量由服务端配置；
- 校验 MIME、文件头和 Content-Length；
- 只通过签名 URL 预览/下载；
- 不允许客户端传入任意远程 URL；
- 过期和删除走既有清理；
- 日志和分析中不记录签名 URL。

## F-03：Prompt 与示例

**类型：** [配置] + [新开发]

**验收：**

- Prompt 有长度边界；
- 示例点击只填充，不提交；
- Prompt 在创建任务前审核；
- 审核拒绝时不创建任务、不预扣 credits；
- 错误文案不泄露审核规则细节；
- 分析事件不得包含 Prompt 原文。

## F-04：服务端报价

**类型：** [现有] + [配置]

**验收：**

- 客户端只提交稳定产品 ID；
- 报价由服务端产品目录和用户权益生成；
- 报价有版本或指纹，创建任务时重新验证；
- 用户能看到 credits、模式和大致输出规格；
- 报价过期时重新获取，不使用旧价格创建任务。

## F-05：匿名草稿接力

**类型：** [现有] + [配置]

**验收：**

- 匿名用户可以上传、输入、选择模式并保存草稿；
- 登录后自动恢复；
- 不重复上传；
- 不跨用户、来源或会话认领；
- 草稿阶段不调用 Provider；
- 页面文案使用 “Start free” 或 “Start editing”，不声称“无需注册即可完成生成”。

## F-06：异步图片编辑任务

**类型：** [现有] + [配置]

**验收：**

- 输入图片是必需的；
- 创建任务、Reservation、输入绑定和初始 Outbox 在单事务内完成；
- Idempotency Key 重放不重复扣费或生成；
- Trigger.dev 提交异步任务；
- Provider 输出转存到私有存储后才对用户可用；
- 输出必须通过审核；
- 成功结算、失败按规则退回；
- 不确定提交保持冻结并进入对账。

## F-07：任务进度与恢复

**类型：** [现有] + [配置]

**验收：**

- 用户可看到等待、执行、输出处理、成功、失败、取消等用户友好状态；
- 刷新页面不丢失任务；
- 任务可在历史中恢复；
- 只有安全可取消状态允许取消；
- Provider/内部错误不直接暴露给用户；
- 管理员可查看原始诊断信息，但日志需脱敏。

## F-08：Before/After 和下载

**类型：** [新开发]

**验收：**

- 成功结果显示原图和结果；
- 支持滑块或清晰切换；
- 无障碍模式下可用按钮切换；
- 下载使用短期签名 URL；
- 下载事件不记录 URL；
- 审核未批准资产不可下载。

## F-09：Edit Again 与版本关系

**类型：** [新开发]

**用户故事：** 作为重复用户，我可以在上一版结果上继续修改，不必重新上传。

**验收：**

- 点击 Edit Again 使用当前结果为输入；
- Prompt 可编辑；
- 新任务仍重新报价、审核和预扣；
- 历史中能从任意版本追溯根原图；
- 删除某一资产时不破坏账本和任务审计；
- 无可用结果或资产被删除时给出明确提示。

## F-10：历史和资产库

**类型：** [现有] + [新开发]

**验收：**

- 可筛选进行中、成功、失败和取消；
- 显示 Prompt 摘要、模式、时间、credits 和缩略图；
- 任务详情显示版本关系；
- 用户只能访问自己的媒体和任务；
- 删除为软删除 + 异步物理清理；
- 历史页面 `noindex`。

## F-11：套餐与订阅

**类型：** [现有] + [配置]

**验收：**

- Free、Creator、Studio 权益由配置定义；
- Checkout、Portal 和 Webhook 使用既有 Stripe 能力；
- Webhook 重放幂等；
- 年付按内部月度周期发 credits；
- 退款、Debt 和积分扣回保持既有逻辑；
- 成功返回页不直接发放权益；
- 失败任务按业务矩阵处理。

## F-12：内容安全

**类型：** [现有] + [配置]

**验收：**

- Prompt 前置审核；
- 输出后置审核；
- 未批准结果隔离；
- 生产环境不能启用测试审核器；
- “No Restrictions”页面明确安全边界；
- 提供可接受使用政策；
- 管理员人工操作有原因、Idempotency Key 和审计记录。

## F-13：真实匿名首编实验

**类型：** [新开发/P1]，默认关闭

只有以下条件全部满足才允许启用：

- `GUEST_GENERATION_ENABLED` feature flag；
- 固定低成本产品路由；
- IP + device + Cookie/session 联合限流；
- CAPTCHA 或风险挑战；
- 每日/每月全局成本预算；
- 匿名资产短期自动删除；
- 仍使用幂等、任务、审核和受控促销 credits；
- 不创建旁路余额；
- 达到预算后可关闭或改为登录接力；
- 后台可查看成本和滥用。

MVP 不因该功能延期；若未启用，页面不得宣称 no-sign-up generation。

## F-14：运营和管理员能力

**类型：** [现有] + [配置] + 少量 [新开发]

**验收：**

- 按产品、Provider、模型、状态和用户筛选任务；
- 查看平均/P50/P95 延迟、成功率、成本和审核结果；
- 查看 Outbox、Webhook、对账和不确定提交；
- 可全局关闭、关闭单产品或单模型路由；
- 人工重放和处理均有审计；
- 不向普通管理员展示密钥、Prompt 原文或永久媒体 URL。

---

# 9. 模型目录与 Provider 选择

## 9.1 原则

- 不沿用过期模型 ID；
- 模型 ID、Provider 和成本仅在服务端目录配置；
- 上线前用真实账户完成基准测试；
- 用户只看到 Standard / Quality；
- 路由切换不改变稳定产品 ID；
- 同一业务任务不得在不确定状态下跨 Provider 重复执行。

## 9.2 2026-08 候选模型

以下只是基准候选，不是未经测试的最终路由：

### Standard 候选

1. `gemini-3.1-flash-image`：Google 当前将其描述为质量、成本和延迟平衡的通用图片生成/编辑模型；
2. `gemini-3.1-flash-lite-image`：低延迟、低成本编辑候选；
3. `fal-ai/flux-2/turbo/edit`：低成本编辑候选；
4. `fal-ai/flux-pro/kontext`：Prompt 编辑和主体保持候选。

### Quality 候选

1. `gemini-3-pro-image`：复杂指令和高质量资产候选；
2. `fal-ai/flux-2-pro/edit`：高质量编辑候选；
3. `fal-ai/flux-pro/kontext/max`：更强 Prompt adherence 与一致性候选。

### 备用 Provider

- 若 Replicate 现有适配器已提供同等候选模型，可作为故障切换；
- Kie 仅在真实基准、成本、条款和可靠性优于现有路线时启用；
- 不为“Provider 数量更多”而新增重复适配。

## 9.3 基准测试集

至少 50 个任务，覆盖：

| 类别 | 最少案例 |
|---|---:|
| 背景替换 | 8 |
| 对象移除/增加 | 10 |
| 颜色/材质 | 8 |
| 光线/天气/氛围 | 8 |
| 风格转换 | 6 |
| 人像/服装 | 5 |
| 商品图 | 5 |

每个模型记录：

- Prompt adherence；
- 未要求区域保持程度；
- 主体/产品一致性；
- 视觉质量；
- 文字处理；
- 安全拒绝；
- 成功率；
- P50/P95 延迟；
- 单次成本；
- 平均重试次数；
- 输出尺寸与 MIME；
- Provider 错误分布。

建议加权评分：

```text
30% 指令遵循
25% 未编辑区域保持与主体一致性
20% 视觉质量
10% 延迟
10% 单次成功成本
5% 稳定性与安全可控性
```

## 9.4 路由冻结条件

- Standard 必须在大多数常见任务上可接受，且成本适合 Free/Creator；
- Quality 必须显著提高复杂编辑质量，不能只是更贵；
- 每个产品至少一个主路由；
- 备用路由仅在 Provider 明确未接单或符合既有安全切换条件时使用；
- 模型下线时只修改服务端目录和迁移文档，不更改客户端产品 ID。

---

# 10. 套餐、积分、成本与毛利

## 10.1 积分定价原则

用 P95 成功成本而不是营销价格倒推 credits。

建议内部成本基准：

```text
目标 Provider 成本 / credit = 0.005 USD
```

产品 credits 公式：

```text
credits = round_up_even(
  (P95 provider cost per successful result × 1.15 safety buffer)
  / 0.005
)
```

示例仅用于说明：

- 若一次成功编辑 P95 成本为 `$0.04`，报价约 `10 credits`；
- 若高质量编辑成本为 `$0.134`，报价约 `32 credits`；
- 若低成本路线约 `$0.016`，报价约 `4 credits`。

最终数字必须来自真实基准，不从文档硬编码。

## 10.2 暂定套餐结构

先复用基座三档，数字保持配置化：

| 套餐 | 暂定价格 | 暂定 credits | 并发 | 产品 |
|---|---:|---:|---:|---|
| Free | $0 | 25/月 | 1 | Standard |
| Creator | $19/月或$190/年 | 1,000/月 | 3 | Standard + Quality |
| Studio | $79/月或$790/年 | 5,000/月 | 10 | Standard + Quality |

上线前可以调整 credits，不得在组件中写死。

## 10.3 毛利公式

```text
Net Revenue
= Subscription Revenue
- Stripe/payment variable fees
- refunds and chargebacks

Variable COGS
= Provider generation cost
+ moderation cost
+ storage and egress
+ transactional email/notification variable cost
+ directly attributable support cost

Gross Margin
= (Net Revenue - Variable COGS) / Net Revenue
```

### 发布门槛

- 以满额 credits 使用和 P95 生成成本估算；
- Creator 和 Studio 预期毛利应不低于 65%；
- 若低于 50%，不得按当前价格和 credits 公开销售；
- Free 层必须有每用户和全局预算；
- 失败、审核和重试成本纳入 P95，而不是只看单次 API 标价。

## 10.4 套餐权益文案

可以销售：

- monthly credits；
- Standard / Quality access；
- more concurrent jobs；
- private assets；
- edit sessions/history；
- plan-specific image input size。

不得销售：

- 隐私本身；所有用户默认私有；
- 无安全审核；
- 无限生成，除非有独立成本模型且真实实现；
- 未实现的优先队列、无限历史、更高输出分辨率、商业使用承诺、4K、批量或 API。

---

# 11. 异常、取消、退款与审核矩阵

Codex 必须先核对现有策略。若已有更严格且经过测试的规则，保留现有规则并更新用户文案；若缺失，按下表实现。

| 场景 | 任务结果 | credits | 用户体验 |
|---|---|---|---|
| 输入校验失败 | 不创建任务 | 不预扣 | 提示格式/大小问题 |
| Prompt 前置审核拒绝 | 不创建任务 | 不预扣 | 给出安全范围内的可理解原因 |
| 余额不足 | 不创建任务 | 不预扣 | 保留草稿并展示升级 |
| 创建事务失败 | 无任务或完整回滚 | 不扣 | 可安全重试 |
| Provider 提交前取消 | 已取消 | Release | 立即更新 |
| Provider 明确拒绝且未产生结果 | 失败 | Release | 可修改 Prompt 重试 |
| Provider 是否接单不确定 | 需要对账 | 保持 Reservation | 禁止取消和跨 Provider 重发 |
| Provider 明确成功但输出转存失败 | 输出处理中/恢复 | 保持 Reservation | 后台重试转存，不重复生成 |
| Provider 超时但有远程任务 ID | 对账 | 保持 Reservation | 继续恢复原任务 |
| 输出因平台/Provider 错误不可用 | 失败 | Release 或既有规则 | 平台承担成本，允许重试 |
| 用户输入规避审核导致输出违规 | 失败/隔离 | 按现有滥用策略；不可自动反复赠送 | 说明违反政策，可限制账户 |
| 审核服务异常 | 审核错误/隔离 | 保持直到恢复；超时后按既有策略 | 不公开结果 |
| 用户安全取消且 Provider 确认取消 | 已取消 | Release | 任务停止 |
| 订阅退款且 credits 未使用 | Refund | 扣回对应 Lot | 更新余额 |
| 订阅退款但 credits 已使用 | Refund + Debt | 记录欠款 | 限制后续使用直到处理 |
| Webhook 重放 | 不变 | 不重复发放/扣除 | 幂等 |

所有人工调整必须包含原因、操作者、稳定引用键和审计记录。

---

# 12. 管理后台和运营需求

## 12.1 任务运营

- 按产品、Provider、模型、状态、时间和用户筛选；
- 查看提交、远程 ID、Webhook、轮询、输出转存和审核时间线；
- 查看不确定提交；
- 重放已持久化事件；
- 安全重试分发、输出处理或结算；
- 不允许直接改账本余额字段。

## 12.2 成本与质量

按日/周/月显示：

- 请求数和成功数；
- P50/P95 延迟；
- Provider 错误率；
- 输出审核拒绝率；
- 平均和 P95 单次成功成本；
- 每产品消耗 credits；
- Free 层成本；
- 订阅收入和估算毛利；
- Edit Again 比例；
- 模型质量抽样结果。

## 12.3 运行时控制

- 全局生成开关；
- Standard/Quality 单产品开关；
- 单 Provider/模型开关；
- 匿名真实编辑开关；
- Free 层日预算；
- Provider 权重回滚；
- 所有变更写审计。

## 12.4 审核与滥用

- 查看隔离结果；
- 查看规则版本和原因；
- 人工批准/拒绝仅在权限允许时执行；
- 用户封禁和速率限制；
- 不在普通日志中显示 Prompt 原文或永久媒体地址。

---

# 13. 数据埋点与核心指标

## 13.1 事件命名

事件属性只能使用 ID、枚举和数值；不得传 Prompt、图片内容、私有 URL、Cookie、密钥或原始 Provider 响应。

建议事件：

```text
landing_view
example_prompt_selected
upload_started
upload_completed
quote_requested
quote_viewed
edit_submit_clicked
auth_gate_shown
signup_completed
draft_restored
generation_created
generation_provider_submitted
generation_succeeded
generation_failed
generation_canceled
result_viewed
before_after_interacted
result_downloaded
edit_again_clicked
credit_paywall_viewed
checkout_started
subscription_started
subscription_canceled
```

建议公共属性：

```text
product_id
plan_id
mode
is_authenticated
source_page
result_count
credit_quote
failure_category
moderation_outcome
latency_bucket
```

## 13.2 SEO 指标

- 首页是否正常索引；
- `ai image editor no restrictions` 词簇 Impression；
- `with prompt` 相关自然 Query；
- 排名 11–20 的词；
- 高曝光低 CTR；
- 国家、设备和页面；
- 非预期重复 URL、canonical 和索引异常。

## 13.3 产品漏斗

```text
首页访问
→ 上传完成
→ 获取报价
→ 点击提交
→ 完成注册/登录
→ 创建任务
→ 成功结果
→ 查看结果
→ 下载
→ Edit Again
→ 订阅
```

## 13.4 核心经营指标

- Upload rate；
- Quote-to-submit；
- Draft restore completion；
- 生成成功率；
- Time to First Successful Result；
- 下载率；
- Edit Again 率；
- D1/D7 回访；
- Free → paid；
- 每成功结果成本；
- credits 利用率；
- Creator/Studio 毛利；
- 退款和拒付；
- 审核拒绝与滥用率。

转化指标在首期作为实验观察，不伪装成行业基准；技术、安全和财务不变量才是硬验收。

---

# 14. 第三方账号与环境配置

## 14.1 必需账号

- PostgreSQL 托管环境；
- Trigger.dev Cloud；
- Stripe；
- 至少一个主图片编辑 Provider；
- 至少一个经过验证的备用 Provider；
- S3 / Cloudflare R2；
- Sightengine 或生产审核服务；
- Sentry；
- 邮件服务；
- Google OAuth/GitHub OAuth（若启用）；
- Google Search Console；
- 单一主产品分析工具，建议 PostHog；
- 域名和 DNS。

## 14.2 环境变量类别

遵循仓库现有命名，不在文档中发明重复变量。至少覆盖：

- Site name、site URL、support email；
- Database；
- Auth secrets 和 OAuth；
- Stripe keys、Webhook secret、Price IDs；
- Trigger.dev；
- S3/R2 bucket、endpoint、credentials；
- Provider API keys；
- Sightengine；
- Sentry；
- Analytics；
- Feature flags；
- Runtime kill switches；
- Guest generation budget（P1）。

## 14.3 环境隔离

- local、test、staging、production 使用独立密钥和资源；
- production 禁用 Mock Provider 和测试审核器；
- staging 不使用生产 Stripe Price；
- 非生产环境默认 `noindex`；
- 不在客户端 bundle 暴露服务器密钥；
- Sentry 和日志脱敏。

---

# 15. 生产验收清单

## 15.1 仓库与构建

- [ ] 基座能力审计完成；
- [ ] 全仓库没有 `supastarter demo`、`example.com` 或错误品牌占位；
- [ ] typecheck、lint、format、unit、integration、Playwright 全部通过；
- [ ] production build 通过；
- [ ] 依赖安全扫描无阻断问题。

## 15.2 产品

- [ ] 首页上传、Prompt、报价和草稿接力可用；
- [ ] 登录后无需重新输入；
- [ ] Standard 与 Quality 路由真实可用；
- [ ] Before/After、下载、Edit Again、历史和版本关系可用；
- [ ] 移动端完成全流程；
- [ ] 错误状态可理解。

## 15.3 任务与积分

- [ ] 重复 Idempotency Key 不重复生成或扣费；
- [ ] 创建任务与 Reservation 同事务；
- [ ] 失败正确 Release；
- [ ] 不确定提交保持冻结并可恢复；
- [ ] Webhook/轮询和对账可恢复；
- [ ] 失败任务重试使用最新报价与审核；
- [ ] 账本不变量测试通过。

## 15.4 存储与安全

- [ ] 输入输出默认私有；
- [ ] 远程结果流式转存；
- [ ] 签名 URL 短期有效；
- [ ] 删除和过期清理可用；
- [ ] Prompt 和输出审核走生产适配器；
- [ ] 拒绝结果不可下载或复用；
- [ ] 日志、Sentry、Analytics 无 Prompt/密钥/私有 URL。

## 15.5 支付

- [ ] Checkout 和 Portal；
- [ ] 月付/年付；
- [ ] Stripe Webhook 验签和幂等；
- [ ] 内部月度 credits；
- [ ] 取消、续费、退款和 Debt；
- [ ] 支付成功返回页不直接发权益；
- [ ] 套餐成本和毛利通过发布门槛。

## 15.6 Provider

- [ ] 至少 50 个真实任务基准；
- [ ] 主/备模型冻结；
- [ ] 成本、P50/P95 延迟和成功率记录；
- [ ] 输出尺寸、MIME 和审核验证；
- [ ] Provider 容量、限流和错误分类验证；
- [ ] 运行时关闭开关验证。

## 15.7 SEO 与分析

- [ ] Title/H1/Description 符合本文合同；
- [ ] canonical、robots、sitemap；
- [ ] 私有页面 `noindex`；
- [ ] SoftwareApplication 数据与真实套餐一致；
- [ ] GSC 连接；
- [ ] 漏斗事件可见且不含敏感数据；
- [ ] 不存在虚假 unlimited/no-sign-up/4K/watermark-free 声明。

## 15.8 运维

- [ ] Trigger.dev Cloud 真实部署；
- [ ] Sentry 报警；
- [ ] Outbox/对账运行；
- [ ] k6 staging 压测；
- [ ] 全局/产品/模型关闭；
- [ ] Runbook、回滚和人工处理流程演练；
- [ ] 上线后的成本预算和告警阈值配置。

---

# 16. Pull Request 实施计划

原则：7 个 PR，每个 PR 都产生完整业务价值；不得拆成大量只改一个组件的微小 PR。每个 PR 合并前必须通过自身范围内的测试，并在描述中明确“不包含内容”。

## PR 1：仓库能力审计、品牌垂直化与首页产品壳

### 业务目标

确认基座能力真实存在，并把通用图片/视频模板变成聚焦的 AI Image Editor 营销站和草稿入口。

### 范围

- 输出 `docs/repository-capability-audit.md`；
- 映射 apps/packages 与本文现有能力；
- 确认积分、任务、Provider、存储、审核、Stripe 和测试位置；
- 工作品牌 EzPic 和站点信息配置化；
- 清除 demo/example 占位；
- 隐藏视频、文本生图和泛模型入口；
- 实现 Raphael 式但视觉独立的首页壳；
- 上传、Prompt、示例、模式和匿名草稿；
- Pricing、Privacy、Terms、Content Policy 品牌化；
- Metadata、canonical、robots、sitemap 和 noindex；
- `WebSite`、`Organization`、真实的 `SoftwareApplication`。

### 验收

- 审计文档列出“已确认、配置、缺失、风险”；
- 若核心基座缺失，停止后续 PR；
- 首页只表达 AI Image Editor；
- 匿名草稿不会调用 Provider；
- 品牌和域名不硬编码；
- 移动端 UI 可用；
- 无虚假能力声明。

### 测试

- 配置与 metadata 单元测试；
- 首页 Playwright；
- 草稿来源、过期和恢复测试；
- sitemap/robots/canonical 测试；
- 构建、类型、lint。

### 不包含

- 真实生成；
- Before/After 真实结果；
- 订阅配置上线；
- 匿名真实编辑。

---

## PR 2：模型基准、图片编辑产品目录与真实异步链路

### 业务目标

让登录用户使用一张输入图片和 Prompt 完成一次可计费、可恢复的真实编辑。

### 范围

- 创建基准脚本/工具和固定测试集；
- 评估候选模型；
- 配置 `image-edit-standard` 和 `image-edit-quality`；
- 复用 image-to-image Provider 接口；
- 服务端报价；
- 输入/Prompt 审核；
- 任务 + Reservation + Asset + Outbox 同事务；
- Trigger.dev 提交；
- Webhook/轮询；
- 输出流式转存；
- 输出审核；
- Settle/Release/对账；
- 用户进度与基础结果。

### 验收

- 客户端不能指定 Provider、模型或价格；
- 相同 Idempotency Key 不重复扣费；
- Provider 不确定提交不自动退款或切换；
- 未审核结果不可用；
- 私有输入输出无泄漏；
- 基准报告记录质量、延迟、成本和路由选择。

### 测试

- Provider 合约测试；
- 积分不变量和数据库集成；
- Trigger.dev 测试；
- Webhook 验签和重放；
- 远程 URL/MIME/大小安全；
- E2E 成功、失败、不确定提交和恢复。

### 不包含

- 版本链；
- Before/After 完整交互；
- Stripe 新套餐；
- 批量、蒙版、API。

---

## PR 3：Before/After、Edit Again、版本链与历史

### 业务目标

把一次“模型调用”变成可重复使用的图片编辑产品。

### 范围

- Before/After 组件；
- 下载；
- Edit Again；
- 父任务/根资产/来源资产关系；
- Prompt 历史；
- 版本视图；
- 历史筛选和任务详情；
- 失败重试；
- 示例案例由真实模型输出替换；
- 移动端结果体验。

### 验收

- 可连续编辑至少两轮；
- 不需重新上传上一版结果；
- 任意版本可追溯根原图；
- 新编辑仍重新报价、审核和预扣；
- 删除资产不破坏财务和任务审计；
- 私有权限严格。

### 测试

- 版本关系单元/集成；
- Edit Again E2E；
- 删除与历史；
- Before/After 可访问性；
- 签名下载；
- 多用户越权测试。

### 不包含

- 项目文件夹；
- 画笔/蒙版；
- 批量；
- 匿名真实编辑。

---

## PR 4：图片编辑套餐、Stripe 权益与订阅转化

### 业务目标

建立 Free → Creator → Studio 的完整付费闭环，并保证积分、退款和账期正确。

### 范围

- 按基准成本确定产品 credits；
- 配置 Free/Creator/Studio；
- 图片编辑专用 Pricing；
- Checkout、Portal、Webhook；
- 月付/年付；
- 权益、并发、队列和产品访问；
- 余额不足升级路径；
- 支付后恢复草稿；
- 退款、Debt 和订阅状态；
- 毛利计算文档与后台基础指标。

### 验收

- Webhook 重放不重复发 credits；
- 年付内部月度周期正确；
- 前端返回页不发权益；
- 退款和 Debt 保持不变量；
- 套餐数字全部配置化；
- 满额使用的估算毛利达到门槛，否则阻止公开销售。

### 测试

- Stripe webhook fixtures；
- 账期、续费、取消、退款、Debt；
- 权限和并发；
- Checkout E2E；
- 支付后草稿恢复。

### 不包含

- Organization 计费；
- 一次性 credit packs，除非基座已经成熟支持；
- API；
- 团队订阅。

---

## PR 5：Feature-flagged 匿名首编与滥用/成本保护

### 业务目标

在不破坏账本和成本控制的前提下，实验 Raphael 式“先获得一次结果，再注册”的低摩擦路径。

### 范围

- 先提交设计说明，明确如何复用现有 credits/任务；
- Guest identity/session 所有权；
- 受控促销 credit lot 或等价现有机制；
- 低成本固定产品；
- IP/device/session 限流；
- CAPTCHA；
- 全局日/月预算；
- 匿名媒体短期删除；
- 登录后结果认领；
- feature flag 和 kill switch；
- 成本/滥用后台。

### 验收

- 默认关闭；
- 不存在旁路余额；
- 仍走审核、幂等、异步任务和私有存储；
- 同设备/IP 不能无限重置；
- 超预算自动停止真实匿名编辑并回退到登录接力；
- 匿名结果不会公开；
- 关闭功能不影响登录用户。

### 测试

- 并发和幂等；
- 限流绕过；
- 预算竞争条件；
- CAPTCHA；
- 匿名到登录认领；
- 过期删除；
- k6 滥用场景。

### 不包含

- 无限匿名生成；
- 匿名订阅；
- 公共画廊。

---

## PR 6：SEO 内容、分析漏斗与运营诊断

### 业务目标

让产品可以安全获取自然流量、衡量激活与订阅，并让运营人员发现成本和任务问题。

### 范围

- 完成首页 Showcase、No Restrictions 说明、How It Works、隐私、Pricing、FAQ；
- 只使用真实生成案例；
- GSC；
- PostHog 或仓库选定的单一产品分析；
- 本文事件；
- 隐私过滤；
- Provider/产品成功率、延迟、成本和审核后台；
- Free/Guest 成本预算；
- 用户反馈入口；
- SEO 技术验收自动化。

### 验收

- 页面文案与真实能力一致；
- Analytics 无敏感信息；
- 首页和漏斗事件可查询；
- 后台能按产品/Provider/模型定位问题；
- 私有页面不索引；
- 不批量创建长尾页面。

### 测试

- 内容快照/Metadata；
- 事件 schema；
- 敏感字段过滤；
- GSC/analytics 配置；
- admin 权限；
- SEO E2E。

### 不包含

- 外链建设；
- 多语言；
- 模型页矩阵；
- 批量内容生成。

---

## PR 7：真实生产验收、压力测试与上线切换

### 业务目标

完成外部账号和生产环境验证，使项目达到可安全公开发布的状态。

### 范围

- Trigger.dev Cloud；
- Stripe 完整账期；
- 主/备 Provider 认证；
- Sightengine；
- S3/R2 上传、转存、签名和清理；
- Sentry 报警；
- Staging；
- k6；
- 恢复/对账；
- kill switch；
- Runbook 和回滚；
- 域名、DNS、canonical 和 GSC；
- 成本和毛利最终冻结；
- 生产验收报告。

### 验收

- 第 15 节清单全部完成或明确阻断；
- 真实 Provider 测试完成；
- Stripe webhook、退款和账期完成；
- 不确定提交恢复演练；
- 私有媒体删除演练；
- 全局和产品级关闭演练；
- 生产环境无 Mock/Test adapter；
- 上线和回滚步骤可由非开发者按 Runbook 执行。

### 测试

- 全量 CI；
- Playwright production-like E2E；
- k6；
- 安全和越权；
- 支付；
- 任务恢复；
- 存储生命周期；
- 灾难演练。

### 不包含

- 多语言扩张；
- 视频；
- API；
- 团队订阅；
- 排名承诺。

---

# 17. Codex 工作方式与交付要求

1. 先阅读仓库的 `AGENTS.md`、README、架构文档和 Runbook；
2. 使用独立 branch/worktree；
3. 每个 PR 开始前列出将修改的现有文件和原因；
4. 遵循仓库现有目录，不根据本文虚构文件路径；
5. 测试先行：先增加失败测试，再实现最小改动；
6. 不做与当前 PR 无关的重构；
7. 每个 PR 描述必须包含：业务目标、范围、关键设计、迁移、测试证据、风险、回滚、不包含内容；
8. 数据库迁移必须可回滚或有清晰前向修复方案；
9. 所有新运行时配置有安全默认值；
10. 新功能默认不扩大生产成本，尤其是 Guest generation；
11. 每个 PR 合并前运行仓库标准的 format、lint、typecheck、unit、integration 和相关 Playwright；
12. 若规格和代码不一致，先在审计文档中说明，再请求决策，不静默改写财务或安全架构。

---

# 18. MVP Definition of Done

项目同时满足以下条件才称为 MVP 完成：

- 首页聚焦 AI Image Editor，关键词和产品承诺一致；
- 用户能上传、输入 Prompt、登录接力、报价并创建异步任务；
- 至少 Standard 路由通过真实基准；
- 任务、credits、Provider、存储和审核不变量通过；
- 用户能查看 Before/After、下载、Edit Again 和历史；
- Stripe 订阅闭环完成；
- 私有媒体和数据脱敏完成；
- GSC 与产品漏斗可用；
- 成本和毛利达到发布门槛；
- Staging、压力、恢复、关闭和回滚完成；
- 没有虚假 unlimited、uncensored、no-sign-up generation、4K、watermark-free 或 commercial-use 声明；
- 视频、公共画廊、批量、API、团队订阅和多语言未被误加入首版。

---

# 19. 上线后的 SEO 扩展规则

首页上线后，先用 GSC 验证：

- `ai image editor no restrictions`；
- `ai image editor with prompt no restrictions`；
- `ai image editor with prompt`；
- 用户真实出现的任务词。

只有以下条件满足才新增页面：

1. Query 持续有曝光；
2. 与核心产品相关；
3. 搜索意图独立；
4. SERP 与首页词簇明显不同；
5. 页面能提供独立工具体验或真实工作流，而不是换词复制首页。

优先纵向候选：

- remove object with AI prompt；
- replace image background with prompt；
- change color in image with AI；
- add object to image with AI；
- change lighting in photo with AI；
- edit product photo with prompt。

主词和产品留存未验证前，不横向扩视频或大规模模型页。

---

# 20. 外部参考

以下链接用于核对当前产品和模型能力，不替代真实基准：

- Raphael 首页：<https://raphael.app/>
- Raphael AI Image Editor：<https://raphael.app/ai-image-editor>
- Raphael Pricing：<https://raphael.app/pricing>
- Google Gemini 图片生成与编辑：<https://ai.google.dev/gemini-api/docs/image-generation>
- Google Gemini API Pricing：<https://ai.google.dev/gemini-api/docs/pricing>
- fal FLUX.2 Turbo Edit：<https://fal.ai/models/fal-ai/flux-2/turbo/edit>
- fal FLUX.1 Kontext Pro：<https://fal.ai/models/fal-ai/flux-pro/kontext>
- fal FLUX.1 Kontext Max：<https://fal.ai/models/fal-ai/flux-pro/kontext/max>
