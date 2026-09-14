# 2026-09-14：Kie 图片模型接口核对

## 范围

对目录 `2026-09-13.1` 的 12 个图片模型、29 档输出逐项核对 Kie 当日官方 OpenAPI。
价格版本保留 `2026-09-13.2`；没有替换模型或修改既有积分价格。下面是服务器内部接口表，
供应商标识、密钥、图片传输 URL 和供应商成本不会进入公共模型列表。

所有图片请求都使用 `POST https://api.kie.ai/api/v1/jobs/createTask`，并通过
`GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=...` 查询持久化的同一任务。
来源索引为 <https://docs.kie.ai/llms.txt>。图片必经既有私有资产、报价、积分预留、Outbox、
审核、结果入库和幂等结算流程。

## 模型与参数

| 前台模型               | Kie `model`                             | 图片字段      | 输出参数                                                           | 官方文档                                                                         |
| ---------------------- | --------------------------------------- | ------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Nano Banana 2 Lite     | `nano-banana-2-lite`                    | `image_urls`  | 固定 1K，无独立分辨率字段                                          | [接口](https://docs.kie.ai/market/google/nano-banana-2-lite)                     |
| Nano Banana            | `google/nano-banana-edit`               | `image_urls`  | `output_format=png/jpeg`                                           | [编辑接口](https://docs.kie.ai/market/google/nano-banana-edit)                   |
| Nano Banana 2          | `nano-banana-2`                         | `image_input` | `resolution=1K/2K/4K`，`output_format=png/jpg`                     | [接口](https://docs.kie.ai/market/google/nanobanana2)                            |
| Nano Banana Pro        | `nano-banana-pro`                       | `image_input` | `resolution=1K/2K/4K`，`output_format=png/jpg`                     | [接口](https://docs.kie.ai/market/google/pro-image-to-image)                     |
| GPT Image 1.5          | `gpt-image/1.5-image-to-image`          | `input_urls`  | `quality=medium/high`                                              | [编辑接口](https://docs.kie.ai/market/gpt-image/1-5-image-to-image)              |
| GPT Image 2            | `gpt-image-2-image-to-image`            | `input_urls`  | `resolution=1K/2K/4K`；背景仅支持 1K                               | [编辑接口](https://docs.kie.ai/market/gpt/gpt-image-2-image-to-image)            |
| GPT Image 2.5 Flare    | `gpt-image-2-5-flare-image-to-image`    | `input_urls`  | `resolution=1K/2K/4K`，`background`                                | [编辑接口](https://docs.kie.ai/market/gpt/gpt-image-2-5-flare-image-to-image)    |
| GPT Image 2.5 Sunburst | `gpt-image-2-5-sunburst-image-to-image` | `input_urls`  | `resolution=1K/2K/4K`，`background`                                | [编辑接口](https://docs.kie.ai/market/gpt/gpt-image-2-5-sunburst-image-to-image) |
| Seedream 4.0           | `bytedance/seedream-v4-edit`            | `image_urls`  | `image_resolution=1K/2K/4K`，`max_images=1`                        | [编辑接口](https://docs.kie.ai/market/seedream/seedream-v4-edit)                 |
| Seedream 4.5           | `seedream/4.5-edit`                     | `image_urls`  | `quality=basic` 对应 2K；`high` 对应 4K                            | [编辑接口](https://docs.kie.ai/market/seedream/4-5-edit)                         |
| Seedream 5 Lite        | `seedream/5-lite-image-to-image`        | `image_urls`  | `quality=basic/high/ultra` 对应 2K/3K/4K；`output_format=png/jpeg` | [编辑接口](https://docs.kie.ai/market/seedream-5-lite-image-to-image)            |
| Seedream 5 Pro         | `seedream/5-pro-image-to-image`         | `image_urls`  | `quality=basic/high` 对应 1K/2K；`output_format=png/jpeg`          | [编辑接口](https://docs.kie.ai/market/seedream/5-pro-image-to-image)             |

前台 JPEG 选项按接口分别映射为 `jpeg` 或 `jpg`。Seedream 4.0 的比例使用 `image_size`
枚举，例如 16:9 为 `landscape_16_9`，9:16 为 `portrait_16_9`；其他模型使用 `aspect_ratio`。

## 修正与回归证据

- 模型标识和图片字段均与官方接口一致。报价快照、SKU 路由和静态任务清单逐项匹配；错误模型与
  SKU 的交叉组合会在发出请求前被拒绝。
- Nano Banana 移除官方未声明的 `nsfw_checker` 参数。既有独立内容审核保持启用。
- Nano Banana／Seedream 4.0／Seedream 5 Pro 上限为 5,000 字符；Seedream 4.5／5 Lite 为
  3,000。Seedream 5 Lite／Pro 下限为三字符。其他模型沿用产品 10,000 字符上限，未把 Kie
  部分接口的 20,000 上限扩大到整个产品。
- 供应商边界复用公共选择规则，拒绝非法比例、格式、背景和强度参数。GPT Image 2 高分辨率
  禁止 `auto`，4K 禁止 1:1，背景仅在 1K 传递。GPT 2.5 的四个特殊比例仅限 1K。
- Sunburst 在 2K／4K 选择透明背景时，按官方要求追加主体提取、无背景／场景／阴影的指令，
  保留原始用户提示词和选定模型。该参数不能保证每次生成都完美遵循指令。

官方字段、枚举、原文限制、来源 URL 与文档 SHA-256 固定在
`packages/ai/media/providers/fixtures/kie-official-image-contracts-2026-09-14.json`。
`kie-official-contracts.test.ts` 初次有效回归运行 26 失败、13 通过；修正后 39 项全部通过。
另有 API 报价检查，验证全部 29 档输出冻结正确模型和单张图片结算规则。

## 发布与实测边界

生产仍要求逐模型开关与明确的目录版本配置。旧的四模型兼容规则不扩大到其他模型或未来目录。
本记录证明官方接口对应关系与本地请求逻辑；独立真实任务结果保存在受忽略保护的
`output/kie-model-audit/`，不把模拟响应当成真实生图、账单或上线验收证据。
供应商查询可能不返回实际费用，目录成本与应用积分结算不能替代供应商账单。
