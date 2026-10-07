# Cloudflare 原生 Git 自动部署配置

在 Cloudflare 中，将现有的两个生产 Worker 连接到 GitHub 仓库 `Micmyw/ez-image-ai`。
连接完成后，每次推送 `main`，Cloudflare 都会自动构建并部署对应服务。应用列表会显示
关联的 GitHub 仓库，构建页面可以查看日志和对应提交。GitHub Actions 继续独立执行代码检查。

## 一、打开现有服务的 Git 配置

进入 Cloudflare 控制台的 **Workers 和 Pages**，点击要配置的现有服务，再进入
**设置 → 构建 → 连接 Git**。如果控制台显示英文，对应入口是
**Workers & Pages → Settings → Build → Connect Git**。

选择 GitHub 账户 `Micmyw` 和仓库 `ez-image-ai`。如果看不到这个私有仓库，需要在 GitHub
已安装的 Cloudflare 应用中，将 `ez-image-ai` 加入该应用可访问的仓库范围。

网站服务和后台任务服务都要各配置一次。两者的根目录均为 `/`，因为 pnpm 工作区、锁文件、
共享包和部署准备命令都位于仓库根目录。

## 二、填写构建和部署设置

| 配置项         | 网站服务                                                              | 后台任务服务                                                       |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 现有服务名称   | `ezimageai-site-production`                                           | `ezpic-workflows-workers-production`                               |
| GitHub 仓库    | `Micmyw/ez-image-ai`                                                  | `Micmyw/ez-image-ai`                                               |
| 生产分支       | `main`                                                                | `main`                                                             |
| 根目录         | `/`                                                                   | `/`                                                                |
| 构建命令       | `pnpm install --frozen-lockfile && pnpm cloudflare:git:build website` | `pnpm install --frozen-lockfile && pnpm cloudflare:git:build jobs` |
| 部署命令       | `pnpm cloudflare:git:deploy website`                                  | `pnpm cloudflare:git:deploy jobs`                                  |
| 非生产分支构建 | 关闭                                                                  | 关闭                                                               |

旧服务 `ezimageai-web-production` 和 `ezpic-workflows-production` 保留用于回滚，不连接此次
自动部署。后续发布会更新上表中的两个现有服务，每次发布的版本记录可在各服务的
**查看部署**页面中找到。

## 三、填写构建变量和机密

在两个服务各自的 **构建变量和机密** 中填写：

| 名称                                            | 类型     | 值或来源                                                           |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `NODE_VERSION`                                  | 普通变量 | `22`                                                               |
| `PNPM_VERSION`                                  | 普通变量 | `11.3.0`                                                           |
| `NEXT_PUBLIC_SITE_NAME`                         | 普通变量 | `EzImageAI`                                                        |
| `CLOUDFLARE_PRODUCTION_ENV`                     | 机密     | 短配置可直接使用 dotenv 全文；长配置使用下述命令生成的分段校验信息 |
| `CLOUDFLARE_PRODUCTION_ENV_PART_1` 至 `_PART_N` | 机密     | 长配置的各个分段，由下述命令生成                                   |

Cloudflare 单个构建变量最多接受 5,000 字符。生产配置超过这个限制时，在仓库根目录执行：

```powershell
pnpm cloudflare:git:secrets
```

命令默认读取 `.env.production.local`，将待写入的变量映射保存到被 Git 忽略的
`.wrangler/ci/build-variables.json`。也可以在命令后指定另一个经过核对的生产配置文件。
生成的每段最多 4,500 字符，全部标记为机密；主变量保存分段数量和完整性校验值。
构建会先还原原始 dotenv 内容并验证完整性，缺段或内容不匹配都会停止。

自动配置时，将生成的 JSON 作为 Cloudflare 构建变量 API 的请求体，分别写入两个服务：
`PATCH /accounts/{account_id}/builds/triggers/{trigger_uuid}/environment_variables`。
该文件含生产密钥，不属于可公开的配置示例。准备命令只生成文件，不修改 Cloudflare。

变量名称必须保持原样。生产环境配置含有密钥，只填入 Cloudflare 的机密输入框，不提交到
Git，也不粘贴到聊天中。构建变量与服务运行时变量是两套设置，仓库中的部署命令会根据上述
配置生成并应用对应的运行时机密文件。

