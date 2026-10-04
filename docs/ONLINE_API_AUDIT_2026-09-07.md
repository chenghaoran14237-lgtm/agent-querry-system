# 线上平台接口实测审计

审计日期：2026-09-07  
目标：为医院数据应用生成器确认现有二次封装平台的真实能力，不把前端菜单或工具名误认为已开放能力。

更正与后续：以 [2026-09-08 分层复核](ONLINE_API_AUDIT_2026-09-08.md) 为准。下列接口清单混合了实际 GET 结果和网站客户端中的接口定义；未调用的写接口、运行和分页接口不能视为已验收。内置浏览器读取超时，本轮资料实际来自服务登录接口、只读 HTTP 请求及站点公开前端中的接入手册，不是完整 UI 操作验收。

## 结论摘要

从登录态读取结果和站点客户端定义看，平台具有以下功能类别；标签区分证据，不能全部当作外部部署已验收：

- 已调用：登录返回 Token、用户/角色/部门信息。
- 已读取：可访问数据源列表和完整数据源详情。
- 已读取：驱动能力清单、表发现和画像范围；连接测试/新画像运行仅核对定义。
- 已读取：目录、表详情、类型/注释/约束/索引/估算行数/脱敏样例。
- 已读取：跨源关系和索引/图谱状态；校验和重建未执行。
- 已读取：敏感定义和规则；候选审核/标注未执行。
- 已读取：查询运行历史；Agent Query Run、分页、取消、重放、规则保存和导出主要来自接口定义，未逐项验收。
- 已读取：Agent 版本/部署配置；发布、External 会话/Run/SSE/Actions/产物仅核对协议，未运行验收。

当前不能确认或不能使用的能力：

- 没有发现面向外部接入方的通用业务表 INSERT/UPDATE/DELETE/BULK WRITE 契约。
- External v1 的部署 `buildkit-demo-test` 当前为 disabled；API/Web/SDK 公网地址为空。
- 该部署的默认凭证已禁用，不能把 External v1 当作当前可用的生产接入路径。
- 页面或工具选择器中出现“执行 SQL/工具”不等于外部调用方获得任意 SQL 或写入权限。

## 已调用的登录与已核对的应用接口

### 登录

```text
POST /api/auth/token
Content-Type: application/x-www-form-urlencoded
body: username, password
```

返回 `access_token`、`user_id`、`user_id_login`、`role`、`department_id` 等。令牌只能保存在本地进程内存，不能写入项目文件或数据库。

### Agent 应用 17

下面 GET 配置在本轮读取成功；Conversation/Run/SSE 的登录态成功记录来自 09-05，取消仍需专项验收。本轮没有新建运行或取消其他任务。

```text
GET  /api/agent-apps
GET  /api/agent-apps/{app_id}
GET  /api/agent-apps/{app_id}/versions
GET  /api/agent-apps/{app_id}/deployments
GET  /api/agent-apps/{app_id}/reviews
POST /api/agent-apps/{app_id}/conversations
POST /api/agent-apps/{app_id}/conversations/{thread_id}/runs
GET  /api/chat/runs/{run_id}
GET  /api/chat/runs/{run_id}/events?after_seq=...
GET  /api/chat/thread/{thread_id}/history
POST /api/chat/runs/{run_id}/cancel
```

当前应用 17 的真实信息：

- 名称：内分泌科 AI 床位调度大师
- 状态：published
- 当前版本：1.0.1，version_id 25
- 运行配置：runtime_agent_config_id 40
- 交互模式：chat
- 已发布工具：空
- 发布版本 25 的知识库：空；草稿中的一个知识库尚未包含在该发布版本中
- 描述：规则模拟全院床位，实现全局调度

这说明现有应用 17 本身是“聊天 Agent”，不是数据库管理系统；床位数据目录读取由数据集成 API 完成，并不代表应用已经拥有数据库写权限。

## 数据集成 API

### 数据源和驱动

```text
GET  /api/data-integration/drivers
POST /api/data-integration/sources/test-connection
GET  /api/data-integration/sources
GET  /api/data-integration/accessible-sources
POST /api/data-integration/sources/{id}/confirm
POST /api/data-integration/sources/{id}/disable
```

当前账号可访问 6 个医疗数据源：HIS、EMR、LIS、医嘱、检查、治理。HIS 数据源 ID 为 26，状态 connected，画像已完成并发布。

驱动能力包括 PostgreSQL、MySQL、MariaDB、SQL Server、Oracle、Caché、达梦、人大金仓、openGauss、GaussDB、OceanBase、TiDB、ClickHouse 等。驱动元数据明确标注 schema discovery、profile、readonly query、注释、约束、索引、行数和样例等能力。

### 表发现、画像与目录

