"""核心领域模型常量与基础工具。

统一 Object Model（需求 §九）。五类 origin 严格区分：
raw（原始事实）/ user_edit / ai_extracted / ai_inferred / ai_suggested。
AI 推断不得伪装成事实。
"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone

OBJECT_TYPES = (
    "note", "idea", "task", "person", "project", "event", "bookmark",
    "document", "meeting", "conversation", "topic", "concept",
    "decision", "risk", "money", "location",
)

RELATION_TYPES = (
    "related_to", "mentions", "belongs_to", "assigned_to", "depends_on",
    "derived_from", "contradicts", "supports", "duplicate_of", "references",
)

# 数据来源分级：决定 AI/UI 如何展示与是否允许外发
ORIGINS = ("raw", "user_edit", "ai_extracted", "ai_inferred", "ai_suggested")

# 数据外发分级（docs/03 §4）：private 默认禁止外发
DATA_CLASSES = ("public", "internal", "private")

LIFECYCLES = ("inbox", "processed", "archived", "deleted")

TASK_PRIORITIES = ("P0", "P1", "P2", "P3")
TASK_STATUSES = ("todo", "doing", "done", "cancelled")


def new_id() -> str:
    """时间有序友好的唯一 id。"""
    return uuid.uuid4().hex


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()