Search Console 使用 DNS 验证时，`NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` 可以留空或不设置；
它只用于可选的 HTML 验证标签，不再作为生产就绪检查的必填项。`EZPIC_GSC_PROPERTY` 仍填写
实际资源标识，例如域名资源的 `sc-domain:ezimageai.com`。就绪检查不验证 Google 账号中的
所有权状态；DNS 记录及 Search Console 中的验证结果应单独确认。

部署令牌选择 Cloudflare 托管的构建 API 令牌，或选择已有且适用于当前生产账户的令牌。
Cloudflare 默认生成的令牌包含 Workers 脚本、Workers 路由、KV、R2 的编辑权限，以及账户和
用户的读取权限。后台任务部署还需要更新现有 Workflow 和使用 Hyperdrive 的相应权限。
此流程无需在 GitHub Actions 中配置部署令牌。

保存 Git 连接可能立即触发第一次构建。应先确认命令已推送到 `main`，并处理下文的生产配置
前置条件，再保存连接。之后每次推送 `main` 都由 Cloudflare 自动执行构建和部署。

## 四、命令会执行哪些操作

网站和任务服务的构建配置也支持一组明确的审核覆盖变量：
`MEDIA_SAFETY_ADAPTER=configured`、`MODERATION_TEXT_WAFFO_ENABLED=true`、
`MODERATION_TEXT_SIGHTENGINE_ENABLED=false`、`MODERATION_IMAGE_SEEAPI_ENABLED=true`、
`MODERATION_IMAGE_SIGHTENGINE_ENABLED=false`。这五项必须一起填写，作为普通构建变量即可；
`SEEAPI_API_KEY` 单独存为构建机密。构建会在校验原有生产机密分段之后应用这组配置，
保留其他生产配置，且拒绝缺项或关闭全部文字/图片检查的组合。两项服务都必须同步，
只改本地 `.env.production.local` 不会更新原生 Git 构建。

品牌名称也通过两个服务的普通构建变量 `NEXT_PUBLIC_SITE_NAME=EzImageAI` 同步。
构建会在校验机密分段后仅覆盖这一项，保留其他配置；未设置时继续使用原始环境包中的名称。
该值允许 1–100 个英文字母、数字、空格、点、下划线或连字符，必须以字母或数字开头，
且不能带首尾空白。Next.js 会在构建时将此名称编入页面标题和公开配置，因此更新变量后
必须重新构建网站；仅修改 Worker 运行时变量或本地环境文件不会更新已部署的标题。

视频回调配置支持三个独立的服务端构建机密：`KIE_WEBHOOK_SECRET`、
`VIDEO_SEEAPI_CALLBACK_SECRET` 和 `SEEAPI_WEBHOOK_SIGNING_KEYS`。在网站和后台两侧同步设置，
构建会在校验原有环境包后仅覆盖提供的项目，无需重写其他生产密钥。SeeAPI 签名配置是
`whkey_*` 到 `whsec_*` 的 JSON 映射；缺少 Key ID 时不能填写临时或猜测的 ID。
部分机密可以先保存，但不代表视频配置就绪，也不会打开 `VIDEO_V1_ENABLED`。
这些覆盖项不会进入公开构建变量，并会从 pnpm 构建子进程环境中移除。

运行时受 Cloudflare 的 128 个文字绑定上限约束。准备脚本不绑定已失效的 Kie 目录认证变量；
在 `configured` 模式下，关闭的审核开关使用默认的 `false`，且完全停用 Sightengine 时不绑定
其凭据。构建机密仍保留完整原值，审核启用状态不变，其他运行时变量照常保留。
Wrangler 版本上传会继续继承历史机密，`keep_bindings: []` 不能清除这些机密。自动部署先用
Worker `versions/latest` 的 JSON Merge Patch，将上述已停用绑定从最新版本中移除，得到一个
不接收流量的中间版本，并核对其他绑定都保留。随后将新代码和完整 `--secrets-file` 上传部署。
旧生产版本在切换前继续使用原始凭据。不要单独部署这个标注为 `do not deploy` 的中间版本，
也不要用即时生效的 `wrangler secret delete` 提前删除旧生产服务仍在使用的凭据。

