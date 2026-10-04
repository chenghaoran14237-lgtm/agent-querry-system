# 线上 API 实测规格与边界

验证日期：2026-09-05。依据真实登录、应用管理“外部接入”页面及 HTTP/SSE 调用结果。打包 JS 中出现工具名不等于接口已成功。

这是历史实验记录。最新发布/草稿、部署与权限边界以 [2026-09-08 复核](ONLINE_API_AUDIT_2026-09-08.md) 为准；当前未完成 External v1 运行验收。

## 三类能力

1. 网站登录态 API：账号授权的数据目录、画像、样例和已发布应用运行。当前 Demo 真实使用这条路径。
2. External v1：封装 Conversation/Run/SSE/Actions 等 Agent 生命周期，不天然提供数据库 CRUD。
3. 业务数据网关：实时查询、分页、主键定位、写回、权限、事务与审计。目前没有完成可供本 Demo 使用的写回契约验收。

RAG、模型回答、工具选项列表不能替代数据库授权。

## 已实测网站接口

Base URL：`http://aitest.fenmiao360.cn`；除登录外均由后端附上 Bearer Token。目录接口的可选 query/cursor 均应在空值时省略，实测传空字符串会 422。

| 方法与路径 | 规格 |
| --- | --- |
| POST /api/auth/token | form-urlencoded username/password；返回 access_token、user_id、username、role |
| GET /api/agent-apps/17 | data envelope；应用详情 |
| GET /api/agent-apps/17/versions | data 数组；发布版本 1.0.1，version_id 25，runtime_agent_config_id 40 |
| GET /api/data-integration/accessible-sources | data_sources 数组；本地仅暴露 id/name |
| GET /api/data-integration/sources/{id}/profile-catalog | query、limit、可选 cursor；返回 table_profiles、has_more、next_cursor、profile_run_id。空字符串 cursor 实测 422，应省略 |
| GET /api/data-integration/sources/{id}/profile-catalog/table | schema_name、table_name；返回 table_profile.columns、constraints_json、row_count、profile_run_id |
| GET /api/data-integration/sources/{id}/sample | schema_name、table_name、limit；返回 columns、rows、field_semantics、profile_run_id。是画像脱敏样例，不是全量实时查询 |
| POST /api/agent-apps/17/conversations | JSON message、client_request_id、image_content:null、starter_form_values:{}；data 中返回 conversation.id/run.run_id |
| POST /api/agent-apps/17/conversations/{thread_id}/runs | JSON message、client_request_id、image_content:null；已验证同会话修改 |
| GET /api/chat/runs/{run_id} | run envelope，确认 completed 后才允许校验发布 |
| GET /api/chat/runs/{run_id}/events?after_seq=0 | SSE，内部游标实测 Redis 字符串，例如 1788598718323-0，不能转整数 |
| GET /api/chat/thread/{thread_id}/history | history 数组；读取最后 ai 的最终 content，不保存 reasoning |

取消路径 `POST /api/chat/runs/{run_id}/cancel` 已适配；本地取消发布与去重由离线测试覆盖。上线前仍需专项验收线上取消、断网续流、限流及长时间等待。

### 真实数据资产

6 个来源：26 HIS、27 EMR、28 LIS、29 医嘱、30 检查、31 治理。

本次选用 `26 / public.bed_master / profile 121`，主键 bed_master_id，估算 73 行。9 个字段：bed_master_id、code、name、category、ward_code、bed_type、effective_date、status、source_updated_at。

code-1、name-1、D001 等是线上返回的演示/脱敏样例，不可包装成真实患者运营数据。估算行数不是已加载样例数或实时 count。

## External v1：文档核对，未真实验收

页面状态：buildkit-demo-test 已停用；原凭证撤销；API/Web/SDK 公开地址未配置。本轮没有启用部署、创建凭证或更改发布版本。

- 后端 Authorization: Bearer yxapp_...。
- X-KnowNet-Visitor-ID：1–256 字符、稳定、不含直接个人信息的不透明标识。
- 创建会话/Run 需 Idempotency-Key，相同 key 不可用于不同输入。
- POST `/api/external/v1/conversations`，可传 title，返回 conversation.id。
- POST `/api/external/v1/conversations/{id}/runs`，传 message，可传 image_content，返回 run.id。
- GET `/api/external/v1/runs/{id}/events?after_seq=0`；公开整数 seq 与 SSE id 相同。
- message.delta/message.completed 的 data.content 是文本；run.completed/failed/cancelled 后有 close。
- approval.required/input.required 需后续 Actions，本 Demo 停止发布，不擅自审批。

内部 SSE 的 init/agent_state/loading/finished/completed 与公开协议不同。本次登录态接口成功不能作为 External v1 验收成功。

## 生成规格与边界

本地先读真实表元数据，再把绑定和字段白名单给线上 Agent。应用 17 发布配置的 tools/knowledges 均为空；不能声称 Agent 自己查询了数据库，目录读取由本地适配后端完成。

```json
{"schema_version":1,"name":"床位管理","description":"只读页面","source":{"id":26,"schema_name":"public","table_name":"bed_master","profile_run_id":121},"columns":[{"field":"code","label":"编码"}],"filters":[],"actions":["read"],"notes":[]}
```

要求来源/画像一致、1–40 个不重复真实字段、筛选仅引用展示列、actions 严格为 read。不接受任意代码、SQL 或 HTML。不合法就失败，保留最终回复但不发布应用。

task id/request_id/run_id/thread_id 不同；规格、对话、幂等任务落 SQLite；token/cookie 不落盘。重启不自动重发可能已被上游受理的生成。

## 完整真实 CRUD 所需补充

| 缺口 | 最低要求 |
| --- | --- |
| 实时查询 | 与画像样例区分；分页、排序、过滤、总数、结果集生命周期 |
| 写回 | 每个实体允许的操作、主键、可写字段、类型校验、删除/恢复规则 |
| 一致性 | expected_version/ETag、幂等键、冲突 409、事务、补偿 |
| 授权 | 最小权限服务身份、用户/租户透传、表/行/列权限及脱敏 |
| 审计 | actor、request_id、实体/记录 ID、前后值、审批链、日志查询 |
| 构建模型 | 独立 Builder Agent、稳定输出协议及回归集；当前借用床位应用仅用于联调 |
| 生产运维 | HTTPS、凭证托管/轮换、限流超时、负载测试、迁移、备份恢复 |

工具选择器中的 data_integration_execute_sql 等只证明配置项存在，不证明外部调用方有或应有任意 SQL 写入权限。
