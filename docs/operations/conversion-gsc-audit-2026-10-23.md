# EzImageAI 转化与 26 个 URL 核查

日期：2026-10-23。首次记录时改动尚在本地；下面的线上观测保留为改动前的基线，不是改动效果。后续首页素材恢复见“本次实现”，发布状态以对应提交的 CI 和部署记录为准。

## 数据来源与结论

- 使用已登录浏览器查看生产管理后台及 GSC，没有修改后台数据、提交收录请求或执行支付。
- 管理后台快照约在 19:49（Asia/Shanghai）加载，选择近 30 天注册客户、全部来源、全部设备，排除管理员。原始主内容见 [后台证据](evidence/conversion-admin-2026-10-23.json)。
- GSC 属性为 `sc-domain:ezimageai.com`。索引汇总报告最后更新 **2026-10-16**；原列表有 26 个“已发现，尚未编入索引”，最后抓取均为 N/A。本次逐一检查发生在 **10 月 23 日**，详情和时间见 [逐 URL 检查证据](evidence/gsc-indexing-2026-10-23.json)。
- 当前逐 URL 检查是 **3 已收录、13 已发现未收录、10 Google 未知**。这是不同时间和报告口径下的观察，不能继续把 26 个全部描述成当前未抓取，也不能把“未知”直接解释为刚被删除。
- 搜索查询不能证明访客没有购买意愿；浏览器统计也不能代替服务器交易记录。当前最明确的问题是首次生成成功率低，以及可关联的浏览器行为覆盖不足。

## 转化基线

| 指标                                             |      观测 |
| ------------------------------------------------ | --------: |
| 近 30 天注册客户                                 |        42 |
| 尝试过生成的客户                                 |        18 |
| 至少生成成功过一次的客户                         |         5 |
| 首次生成成功 / 失败                              |    3 / 15 |
| 首次成功率，分母为 18 次首次尝试                 |     16.7% |
| 购买点击客户 / 已创建结账单客户 / 已核实付款客户 | 0 / 0 / 0 |
| 注册客户中有浏览器事件的客户                     |         2 |
| 注册来源未知的客户                               |        39 |
| 已同意统计的浏览器标识 / 页面浏览次数            |   32 / 42 |
| 关联到服务端确认注册的浏览器                     |         1 |
| 无访客标识的匿名汇总页面访问次数                 |       107 |

失败原因共 23 个任务：输入图片内容审查未通过 17、服务商内容政策拒绝 5、生成超时 1。这是多次任务的计数，不是 15 名首次失败用户的一一分类；不能把这些都说成技术故障或放宽审核的理由。

匿名汇总访问来源：Google 40、直接 31、other 20、Bing 16。它们是页面浏览次数，不是独立用户。注册来源未知占比高，不能直接拿 GSC 点击数、匿名 PV 或浏览器标识数去除注册人数推断真实转化率。购买点击为零也可能受可选统计覆盖影响；持久化结账单与已核实付款是更强的交易证据，但这里的零值仍受所选注册批次和窗口约束。

业务总览显示 49 个注册用户、0 个有效订阅、近 30 天收入无记录。它与排除管理员的 42 人注册批次不是同一个分母。旧后台没有结果可见、下载及新老用户耗时表，因此这些指标不从空缺记录中推算。

## 26 个 URL 的逐条结果

表中的“引用页面”来自 GSC 的 URL Inspection。未知状态的条目同时显示没有引用 sitemap；这与当前公开 sitemap 已包含它们的事实应分开保留。