准备脚本将 12 个图片模型 `MEDIA_*_ENABLED` 开关压缩为一个服务端
`MEDIA_IMAGE_MODEL_FLAGS` JSON 绑定，原始环境配置仍保留平铺格式。JSON 仅允许这
12 个原始变量名，值为字符串 `"true"` / `"false"`；不补齐缺失的必填项，三个可选模型
仍默认关闭。全局生成、审核、计费和游客控制不参与压缩。坏 JSON、未知键、错误值或与残留平铺
值冲突会拒绝发布校验并关闭运行时图片模型，不会回退为开启。部署只在新 JSON 实际存在且验证通过时，
从未部署的中间版本移除其明确覆盖的旧模型文本绑定。新代码兼容旧平铺格式；旧代码不识别 JSON，
所以站点和 jobs 各自的代码与绑定必须配套部署、配套回滚。

视频的非机密政策、模型合同版本、积分成本政策、登录账号范围、并发、时限和输出主机列表统一打包为
一个私有 `VIDEO_RUNTIME_CONFIG` JSON 文本绑定。只接受
`packages/config/video-runtime-environment.ts` 中的固定变量名和值为字符串的对象，UTF-8 总长度
最多 5,000 字节。普通视频参数依据已实现的 Kie 模型合同校验，没有用户 ID 或模型参数测试白名单。
旧政策中的 `VIDEO_V1_ALLOWED_USER_IDS` 和 `VIDEO_MODEL_ALLOWED_OPTIONS` 仅作为兼容字段读取，
不控制准入；标准打包会去掉它们。未知键、非字符串值、控制字符、超限载荷和有效政策字段的
打包/平铺同名不同值都会停止构建。
供应商、审核与回调密钥不参加打包，`VIDEO_WORKFLOW`、R2、Hyperdrive 等资源也不参加。

原始 dotenv 环境包可继续使用平铺格式，准备命令会为网站和后台生成相同的私有政策绑定；也可以在
两个 Git 构建中同步设置机密类型的 `VIDEO_RUNTIME_CONFIG`，仅覆盖环境包的同名政策对象。
环境包里仍存在的同名平铺值必须与 JSON 一致，不会静默覆盖。该配置及其展开字段不进入
`public-build.env`，也不会通过构建子进程环境泄漏到 Next.js 静态编译。

`VIDEO_V1_ENABLED` 始终保留独立平铺 Worker 变量，JSON 不允许包含它；缺失时为关闭。
构建默认采用权威 dotenv 环境包中的该开关，始终忽略外围构建环境偶然继承的同名值，设置政策或
回调密钥不会自动开放视频。需要在不重写旧机密环境包的情况下持续启用验收时，在两个 Git 构建中
显式设置专用普通构建变量 `VIDEO_V1_BUILD_ENABLED=true`，并在本次构建同时提供有效的私有
`VIDEO_RUNTIME_CONFIG` 覆盖。该 JSON 的 `VIDEO_MODEL_CONTRACT_VERSION` 必须精确匹配
当前代码的 `VIDEO_MODEL_CATALOG_VERSION`；不再要求模型白名单字段。

`VIDEO_V1_BUILD_ENABLED` 只接受精确字符串 `true` / `false`。`false` 可独立用于后续构建紧急
关闭，无需提供新政策；立即关闭也可以将两个 Worker 的独立 `VIDEO_V1_ENABLED`
变量设为 `false`，并同步构建控制，防止下一次发布恢复旧状态。构建在 dotenv 末尾仅追加目标
`VIDEO_V1_ENABLED`，随后核对其他字段原值及字段数未变。专用构建变量不进入政策 JSON、运行时
绑定或构建子进程环境。实际开放仍要求登录账号、支持的模型参数、价格、审核与其他准入条件全部满足。

`VIDEO_V1_BUILD_ACCESS=internal|authenticated` 只覆盖现有私有政策中的普通视频账号范围。
`authenticated` 允许所有已登录的非匿名账号，仍要求合格付费积分。缺失时保持原政策，非法值
拒绝构建；必须提供模型合同版本匹配的有效 `VIDEO_RUNTIME_CONFIG`。`internal` 仅保留管理员
回退范围，不恢复用户 ID 白名单。它不扩大 Hotel Lobby
或 Raindance 的独立权限，也不继承管理员测试资助。先发布后台，再发布网站。

