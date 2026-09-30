"""Capture Pipeline（需求 19-H / 20-C）：一切输入统一进 Inbox。

- 原始内容字节级保留；AI 失败不得丢数据（22-C）。
- 重复内容只提示 duplicate_of（suggested），默认不合并（17-B）。
"""
from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

from . import audit
from .models import new_id, now, sha256_text


def capture_text(
    conn: sqlite3.Connection,
    content: str,
    title: str | None = None,
    source_uri: str | None = None,
    tags: list[str] | None = None,
    actor: str = "user",
    data_class: str = "internal",
) -> dict:
    if not content.strip():
        raise ValueError("内容为空")
    import json

    obj_id = new_id()
    ts = now()
    title = title or content.strip().splitlines()[0][:60]
    content_hash = sha256_text(content)
    record = {
        "id": obj_id, "type": "note", "title": title, "content": content,
        "source_uri": source_uri, "content_hash": content_hash,
        "origin": "raw", "confidence": 1.0, "provenance": "{}",
        "tags": json.dumps(tags or [], ensure_ascii=False),
        "properties": "{}", "data_class": data_class,
        "lifecycle": "inbox", "created_at": ts, "updated_at": ts,
    }
    conn.execute(
        """INSERT INTO objects (id, type, title, content, source_uri, content_hash, origin,
                                confidence, provenance, tags, properties, data_class,
                                lifecycle, created_at, updated_at)
           VALUES (:id, :type, :title, :content, :source_uri, :content_hash, :origin,
                   :confidence, :provenance, :tags, :properties, :data_class,
                   :lifecycle, :created_at, :updated_at)""",
        record,
    )
    conn.commit()
    audit.record(conn, "create", "objects", obj_id, None, record, actor)

    # 重复检测：只提示，不合并
    dup = conn.execute(
        "SELECT id FROM objects WHERE content_hash = ? AND id != ? AND lifecycle != 'deleted'",
        (content_hash, obj_id),
    ).fetchone()
    if dup:
        conn.execute(
            """INSERT INTO relations (id, src_id, dst_id, type, status, confidence, provenance, created_at)
               VALUES (?, ?, ?, 'duplicate_of', 'suggested', 1.0, '{}', ?)""",
            (new_id(), obj_id, dup["id"], ts),
        )
        conn.commit()
    return {"id": obj_id, "title": title, "duplicate_of": dup["id"] if dup else None}


def capture_file(conn: sqlite3.Connection, path: str, files_dir: Path, actor: str = "user") -> dict:
    """文件拖入：原始文件复制进文件仓库（永不丢失），文本内容进库。"""
    src = Path(path)
    if not src.is_file():
        raise FileNotFoundError(path)
    stored = files_dir / f"{new_id()}-{src.name}"
    shutil.copy2(src, stored)
    try:
        content = src.read_text(encoding="utf-8", errors="replace")
    except OSError:
        content = ""
    result = capture_text(
        conn, content or src.name, title=src.name,
        source_uri=str(stored), actor=actor,
    )
    import json

    audit.apply_update(conn, "objects", result["id"], {
        "type": "document",
        "properties": {"original_path": str(src), "stored_path": str(stored)},
    }, actor)
    return result
