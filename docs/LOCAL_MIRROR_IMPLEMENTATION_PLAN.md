# 医院数据应用平台：本地工作副本完整实施方案

版本：2026-09-08

## 1. 最终决策

第一阶段不把生成系统直接绑定到远端业务表，而采用：

```text
远端医疗平台
  → 元数据确认
  → 全量/分页导入
  → 本地工作副本
  → 本地生成系统和完整 CRUD
  → 后续接入远端同步
```

本地工作副本是第一阶段管理系统的业务数据源。远端系统是初始导入来源，不承诺用户修改会立即写回远端。

这条路线解决当前最现实的缺口：线上 Agent 有会话能力，但没有经过验收的稳定业务写入接口。同步机制可以延后，但主键、来源版本、导入批次、变更队列和冲突状态必须从第一天设计好。

## 1.1 本地雏形已执行到的范围

本仓库已经把第一阶段的可运行闭环接上：`mirror_bindings`、`mirror_import_runs`、`mirror_rows`、`mirror_outbox_events` 和镜像审计表均持久化在 `data/live.sqlite3`；首页连接页可以把线上 `public.bed_master` 的真实脱敏样例导入本地，生成的医院床位系统随后通过本地 API 提供分页、搜索、筛选、详情、新增、编辑、软删除和恢复。当前上游只验收了 `/sample`，因此导入任务会固定标注 `preview_sample`/“脱敏样例来源”，不能被解释成远端全量导入。线上全量分页读取和写回接口补齐后，沿现有 binding、source_pk、import_run 和 outbox 字段扩展即可。

## 2. 目标和非目标

### 第一阶段目标

- 选择医院平台中的数据源、Schema 和表。
- 读取可信表结构、主键、字段类型和画像版本。
- 通过全量/分页读取接口导入本地数据库。
- Agent 根据本地已确认的数据资产生成管理页面定义。
- 本地系统提供查询、分页、筛选、排序、详情、新增、编辑、删除和批量导入。
- 应用定义、数据副本、导入任务、版本和本地操作持久化。
- 页面明确显示数据来源、导入时间、数据模式和同步状态。

### 第一阶段不做

- 不将画像脱敏样例冒充全量数据。
- 不依赖模型生成任意代码或 SQL。
- 不承诺本地修改自动写回 HIS。
- 不复制整个医院平台的全部 80 张表；先选择一个或少量业务表闭环。
- 不把跨表业务流程当成普通单表 CRUD。

## 3. 产品结构

### A. 数据源与导入中心

页面回答“数据从哪里来、当前导入到什么状态”。

主要区域：

- 数据源卡片：HIS、EMR、LIS、医嘱、检查、治理。
- 数据源状态、画像版本、表数量和最近导入时间。
- Schema/表目录搜索。
- 表详情：字段、类型、主键、可空、注释、索引、估算行数。
- 脱敏样例预览，明确标注“仅用于了解结构”。
- 导入配置：全量导入、重新导入、仅同步新增/变化。
- 导入进度：读取、校验、写入、校验完成、失败。
- 导入完成后显示本地副本版本。

“查看表”和“导入到本地”是两个动作。浏览不会修改当前应用绑定。

### B. 需求生成工作室

页面回答“我要把这批本地数据做成什么系统”。

建议三栏布局：

```text
左：当前数据资产和字段
中：需求对话、澄清、确认
右：生成的页面预览
```

流程：

1. 选择本地副本和业务实体。
2. 描述列表、筛选、详情、统计和操作。
3. Agent 先复述需求并指出缺失字段。
4. 用户确认需求摘要。
5. 生成受约束的 AppSpec。
6. 本地校验字段、组件、动作和数据绑定。
7. 预览页面。
8. 保存草稿或发布版本。

Run ID、Thread ID、SSE 和 AppSpec 放在技术详情抽屉，不占据业务主视图。

### C. 已生成系统中心

页面回答“现在如何使用已经生成的系统”。

应用列表显示：

- 名称
- 数据实体
- 当前数据版本
- 草稿/已发布
- 本地 CRUD 能力
- 同步状态
- 最近导入时间

业务系统页面显示：

- 系统名称和业务描述
- 数据来源与本地副本版本
- 搜索、筛选、排序、分页
- 结果表格
- 详情抽屉
- 新增、编辑、删除、批量导入
- 导入/同步状态
- 本地操作记录

页面顶部固定显示：

```text
数据模式：本地工作副本
来源：医疗演示 HIS / public.bed_master
副本版本：mirror-20260908-001
远端同步：未配置
```

## 4. 数据模型

生产环境建议使用 PostgreSQL；本地开发可以继续使用 SQLite。不要把全部业务记录塞进一个 JSON 表作为正式方案，因为筛选、排序、校验和未来同步都会变得困难。

### 平台元数据表

#### connections

保存已授权的数据源引用，不保存远端数据库密码。

```text
id
provider
remote_source_id
name
status
last_health_check_at
created_at
updated_at
```

