"""IMA（腾讯 ima 知识库）Connector 契约。

定位：外部知识源 / 导入来源（§十四），不是事实源。
已核实：2026-05-28 起 ima 知识库接入 WorkBuddy，知识可被外部 Agent 调用；
开放 API 仍在演进，接入时以官方最新文档为准。

策略：导入即复制进本地库（本地副本为事实源）；不做双向强同步。
"""
CONNECTOR_ID = "ima"
SCOPES = {"allow": ["capture_text", "search", "ask"], "confirm": [], "deny": ["outbound_send"]}
