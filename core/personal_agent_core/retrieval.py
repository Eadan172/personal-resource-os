"""混合检索（需求 28-G）：FTS5 + 元数据过滤 + 时间过滤。

MVP：FTS5 trigram（支持中文）+ 过滤 + 规则 rerank；向量接口预留（V1 RRF 融合）。
返回结果带 span，可跳回原文位置（需求 30-D）。
"""
from __future__ import annotations

import sqlite3


def _fts_query(query: str) -> str | None:
    """把自然语言查询拆成 trigram 友好的 OR 查询。

    FTS5 trigram 会对整个短语做隐式 AND，中文长查询会过严；
    这里把每个空白分隔词切成连续 3 字窗口做 OR，提升中文召回。
    """
    terms = []
    for token in query.split():
        if len(token) >= 3:
            terms.extend(token[i:i + 3] for i in range(len(token) - 2))
        else:
            terms.append(token)
    if not terms or max(len(t) for t in terms) < 3:
        return None
    return " OR ".join(f'"{t}"' for t in terms if len(t) >= 3) or None


def _locate_span(content: str, query: str) -> dict:
    idx = content.find(query)
    if idx == -1:
        # 退化：定位查询中最长的连续片段
        for size in range(min(len(query), 12), 1, -1):
            idx = content.find(query[:size])
            if idx != -1:
                return {"start": idx, "end": idx + size}
        return {"start": 0, "end": min(len(content), 60)}
    return {"start": idx, "end": idx + len(query)}


def search(
    conn: sqlite3.Connection,
    query: str,
    types: list[str] | None = None,
    tags: list[str] | None = None,
    start: str | None = None,
    end: str | None = None,
    limit: int = 20,
) -> list[dict]:
    filters = ["o.lifecycle != 'deleted'"]
    params: list = []
    if types:
        filters.append(f"o.type IN ({', '.join('?' for _ in types)})")
        params += types
    if start:
        filters.append("o.created_at >= ?")
        params.append(start)
    if end:
        filters.append("o.created_at <= ?")
        params.append(end + "T23:59:59+00:00" if len(end) == 10 else end)
    for tag in tags or []:
        filters.append("o.tags LIKE ?")
        params.append(f'%"{tag}"%')
    where = " AND ".join(filters)

    rows: list[sqlite3.Row]
    fts_q = _fts_query(query)
    if fts_q:
        rows = conn.execute(
            f"""SELECT o.*, rank AS fts_rank FROM objects_fts f
                JOIN objects o ON o.rowid = f.rowid
                WHERE objects_fts MATCH ? AND {where}
                ORDER BY fts_rank LIMIT ?""",
            (fts_q, *params, limit),
        ).fetchall()
    else:
        like = f"%{query}%"
        rows = conn.execute(
            f"""SELECT o.*, 0.0 AS fts_rank FROM objects o
                WHERE (o.title LIKE ? OR o.content LIKE ?) AND {where}
                ORDER BY o.created_at DESC LIMIT ?""",
            (like, like, *params, limit),
        ).fetchall()

    results = []
    for r in rows:
        obj = dict(r)
        span = _locate_span(obj["content"], query)
        snippet = obj["content"][max(0, span["start"] - 20): span["end"] + 40]
        results.append({
            "object_id": obj["id"], "type": obj["type"], "title": obj["title"],
            "snippet": snippet, "span": span, "score": -obj.get("fts_rank", 0.0),
            "created_at": obj["created_at"],
        })
    return results
