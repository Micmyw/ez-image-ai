# 本地 Google Search Console 工具

官方 GSC API → 每日 JSON 快照 → 本地 SEO 报告 → CLI / MCP。此包独立运行，不进入网站构建、业务数据库或 Cloudflare Worker。

## 快速使用

在仓库根目录执行：

```powershell
pnpm gsc status
pnpm gsc sites
pnpm gsc daily --site ezimageai
pnpm gsc report --site ezimageai --days 28 --markdown
pnpm gsc report --site ezimageai --min-impressions 20 --limit 30 --markdown
pnpm gsc query --site ezimageai --start 2026-10-14 --end 2026-11-10 --query 'image editor' --non-brand
pnpm gsc inspect --site ezimageai --url https://ezimageai.com/
```

`report` / `query` 读取本地缓存；`sites` / `sync` / `inspect` 调用 Google。`daily` 同步最近 56 个有完整日期窗口的数据日，重新抓取最近 7 天，然后保存最近 28 天与此前 28 天的对比报告。报告与明细包含网站私有分析数据，不要提交到 Git。

默认目录是 `~/.gsc-seo`，可用 `GSC_HOME` 覆盖；`GSC_CONFIG` 可单独指定配置文件。配置保存允许读取的站点、品牌词、凭据路径和数据目录。凭据不通过 MCP 返回，也不写入仓库、日志或 Codex MCP 参数。

## 首次授权

1. 在已有 Google Cloud 项目启用 **Google Search Console API** (`searchconsole.googleapis.com`)。
2. 创建一个独立的 **Desktop app** OAuth 客户端。不要改网站登录客户端的 ID、密钥或重定向 URI。
3. 下载客户端 JSON 到本地私有目录。OAuth 的品牌与发布状态在同一 Cloud 项目内共享；切换状态前检查影响。
4. 只申请 `https://www.googleapis.com/auth/webmasters.readonly`。运行下方命令，在 Chrome 打开终端返回的 Google 授权地址。回调仅监听本机 `127.0.0.1`，使用随机端口、PKCE 和 state 校验；8 分钟内未完成会关闭。

```powershell
pnpm gsc authorize --oauth-client ABSOLUTE_DESKTOP_CLIENT_JSON --credentials ABSOLUTE_TOKEN_JSON
pnpm gsc configure --site ezimageai --property sc-domain:ezimageai.com --credentials ABSOLUTE_TOKEN_JSON --brand 'ezimage,ez image,ezpic,ez pic'
pnpm gsc sites
pnpm gsc daily --site ezimageai
```

外部应用的 **Testing** 模式下，GSC refresh token 通常只有 7 天有效期；切换到 **In production** 后重新授权，才应以新授权作为长期同步依据。正式状态不等于 Google 已完成品牌/敏感权限验证，个人使用可能仍出现未验证提示；它也不保证 token 永不过期。撤销授权、账号策略或 Google 风控可能要求重新授权。使用已有的 Desktop 客户端重新运行 `authorize` 即可。

Google 的用户 OAuth 只读 scope 并不限制到单个站点；其理论权限覆盖该账号有权访问的 GSC 资源。本工具通过配置限制查询和返回的站点，目前仅允许 `sc-domain:ezimageai.com`。添加其他站点需要显式运行 `configure`。若改用服务账号，必须为目标 GSC property 授予相应权限；不要为获得 JSON 密钥而关闭组织安全策略。

Windows 上为存储目录设置仅当前用户与 SYSTEM 的 ACL。POSIX 新目录/文件使用 `0700` / `0600`。本机默认 AppData 目录使用 EFS，实测同目录原子重命名返回 EXDEV，因此实际数据目录使用用户主目录下单独受 ACL 保护的 `.gsc-seo`；未修改原有目录的加密设置。不要将凭据放在共享目录或提交到源码。

## MCP

