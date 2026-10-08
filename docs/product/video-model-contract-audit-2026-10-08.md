# 视频模型合同复核：2026-10-08

后续同日档位实现新增显式 Veo Lite/Fast/Quality 合同及真实 Seedance 2、Kling 3 变体控件。Veo 使用当前统一端点的 `input.model`，新 1080p/4K 从冻结结果合同的 `data.result_urls` 读取，低分辨率原片不能代替交付结果。新的模型/价格版本、利润计算与先后台后网站发布顺序见[档位价格与兼容依据](../operations/video-v1-price-basis-2026-10-08.md)。下文首次审计中“本轮不改生产绑定”描述的是先前 UI 修正；此次档位增加按明确授权更新已知版本，旧任务不改写。

本次只读取得 16 份 Kie 官方 Markdown 文档，均返回 HTTP 200；没有购买生成、调用付费模型或读取生产密钥。当前 OpenAPI 请求结构及原始 Markdown SHA-256 记录在 `packages/ai/media/catalog/fixtures/kie-video-model-contracts-2026-10-08.json`，旧 `2026-10-04` fixture 保留为历史证据。新 fixture 删除示例和文档工具元数据，保留类型、必需字段、枚举、边界及说明；顶层 `durationEvidence` 独立记录 16 份来源的固定秒数集合/整数步长及保守应用子集，`conflicts` 记录正文与 schema 的未解矛盾。当前文档不是供应商账单或付费端到端验收。

## 范围与来源

范围是应用已实现的文字生成及单首帧图片生成。秒数区间均为整数步长 1；`5 / 10` 等枚举不代表中间秒数可用。图例：横竖 = 16:9、9:16；常规 = 横竖、1:1；扩展 = 常规、4:3、3:4、21:9；首帧 = 由参考图确定。表中的 prompt 上限是官方说明；应用还执行下节的更保守限制。

