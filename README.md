# BuildKit Platform · 真实线上联调雏形

连接现有 KnowNet 平台的真实账号、数据目录与应用 17 Agent，通过对话生成并保存可渲染的管理页面规格。默认首页不使用关键词模板或本地假数据兜底。

## 启动与使用

要求 Python 3.9+，无第三方运行依赖。在本目录运行：

```bash
python3 backend/server.py
```

打开 [本地项目](http://127.0.0.1:4180/)，用已有线上账号登录：

1. 选择数据源和真实表。
2. 描述需要的字段和筛选条件，点击“开始生成”。
3. 本地后端读取真实元数据，提交给线上 Agent，消费 SSE 并校验 AppSpec。
4. 在表详情点击“导入本地副本”。当前线上已确认的是脱敏样例接口，因此导入任务会明确标为 `preview_sample`，不会把样例包装成全量 HIS 数据。
5. 描述需求并生成；已导入的表会自动绑定到本地工作副本。生成系统中的新增、编辑、软删除、恢复和分页查询都落在本地 SQLite，重启后仍保留。
6. 继续描述修改会沿用原线上会话；“已生成系统”可恢复规格、版本和运行证据。

## 能力与边界

| 能力 | 当前实现 |
| --- | --- |
| 登录、数据源、字段、样例 | 真实网站 API；每个浏览器独立 HttpOnly 会话 |
| Agent 生成和多轮修改 | 应用 17 的 Conversation/Run/SSE，已实测 |
| 页面生成 | 受约束 AppSpec → 表格/筛选器，不执行模型生成的代码或 SQL |
| 数据展示 | 导入后读取本地工作副本；未导入时才显示线上脱敏样例 |
| 本地 CRUD | 服务端分页、搜索、字段白名单、详情、乐观锁、软删除/恢复、审计和 outbox |
| 持久化 | SQLite 保存数据绑定、导入批次、镜像行、AppSpec、版本、对话、任务和 Run/Thread 坐标 |
| 线上业务增删改/同步 | **未接入**；本地变更留在 `pending` outbox，线上安全写回契约尚未验证 |

本地副本接口（均要求当前线上登录会话）：

```text
GET  /api/live/mirror
POST /api/live/mirror/import              # 当前真实可用的脱敏样例导入
GET  /api/live/mirror/records?binding_id=...
GET  /api/live/mirror/records/{row_id}
POST /api/live/mirror/records              # 新增
PATCH /api/live/mirror/records/{row_id}    # 乐观锁 version/_version
DELETE /api/live/mirror/records/{row_id}   # 软删除
POST /api/live/mirror/records/{row_id}/restore
GET  /api/live/mirror/sync-status
```
| External v1 | 保留实验适配分支，**未完成真实验收**；不是当前登录态 API |

[旧本地 CRUD 实验区](http://127.0.0.1:4180/index.html) 仍保留用于回归；正式雏形请从首页三段式流程进入。首页的本地副本 CRUD 不写回线上，所有记录都会带来源主键、导入批次、版本和同步状态。

## 实测记录（2026-09-05）

- demo_admin 对应线上用户 3，可见 6 个演示数据源。
- 应用 17：内分泌科AI床位调度大师，发布版本 1.0.1。
- HIS 26 / public.bed_master / 画像 121，9 个字段，估算 73 行。
- 初次生成：12,273 ms，69 个事件，Run 84d9850f-2b72-4926-ae5f-7d1027446e78。
- 同会话修改：7,025 ms，34 个事件，Run e4765dd0-1f9d-477c-83a6-6e89de2d34bf。
- 同一 request_id 重放返回同一个本地任务。这些是功能实测，不是稳定性 SLA 或压力测试。

最新外部部署、发布配置与权限边界见 [2026-09-08 分层复核](docs/ONLINE_API_AUDIT_2026-09-08.md)，本地工作副本 + CRUD + 后续同步的实施方案见 [LOCAL_MIRROR_IMPLEMENTATION_PLAN.md](docs/LOCAL_MIRROR_IMPLEMENTATION_PLAN.md)，平台架构和验收关卡见 [医院项目方案](docs/HOSPITAL_AGENT_STUDIO_PLAN.md)。历史记录保留在 [ONLINE_API.md](docs/ONLINE_API.md) 和 [09-07 接口清单](docs/ONLINE_API_AUDIT_2026-09-07.md)，不能混同为所有接口已验收。

2026-09-08 更正：应用 17 发布版本 25 的工具、MCP 和知识库均为空，草稿另有的知识库未发布；唯一可见部门外部部署已停用。当前项目仍是登录态联调，不是 External v1 已完成接入。应用定义会保存，但真实路径没有草稿/发布/不可变版本模型；需求和回复可能包含粘贴的医疗信息，不能绝对宣称医疗信息都不落本地。

## 工程与持久化

```text
backend/server.py          HTTP 服务、静态页面、旧本地 CRUD 兼容层
backend/live_service.py    真实适配、会话、SSE、校验、本地副本/导入/CRUD/outbox 持久化
frontend/live.*            真实联调首页与 AppSpec 渲染器
frontend/index.html        独立的旧本地 CRUD 实验区
tests/test_live_service.py 离线线上适配契约测试
tests/test_mirror_service.py 本地导入、CRUD、乐观锁和字段白名单测试
data/live.sqlite3          真实生成的规格/对话/任务
data/buildkit.sqlite3      本地演示记录/审计
```

刷新或重启不会丢已保存应用、本地镜像行或操作队列。当前导入严格是线上脱敏样例副本；要上线全量业务数据，必须先补齐经过验收的分页读取接口，再把 `preview_sample` 扩展为 `full`/`incremental` staging 导入。重启将未完成任务标记为 interrupted，不自动重发上游请求。

密码不写入文件或数据库；令牌仅在进程内存中，12 小时本地会话上限，重启后重新登录。仅监听 127.0.0.1；真实接口有 Host/Origin/跨站和所有者校验；动态内容用 textContent 渲染。模型不能虚构字段、绑定其他表或声明写权限。

data/ 与 .env 已忽略。备份时停止服务后复制整个 data/ 目录，不要仅复制运行中的 WAL 数据库主文件。

**线上当前使用明文 HTTP**。生产必须启用 HTTPS、最小权限服务身份、凭证托管、细粒度授权、迁移及备份策略，不能把这个本地标准库服务器直接开放到公网。

## 测试与配置

```bash
python3 -m unittest discover -s tests -v
python3 -m py_compile backend/server.py backend/live_service.py
node --check frontend/live.js
```

### 浏览器 E2E 测试

项目现在包含一条真正操作页面的 Playwright 流程，覆盖：未登录门禁、线上登录、HIS 数据源和 `public.bed_master` 表、字段画像、脱敏样例、本地副本导入、线上 Agent 生成、应用持久化、搜索、筛选、分页、查看、新增、编辑、软删除、恢复、刷新恢复和退出登录。

默认运行在临时端口和临时 SQLite 文件中，测试结束自动清理，不会污染当前 `4180` 工作区：

```bash
E2E_PASSWORD='从环境变量提供' npm run e2e:live
```

密码只在本次进程内存中使用，不写入脚本、数据库或测试结果。测试结果写入被忽略的 `test-results/live-workflow.json`；失败时可保留截图作为诊断材料。若需要测试已经运行的服务，可显式指定：

```bash
E2E_BASE_URL=http://127.0.0.1:4180 \
E2E_ISOLATED=0 \
E2E_PASSWORD='从环境变量提供' \
npm run e2e:live
```

脚本优先使用 macOS 的 Chrome；如果运行环境没有系统 Chrome，需要额外执行 `npx playwright install chromium`。只想验证已有应用、跳过一次真实 Agent Run，可加 `E2E_SKIP_GENERATION=1`。完整脚本在 [e2e/live_workflow.mjs](e2e/live_workflow.mjs)，依赖和锁文件为 [package.json](package.json) 与 [package-lock.json](package-lock.json)。

配置见 .env.example。服务不自动加载 .env，使用 shell 环境变量传入。默认无需长期 External Key，不要把管理员密码写进配置文件。