价格依据更新时，同时设置 `VIDEO_V1_BUILD_PRICE_VERSION` 和 `VIDEO_V1_BUILD_PRICE_BASIS`。
版本必须精确匹配当前代码的供应商价格版本；依据作为补充附加到现有完整费用依据，保持现有
成本、积分算法和模型合同。构建先核对原批准版本和非空费用依据，普通视频
`VIDEO_PRICE_VALID_UNTIL` 可以是有限日期或精确字符串 `none`。有限日期必须有效且未到期，
除非本次明确使用下面的取消期限控制；不自动延期。只记录批准版本和期限，不打印私有政策。
两个构建目标须使用相同控制值；这些构建控制不进入浏览器、子进程或 Worker 运行时绑定。

本次授权普通视频取消固定价格批准日期：两个构建目标同时设置
`VIDEO_V1_BUILD_PRICE_EXPIRY=none`，仅将普通 `VIDEO_PRICE_VALID_UNTIL` 改为 `none`。
该控制只接受精确字符串 `none`，可配合上述供应商价格依据迁移；必须有有效私有政策、
已知批准版本和非空完整费用依据。未设置时保持原期限，旧有限期限已到期则继续拒绝；
不打印私有政策，不改变费用项、积分算法或 Hotel Lobby/Raindance 的有限价格批准。
十分钟报价有效期继续保留，已接受任务的有限期限不会改写；供应商价格版本、合同和费用校验仍须通过。
参见[普通视频开放与回滚](video-authenticated-rollout-2026-10-07.md)。

部署暂存只移除新 JSON 明确覆盖的旧视频平铺文本绑定；现存可打包字段既不保留为平铺、又未包含在
新 JSON 时，在任何 PATCH 前拒绝发布，防止 Wrangler 继承旧配置造成冲突。不要部署此暂存版本。
网站入口和后台原生 Workflow/恢复入口在读取业务配置前展开同一套规则；运行时解析失败会清除残留
政策并关闭视频准入，不以旧配置继续生成。回滚必须同时恢复代码和匹配的绑定格式；旧代码无法解释
该 JSON。配置、构建或部署成功均不等于真实生成、审核、转存及结算已验收。

- 仅接受 `workers` 部署模式。在 Cloudflare 中检查 `WORKERS_CI_BRANCH=main`，并确认检出的
  提交与 `WORKERS_CI_COMMIT_SHA` 一致。
- 复用现有生产环境准备流程，保留功能开关和资源绑定。
- 生成 Node 和 Workers 使用的 Prisma 客户端，通过验证 TLS 的连接执行只读
  `prisma migrate status`。待执行的数据库迁移需要单独处理，构建过程不修改数据库结构。
- 在 Linux 环境通过项目的 OpenNext 构建入口打包网站。网站构建子进程只接收允许公开的
  配置，以及占位的数据库、认证和邮件值，不继承生产配置全文、任何机密分段或 Cloudflare API 令牌。
  同时移除 OpenNext 内嵌的 dotenv 回退配置。
- 网站发布前先填充远程 R2 缓存；使用生成的机密文件部署对应服务，并将当前提交 SHA 作为
  版本标签。
- 检查线上版本标签和 100% 流量归属。网站还会检查 `/api/health`、`/`、`/docs`、`/create`
  是否返回 HTTP 200。

两个服务的原生构建独立运行，没有保证的先后顺序，也不是一次共同成功或失败的操作。
如果一个成功、另一个失败，应修复错误后重试同一提交，并确保这段时间内网站和后台任务
能够兼容。混合模式切换和回滚方式见[部署模式操作说明](cloudflare-workers-profiles.md)。

## 五、模型可用性与发布检查

### 游客每日两次额度（2026-09-21）

先通过 Prisma 应用 `20260921092212_guest_daily_allowance`，再发布新消费者。
迁移将游客活动期唯一约束替换为每日查询索引；原始草稿、bootstrap、幂等请求及任务唯一约束保留。
网站与后台 Worker 的原生 Git 构建同时设置以下非机密变量，每项均为 `2`：

- `GUEST_SESSION_MAX_ACCEPTED_PER_DAY`
- `GUEST_DEVICE_MAX_ACCEPTED_PER_DAY`
- `GUEST_IP_MAX_PER_10_MINUTES`

