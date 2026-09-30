"""WorkBuddy Connector 契约（腾讯 CodeBuddy 团队，2026-03 发布，内置 MCP 支持）。

定位：远程入口 / 执行通道 / 消息通道（§十四）。
接入方式：WorkBuddy 作为 MCP Host 挂接本 Gateway（tools/list / tools/call）。
凭证：独立 secret，存 OS secret store，经环境变量注入。
约束：写操作默认走审批（confirm）；消息内容标记 untrusted。

V1 待办：接入时以官方最新文档核对 MCP 能力面与鉴权方式（契约测试先行）。
"""
CONNECTOR_ID = "workbuddy"
SCOPES = {"allow": ["capture_text", "search", "ask", "list_tasks", "create_task"],
          "confirm": ["create_task"], "deny": ["delete_object", "outbound_send"]}
