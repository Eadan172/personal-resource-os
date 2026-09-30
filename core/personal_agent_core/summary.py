"""阶段总结（需求 §十二）：日/周/月/任意区间。

输出维度：发生了什么、主题、新发现、已完成、未完成、人物、决策、风险、下一步行动。
行动建议可一键转 Task。决策评估走可插拔 DecisionEvaluationModel（ADR-007）。
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter

from . import tasks as tasks_mod
from .decision import DecisionEvaluationModel, NullDecisionModel


def summarize_range(
    conn: sqlite3.Connection,
    provider,
    start: str,
    end: str,
    decision_model: DecisionEvaluationModel | None = None,
) -> dict:
    end_exclusive = end + "T23:59:59+00:00" if len(end) == 10 else end
    objs = conn.execute(
        """SELECT * FROM objects WHERE created_at >= ? AND created_at <= ?
           AND lifecycle != 'deleted' ORDER BY created_at""",
        (start, end_exclusive),
    ).fetchall()
    done = conn.execute(
        "SELECT * FROM tasks WHERE completed_at >= ? AND completed_at <= ?", (start, end_exclusive)
    ).fetchall()
    pending = conn.execute("SELECT * FROM tasks WHERE status = 'todo'").fetchall()

    type_counter = Counter(o["type"] for o in objs)
    tag_counter: Counter = Counter()
    people = set()
    for o in objs:
        for t in json.loads(o["tags"] or "[]"):
            tag_counter[t] += 1
        if o["type"] == "person":
            people.add(o["title"])

    decisions = [dict(o) for o in objs if o["type"] == "decision"]
    dm = decision_model or NullDecisionModel()
    decision_assessments = [dm.evaluate(dict(d), {"objects": len(objs)}) for d in decisions]

    return {
        "range": {"start": start, "end": end},
        "what_happened": [{"id": o["id"], "title": o["title"], "type": o["type"]} for o in objs],
        "themes": [t for t, _ in tag_counter.most_common(10)],
        "discoveries": [
            {"id": o["id"], "title": o["title"]}
            for o in objs if o["origin"] in ("ai_extracted", "ai_inferred")
        ],
        "completed": [{"id": t["id"], "title": t["title"]} for t in done],
        "pending": [{"id": t["id"], "title": t["title"], "due_at": t["due_at"]} for t in pending],
        "people": sorted(people),
        "decisions": [{"id": d["id"], "title": d["title"]} for d in decisions],
        "decision_assessments": decision_assessments,
        "risks": [{"id": o["id"], "title": o["title"]} for o in objs if o["type"] == "risk"],
        "next_actions": _suggest_actions(pending, objs),
        "stats": {"objects": len(objs), "by_type": dict(type_counter)},
    }


def _suggest_actions(pending, objs) -> list[dict]:
    actions = [
        {"kind": "follow_up", "title": f"跟进未完成任务：{t['title']}", "task_id": t["id"]}
        for t in pending[:5]
    ]
    inbox_count = sum(1 for o in objs if o["lifecycle"] == "inbox")
    if inbox_count:
        actions.append({"kind": "triage", "title": f"清理 Inbox 中 {inbox_count} 条未处理内容"})
    return actions


def action_to_task(conn: sqlite3.Connection, action: dict, actor: str = "user") -> str:
    """总结中的行动建议一键转 Task（带 provenance）。"""
    return tasks_mod.create_task(
        conn, title=action["title"],
        provenance={"origin": "summary.next_actions", "kind": action.get("kind")},
        actor=actor,
    )