#### asset_bindings

```text
id
connection_id
schema_name
table_name
profile_run_id
structure_fingerprint
primary_key_definition
field_manifest_json
status
```

#### mirror_import_runs

```text
id
asset_binding_id
mode                 full / incremental / reconcile
status               queued / running / succeeded / failed / cancelled
source_cursor
source_snapshot
total_read
total_inserted
total_updated
total_deleted
error_message
started_at
finished_at
```

#### apps

```text
id
name
owner_id
draft_version_id
published_version_id
status
created_at
updated_at
```

#### app_versions

```text
id
app_id
version
app_spec_json
asset_binding_id
mirror_snapshot_id
capability_manifest_json
spec_hash
status                 draft / published / archived
created_at
published_at
```

#### audit_events

记录本地导入、应用发布和本地 CRUD 操作。第一阶段不需要把完整患者记录写入日志，只保存实体、主键、动作、结果和关联 ID。

### 本地镜像业务表

每个远端业务表在本地建立对应的关系表，例如：

```text
mirror_his_public_bed_master
```

保留远端原始字段，并增加平台字段：

```text
_mirror_source_id
_mirror_schema_name
_mirror_table_name
_mirror_source_pk
_mirror_source_updated_at
_mirror_row_hash
_mirror_import_run_id
_mirror_origin              remote / local
_mirror_sync_state          clean / local_changed / conflict / deleted
_mirror_deleted_at
_mirror_local_updated_at
```

远端主键必须原样保留，不能用本地自增 ID 替代。未来同步需要依靠稳定主键和来源版本定位记录。

## 5. 导入流程

### 5.1 预检

导入前读取：

- 表是否存在
- 主键是否存在
- 字段类型
- 可空性
- 画像版本
- 结构指纹
- 远端是否支持分页/总数/更新时间

如果只能拿到 `sample` 样例，则只能创建“预览副本”，不能进入正式导入流程。

### 5.2 建立 staging 表

导入数据先写入临时 staging 表，不直接覆盖线上正在使用的本地副本。

```text
读取远端 → staging → 行数/主键/hash 校验 → 原子切换正式副本
```

失败时保留旧副本继续使用，不出现半张表状态。

### 5.3 分页读取

优先使用：

- 稳定排序字段
- 游标分页
- 主键范围分页
- 每批固定大小

不建议使用无排序的 offset 分页作为唯一方案，因为远端数据变化时可能重复或漏行。

### 5.4 导入完成校验

至少校验：

- 实际读取行数
- 主键重复
- 必填字段
- 字段类型转换失败数
- 删除标记数量
- 远端总数（如果平台能提供）
- 结构指纹是否仍匹配

只有校验通过，才将 staging 切换为当前本地副本。

## 6. 本地 CRUD

CRUD 不由 Agent 直接执行，而由本地后端根据 AppSpec 和能力清单执行。

### 查询

- 服务端分页
- 类型化筛选
- 稳定排序
- 白名单字段搜索
- 详情按主键读取

### 新增

- 根据字段类型生成表单
- 必填和长度校验
- 默认值
- 唯一键校验
- 提交后写入本地表
- 写入 audit_events
- 产生 outbox 事件，但同步关闭时保持 pending

### 编辑

- 只允许修改 AppSpec 中声明的字段
- 保存前校验当前版本
- 记录修改前后字段摘要
- 标记 `_mirror_origin=local`
- 产生本地变更事件

### 删除

第一阶段建议软删除：

```text
_mirror_sync_state = deleted
_mirror_deleted_at = now()
```

物理删除等未来同步契约明确后再开放。

### 批量导入

流程固定为：

```text
上传 → 解析 → 字段映射 → 预校验 → 错误下载 → 用户确认 → 批量写入
```

不要让批量导入直接覆盖本地表。

## 7. 同步机制预留

### 第一阶段：远端单向导入

```text
remote → local
```

本地修改只影响本地工作副本，不自动回远端。系统显示“同步未配置”。

### 第二阶段：远端增量同步

需要远端至少提供一种：

- `updated_at` 增量条件
- 递增版本号
- 变更游标
- CDC/变更日志
- 稳定的删除记录标识

没有这些信息，只能定期全量比对。

### 第三阶段：双向同步

```text
remote ⇄ local
```

需要新增 MutationGateway：

- 新增/更新/删除契约
- 幂等键
- expected_version/ETag
- 冲突错误
- 事务边界
- 失败重试
- 审计 ID

本地变更写入 `outbox_events`：

```text
pending → sending → succeeded
                 └→ failed / conflict
```

冲突策略不要留到最后才决定。建议初期采用“人工确认”，不使用静默的最后写入覆盖。

## 8. 本地 API 设计

以下是本地平台 API，不代表线上平台已有这些路径。

### 数据和导入

```text
GET  /api/connections
GET  /api/connections/{id}/assets
GET  /api/assets/{id}
POST /api/assets/{id}/imports
GET  /api/import-runs/{id}
POST /api/import-runs/{id}/cancel
```

