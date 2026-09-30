# ADR-006 MCP Gateway 对齐 2026-07-28 规范

- 状态：已接受  日期：2026-09-29
- 决定：Gateway 按无状态核心实现：每请求自包含、实现 server/discover、使用 Mcp-Method/Mcp-Name 路由头做策略与审计、审批用 MRTR/Tasks 语义（长时操作返回 durable handle）。不实现已进 12 个月弃用窗口的 Roots/Sampling/Logging 旧语义。
- 理由：2026-07-28 是发布以来最大修订且为主流方向（Linux Foundation 托管，官方 TS/Python SDK 已配套）；直接按新版避免二次迁移。
- 后果：与旧版 host 互通需兼容层（暂不做，记录在案）。
