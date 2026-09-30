"""审计 / Diff / 回滚（ADR-005）。

- 所有 mutation 经 record() 记录 before/after 快照。
- rollback() 按 op 取逆；回滚本身也留痕。
- schema 级保护：actor 为 agent 时禁止写 objects.content（原始事实不可被 AI 覆盖）。
"""
from __future__ import annotations

import json
import sqlite3

from .models import new_id, now

# 每张表允许被 update 的字段（白名单）
UPDATABLE_FIELDS = {
    "objects": {
        "type", "title", "content", "source_uri", "origin", "confidence",
        "provenance", "tags", "properties", "data_class",
        "event_time_start", "event_time_end", "lifecycle", "updated_at",
    },
    "tasks": {
        "title", "source_object_id", "due_at", "priority", "status", "project",
        "assignee", "tags", "provenance", "confidence", "created_by_agent",
        "completed_at",
    },
    "relations": {"type", "status", "confidence", "provenance"},
}

# 这些字段 agent 一律不可写（即使通过其他路径调用）
AGENT_FORBIDDEN_FIELDS = {"objects": {"content", "content_hash"}}


def _dump(obj) -> str | None:
    return None if obj is None else json.dumps(obj, ensure_ascii=False, default=str)


def record(
    conn: sqlite3.Connection,
    op: str,
    object_type: str,
    object_id: str,
    before,
    after,
    actor: str,
    agent_run_id: str | None = None,
    reversible: bool = True,
) -> str:
    audit_id = new_id()
    conn.execute(
        """INSERT INTO audit_log (id, op, object_type, object_id, before, after,
                                  actor, agent_run_id, reversible, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (audit_id, op, object_type, object_id, _dump(before), _dump(after),
         actor, agent_run_id, 1 if reversible else 0, now()),
    )
    conn.commit()
    return audit_id


def fetch(conn: sqlite3.Connection, table: str, obj_id: str) -> dict | None:
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (obj_id,)).fetchone()
    return dict(row) if row else None


def apply_update(
    conn: sqlite3.Connection,
    table: str,
    obj_id: str,
    fields: dict,
    actor: str,
    agent_run_id: str | None = None,
) -> str:
    """带审计与权限检查的更新。返回 audit_id。"""
    if table not in UPDATABLE_FIELDS:
        raise ValueError(f"表 {table} 不支持受控更新")
    unknown = set(fields) - UPDATABLE_FIELDS[table]
    if unknown:
        raise ValueError(f"不允许更新的字段: {unknown}")
    if actor.startswith("agent") or actor.startswith("connector"):
        forbidden = set(fields) & AGENT_FORBIDDEN_FIELDS.get(table, set())
        if forbidden:
            raise PermissionError(f"{actor} 禁止修改字段 {forbidden}（原始事实不可被 AI 覆盖）")

    before = fetch(conn, table, obj_id)
    if before is None:
        raise KeyError(f"{table}:{obj_id} 不存在")
    fields = {**fields, "updated_at": now()} if table == "objects" else fields
    assignments = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(
        f"UPDATE {table} SET {assignments} WHERE id = ?",
        (*[json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for v in fields.values()], obj_id),
    )
    conn.commit()
    after = fetch(conn, table, obj_id)
    return record(conn, "update", table, obj_id, before, after, actor, agent_run_id)


def rollback(conn: sqlite3.Connection, audit_id: str, actor: str = "user") -> str:
    """回滚单条审计记录。返回新的审计 id。"""
    entry = conn.execute("SELECT * FROM audit_log WHERE id = ?", (audit_id,)).fetchone()
    if entry is None:
        raise KeyError(f"审计记录 {audit_id} 不存在")
    if not entry["reversible"]:
        raise ValueError("该操作标记为不可逆")
    op, table, obj_id = entry["op"], entry["object_type"], entry["object_id"]
    before = json.loads(entry["before"]) if entry["before"] else None
    rollback_actor = f"rollback:{actor}"

    if op == "create":
        if table == "objects":
            # create 的逆 = 软删除（可再恢复）
            current = fetch(conn, table, obj_id)
            conn.execute("UPDATE objects SET lifecycle = 'deleted', updated_at = ? WHERE id = ?", (now(), obj_id))
            conn.commit()
            return record(conn, "delete", table, obj_id, current, fetch(conn, table, obj_id), rollback_actor)
        conn.execute(f"DELETE FROM {table} WHERE id = ?", (obj_id,))
        conn.commit()
        return record(conn, "delete", table, obj_id, before, None, rollback_actor)

    if op == "update":
        fields = {k: before[k] for k in UPDATABLE_FIELDS[table] if k in before}
        assignments = ", ".join(f"{k} = ?" for k in fields)
        current = fetch(conn, table, obj_id)
        conn.execute(
            f"UPDATE {table} SET {assignments} WHERE id = ?",
            (*[json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v for v in fields.values()], obj_id),
        )
        conn.commit()
        return record(conn, "update", table, obj_id, current, fetch(conn, table, obj_id), rollback_actor)

    if op == "delete":
        if table == "objects":
            current = fetch(conn, table, obj_id)
            conn.execute(
                "UPDATE objects SET lifecycle = ?, updated_at = ? WHERE id = ?",
                (before.get("lifecycle", "inbox"), now(), obj_id),
            )
            conn.commit()
            return record(conn, "restore", table, obj_id, current, fetch(conn, table, obj_id), rollback_actor)
        # 其他表：从快照重建
        cols = ", ".join(before.keys())
        conn.execute(
            f"INSERT OR REPLACE INTO {table} ({cols}) VALUES ({', '.join('?' for _ in before)})",
            tuple(before.values()),
        )
        conn.commit()
        return record(conn, "restore", table, obj_id, None, before, rollback_actor)

    raise ValueError(f"不支持的回滚 op: {op}")


def history(conn: sqlite3.Connection, object_type: str | None = None, object_id: str | None = None, limit: int = 100):
    sql = "SELECT * FROM audit_log"
    cond, params = [], []
    if object_type:
        cond.append("object_type = ?")
        params.append(object_type)
    if object_id:
        cond.append("object_id = ?")
        params.append(object_id)
    if cond:
        sql += " WHERE " + " AND ".join(cond)
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in conn.execute(sql, params).fetchall()]
