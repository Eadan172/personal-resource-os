"""RAG 问答（需求 29-E / 30-D）。

流程：Query → Hybrid Retrieval → Evidence selection → Answer → Citation。
铁律：无证据明确说不知道；引用 span 必须与原文切片完全一致（citation correctness）。
"""
from __future__ import annotations

import re
import sqlite3

from . import retrieval

NO_EVIDENCE_ANSWER = "我没有在资料库中找到可回答该问题的证据。"

_CITE_RE = re.compile(r"\[(\d+)\]")


def ask(conn: sqlite3.Connection, provider, question: str, limit: int = 5) -> dict:
    hits = retrieval.search(conn, question, limit=limit)
    if not hits:
        return {"answer": NO_EVIDENCE_ANSWER, "citations": [], "evidence_count": 0}

    evidence = []
    for h in hits:
        row = conn.execute("SELECT content, title FROM objects WHERE id = ?", (h["object_id"],)).fetchone()
        s, e = h["span"]["start"], h["span"]["end"]
        # 证据片段：以 span 为中心扩展窗口，但引用 span 保持精确
        chunk = row["content"][max(0, s - 60): min(len(row["content"]), e + 120)]
        evidence.append({"object_id": h["object_id"], "title": row["title"],
                         "chunk": chunk, "span": h["span"]})

    answer = provider.answer(question, [e["chunk"] for e in evidence])

    # 只保留回答中实际引用的编号，且校验 span 切片来自原文
    citations = []
    for n in sorted({int(m.group(1)) for m in _CITE_RE.finditer(answer)}):
        if 1 <= n <= len(evidence):
            ev = evidence[n - 1]
            row = conn.execute("SELECT content FROM objects WHERE id = ?", (ev["object_id"],)).fetchone()
            s, t = ev["span"]["start"], ev["span"]["end"]
            exact = row["content"][s:t]
            citations.append({
                "n": n, "object_id": ev["object_id"], "title": ev["title"],
                "span": ev["span"], "exact_text": exact,  # 点击可跳回原文位置
            })
    return {"answer": answer, "citations": citations, "evidence_count": len(evidence)}
