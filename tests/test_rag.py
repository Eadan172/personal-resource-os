"""T6/T7：检索过滤 + 引用问答 + 引用正确性 + 无证据拒答。"""
from personal_agent_core import capture, rag, retrieval


def test_search_with_metadata_and_time_filter(conn):
    capture.capture_text(conn, "Python 虚拟机垃圾回收机制笔记", tags=["技术"])
    capture.capture_text(conn, "今晚吃什么菜好", tags=["生活"])
    hits = retrieval.search(conn, "垃圾回收")
    assert len(hits) == 1 and "Python" in hits[0]["title"]
    assert hits[0]["span"]["start"] >= 0
    none = retrieval.search(conn, "垃圾回收", types=["bookmark"])
    assert none == []
    none = retrieval.search(conn, "垃圾回收", start="2099-01-01")
    assert none == []


def test_short_query_fallback(conn):
    capture.capture_text(conn, "咖啡店推荐清单")
    assert retrieval.search(conn, "咖")


def test_ask_with_citations_and_span_correctness(conn, provider):
    r = capture.capture_text(conn, "团队决定使用 SQLite 作为本地存储，理由是零依赖和便于备份。")
    out = rag.ask(conn, provider, "本地存储用什么")
    assert out["evidence_count"] >= 1
    assert out["citations"], "回答必须带来源引用"
    for c in out["citations"]:
        row = conn.execute("SELECT content FROM objects WHERE id = ?", (c["object_id"],)).fetchone()
        s, e = c["span"]["start"], c["span"]["end"]
        assert row["content"][s:e] == c["exact_text"]   # 引用切片与原文完全一致
        assert c["object_id"] == r["id"]


def test_ask_without_evidence_says_unknown(conn, provider):
    out = rag.ask(conn, provider, "火星基地的预算获批了吗")
    assert out["answer"] == rag.NO_EVIDENCE_ANSWER
    assert out["citations"] == []                       # 不得编造引用
