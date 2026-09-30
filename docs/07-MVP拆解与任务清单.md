# H. 目录结构 + I. MVP 拆解 + J. 任务清单 + K. Definition of Done

## 1. H. Repository / Directory Structure

```
personal-resource-os/
├── README.md
├── Makefile                     # dev/test/lint/typecheck/build/e2e/backup/restore
├── Dockerfile  docker-compose.yml
├── pyproject.toml
├── docs/                        # 本套规格文档（A–O）
├── adr/                         # ADR-001…007
├── core/
│   └── personal_agent_core/
│       ├── config.py            # 配置 + 数据分级 + 出站 allowlist
│       ├── db.py                # SQLite + FTS5 + migrations（幂等）
│       ├── models.py            # Object/Relation/Task/Audit 数据结构
│       ├── capture.py           # Capture pipeline（文本/文件/剪贴板）
│       ├── pipeline.py          # Inbox 自动处理：分类→摘要→提取→关系建议
│       ├── extraction.py        # 日期/人物/金额/任务等结构化提取（带证据 span）
│       ├── retrieval.py         # Hybrid search：FTS5 + 元数据 + 时间（向量接口预留）
│       ├── rag.py               # 证据选择 → 回答 → 引用；无证据拒答
│       ├── tasks.py             # 任务系统
│       ├── audit.py             # operation log + diff + rollback
│       ├── agents.py            # Agent 定义/Runtime/预算/审批
│       ├── summary.py           # 阶段总结（日/周/月/区间）
│       ├── backup.py            # 导出/备份/恢复
│       ├── providers/           # base / mock / openai_compatible（DeepSeek/Qwen 预设）
│       ├── api.py               # FastAPI 服务
│       └── cli.py               # 一条命令闭环
├── mcp_gateway/
│   ├── server.py                # 无状态 JSON-RPC 工具面（对齐 2026-07-28 语义）
│   └── connectors/              # workbuddy.py / wecom.py / ima.py（契约 + mock）
├── plugins/
│   └── obsidian/                # 薄适配层（TS 骨架）：capture/related/backlinks/summary 面板
├── tests/                       # unit + integration + AI-mock 确定性测试
└── e2e/                         # 闭环 E2E（MVP 后补）
```

## 2. I. MVP 功能拆解（最小可运行闭环，§十八.5）

**MVP = Capture → Inbox → AI 分类 → 持久化 → 混合检索(FTS) → 带引用问答 → 建任务 → 审计/回滚。**

| 编号 | 功能 | 范围裁剪 |
|---|---|---|
| MVP-1 | Capture（CLI + HTTP + 文件拖入目录监视） | 仅文本/Markdown/文件 |
| MVP-2 | Inbox + 自动处理（Mock/真实 Provider 皆可） | 分类、摘要、任务提取、关系建议 |
| MVP-3 | SQLite + FTS5 存储 + migration | 单文件库 |
| MVP-4 | 混合检索 | FTS5 + 元数据 + 时间过滤；向量接口预留 |
| MVP-5 | RAG 问答 | 引用到片段（含 offset），无证据拒答 |
| MVP-6 | 任务中心 | 全字段、AI 创建、完成状态 |
| MVP-7 | 审计 + 回滚 | 全 mutation 覆盖 |
| MVP-8 | Agent Runtime | 预算/超时/审批门 |
| MVP-9 | 极简 Web UI | Inbox/Search/QA/Task/Audit 五个视图 |

## 3. 路线图

- **MVP（2–3 周）**：上表闭环 + 测试 + Docker。
- **V1（+4–6 周）**：Obsidian 薄插件、向量检索融合、关系/Graph/Backlinks、阶段总结 + 一键转 Task、Approval Center、备份恢复 UI、MCP Gateway 上线 + WorkBuddy Connector 契约测试。
- **V2（+6–8 周）**：多模态（PDF/图片 OCR/音视频转写）、自定义 Agent UI、移动端 PWA（Capture/Search/Task/AI）、ima Connector、周期自动化面板。

## 4. J/K. 第一阶段任务清单与 Definition of Done

| # | 任务 | Definition of Done |
|---|---|---|
| T1 | db.py：schema + migration 框架 | migration 幂等（跑两次无差异）；全部表/索引/FTS 建成；单测通过 |
| T2 | capture.py：文本/文件入库 | 原始内容字节级保留；content_hash 正确；重复内容只提示 duplicate 不合并；单测通过 |
| T3 | providers：base + Mock + OpenAI-compatible | Mock 完全确定性；真实 Provider 的 key 只从 secret store/env 读取；出站仅命中 allowlist；单测通过 |
| T4 | extraction.py：日期/人物/任务提取 | 每个提取项带 source span(offset)；注入 AI 失败时原始对象不变；单测通过 |
| T5 | pipeline.py：Inbox 自动整理 | 处理时机可配置（立即/手动）；失败对象留 inbox 并标 error；AI 字段与原文分离；单测通过 |
| T6 | retrieval.py：FTS + 元数据 + 时间过滤 | 10 万条种子数据下 P95 < 300ms；过滤条件正确；单测通过 |
| T7 | rag.py：引用问答 | 无证据时返回固定拒答且无编造引用；引用含 object_id+span 可跳回；引用正确性测试通过 |
| T8 | tasks.py：任务系统 | 全字段；AI 创建带 created_by_agent=1；完成/重开有审计；单测通过 |
| T9 | audit.py：日志 + diff + 回滚 | 每种 op(create/update/delete/restore) 可单条回滚；回滚本身也留痕；单测通过 |
| T10 | agents.py：Runtime + 预算 + 审批 | 超限 abort 测试通过；confirm 类动作未批准不落库；run history 可查；单测通过 |
| T11 | api.py + cli.py | 闭环 E2E（capture→process→search→ask→task→rollback）脚本一次通过 |
| T12 | summary.py：区间总结 | 输出含 §十二全部维度；行动建议可转 Task（带 provenance）；单测通过 |
| T13 | backup.py：导出/备份/恢复 | 备份→删除→恢复后数据哈希一致；restore 校验失败拒绝写入；单测通过 |
| T14 | Docker + Makefile | 干净环境 `docker compose up` 可跑；`make test` 全绿 |
| T15 | MCP Gateway 骨架 + Connector 契约 | 工具面注册；契约测试（mock connector）通过；策略拒绝路径有测试 |
| T16 | Obsidian 插件骨架 | manifest + capture 命令 + Related 面板调用 Core API；不进 Obsidian 社区目录（私有部署） |
