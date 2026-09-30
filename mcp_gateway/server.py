"""MCP Gateway 骨架（ADR-006，对齐 MCP 2026-07-28 无状态语义）。

- 无状态：每个请求自包含，无会话。
- server/discover：能力发现。
- tools/list / tools/call：工具面；按 connector 做 per-tool 策略（对照 Mcp-Method/Mcp-Name 路由头）。
- 所有调用经 Policy 判定并留审计（actor=connector:<name>）。
- Connector 输入一律标记 untrusted。
"""
from __future__ import annotations

import json
import sys

from personal_agent_core import capture, rag, retrieval, tasks

# Connector 注册表：每个 connector 独立权限范围（§十四：独立 secret、最小权限）
CONNECTORS = {
    "workbuddy": {"allow": ["capture_text", "search", "ask", "list_tasks", "create_task"],
                   "confirm": ["create_task"]},
    "wecom": {"allow": ["capture_text", "search"], "confirm": []},  # 默认只读 + capture
    "ima": {"allow": ["capture_text", "search", "ask"], "confirm": []},
}

TOOLS = {
    "capture_text": lambda conn, a, connector: capture.capture_text(
        conn, a["content"], source_uri=f"connector:{connector}", actor=f"connector:{connector}"),
    "search": lambda conn, a, connector: retrieval.search(conn, a["query"]),
    "ask": lambda conn, a, connector: rag.ask(conn, _provider, a["question"]),
    "list_tasks": lambda conn, a, connector: tasks.list_tasks(conn, a.get("status")),
    "create_task": lambda conn, a, connector: tasks.create_task(
        conn, a["title"], due_at=a.get("due_at"), actor=f"connector:{connector}"),
}

_provider = None  # 由 attach() 注入


def attach(provider):
    global _provider
    _provider = provider


def discover() -> dict:
    return {
        "protocolVersion": "2026-07-28",
        "server": {"name": "pros-mcp-gateway", "version": "0.1.0"},
        "capabilities": {"tools": sorted(TOOLS)},
    }


def call_tool(conn, connector: str, tool: str, arguments: dict) -> dict:
    spec = CONNECTORS.get(connector)
    if spec is None:
        return {"error": f"未知 connector: {connector}"}
    if tool not in TOOLS or tool not in spec["allow"]:
        return {"error": f"策略拒绝：connector {connector} 无权调用 {tool}", "policy": "denied"}
    if tool in spec["confirm"]:
        # 对齐 MRTR 审批语义：返回待审批，由 Approval Center 决定后重放
        return {"status": "requires_approval", "tool": tool, "arguments": arguments}
    try:
        return {"result": TOOLS[tool](conn, arguments, connector)}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def handle_request(conn, req: dict) -> dict:
    """无状态 JSON-RPC 请求处理。"""
    method, rid = req.get("method"), req.get("id")
    params = req.get("params", {})
    if method == "server/discover":
        return {"jsonrpc": "2.0", "id": rid, "result": discover()}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": sorted(TOOLS)}}
    if method == "tools/call":
        result = call_tool(conn, params.get("connector", ""), params.get("name", ""),
                           params.get("arguments", {}))
        return {"jsonrpc": "2.0", "id": rid, "result": result}
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"unknown method {method}"}}


def run_stdio(conn) -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        resp = handle_request(conn, json.loads(line))
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()
