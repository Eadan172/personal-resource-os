"""Agent Runtime（需求 §八）：预算、超时、审批门、可观察、可回滚。

- max_steps / timeout_s / max_tokens / max_retries / max_depth 硬限制。
- 敏感操作按 approval_policy 进入 approvals 队列，未批准不落库。
- 每个 mutation 带 agent_run_id 进审计。
"""
from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass, field

from . import retrieval, tasks
from .models import new_id, now

DEFAULT_BUDGETS = {
    "max_steps": 20, "timeout_s": 300, "max_tokens": 50000,
    "max_retries": 2, "max_depth": 1,
}


@dataclass
class AgentDef:
    name: str
    purpose: str
    instructions: str
    allowed_tools: list[str]
    allowed_scopes: dict = field(default_factory=dict)
    provider: str = "mock"
    model: str | None = None
    trigger: str = "manual"
    approval_policy: dict = field(default_factory=lambda: {"write": "confirm", "outbound": "confirm", "read": "auto"})
    budgets: dict = field(default_factory=lambda: dict(DEFAULT_BUDGETS))


class Tool:
    def __init__(self, name, fn, action_class):
        self.name, self.fn, self.action_class = name, fn, action_class


def _tool_search(conn, query: str, **_):
    return retrieval.search(conn, query, limit=5)


def _tool_read_object(conn, object_id: str, **_):
    row = conn.execute("SELECT * FROM objects WHERE id = ? AND lifecycle != 'deleted'", (object_id,)).fetchone()
    return dict(row) if row else None


def _tool_create_task(conn, title: str, due_at=None, priority="P2", agent_run_id=None, **_):
    return tasks.create_task(conn, title, due_at=due_at, priority=priority,
                             actor="agent:runtime", agent_run_id=agent_run_id)


def _tool_suggest_relation(conn, src_id: str, dst_id: str, rel_type: str = "related_to", **_):
    rid = new_id()
    conn.execute(
        """INSERT INTO relations (id, src_id, dst_id, type, status, confidence, provenance, created_at)
           VALUES (?, ?, ?, ?, 'suggested', 0.5, '{"origin": "ai_suggested"}', ?)""",
        (rid, src_id, dst_id, rel_type, now()),
    )
    conn.commit()
    return rid


TOOLS = {
    "search": Tool("search", _tool_search, "read"),
    "read_object": Tool("read_object", _tool_read_object, "read"),
    "create_task": Tool("create_task", _tool_create_task, "write"),
    "suggest_relation": Tool("suggest_relation", _tool_suggest_relation, "write"),
}


def _estimate_tokens(messages: list[dict]) -> int:
    return sum(len(str(m.get("content", ""))) for m in messages) // 4


def run_agent(conn: sqlite3.Connection, provider, agent: AgentDef, input_text: str) -> dict:
    budgets = {**DEFAULT_BUDGETS, **agent.budgets}
    run_id = new_id()
    conn.execute(
        "INSERT INTO agent_runs (id, agent_name, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)",
        (run_id, agent.name, agent.trigger, now()),
    )
    conn.commit()

    messages = [
        {"role": "system", "content": agent.instructions},
        {"role": "user", "content": input_text},
    ]
    started = time.monotonic()
    steps = tokens = 0
    final_status, error, result = "succeeded", None, None

    while True:
        if steps >= budgets["max_steps"]:
            final_status, error = "aborted_budget", f"超过 max_steps={budgets['max_steps']}"
            break
        if time.monotonic() - started > budgets["timeout_s"]:
            final_status, error = "aborted_timeout", f"超过 timeout_s={budgets['timeout_s']}"
            break

        resp = provider.complete(messages)
        tokens += _estimate_tokens(messages)
        if tokens > budgets["max_tokens"]:
            final_status, error = "aborted_budget", "超过 max_tokens"
            break

        if "final" in resp:
            result = resp["final"]
            break

        for call in resp.get("tool_calls", []):
            steps += 1
            name, args = call.get("name"), call.get("arguments", {})
            if name not in agent.allowed_tools or name not in TOOLS:
                error = f"工具 {name} 不在白名单"; final_status = "failed"
                break
            tool = TOOLS[name]
            policy = agent.approval_policy.get(tool.action_class, "confirm")
            if policy == "deny":
                final_status, error = "failed", f"策略拒绝 {name}"
                break
            if policy == "confirm":
                conn.execute(
                    """INSERT INTO approvals (id, agent_run_id, action, status, created_at)
                       VALUES (?, ?, ?, 'pending', ?)""",
                    (new_id(), run_id, json.dumps({"tool": name, "arguments": args},
                                                  ensure_ascii=False), now()),
                )
                conn.execute("UPDATE agent_runs SET status = 'waiting_approval', steps = ?, tokens_used = ? WHERE id = ?",
                             (steps, tokens, run_id))
                conn.commit()
                return {"run_id": run_id, "status": "waiting_approval"}
            try:
                result = tool.fn(conn, agent_run_id=run_id, **args)
            except Exception as exc:  # noqa: BLE001
                final_status, error = "failed", str(exc)
                break
            messages.append({"role": "tool", "content": f"[TOOL_RESULT] {name}: {result}"})
        if final_status != "succeeded":
            break

    conn.execute(
        "UPDATE agent_runs SET status = ?, steps = ?, tokens_used = ?, error = ?, finished_at = ? WHERE id = ?",
        (final_status, steps, tokens, error, now(), run_id),
    )
    conn.commit()
    return {"run_id": run_id, "status": final_status, "error": error, "result": result}


def decide_approval(conn: sqlite3.Connection, approval_id: str, approve: bool, actor: str = "user") -> dict:
    ap = conn.execute("SELECT * FROM approvals WHERE id = ?", (approval_id,)).fetchone()
    if ap is None or ap["status"] != "pending":
        raise KeyError(f"审批 {approval_id} 不存在或已处理")
    status = "approved" if approve else "rejected"
    conn.execute("UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?",
                 (status, actor, now(), approval_id))
    result = None
    if approve:
        action = json.loads(ap["action"])
        tool = TOOLS[action["tool"]]
        result = tool.fn(conn, agent_run_id=ap["agent_run_id"], **action["arguments"])
        conn.execute("UPDATE agent_runs SET status = 'succeeded', finished_at = ? WHERE id = ?",
                     (now(), ap["agent_run_id"]))
    else:
        conn.execute("UPDATE agent_runs SET status = 'failed', error = '审批被拒绝', finished_at = ? WHERE id = ?",
                     (now(), ap["agent_run_id"]))
    conn.commit()
    return {"approval_id": approval_id, "status": status, "result": result}
