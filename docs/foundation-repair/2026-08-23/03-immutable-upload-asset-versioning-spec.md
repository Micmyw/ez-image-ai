# PR-F3：上传 staging、不可变资产版本与审核绑定

## PR 标题

`fix(storage): finalize uploads into immutable asset versions`

## 业务目标

消除“审核通过后仍能用未过期 PUT URL 覆盖最终对象”的完整性漏洞，确保用户看到、Provider 使用和审核批准的是同一字节版本。

## 来源发现

- FND-003：单 PUT URL 指向最终资产 key；审核后旧 URL 仍可能覆盖内容。

## 威胁模型

攻击者是合法获得上传签名 URL 的用户或持有该 URL 的第三方。攻击路径：

1. 上传安全文件；
2. 服务端完成检查和审核；
3. 资产被标记可用；
4. 在签名 URL 过期前，对同一 final key 再次 PUT 不同内容；
5. 数据库和审核证据仍指向旧内容，但读取时返回新内容。

这会破坏：

- 内容审核；
- Provider 输入证据；
- 用户资产完整性；
- MIME/大小验证；
- 事故调查和删除证明。

## 冻结设计

### 1. Staging 与 Final 分离

客户端只获得一次性 staging object 的写权限，例如现有命名体系等价于：

```text
staging/{uploadSessionId}/{randomNonce}
```

客户端永远不获得 final asset/version key 的写 URL。

Final key 由服务端生成，必须全局唯一且不可复用，例如：

```text
assets/{ownerId}/{assetId}/{assetVersionId}
```

不要求采用这个字面路径，但必须具备 owner、asset、version 的稳定边界。

### 2. 完成上传

完成接口必须幂等执行：

1. 锁定 upload session；
2. 确认 session 所有者、状态、过期时间和预期元数据；
3. HEAD/stream staging 对象；
4. 验证实际 Content-Length；
5. 检查 MIME 和文件头；
6. 流式计算 SHA-256 或仓库选择的强内容指纹；
7. 写入一个全新的 final version key；
8. 记录 storage version ID/ETag、hash、size、MIME；
9. 将 AssetVersion 与 UploadSession 绑定；
10. 将 staging 标记待清理；
11. 后续审核只针对 AssetVersion。

如果使用 server-side copy，仍需保证 final key 从未暴露给客户端且不会覆盖既有 version。若存储后端不支持条件写，依靠不可预测唯一 version key 和数据库唯一约束保证不复用。

### 3. 版本不可变

- AssetVersion 创建后，object key、hash、size、MIME 不可修改；
- 需要替换内容时创建新 AssetVersion；
- 逻辑 Asset 可以指向当前 version，但历史任务/审核永远引用具体 version；
- Provider 输入绑定具体 AssetVersion；
- 下载与预览签名 URL 绑定具体 version；
- 删除采用软删除 + 异步物理删除，保留必要审计引用。

### 4. 审核证据绑定

输入和输出审核记录至少绑定：

- assetVersionId；
- content hash；
- moderation provider；
- rule/policy version；
- verdict；
- evidence timestamp。

任务创建时再次确认：

- version 仍存在且属于用户；
- 当前对象元数据与记录一致；
- 审核证据指纹一致；
- verdict 仍有效。

### 5. 旧 URL

完成后即使旧 staging PUT URL 未过期：

- 它只能改变 staging key；
- 不能改变 final AssetVersion；
- 已完成 session 不能再次 finalize 成第二个 version，除非显式创建新 session；
- staging 清理前的覆盖行为只影响待删除临时对象。

## 用户故事

### US-F3.1 审核后不可替换

作为平台，我确认审核通过的图片在后续任务和下载时仍是同一份字节内容。

### US-F3.2 重试安全

作为用户，如果完成请求因网络原因重试，我不会得到多个资产版本，也不会覆盖原资产。

### US-F3.3 多版本编辑

作为后续图片编辑产品，每一次真实编辑结果都可以作为新的不可变版本参与版本链。

## 测试

### 单元/合同

- final key 不出现在签名 PUT API 响应；
- session 完成幂等；
- owner mismatch；
- session 过期；
- size mismatch；
- MIME/文件头 mismatch；
- multipart 分片约束；
- hash 记录；
- final key 唯一约束。

### MinIO/S3 integration

必须在 Linux Docker/CI 或隔离环境验证：

1. 获取 staging URL；
2. 上传安全文件；
3. finalize；
4. 读取 final 内容并记录 hash；
5. 使用旧 PUT URL 覆盖 staging；
6. 再次读取 final，hash 不变；
7. 重放 finalize，不产生第二个 version；
8. 旧 session 不能绑定新内容；
9. staging 清理不删除 final；
10. signed GET 不能写；
11. final object 不公开。

### 并发

- 两个 finalize 同时执行；
- finalize 与 expire/cleanup 并发；
- delete 与 task bind 并发；
- multipart complete 重放。

## 数据迁移

Codex必须评估既有资产是否直接使用 final key：

- 新上传路径必须立即使用版本化合同；
- 旧资产不得无证据地假装已计算 hash；
- 可以将旧资产标记 `legacy_unverified` 或等价状态；
- 旧资产首次复用前完成服务器端 hash/metadata verification；
- 不自动公开或删除旧资产；
- migration/backfill 可恢复并有进度记录。

## 验收标准

- 客户端不再获得 final key 的 PUT URL；
- 旧 PUT URL 无法改变已批准资产；
- AssetVersion 和 content hash 成为审核、任务、下载的引用边界；
- MinIO integration 复现旧攻击并证明修复；
- 完成接口幂等；
- 私有默认和流式处理保持；
- 日志/Sentry 不包含签名 URL 或媒体内容。

## 不包含

- 公共作品画廊；
- CDN 公共缓存；
- 图片编辑版本 UI；
- 内容审核状态机修复（PR-F4）；
- Provider 输出业务逻辑重写，除非为统一 AssetVersion 合同所必需。

## 回滚

- 新旧读取路径可在短期内兼容，但所有新写必须保持 staging-to-immutable；
- 不允许回滚为客户端写 final key；
- migration 出错时关闭新上传，保留已完成 version 和 staging 清理队列。