```text
GET  /api/data-integration/sources/{id}/discovery
GET  /api/data-integration/sources/{id}/profile-scope/configuration
GET  /api/data-integration/sources/{id}/profile-scope/directory
GET  /api/data-integration/sources/{id}/profile-catalog
GET  /api/data-integration/sources/{id}/profile-catalog/table
GET  /api/data-integration/sources/{id}/profile-runs
POST /api/data-integration/sources/{id}/profile-runs
GET  /api/data-integration/profile-runs/{run_id}
GET  /api/data-integration/profile-runs/{run_id}/items
GET  /api/data-integration/profile-runs/{run_id}/diff
POST /api/data-integration/profile-runs/{run_id}/publish
```

HIS 26 当前画像 124：

- 80 张表，范围为 BASE TABLE 和 VIEW
- 画像状态 completed，已发布
- 默认采样上限 20，行数模式 estimated，语义推断开启
- 画像可以返回字段注释、数据类型、可空性、主键、索引、估算行数、样例值和敏感扫描状态

### 预览样例与搜索

```text
GET  /api/data-integration/sources/{id}/sample?schema_name=...&table_name=...&limit=...
POST /api/data-integration/sources/{id}/search
```

`sample` 返回的是画像产生的脱敏样例，不是实时全量查询。以 `public.bed_master` 为例：

- 主键：bed_master_id
- 估算行数：73
- 字段数：9
- 字段包含床位编码、名称、病区代码、床位类型、状态、生效日期、源系统更新时间

当前项目必须把“脱敏样例预览”和“真实业务查询结果”分成两个状态，不能用样例冒充在线管理数据。

### 关系、资产和治理

```text
GET/POST /api/data-integration/graph/relations
POST     /api/data-integration/graph/relations/{id}/validate
GET      /api/data-integration/asset-index/status
POST     /api/data-integration/asset-index/rebuild
GET      /api/data-integration/asset-graph/status
POST     /api/data-integration/asset-graph/rebuild
POST     /api/data-integration/asset-search
POST     /api/data-integration/asset-graph/subgraph
POST     /api/data-integration/asset-graph/paths
```

HIS、LIS、检查和治理库之间已有验证关系，可用于 Agent 的跨表/跨库查询建模。关系包含 join 字段、类型兼容性、样本交集、基数、验证状态和结构指纹。

### 敏感数据

```text
GET/POST /api/data-integration/sensitivity-definitions
GET/POST /api/data-integration/sensitivity-rules
GET      /api/data-integration/sources/{id}/profile-runs/{run_id}/sensitivity-candidates
GET      /api/data-integration/sources/{id}/profile-runs/{run_id}/sensitivity-blockers
POST     /api/data-integration/sources/{id}/sensitivity-candidates/review
PATCH    /api/data-integration/sources/{id}/sensitivity-annotations
```

已配置身份证、手机号、邮箱、详细地址、人员姓名和人工业务敏感数据规则。医院项目必须复用这些状态，不能仅在前端做遮罩。

## External v1 接入协议

页面内置的正式 API 手册定义了：

```text
POST /api/external/v1/conversations
GET  /api/external/v1/conversations
GET  /api/external/v1/conversations/{conversation_id}
GET  /api/external/v1/conversations/{conversation_id}/history
POST /api/external/v1/conversations/{conversation_id}/runs
GET  /api/external/v1/runs/{run_id}
GET  /api/external/v1/runs/{run_id}/events?after_seq=...
POST /api/external/v1/runs/{run_id}/cancel
POST /api/external/v1/runs/{run_id}/actions
GET  /api/external/v1/runs/{run_id}/artifacts
GET  /api/external/v1/runs/{run_id}/artifacts/{artifact_id}
```

必需边界：

- `Authorization: Bearer yxapp_...` 只由接入方后端持有。
- `X-KnowNet-Visitor-ID` 是稳定但不含直接个人信息的不透明访客标识。
- 创建会话和 Run 使用 `Idempotency-Key`。
- SSE 使用公开整数 `seq`，断线从 `after_seq` 续传。
- `approval.required` 和 `input.required` 必须通过 revision 对齐的 Actions 响应，不能自动猜测审批。

现阶段 External v1 只能被视为“已定义的接入协议”，不能视为本地项目已验收的线上能力。要启用它，必须先在平台中配置公开地址、启用部署、创建/轮换凭证，再用真实凭证做最小端到端验收。

## 对本地医院项目的直接影响

本地系统应采用四层适配：

1. `KnowNetCatalogGateway`：登录、数据源、目录、画像、样例、关系和敏感状态。
2. `KnowNetAgentGateway`：应用 17 的 Conversation/Run/SSE，或未来启用的 External v1。
3. `RemoteQueryGateway`：等待平台提供实时分页查询契约后接入；当前不得假装由画像样例实现。
4. `RemoteMutationGateway`：等待受控新增/更新/删除/批量写入契约；必须带权限、幂等、版本冲突和审计。

因此现有本地路径能够生成并保存应用定义、展示脱敏样例，但使用的是网站登录态 API；不能作为 External v1 已接通的证明。真实业务 CRUD 必须在所选外部契约的查询/写入能力验收后再启用。
