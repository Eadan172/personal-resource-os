"""T1/T8/T12/T13/T15：migration 幂等、任务、总结、备份恢复、Gateway 策略。"""
import json
import sqlite3
from pathlib import Path

import pytest

from personal_agent_core import backup, capture, db, summary, tasks
from mcp_gateway import server as gw


def test_migration_idempotent(tmp_path):
    path = str(tmp_path / "m.db")
    c1 = db.init_db(path)
    v1 = db.migrate(c1)
    c1.close()
    c2 = db.init_db(path)     # 重复初始化不出错
    assert db.migrate(c2) == v1
    c2.close()


def test_task_lifecycle(conn):
    tid = tasks.create_task(conn, "写月报", due_at="2026-10-01", priority="P1")
    tasks.complete_task(conn, tid)
    t = conn.execute("SELECT * FROM tasks WHERE id=?", (tid,)).fetchone()
    assert t["status"] == "done" and t["completed_at"]
    tasks.reopen_task(conn, tid)
    assert conn.execute("SELECT status FROM tasks WHERE id=?", (tid,)).fetchone()["status"] == "todo"


def test_summary_dimensions(conn, provider):
    from personal_agent_core import pipeline
    capture.capture_text(conn, "今天评审了新架构方案，风险：进度可能延期 #架构")
    pipeline.process_inbox(conn, provider)   # 让 AI 分类生效（risk 类型）
    tid = tasks.create_task(conn, "补充压测数据")
    tasks.complete_task(conn, tid)
    out = summary.summarize_range(conn, provider, "2000-01-01", "2100-01-01")
    for key in ("what_happened", "themes", "discoveries", "completed", "pending",
                "people", "decisions", "decision_assessments", "risks", "next_actions"):
        assert key in out
    assert out["completed"][0]["title"] == "补充压测数据"
    assert out["risks"]                      # 风险维度有内容
    new_tid = summary.action_to_task(conn, {"kind": "triage", "title": "清理 Inbox"})
    assert conn.execute("SELECT provenance FROM tasks WHERE id=?", (new_tid,)).fetchone()["provenance"]


def test_backup_restore_roundtrip(conn, provider, tmp_path):
    capture.capture_text(conn, "备份恢复一致性测试内容")
    conn2 = db.init_db(str(tmp_path / "b.db"))
    # 用另一个连接模拟目标库备份
    from personal_agent_core.backup import backup as do_backup, restore
    result = do_backup(conn, str(tmp_path / "backups"))
    target = tmp_path / "restored.db"
    restore(result["backup_dir"], str(target))
    r = sqlite3.connect(str(target))
    assert r.execute("SELECT COUNT(*) c FROM objects WHERE content LIKE '%备份恢复一致性%'").fetchone()[0] == 1
    r.close()
    # 篡改备份 → 拒绝恢复
    bd = Path(result["backup_dir"])
    (bd / "export.json").write_text("corrupted", encoding="utf-8")
    with pytest.raises(ValueError):
        restore(str(bd), str(tmp_path / "x.db"))


def test_gateway_policy_and_capture(conn, provider):
    gw.attach(provider)
    # 未知 connector 拒绝
    assert "error" in gw.call_tool(conn, "unknown", "search", {"query": "x"})
    # wecom 无权 create_task
    denied = gw.call_tool(conn, "wecom", "create_task", {"title": "x"})
    assert denied.get("policy") == "denied"
    # workbuddy create_task 走审批语义
    pending = gw.call_tool(conn, "workbuddy", "create_task", {"title": "x"})
    assert pending["status"] == "requires_approval"
    # workbuddy capture 直接进 Inbox 且标记来源
    ok = gw.call_tool(conn, "workbuddy", "capture_text", {"content": "来自企微的灵感记录"})
    assert "result" in ok
    row = conn.execute("SELECT * FROM objects WHERE id=?", (ok["result"]["id"],)).fetchone()
    assert row["source_uri"] == "connector:workbuddy" and row["lifecycle"] == "inbox"
    # discover 对齐 2026-07-28
    assert gw.discover()["protocolVersion"] == "2026-07-28"