```powershell
codex mcp add gsc-seo -- 'C:\Program Files\nodejs\node.exe' 'D:\AIProject\Gefei\SaaSTool\ez-image-ai\tooling\gsc\src\mcp.mjs'
codex mcp get gsc-seo
```

提供 `gsc_status`、`gsc_sites`、`gsc_sync`、`gsc_report`、`gsc_query`、`gsc_inspect`。新注册的 MCP 可能需要新开聊天或重新加载 Codex 才会显示；CLI 可立即使用。移动仓库后需要更新注册路径。

可以询问：“ezimageai 最近有哪些非品牌词值得优化”“哪些页面点击下降”“首页是否被 Google 收录”。关键词和 URL 是不可信数据，不应当作指令执行。

## 数据口径

- 日期采用 Google 的 `America/Los_Angeles`，仅保存 `dataState: final`。自动寻找最近可用的 finalized 日期；不是按中国时区把昨天当作完整数据。
- 每日分别采集全站总量、页面、关键词 × 页面。带关键词维度的数据受匿名查询和内部行数限制，不能用它求全站总量。站点、页面的聚合方式也不同。
- 分页每次最多 25,000 行，每类每日最多 50,000 行；达到上限会明确提示截断。它不是 Google 全量搜索词导出，也不提供竞品关键词或全网搜索量。
- CTR 用总点击 / 总曝光；平均排名按曝光加权。平均排名不是某次实时搜索的固定位置。
- 默认非品牌词按配置的字符串子串排除，忽略大小写，不做模糊猜测。可以修改 `brandTerms`；相似品牌或通用缩写仍需人工辨别。
- 机会筛选为平均排名 4–20、曝光达到阈值；低 CTR 为前 10 位且 CTR < 2%。这些是筛查规则，应结合搜索意图、国家、设备和 SERP 核实，不能直接推断标题有问题或保证增长。
- 两期缓存缺失任何日期时，停止输出变化结论。URL 保留 `?lang=` 等查询参数，不把不同语言页面合并。
- 多页面获得同一词的曝光仅作为待核实的重叠候选，不等于有害关键词竞争。URL Inspection 查询的是 Google 已索引版本，不执行实时抓取，也不申请收录。

## 运行与恢复

每天执行 `pnpm gsc daily --site ezimageai` 即可持续保留历史快照。所有 Google 请求均为只读；不会编辑网页、提交 sitemap 或请求索引。Google GSC API 本身免费，但有配额；HTTP 429/5xx 最多尝试 4 次，其他错误直接返回。定时任务在本机运行，需要电脑和 Codex 在线。

同一站点/搜索类型使用独占 `sync.lock`。中断时已完成日期保留，失败的当天不会提交。若进程被强制结束留下锁，先读取锁内 `owner.json` 并核对 PID 和启动时间，确认原进程及其子进程已退出后，才删除该锁的 owner 文件与空目录。不要删除正在使用的锁。

删除 MCP 注册可用 `codex mcp remove gsc-seo`；停止自动任务另在 Codex 自动化中暂停。撤销 Google 授权需要到账号的第三方连接管理中移除相应授权。不要为了移除此工具删除现有 Cloud 项目或网站登录 OAuth 客户端。

## 验证

```powershell
pnpm gsc:test
pnpm exec oxlint tooling/gsc/src tooling/gsc/test
pnpm exec oxfmt --check tooling/gsc package.json
git diff --check
```

测试包含真实 MCP stdio 握手、分页/配额、授权回调状态与超时、按曝光加权、品牌过滤、缺失日期、同步锁与中断安全。测试使用本地样例，不代表 Google 在线授权成功；在线证据需由 `sites`、`daily`、`inspect` 单独确认。

## 官方资料

- [授权与只读 scope](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing)
- [Search Analytics query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query)
- [数据导出与行数限制](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data)
- [URL Inspection API](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect)
- [OAuth refresh token 有效期](https://developers.google.com/identity/protocols/oauth2)
- [GSC API 费用](https://developers.google.com/webmaster-tools/pricing)
