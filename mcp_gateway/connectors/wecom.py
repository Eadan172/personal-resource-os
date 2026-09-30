"""企业微信 Connector 契约。

定位：微信生态远程入口。原则：不逆向微信协议（§十四）。
官方通道（已核实 2026-09）：企业微信管理后台「安全与管理 → 管理工具 → 智能机器人
→ 创建机器人 → API 模式 → 使用长连接」，凭证为 Bot ID + Secret。
也可经 WorkBuddy 的企微集成中转。

默认策略：只读 + capture（进 Inbox 并标记 untrusted，防提示注入）。
"""
CONNECTOR_ID = "wecom"
SCOPES = {"allow": ["capture_text", "search"], "confirm": [], "deny": ["create_task", "delete_object", "outbound_send"]}
REQUIRED_SECRETS = ("WECOM_BOT_ID", "WECOM_BOT_SECRET")  # 经 OS secret store / 环境变量注入
