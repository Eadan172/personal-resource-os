"""T10：Agent 预算 / 审批门 / 工具白名单。"""
from personal_agent_core.agents import AgentDef, decide_approval, run_agent


def test_agent_auto_write_creates_task(conn, provider):
    agent = AgentDef(
        name="t1", purpose="test", instructions="整理",
        allowed_tools=["create_task"],
        approval_policy={"write": "auto", "read": "auto"},
    )
    out = run_agent(conn, provider, agent, "待办：2026-10-01 之前完成报销")
    assert out["status"] == "succeeded"
    assert conn.execute("SELECT COUNT(*) c FROM tasks WHERE title LIKE '%报销%'").fetchone()["c"] == 1


def test_agent_confirm_policy_blocks_until_approved(conn, provider):
    agent = AgentDef(
        name="t2", purpose="test", instructions="整理",
        allowed_tools=["create_task"],
        approval_policy={"write": "confirm"},
    )
    out = run_agent(conn, provider, agent, "待办：2026-10-01 之前完成报销")
    assert out["status"] == "waiting_approval"
    assert conn.execute("SELECT COUNT(*) c FROM tasks").fetchone()["c"] == 0  # 未批准不落库
    ap = conn.execute("SELECT * FROM approvals WHERE agent_run_id=?", (out["run_id"],)).fetchone()
    res = decide_approval(conn, ap["id"], approve=True)
    assert res["status"] == "approved"
    assert conn.execute("SELECT COUNT(*) c FROM tasks").fetchone()["c"] == 1


def test_agent_budget_abort_on_loop(conn, provider):
    agent = AgentDef(
        name="t3", purpose="test", instructions="循环",
        allowed_tools=["search"],
        approval_policy={"read": "auto"},
        budgets={"max_steps": 3, "timeout_s": 60, "max_tokens": 100000},
    )
    out = run_agent(conn, provider, agent, "FORCE_LOOP")
    assert out["status"] == "aborted_budget"
    run = conn.execute("SELECT * FROM agent_runs WHERE id=?", (out["run_id"],)).fetchone()
    assert run["steps"] <= 3


def test_tool_whitelist_enforced(conn, provider):
    class EvilProvider:
        name = "evil"
        def complete(self, messages):
            return {"tool_calls": [{"name": "suggest_relation", "arguments": {"src_id": "a", "dst_id": "b"}}]}
    agent = AgentDef(name="t4", purpose="t", instructions="x", allowed_tools=["search"])
    out = run_agent(conn, EvilProvider(), agent, "hi")
    assert out["status"] == "failed" and "白名单" in out["error"]
