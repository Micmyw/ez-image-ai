# 管理能力发布与生产数据库更新

用户授权：合并主分支、推送远程，并包括数据库。生产 SQL 在执行前已展示给用户，
并按原要求保留目标积分债务、退款和订阅规则。本记录不代替网站部署或真实付款验收。

## 目标与增量审查

- Supabase：`ezimageai-production` / `cresrmesgalqdgbxtyvm`，新加坡，PostgreSQL 17.6。
  项目连接器、现有生产配置和数据库查询三者对应一致；使用既有 `ezpic_app`，
  TLS 校验证书及主机名，不修改数据库口令。
- 生产当前完成 67 个迁移，无未解决的失败迁移。历史文件校验和逐项匹配，
  保留早期已明确 rolled back 的记录，不删除或重写历史。
- 实际生产 schema 到目标 schema 的 Prisma diff 与 `20261020010000_admin_capabilities`
  的结构 SQL 完全一致；没有其他待补偿 schema 差异。
- 结构迁移增加 8 张管理/工单表、`ADMIN_DEDUCT` enum 值、可空
  `subscription.initialPaymentEvidence`；没有历史业务数据回填或账本改写。
- `20261020010100_admin_capabilities_private_boundary` 仅限制 8 张新表：
  RLS、PUBLIC/anon/authenticated/service_role 访问撤销、既有 `ezpic_app` 服务端策略。
  不全量运行可能改变其他 schema 权限的硬化脚本。

SQL 的 LF SHA-256：

| 迁移                                                 | SHA-256                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `20261020010000_admin_capabilities`                  | `fd2b170ed1d90f8b5b7e32b7f224c0623b3689acf66ab63ca3c11dadd41d4e36` |
| `20261020010100_admin_capabilities_private_boundary` | `171736534f57f5e834e362f7abd8bba5397016f3fd9121fa47b2c91b14048bfc` |

## 备份与本地发布验证

- 2026-10-20 13:06 UTC 已通过 TLS 完成生产 `public` 应用 schema 与数据的
  PostgreSQL custom-format 备份，68 个 TABLE DATA 条目，893,697 字节。
  SHA-256：`a47565330dca58157f1d19719eea58c53f76b8ca7a72edd011b9d2d810b2d362`。
  私有备份位于操作者用户目录 `.codex/backups/ezpic-admin-capabilities-20261020/`，
  不进入 Git。`pg_restore --list` 和完整归档解码通过；本轮未进行完整恢复演练。
  恢复目标应是隔离 PostgreSQL 17，禁止原地覆盖生产。
- 使用 PostgreSQL 官方 PGDG 签名索引与 SHA-256 验证的 17.11 客户端，
  未安装或启动新的数据库服务，未把数据库口令放入命令参数或日志。
- 本地完整迁移数增至 69。先模拟 Supabase API 角色已获得表权限，再应用权限迁移，
  实测 3 个角色 × 8 张表的 24 次直接查询全部拒绝，服务端角色 8 次查询全部允许。
- 新增真实 catalog 回归；管理 SQL 集成 4 文件 / 15 项通过。
- 远程主分支 `bf55dff1` 的共享积分改动已保留；自动合并的 4 种语言文件无冲突。
  合并后的 UI/共享积分回归 6 文件 / 92 项通过。

## 执行边界

此记录提交时已完成上述预检与备份。生产迁移执行、读回和远程推送的结果将追加在此处。
新迁移不创建管理 key、不分配机器权限、不触发退款或机器人消息。
机器人生产加密 key、接收端配置和网站/Worker 部署仍应分别核对。