| 应用型号                      | 官方模型 ID 与来源                                                                                                                                                                                        | 输入 / 秒数 / 分辨率                                 | 画幅与声音                                                 | 官方 prompt                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- | -------------------------- |
| MiniMax H3                    | `minimax-h3/text-to-video` / `minimax-h3/image-to-video`；[文字](https://docs.kie.ai/market/minimax-h3/text-to-video.md)、[图片](https://docs.kie.ai/market/minimax-h3/image-to-video.md)                 | 文字、单图；4–15；768P / 2K                          | 文字扩展，图片首帧；原生音频，无关闭参数                   | 1–7,000                    |
| Seedance 2.5                  | `bytedance/seedance-2-5`；[官方文档](https://docs.kie.ai/market/bytedance/seedance-2-5.md)                                                                                                                | 文字、单图；4–30；480p / 720p / 1080p                | 扩展；图片另有 adaptive；可开关音频                        | 最大 20,480；未列最小值    |
| Seedance 2 Mini               | `bytedance/seedance-2-mini`；[官方文档](https://docs.kie.ai/market/bytedance/seedance-2-mini.md)                                                                                                          | 文字、单图；4–15；480p / 720p                        | 扩展；图片另有 adaptive；可开关音频                        | 3–20,000                   |
| Seedance 1 Pro Fast           | `bytedance/v1-pro-fast-image-to-video`；[官方文档](https://docs.kie.ai/market/bytedance/v1-pro-fast-image-to-video.md)                                                                                    | 仅单图；5 / 10；720p / 1080p                         | 首帧；静音                                                 | 最大 10,000；未列最小值    |
| Seedance 1.5 Pro              | `bytedance/seedance-1.5-pro`；[官方文档](https://docs.kie.ai/market/bytedance/seedance-1-5-pro.md)                                                                                                        | 文字、单图；4–12；480p / 720p / 1080p                | 扩展；可开关音频                                           | 3–20,000                   |
| Seedance 2                    | `bytedance/seedance-2`；[官方文档](https://docs.kie.ai/market/bytedance/seedance-2.md)                                                                                                                    | 文字、单图；4–15；480p / 720p / 1080p / 4K           | 扩展；图片另有 adaptive；可开关音频                        | 3–20,000                   |
| Seedance 2 Fast               | `bytedance/seedance-2-fast`；[官方文档](https://docs.kie.ai/market/bytedance/seedance-2-fast.md)                                                                                                          | 文字、单图；4–15；480p / 720p                        | 扩展；图片另有 adaptive；可开关音频                        | 3–20,000                   |
| Gemini Omni 1.1 Flash         | `google/gemini-omni-flash-1-1`；[官方文档](https://docs.kie.ai/market/google/gemini-omni-flash-1-1.md)                                                                                                    | 文字、单图；4 / 6 / 8 / 10；360p / 720p / 1080p / 4K | 横竖；原生音频                                             | 最大 20,000；未列最小值    |
| Kling 3                       | `kling-3.0/video`；[官方文档](https://docs.kie.ai/market/kling/kling-3-0.md)                                                                                                                              | 文字、单图；3–15；std=720p / pro=1080p / 4K          | 文字常规，图片首帧；可开关音频；应用固定 multi_shots=false | 单镜头必须提供；最大 2,500 |
| Kling 3 Turbo                 | `kling/v3-turbo-text-to-video` / `kling/v3-turbo-image-to-video`；[文字](https://docs.kie.ai/market/kling/v3-turbo-text-to-video.md)、[图片](https://docs.kie.ai/market/kling/v3-turbo-image-to-video.md) | 文字、单图；3–15；720p / 1080p                       | 文字常规，图片首帧；原生音频                               | 最大 2,500                 |
| Kling 2.6                     | `kling-2.6/text-to-video` / `kling-2.6/image-to-video`；[文字](https://docs.kie.ai/market/kling/text-to-video.md)、[图片](https://docs.kie.ai/market/kling/image-to-video.md)                             | 文字、单图；5 / 10；接口默认分辨率，无选择参数       | 文字常规，图片首帧；可开关音频                             | 最大 2,500                 |
| Veo 3.1 Fast                  | `veo3_fast`，专用 `/api/v1/veo/generate`；[现存旧端点文档](https://docs.kie.ai/old-model/veo3-api/generate-veo-3-video.md)                                                                                | 文字、单图；4 / 6 / 8；720p / 1080p / 4K             | 横竖；图片可 Auto 中心裁切；原生音频                       | 必须提供；未列数字上限     |
| Veo 3.1 Lite / Fast / Quality | `veo-3-1`，通用 createTask；[统一端点文档](https://docs.kie.ai/veo3-api/generate-veo-3-video.md)                                                                                                          | 文档为文字、单图；4 / 6 / 8；720p / 1080p / 4K       | 横竖；图片可 Auto；原生音频                                | 必须提供；未列数字上限     |

MiniMax H3 Turbo、H3 Max Turbo、H3 Max 继续因缺少确认的官方模型合同而禁用；Veo 3.1 Pro 继续因变体映射未确认而禁用。没有根据竞品名称推断可调用 ID。

## 确认差异与应用边界

1. **Seedance 2.5 证据更正。** 旧 fixture 为 30,000 字符，当前官方为 20,480；更新来源 fixture 和模型声明。原 4–30 秒及三个分辨率正确，无需缩到旧代模型范围。Mini 4–15 秒和 480p / 720p 同样已确认。
2. **Kling 3 首帧比例。** 官方明确图生输出跟随第一帧。新公共能力只提供 `source`，请求不传 `aspect_ratio` override。旧实现提供 16:9 / 9:16 / 1:1 会误导用户，并可能让后续输出比例检查要求错误裁切。
3. **双重文字限制。** Kling 2.6 和 Kling 3 的应用上限仍为 1,000 code points，虽低于官方 2,500，也不在本轮放宽。模型官方上限超过 10,000 的，应用上限仍为 10,000 code points，且所有请求须满足现行审核系统的 **10,000 UTF-16 单元**硬上限。此前 UI 只按 code points 计数，6,000 个常见 emoji 显示 6,000 却实际占 12,000 单元；现在本地校验和反馈明确两个限制。Veo 的 1,000 是应用限制，不宣称为官方上限。没有明确官方下限的型号仍要求非空描述。
4. **时长摘要。** Kling 2.6 / Seedance 1 Pro Fast 显示 5 / 10 秒，Gemini 为 4 / 6 / 8 / 10，Veo 为 4 / 6 / 8；只有完整连续整数集合显示区间。
5. **未开放的能力。** Seedance 文档允许 `-1` 自动时长，应用继续仅接受已知秒数，以便精确计费与输出校验。自适应文字比例、参考视频、多图、尾帧、多镜头、搜索及编辑等未因本次审计扩大。数量保持一次一个结果，无新增批量输出控制。原生音频表示允许音轨，不保证每条结果一定含音频。
6. **条件边界。** 在本次文字/单首帧范围内，未发现额外时长×分辨率限制。Gemini 使用视频输入时 duration 会被模型忽略；Veo REFERENCE_2_VIDEO 只支持 8 秒；二者均不属于当前输入范围。Seedance 2 的 4K 官方注明 HEVC，实际解码/私有输出检查仍属于原有交付门禁，不因文档复核被绕过。

## 已接受任务、旧报价与未来激活

### 未确认：Kling 3 Pro 正方形实际输出像素

[同一份官方文档](https://docs.kie.ai/market/kling/kling-3-0.md)的 Pro Mode 正文分辨率表，1:1 行写 **1440×1440**（本次原文第 95 行）；OpenAPI `input.mode.description` 的 pro/1:1 映射却写 **1080×1080**（第 498 行）。原文 SHA-256 为 `5c94e307ab992912d00dfc95bf254fb3d982cb31266833f82506df47e6683f10`。两处均支持相同 `mode=pro`（应用 1080p）+ `aspect_ratio=1:1` 参数组合，矛盾仅涉及实际生成像素。

现有 `packages/config/video-output.ts` 将 Kling 3 1080p + 1:1 分类为 `DOCUMENTED` 并严格要求 1080×1080；该内部标签不代表此次已完成供应商消歧。若供应商遵循正文返回 1440×1440，既有检查会返回 `VIDEO_RESOLUTION_MISMATCH`，结果可能无法交付。此像素映射应明确标为**供应商实际未核实**，不能用本次请求参数测试通过来证明输出尺寸已确认。

本轮保留既有可选参数、价格、冻结订单和严格输出校验；不猜测哪处文档正确、不接受额外像素尺寸、不降级验证，也不做付费消歧。fixture 保存两处位置、数值和现有风险，回归要求矛盾保持可见。后续需供应商澄清或另行授权的输出验证后，再独立决定输出合同调整。

### 已接受任务与无定价路由

新报价及新 admission 使用严格当前 schema。历史 Kling 3 图生回执仅在专用 receipt parser 中保留已知旧比例；owner、完整请求指纹、幂等键和数据库快照仍须匹配。RPC → admission → DB 先检查已接受任务，原请求可在报价过期或新生成关闭后恢复；换比例会发生幂等冲突，新幂等键不会绕过当前能力校验。provider builder 读取冻结请求，保留老订单原本的请求语义，不悄悄重写比例。没有迁移或修改已有订单。

历史确认若从未被接受，当前准入明确返回 `VIDEO_MODEL_OPTION_UNAVAILABLE` 后，前端清除该确认及其持久化回执、刷新目录，并把可编辑草稿规范到当前合法参数（Kling 3 图生为 `source`）。描述和图生意图保留；刷新恢复而未在当前上传流程封存的参考图必须重选，随后由用户取得新报价和新幂等键。仅识别准确拒绝码，未知网络响应或已接受任务恢复不会提前清回执或重写原请求。

未接受的旧 Kling explicit-ratio quote 不再获得新 admission，用户需按首帧比例重新报价。保留当前 `video-models-2026-10-04.2` 生产合同绑定：本轮收窄选择且不改价格，改绑定会使现有确认的生产配置整体失效，超出此次 UI/合同修正授权。

**通用 Veo 后续激活合同。** 初次审计所列无价格、缺 `input.model` 和高分辨率解析缺口，已在本次档位实现中补齐：顶层 `veo-3-1`，Lite/Fast/Quality 分别绑定 `veo3_lite`/`veo3_fast`/`veo3`；覆盖 4/6/8 秒、720p/1080p/4K、文字和单首帧的 54 报价组合。引用结果必须符合冻结任务 ID、模型/档位和分辨率上下文；1080p/4K 不回退 `origin_urls`。新任务还冻结 **APP_MINIMUM** 应用最小短边 720/1080/2160，包括 Auto/source；这不是供应商精确像素的付费验收。缺 tier 的旧 generic 请求保留历史默认 Fast 语义，原专用 Fast adapter、端点和报价不重解释。部署须先完成消费兼容阶段并确认后台完全切换，才可发布新版价格和 UI；本文件不声称已经上线或完成付费生成。

### 未扩大修复范围的独立风险

完整来源复核另确认 MiniMax 图生每边 256–5760、比例 0.4–2.5 的输入 gate 缺口，本次仅列出并未实现；不得据此声称所有输入约束已闭环。多数型号精确输出像素和音频行为仍缺实际验证；Kling Pro 正方形矛盾及严格旧校验保持不变。区域价格资格、账单、支付费实际分摊及供应商成功但被应用拒绝的收费归属也未因 mock/本地数据库测试获得确认。

## 价格与品牌来源

价格预览直接使用受保护 catalog 的精确 `credits` 字符串，按型号、输入、秒数、分辨率和声音匹配；画幅无独立费率。不使用竞品积分、客户端公式或伪造提示词，也不为预览创建 quote。实际 Generate 使用当前后端 quote；与已显示总额不同须重新明确确认。生产价格、费用预算、资费开关和审核要求均未调整。

品牌 SVG 来自 MIT 的 `@lobehub/icons-static-svg@1.95.1`，registry tarball SHA-512 已由控制线程校验；原 SVG 字节未修改，原色保留。许可证、下载 URL、哈希及映射见 `apps/saas/public/images/model-logos/VIDEO-SOURCES.md` 与 `LICENSE.lobe-icons`。Seedance 使用 ByteDance 厂牌，Veo 使用 Google 厂牌；不虚构模型专属标识。渲染复用 ImageModelIcon 的品牌组件，按钮仍有完整可访问名称。

## 验证方式与限制

单元合同测试将共享 catalog 的每种模式、时长、分辨率、画幅和声音组合送入实际 provider builder，对当前 fixture 的 ID、字段枚举和声明边界逐项检查。时长期望另从 16 份官方 enum/说明文字独立转录，未用应用 `getVideoModelOptions` 生成；测试逐型号/模式比较完整秒数集合，并拒绝范围外、离散缺口、非整数及未开放自动秒数。Kling Turbo 的 1 秒步长是对正文 3–15 秒范围的保守整数选择，不声称已证实供应商拒绝所有小数时长。另验证默认/历史 Kling 比例、prompt 限制及未解像素矛盾与现有严格校验。真实隔离 PostgreSQL 集成验证旧回执通过 protected RPC 重复恢复、不可变快照、单次预留及新请求拒绝。

浏览器回归拦截所有外部域及非 fixture API，只使用合成账户和测试积分。截图中的 23 / 29 / 37 / 41 / 57 credits 不能作为线上售价证据。完整生产构建、首页原有性能预算及其余数据库验收由控制线程在最终提交上执行。没有真实付费视频或供应商输出质量验收。