| #   | URL                                                                                   | 10 月 23 日逐 URL 状态 | GSC 引用页面                                              |
| --- | ------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------- |
| 1   | [/?lang=de](https://ezimageai.com/?lang=de)                                           | 已收录                 | /                                                         |
| 2   | [/?lang=es](https://ezimageai.com/?lang=es)                                           | 已收录                 | /                                                         |
| 3   | [/contact?lang=de](https://ezimageai.com/contact?lang=de)                             | Google 未知            | 未检测到                                                  |
| 4   | [/contact?lang=es](https://ezimageai.com/contact?lang=es)                             | 已发现，未收录         | /contact                                                  |
| 5   | [/contact?lang=fr](https://ezimageai.com/contact?lang=fr)                             | 已发现，未收录         | /contact                                                  |
| 6   | [/create?lang=de](https://ezimageai.com/create?lang=de)                               | 已发现，未收录         | /create                                                   |
| 7   | [/create?lang=es](https://ezimageai.com/create?lang=es)                               | 已发现，未收录         | /create                                                   |
| 8   | [/create?lang=fr](https://ezimageai.com/create?lang=fr)                               | 已发现，未收录         | /create                                                   |
| 9   | [/docs](https://ezimageai.com/docs)                                                   | 已发现，未收录         | /                                                         |
| 10  | [/docs/credits](https://ezimageai.com/docs/credits)                                   | 已发现，未收录         | /blog/private-image-editing-workflow                      |
| 11  | [/docs/image-editing](https://ezimageai.com/docs/image-editing)                       | 已发现，未收录         | /docs/support                                             |
| 12  | [/examples?lang=de](https://ezimageai.com/examples?lang=de)                           | Google 未知            | 未检测到                                                  |
| 13  | [/examples?lang=es](https://ezimageai.com/examples?lang=es)                           | Google 未知            | 未检测到                                                  |
| 14  | [/examples?lang=fr](https://ezimageai.com/examples?lang=fr)                           | 已发现，未收录         | 未检测到                                                  |
| 15  | [/image-to-image?lang=de](https://ezimageai.com/image-to-image?lang=de)               | 已发现，未收录         | /image-to-image?lang=fr；/image-to-image                  |
| 16  | [/image-to-image?lang=es](https://ezimageai.com/image-to-image?lang=es)               | 已发现，未收录         | /image-to-image?lang=fr；/image-to-image                  |
| 17  | [/image-to-image?lang=fr](https://ezimageai.com/image-to-image?lang=fr)               | 已收录                 | /image-to-image                                           |
| 18  | [/models](https://ezimageai.com/models)                                               | Google 未知            | 未检测到                                                  |
| 19  | [/models/gpt-image-1-5](https://ezimageai.com/models/gpt-image-1-5)                   | Google 未知            | 未检测到                                                  |
| 20  | [/models/gpt-image-2](https://ezimageai.com/models/gpt-image-2)                       | Google 未知            | 未检测到                                                  |
| 21  | [/models/gpt-image-2-5-flare](https://ezimageai.com/models/gpt-image-2-5-flare)       | Google 未知            | 未检测到                                                  |
| 22  | [/models/gpt-image-2-5-sunburst](https://ezimageai.com/models/gpt-image-2-5-sunburst) | Google 未知            | 未检测到                                                  |
| 23  | [/models/seedream-4](https://ezimageai.com/models/seedream-4)                         | Google 未知            | 未检测到                                                  |
| 24  | [/models/seedream-5-pro](https://ezimageai.com/models/seedream-5-pro)                 | Google 未知            | 未检测到                                                  |
| 25  | [/photo-to-coloring-page](https://ezimageai.com/photo-to-coloring-page)               | 已发现，未收录         | /blog/ai-image-editing-prompts                            |
| 26  | [/pricing](https://ezimageai.com/pricing)                                             | 已发现，未收录         | /pricing?lang=es；/pricing?plan=ultimate&interval=year；/ |

已收录的三页：

| URL                                                                     | GSC 显示的最后抓取时间    | 用户声明 canonical | Google 选择 canonical |
| ----------------------------------------------------------------------- | ------------------------- | ------------------ | --------------------- |
| [/?lang=de](https://ezimageai.com/?lang=de)                             | Oct 20, 2026, 11:45:36 PM | 自身 URL           | 检查的 URL            |
| [/?lang=es](https://ezimageai.com/?lang=es)                             | Oct 20, 2026, 9:53:07 PM  | 自身 URL           | 检查的 URL            |
| [/image-to-image?lang=fr](https://ezimageai.com/image-to-image?lang=fr) | Oct 20, 2026, 11:08:10 PM | 自身 URL           | 检查的 URL            |

上述时间保留 GSC 界面的原始显示，未擅自补充时区。三页均为 Googlebot smartphone、抓取成功、允许抓取且允许索引。西语首页的 Sitemaps 项单独显示 “Temporary processing error”，但页面本身已收录。其余 23 页的最后抓取、抓取代理、抓取结果及 canonical 均显示 N/A；N/A 不代表已确认禁止抓取。

## 当前页面技术检查

另用未登录的公开 HTTP 请求检查全部 26 个地址；这不是 GSC 的“测试实际网址”，也不能证明 Google 已经抓取了当前版本。

- 26 个地址最终均返回 200，均在当前 `/sitemap.xml` 内。
- 26 个地址均声明 `index, follow` 且 canonical 指向自身。
- 带 `lang` 的页面 HTML 语言与参数一致，均输出五条 hreflang（含 x-default）；英文独有的文档和模型页无需虚构翻译版本。
- [robots.txt 证据](evidence/robots-2026-10-23.json)允许这些公开路径，限制的是 API、管理员和私有业务路径。
- 西语首页第一次公开 HTTP 请求出现一次 fetch 连接错误；同一地址复查为 200。原错误保留在证据中，不能凭一次连接失败断言持续服务故障。
- 公开检查和逐 URL 详情分别保存在 [HTTP、canonical、robots、hreflang、sitemap 结果](evidence/gsc-public-checks-2026-10-23.json)及上面的 GSC 证据中。

这些结果未发现这 26 页统一的 HTTP、robots、noindex 或错误 canonical 阻断。真实翻译页面使用 `?lang=` 自规范 URL 是当前产品策略；不应批量 canonical 到英文或 noindex。抓取优先级、内容价值和站外发现仍可能影响收录，但现有证据不足以认定“权重低就是唯一原因”，也没有固定“收录位”可供这些页面争抢。

## 本次实现

1. 更正首页和定价权益文案：Free 可用当前可用的图片模型，包含 GPT Image 2、Seedream 5 Pro 等，前提是积分足够支付当前报价。明确每月 25 积分与一次性 5 积分登录奖励分开；新生成的账户积分图片无访客水印，目标保留 30 天。登录不会自动去掉旧访客图片的水印。
2. 失败反馈提供恢复说明入口；结算未完成时不提前承诺已退还积分。未更改审核、实际套餐额度、价格或模型准入。
3. 根据用户后续要求，首页恢复原有 12 张素材画廊、提示词选择和横向矢量比较图，撤回新增的人像对比。素材继续按示意内容标注；可核查的肖像输出保留在原文章中。原虚构工作流故事仍由具体编辑用途指南替代。
4. 独立 50/50 测试“年付默认 / 月付默认”和“结果原有操作 / 结果后的购买引导”。明确用户选择优先，曝光需要可见，只有同意可选统计的浏览器入组；统计失败不阻止购买。未同意统计时保留原体验。
5. 后台新增新老客户生成与结果活动、成功任务耗时、实验曝光与入口点击、后续结账按钮点击、结账创建、已核实支付及七天完整观察窗口转化率。关联不清或多浏览器账户不猜测支付归属。
6. 首页增加背景替换、80 年代肖像、照片转涂色页的具体用途入口；补充已有提示词文章的背景编辑步骤，并更新积分与图片编辑文档和内链。没有批量创建模型页或新 URL。

详细实验设计、财务证据、样本限制和停止方式见 [实验说明](conversion-experiments-2026-10-23.md)。结果页控制组没有新增引导按钮，其入口点击不能与有按钮组作胜负比较；应看两组共同的后续结账和核实支付。样本量小、可选统计覆盖和两个同时进行的实验之间的交互，都限制短期结论。

## 收录处理优先级

- **已收录三页**：保留正确的本地化 canonical/hreflang，无需为了旧报表重写索引策略。
- **高价值已发现页**：优先 `/photo-to-coloring-page`、`/pricing`、`/docs/image-editing`、`/docs/credits` 及编辑器相关入口。本次已有用途入口、真实案例、文档修正和上下文链接；发布后再核对 Google 抓取版本及报告更新时间。
- **模型集合与六个模型页**：当前公开页面和 sitemap 正常，而 Inspection 显示未知。保留该不一致的证据；后续以少量有实际输出、明确用途和独特比较信息的重点模型页验证收录，避免复制模板批量扩页。
- **Contact 与 Examples 本地化页**：页面技术声明正常，先保留；联系页收录优先级低于使用场景页，不能用它的未收录数衡量产品需求。
- 不因一份过期汇总报告停掉所有有效内容；不把搜索量、KD 或“20–40 个引用域”当成已验证的获客或首单承诺。

## 验证与边界

本地已完成受影响工作区类型检查、聚焦单元测试、真实组件的 A/B 浏览器夹具回归，以及现有私有结果预览稳定性回归；浏览器夹具不执行真实付款或付费生成。检查记录与本地报告路径见实验说明。

尚未 Git 发布、CI 验证或部署，生产实验尚未开始。本次不宣称转化、生成成功率、排名或收录已经因代码改动而提高。
