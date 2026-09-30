"""T9：审计 / Diff / 回滚 + Agent 写保护（需求 47-D）。"""
import pytest

from personal_agent_core import audit, capture


def test_update_diff_and_rollback(conn):
    r = capture.capture_text(conn, "原标题内容")
    audit_id = audit.apply_update(conn, "objects", r["id"], {"title": "新标题"}, actor="user")
    assert conn.execute("SELECT title FROM objects WHERE id=?", (r["id"],)).fetchone()["title"] == "新标题"
    audit.rollback(conn, audit_id)
    assert conn.execute("SELECT title FROM objects WHERE id=?", (r["id"],)).fetchone()["title"] == "原标题内容"


def test_create_rollback_is_soft_delete_and_restorable(conn):
    r = capture.capture_text(conn, "将被回滚的创建")
    create_audit = conn.execute(
        "SELECT id FROM audit_log WHERE object_id=? AND op='create'", (r["id"],)
    ).fetchone()["id"]
    del_audit = audit.rollback(conn, create_audit)   # 回滚创建 → 软删除
    assert conn.execute("SELECT lifecycle FROM objects WHERE id=?", (r["id"],)).fetchone()["lifecycle"] == "deleted"
    audit.rollback(conn, del_audit)                  # 再回滚删除 → 恢复
    assert conn.execute("SELECT lifecycle FROM objects WHERE id=?", (r["id"],)).fetchone()["lifecycle"] == "inbox"


def test_agent_cannot_overwrite_raw_content(conn):
    r = capture.capture_text(conn, "原始事实不可被 AI 覆盖")
    with pytest.raises(PermissionError):
        audit.apply_update(conn, "objects", r["id"], {"content": "AI 篡改"}, actor="agent:inbox-organizer")
    assert conn.execute("SELECT content FROM objects WHERE id=?", (r["id"],)).fetchone()["content"] == "原始事实不可被 AI 覆盖"


def test_rollback_is_itself_audited(conn):
    r = capture.capture_text(conn, "审计链测试")
    aid = audit.apply_update(conn, "objects", r["id"], {"title": "改过"}, actor="user")
    audit.rollback(conn, aid)
    actors = [h["actor"] for h in audit.history(conn, "objects", r["id"])]
    assert any(a.startswith("rollback:") for a in actors)