构建入口将这三项覆盖到现有环境包，不需要重写机密分段。新的每日配置替代旧的
`GUEST_SESSION_MAX_ACCEPTED_TRIALS` 和 `GUEST_DEVICE_MAX_ACCEPTED_PER_PROMOTION`。
每日按 UTC 00:00（北京时间 08:00）重置，不累积；每次仍代付 5 积分。
并发上限仍为每游客/设备 1 个任务；每日次数与全站成本预算、全局流量、IP 每日及子网限制分别生效。
回滚旧代码会恢复每活动期最多一次的应用限制；已有多次试用记录必须保留，不能重建旧唯一索引。

用户批准调整全站游客成本预算后，可在两个原生构建中同步设置普通变量
`GUEST_RISK_BUDGET_MICROS`（例如 `200000` 表示本轮总预算 $0.20）。构建只覆盖这一项，
并要求其为正整数且不超过原始环境包里的 `GUEST_HARD_BUDGET_MICROS`。
同时更新本地生产环境文件；已有 `guest_risk_budget_bucket` 还会独立限制额度，需在
`guest-promotion:<promotionPeriod>` 事务锁下调整其 `hardLimitMicros` 并追加审计记录。
保留 `reservedMicros`、`consumedMicros` 和过期时间，不清空历史消费或更换活动标识来绕过限制。
此预算不是每天自动发放的用户积分，也不因每日两次额度刷新而自动重置。

### 游客共享预算无上限（2026-09-21）

用户明确批准无上限后，先应用 `20260921112500_guest_unlimited_budget`，使数据库预算列允许
`NULL`。这项迁移不改变已有额度、预留或消费记录。游客专用数据表继续只由 Prisma 管理，
不扩展目前仅维护认证字段的 Drizzle 替代实现。

在本地生产环境及两个原生 Git 构建中，同时设置 `GUEST_RISK_BUDGET_MICROS=unlimited`
和 `GUEST_HARD_BUDGET_MICROS=unlimited`。构建只允许两项一起显式覆盖；空值、`0`、
`Infinity`、缺项均不表示无上限。无需更换机密、活动标识或新增 Worker 绑定。

确认网站和后台均已发布支持无上限的同一提交后，在原有
`guest-promotion:<promotionPeriod>` 事务锁下，将当前 global bucket 的 `hardLimitMicros`
改为 `NULL` 并追加审计。保留预留、消费、版本递增和过期时间。配置与数据库任一侧仍有
有限预算时，取仍然存在的较小上限，不自动解除旧数据库上限。

无上限取消游客累计成本阈值产生的减速、拒绝和自动关闭；同时不再把全站
`MEDIA_DAILY_PROVIDER_COST_BUDGET_MICROS` 作为此游客活动的提交门槛。已注册用户的
每日成本门槛不变。成本预留和结算、报价上限、每日两次额度、IP/全局流量限制、单任务并发、
验证码、审核、清理和账单异常监控继续生效。后台显示“无花费上限”，使用率返回 `null`。
用户要求的第二次免费排队方案仍独立于此配置，本文不启用该方案。

回退有限预算时，先选取高于已预留加已消费金额的有效上限，再在同样的锁下恢复数据库
额度并同步两项环境值。不要直接回滚到不识别 `NULL` 的旧代码；不得通过清空账本回退。
正式发布认证中的供应商硬限额证明仍按实记录；无上限不构成该外部证明。

2026 年 9 月 14 日按用户要求移除目录认证版本硬门槛。发布、模型目录、生产配置检查和
任务调度都不再读取 `MEDIA_KIE_IMAGE_CERTIFIED_CATALOG_VERSIONS`。现有构建机密中的旧值
会被忽略，无需为了目录升级同步认证版本，也不再触发 `PRODUCTION_CATALOG_NOT_CERTIFIED`。

模型可用性由生成总开关、各模型开关、数据库运行时开关、已配置的供应商和任务路由决定。
任务执行继续检查供应商凭据、输入参数、报价快照和成本上限，并沿用审核、私有存储、
积分预留/结算和恢复流程。目录与价格版本仍用于冻结报价及历史任务。

发布继续检查目标分支/提交、部署模式、必要配置、数据库 TLS 和迁移状态，以及部署后的
版本与健康接口。真实生图、质量和计费记录可按[AI 生图运行手册](ai-media-runbook.md)
单独核对，不再作为目录升级的发布条件。最初的失败记录保存在
[9 月 14 日构建排查](evidence/cloudflare-text-catalog-block-2026-09-14.md)。

官方参考：[Cloudflare Workers 构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。
