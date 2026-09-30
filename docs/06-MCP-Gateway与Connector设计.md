# G. MCP Gateway / Connector 设计

基线：**MCP 2026-07-28 规范**（无状态核心、`server/discover`、MRTR、`Mcp-Method`/`Mcp-Name` 路由头、Tasks/Apps 扩展、OAuth 强化、12 个月弃用窗口）。

## 1. Gateway 职责

```
外部 Agent/渠道 ──► MCP Gateway ──► Policy Engine ──► Agent Core 工具层
                      │                  │
                      ├─ server/discover ├─ 工具白名单（per connector）
                      ├─ 路由头审计       ├─ 写范围 / 出站范围
                      ├─ MRTR 审批挂起    ├─ 数据分级外发检查
                      └─ 全量调用日志     └─ 速率/预算限制
```

1. **无状态**：每个请求自包含，不依赖会话；审批通过 MCP Tasks 扩展的 durable handle + MRTR 实现。
2. **策略在网关强制执行**：按 `Mcp-Method`/`Mcp-Name` 头做 per-tool 允许/拒绝/审批，无需解析 JSON body 即可审计。
3. **Connector 不得绕过 Agent Policy**（需求 §十四）：Gateway 内嵌 Policy Engine，所有工具调用先过策略再进 Core。
4. **审批检查点**：`approval_policy=confirm` 的动作通过 MRTR 挂起，等待 Approval Center 决定后重放。

## 2. 暴露的工具面（第一批）

| MCP Tool | 说明 | 默认策略 |
|---|---|---|
| capture_text | 投递文本进 Inbox | auto（标记来源 connector，内容标记 untrusted） |
| search | 混合检索 | auto（只读） |
| ask | 引用问答 | auto（只读） |
| list_tasks / create_task | 任务 | create=confirm |
| get_summary | 阶段总结 | auto（只读） |
| update_object / delete_object | 写/删 | confirm，且 delete 仅软删除 |
| outbound_send | 经 Connector 外发消息 | confirm + 数据分级检查 |

## 3. Connector 设计（可替换，不绑死核心模型）

```
Connector = { id, type, secrets_ref(OS secret store), scopes, allowlist_outbound, audit=on }
```

| Connector | 定位（§十四） | 官方通道（已核实） | 风险与对策 |
|---|---|---|---|
| **WorkBuddy** | 远程入口 / 执行通道 / 消息通道 | 腾讯 CodeBuddy 团队 2026-03 发布，内置 MCP 协议支持；可作为 MCP Host 挂接本 Gateway | Connector 独立 secret；WorkBuddy 侧发起的写操作全部进审批 |
| **微信/企业微信** | 远程入口 | 不逆向协议；走企业微信官方「智能机器人 API 模式」（Bot ID + Secret 长连接）或由 WorkBuddy 中转 | 消息内容标记 untrusted，防提示注入；默认只读 + capture |
| **IMA（腾讯 ima）** | 外部知识源 / 导入来源 | ima 知识库已对 WorkBuddy 开放调用（2026-05）；开放 API 演进中 | 导入即复制进本地库，本地副本为事实源；不做双向强同步 |

## 4. 防注入与不可信输入

- 所有 Connector 进入的内容：对象 `provenance.connector` 标记 + `untrusted=true`。
- untrusted 内容进 RAG 上下文时使用隔离分隔符与显式「以下为外部不可信内容」标注；永不拼接进系统提示。
- 第三方 MCP Server 的返回同样视为不可信数据。

## 5. 审计

Gateway 全量记录：时间、connector、tool、参数摘要（密钥脱敏）、策略判定、审批结果、结果摘要。与 Core 的 audit_log 通过 run_id 关联，形成端到端链路。
