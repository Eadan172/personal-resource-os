"""确定性结构化提取（需求 32-J）。

所有提取项带 source span（start/end 偏移），保证可回溯到原文（需求 18-C）。
Mock Provider 与离线模式复用本模块；真实 LLM 提取也必须返回相同结构。
"""
from __future__ import annotations

import re
from datetime import date, timedelta

_DATE_RE = re.compile(r"(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?")
_MONEY_RE = re.compile(r"[¥￥$]\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?元")
_MENTION_RE = re.compile(r"@([\w一-鿿]+)")
_TAG_RE = re.compile(r"#([\w一-鿿/]+)")
_TASK_HINT = re.compile(r"待办|TODO|记得|需要|务必|尽快|截止|之前完成|别忘了")
_URGENT_HINT = re.compile(r"紧急|重要|务必|ASAP|asap")
_RELATIVE_DAYS = {"今天": 0, "明天": 1, "后天": 2}


def _span(m: re.Match) -> dict:
    return {"start": m.start(), "end": m.end()}


def find_dates(text: str, base: date | None = None) -> list[dict]:
    base = base or date.today()
    out = []
    for m in _DATE_RE.finditer(text):
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            out.append({"value": date(y, mo, d).isoformat(), **_span(m)})
        except ValueError:
            continue
    for word, delta in _RELATIVE_DAYS.items():
        for m in re.finditer(word, text):
            out.append({"value": (base + timedelta(days=delta)).isoformat(), **_span(m)})
    return out


def find_money(text: str) -> list[dict]:
    return [
        {"value": m.group(1) or m.group(2), "currency": "CNY" if "元" in m.group(0) or "¥" in m.group(0) or "￥" in m.group(0) else "USD", **_span(m)}
        for m in _MONEY_RE.finditer(text)
    ]


def find_mentions(text: str) -> list[dict]:
    return [{"value": m.group(1), **_span(m)} for m in _MENTION_RE.finditer(text)]


def find_tags(text: str) -> list[dict]:
    return [{"value": m.group(1), **_span(m)} for m in _TAG_RE.finditer(text)]


def find_task_lines(text: str, base: date | None = None) -> list[dict]:
    """从文本中找任务候选行，附带行内日期作为 due_at、紧急词作为优先级。"""
    tasks = []
    offset = 0
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        if stripped and _TASK_HINT.search(stripped):
            dates = find_dates(stripped, base)
            tasks.append({
                "title": stripped.lstrip("-* ").rstrip("。"),
                "due_at": dates[0]["value"] if dates else None,
                "priority": "P0" if _URGENT_HINT.search(stripped) else "P2",
                "span": {"start": offset + (len(line) - len(line.lstrip())), "end": offset + len(line.rstrip("\n"))},
            })
        offset += len(line)
    return tasks