### 应用生成

```text
GET  /api/apps
POST /api/apps
GET  /api/apps/{id}
POST /api/apps/{id}/drafts
POST /api/apps/{id}/validate
POST /api/apps/{id}/publish
GET  /api/apps/{id}/versions
POST /api/apps/{id}/rollback
```

### 本地业务运行时

```text
GET    /api/runtime/{app_id}/records
GET    /api/runtime/{app_id}/records/{pk}
POST   /api/runtime/{app_id}/records
PATCH  /api/runtime/{app_id}/records/{pk}
DELETE /api/runtime/{app_id}/records/{pk}
POST   /api/runtime/{app_id}/imports/preview
POST   /api/runtime/{app_id}/imports/commit
```

### 同步预留

```text
GET  /api/sync/status
POST /api/sync/pull
POST /api/sync/push
GET  /api/sync/conflicts
POST /api/sync/conflicts/{id}/resolve
```

## 9. AppSpec 设计

模型只生成声明，不生成可执行代码：

```json
{
  "schema_version": 2,
  "name": "床位主数据管理",
  "asset_binding_id": "asset_123",
  "data_mode": "local_mirror",
  "list": {
    "columns": ["code", "name", "ward_code", "bed_type", "status"],
    "search_fields": ["code", "name", "ward_code"],
    "filters": ["bed_type", "status"],
    "sort": ["code"]
  },
  "detail": {
    "fields": ["code", "name", "ward_code", "bed_type", "status", "effective_date"]
  },
  "requested_operations": ["read", "create", "update", "delete"]
}
```

本地服务再计算真实能力：

```text
requested_operations
∩ local_schema_capabilities
∩ app_capabilities
∩ user_permissions
```

只有交集中的动作才进入 UI。

## 10. 分阶段开发计划

### Phase 0：基础修正

- 将“远端样例”与“本地副本”分成两种 data mode。
- 去掉当前看似可用但无法执行的远端 CRUD 按钮。
- 加入应用草稿/发布/版本数据模型。
- 修复数据表恢复、浏览覆盖绑定和清除状态问题。
- 将旧本地 CRUD 实验区从正式运行路径隔离。

### Phase 1：单表本地副本

- 先支持 HIS 26 的一个已授权表。
- 先确认平台能提供全量/分页读取。
- 建立 staging、校验、切换和导入任务。
- 使用 `bed_master` 做第一个真实本地副本样板。
- 完成本地查询、分页、详情和 CRUD。

### Phase 2：生成器接入本地副本

- Agent 读取本地可信 schema 和字段说明。
- 生成 AppSpec v2。
- 生成预览、表单和能力清单。
- 保存草稿、发布版本、重新打开和回滚。

### Phase 3：多表和医院模块

- 支持多个本地镜像表。
- 根据已验证关系生成关联页面。
- 支持患者、科室、预约、检查、医嘱等模块。
- 每个模块只显示真实存在并已授权的业务字段。

### Phase 4：同步

- 先做远端到本地增量。
- 再做本地 outbox。
- 最后接远端写回。
- 引入冲突列表和人工处理。

## 11. 完成标准

### 本地副本

- 全量导入不依赖脱敏样例。
- 导入失败不会破坏旧副本。
- 重复导入不会产生重复主键。
- 表结构变化会阻止不兼容发布。
- 每个应用能明确绑定一个本地副本版本。

### 本地 CRUD

- 查询、分页、筛选、排序真实在后端执行。
- 新增/编辑/删除都能在刷新后保留。
- 表单根据真实类型校验。
- 删除有可追踪状态。
- 批量导入有预览和错误反馈。

### 生成器

- 不生成不存在的字段。
- 不生成任意代码或 SQL。
- 修改产生新草稿，不覆盖已发布版本。
- 发布后始终使用锁定的 AppSpec 和副本版本。

### 同步预留

- 每条本地记录能定位远端主键。
- 每条本地修改能进入 outbox。
- 远端变化能判断新增、更新和删除。
- 冲突不会静默覆盖。

## 12. 当前还需要平台提供的信息

在开始 Phase 1 前，只需要确认以下功能性契约：

1. 能否读取指定表的全量数据。
2. 是否支持稳定分页或游标。
3. 是否返回准确总数。
4. 是否有主键详情查询。
5. 是否有更新时间或增量游标。
6. 是否能识别删除记录。
7. 后续是否计划开放受控写入。

如果第 1～6 项暂时都没有，项目仍可以先用可丢弃的本地样例完成界面和 CRUD，但不能称为“真实医院数据系统”。

## 最终产品定义

第一阶段的正式名称建议是：

> 医院数据应用生成与本地工作副本平台

它先把远端医院数据导入本地，生成真正可操作的业务系统；同步是第二阶段能力，不阻塞第一阶段的本地 CRUD，但必须从数据模型和版本设计上预留。
