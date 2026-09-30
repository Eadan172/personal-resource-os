"""任务系统（需求 §十一）。全字段 + 审计 + AI 创建标记。"""
from __future__ import annotations

import json
import sqlite3

from . import audit
from .models import new_id, now


def create_task(
    conn: sqlite3.Connection,
    title: str,
    source_object_id: str | None = None,
    due_at: str | None = None,
    priority: str = "P2",
    project: str | None = None,
    assignee: str | None = None,
    tags: list[str] | None = None,
    provenance: dict | None = None,
    confidence: float = 1.0,
    actor: str = "user",
    agent_run_id: str | None = None,
) -> str:
    task_id = new_id()
    rec = {
        "id": task_id, "title": title, "source_object_id": source_object_id,
        "due_at": due_at, "priority": priority, "status": "todo",
        "project": project, "assignee": assignee,
        "tags": json.dumps(tags or [], ensure_ascii=False),
        "provenance": json.dumps(provenance or {}, ensure_ascii=False),
        "confidence": confidence,
        "created_by_agent": 1 if actor.startswith("agent") else 0,
        "created_at": now(), "completed_at": None,
    }
    conn.execute(
        """INSERT INTO tasks (id, title, source_object_id, due_at, priority, status, project,
                              assignee, tags, provenance, confidence, created_by_agent,
                              created_at, completed_at)
           VALUES (:id, :title, :source_object_id, :due_at, :priority, :status, :project,
                   :assignee, :tags, :provenance, :confidence, :created_by_agent,
                   :created_at, :completed_at)""",
        rec,
    )
    conn.commit()
    audit.record(conn, "create", "tasks", task_id, None, rec, actor, agent_run_id)
    return task_id


def list_tasks(conn: sqlite3.Connection, status: str | None = None) -> list[dict]:
    if status:
        rows = conn.execute("SELECT * FROM tasks WHERE status = ? ORDER BY due_at IS NULL, due_at", (status,))
    else:
        rows = conn.execute("SELECT * FROM tasks ORDER BY status = 'done', due_at IS NULL, due_at")
    return [dict(r) for r in rows.fetchall()]


def complete_task(conn: sqlite3.Connection, task_id: str, actor: str = "user") -> str:
    return audit.apply_update(conn, "tasks", task_id,
                              {"status": "done", "completed_at": now()}, actor)


def reopen_task(conn: sqlite3.Connection, task_id: str, actor: str = "user") -> str:
    return audit.apply_update(conn, "tasks", task_id,
                              {"status": "todo", "completed_at": None}, actor)
