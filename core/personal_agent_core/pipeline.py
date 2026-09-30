"""Inbox 自动处理管道（需求 20-C / 21 / 22-C）。

分类 → 摘要 → 任务提取 → 关系建议 → lifecycle=processed。
铁律：objects.content 永不被 AI 修改；任何环节失败，对象留 inbox 并标记错误。
"""
from __future__ import annotations

import json
import sqlite3

from . import audit, tasks
from .models import new_id, now, sha256_text

PROCESSOR_VERSION = "pipeline/0.1.0"


def process_object(conn: sqlite3.Connection, provider, obj_id: str, actor: str = "agent:inbox-organizer") -> dict:
    row = conn.execute("SELECT * FROM objects WHERE id = ?", (obj_id,)).fetchone()
    if row is None:
        raise KeyError(obj_id)
    obj = dict(row)
    try:
        classification = provider.classify(obj["content"])
        summary = provider.summarize(obj["content"])
        found_tasks = provider.extract_tasks(obj["content"])

        # 1) AI 结果写 properties.ai（与原文分离），origin=ai_extracted
        props = json.loads(obj["properties"] or "{}")
        props["ai"] = {
            "classification": classification,
            "processed_at": now(),
            "origin": "ai_extracted",
        }
        audit.apply_update(conn, "objects", obj_id, {
            "type": classification.get("type", obj["type"]),
            "properties": props,
            "confidence": float(classification.get("confidence", 0.5)),
            "origin": "ai_extracted",
            "lifecycle": "processed",
        }, actor)

        # 2) 摘要作为衍生数据（带 processor_version）
        conn.execute(
            """INSERT INTO extractions (id, source_object_id, kind, content, content_hash,
                                        processor, processor_version, created_at)
               VALUES (?, ?, 'summary', ?, ?, ?, ?, ?)""",
            (new_id(), obj_id, summary, sha256_text(summary), provider.name,
             PROCESSOR_VERSION, now()),
        )
        conn.commit()

        # 3) 任务提取（带证据 span，可回溯原文）
        for t in found_tasks:
            tasks.create_task(
                conn, title=t["title"], source_object_id=obj_id,
                due_at=t.get("due_at"), priority=t.get("priority", "P2"),
                provenance={"source_object_id": obj_id, "span": t.get("span"),
                            "processor": provider.name},
                confidence=0.8, actor=actor,
            )

        # 4) 关系建议（只写 suggested，不自动确认）
        _suggest_relations(conn, obj_id, obj["content"], actor)
        return {"id": obj_id, "status": "processed", "tasks": len(found_tasks)}

    except Exception as exc:  # noqa: BLE001 — 失败安全：原始数据不受影响
        props = json.loads(obj["properties"] or "{}")
        props.setdefault("ai", {})["processing_error"] = str(exc)
        audit.apply_update(conn, "objects", obj_id, {"properties": props}, actor)
        return {"id": obj_id, "status": "error", "error": str(exc)}


def _suggest_relations(conn: sqlite3.Connection, obj_id: str, content: str, actor: str) -> None:
    """共现引用建议：正文中出现其他对象标题 → references（suggested）。"""
    others = conn.execute(
        "SELECT id, title FROM objects WHERE id != ? AND lifecycle != 'deleted'", (obj_id,)
    ).fetchall()
    for other in others:
        title = other["title"]
        if len(title) >= 3 and title in content:
            start = content.find(title)
            conn.execute(
                """INSERT INTO relations (id, src_id, dst_id, type, status, confidence,
                                          provenance, created_at)
                   VALUES (?, ?, ?, 'references', 'suggested', 0.6, ?, ?)""",
                (new_id(), obj_id, other["id"],
                 json.dumps({"span": {"start": start, "end": start + len(title)},
                             "origin": "ai_suggested"}, ensure_ascii=False), now()),
            )
    conn.commit()


def process_inbox(conn: sqlite3.Connection, provider, limit: int = 50) -> list[dict]:
    rows = conn.execute(
        "SELECT id FROM objects WHERE lifecycle = 'inbox' ORDER BY created_at LIMIT ?", (limit,)
    ).fetchall()
    return [process_object(conn, provider, r["id"]) for r in rows]
