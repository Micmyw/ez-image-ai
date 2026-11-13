# Bing IndexNow 自动提交

生产域名为 `https://ezimageai.com`。脚本从**线上** `/sitemap.xml` 读取已发布页面，
支持 sitemap index，只提取页面 `loc`，不把图片地址或 hreflang 链接当成新增页面。
首次运行提交全部 sitemap 页面；后续仅提交新 URL 和 `lastmod` 变化的 URL，包含正式的
`?lang=de|es|fr` 页面。页面的发布及索引资格继续由现有 sitemap 管理，新内页仍须进入 sitemap。

## 自动运行与授权

- `.github/workflows/indexnow.yml` 在 main 分支的 Validate PRs 运行结束后自动运行。
  Cloudflare 发布独立于 CI，脚本只读取线上内容，不以 CI 通过代替部署成功。
- 每小时 UTC 第 23 分钟补查，覆盖部署较晚完成、外部服务失败或上一次未成功提交的页面。
  GitHub 定时调度可能延迟；没有承诺分钟级实时触达。
- GitHub Actions 已启用。工作流只声明 `contents: read`，使用 Actions 自身的缓存权限，
  不需要新增 PAT、Cloudflare Token、Bing Webmaster 登录或 OAuth。
- `tooling/indexnow/config.json` 指定 Bing 官方提交接口与根目录校验文件。
  校验文件是公开的域名验证文本，不是管理员凭据，不需要加入生产环境机密。
- `workflow_dispatch` 保留运维补跑入口，正常发布无需手动操作。

## 状态与重试

状态在 `.cache/indexnow/state.json`，使用独立的 GitHub Actions cache 保存；同一工作流串行运行。
每批最多 10,000 个 URL，只有 HTTP 200 / 202 后才记录该批，失败批次留待下次重试。
202 单独记录为等待 IndexNow 校验；200/202 都仅表示收到提交，不能作为已收录证据。
缓存丢失会重新提交当前 sitemap，不会漏掉新页面。缓存只存 URL、lastmod、提交时间及响应码。
内容更新应维护真实 `lastmod`；没有时间戳变化的正文修改不在本脚本的检测范围内。

自动检查并不访问账户、作品私有 URL 或临时下载地址。不需要数据库、生成接口或付费调用。
线上校验文件不匹配、sitemap 无法读取、Bing 限流或拒绝时工作流报错，已有成功批次仍保存。
可以在 GitHub Actions 的 **Bing IndexNow** 运行摘要查看页面数、提交数与等待校验数。

## 本地验证

```sh
node --test tooling/indexnow/sync.test.mjs
node tooling/indexnow/sync.mjs --dry-run
```

不传 `--dry-run` 会实际通知 Bing。可通过 `INDEXNOW_STATE_PATH` 指定本地独立状态文件。
停止自动提交可禁用该工作流；不会改变页面索引策略或网站功能。

协议依据：[IndexNow 官方文档](https://www.indexnow.org/documentation)。
