"""T2/T4/T5：Capture、提取、Inbox 处理 + 数据防丢失。"""
import json

from personal_agent_core import capture, pipeline


def test_capture_keeps_raw_content(conn):
    text = "明天下午3点前记得给@张三发项目周报 #工作"
    r = capture.capture_text(conn, text)
    row = conn.execute("SELECT * FROM objects WHERE id = ?", (r["id"],)).fetchone()
    assert row["content"] == text          # 原始内容字节级保留
    assert row["lifecycle"] == "inbox"
    assert row["origin"] == "raw"


def test_duplicate_is_suggested_not_merged(conn):
    r1 = capture.capture_text(conn, "重复内容测试12345")
    r2 = capture.capture_text(conn, "重复内容测试12345")
    assert r2["duplicate_of"] == r1["id"]
    rel = conn.execute(
        "SELECT * FROM relations WHERE src_id = ? AND type = 'duplicate_of'", (r2["id"],)
    ).fetchone()
    assert rel["status"] == "suggested"    # 只提示不合并
    # 两条都还在
    assert conn.execute("SELECT COUNT(*) c FROM objects").fetchone()["c"] == 2


def test_process_inbox_classifies_and_extracts_tasks(conn, provider):
    r = capture.capture_text(conn, "会议纪要：下周三 2026-10-14 评审。\n待办：2026-10-10 之前完成方案修订 #项目A")
    out = pipeline.process_inbox(conn, provider)
    assert out[0]["status"] == "processed"
    obj = conn.execute("SELECT * FROM objects WHERE id = ?", (r["id"],)).fetchone()
    assert obj["type"] == "meeting"
    assert obj["origin"] == "ai_extracted"
    assert obj["lifecycle"] == "processed"
    # 原始内容未被 AI 改动
    assert "会议纪要" in obj["content"]
    # 任务被自动创建且带 provenance span
    task = conn.execute("SELECT * FROM tasks WHERE source_object_id = ?", (r["id"],)).fetchone()
    assert task is not None and task["created_by_agent"] == 1
    assert task["due_at"] == "2026-10-10"
    prov = json.loads(task["provenance"])
    s, e = prov["span"]["start"], prov["span"]["end"]
    assert obj["content"][s:e]               # span 可回溯原文
    # 摘要衍生数据带 processor_version
    ext = conn.execute("SELECT * FROM extractions WHERE source_object_id = ? AND kind='summary'", (r["id"],)).fetchone()
    assert ext is not None and ext["processor_version"]


def test_ai_failure_never_loses_raw_data(conn):
    class BrokenProvider:
        name = "broken"
        def classify(self, text): raise RuntimeError("LLM 故障")
        def summarize(self, text): raise RuntimeError("LLM 故障")
        def extract_tasks(self, text): raise RuntimeError("LLM 故障")

    text = "这条内容在 AI 故障时必须原样保留"
    r = capture.capture_text(conn, text)
    out = pipeline.process_inbox(conn, BrokenProvider())
    assert out[0]["status"] == "error"
    obj = conn.execute("SELECT * FROM objects WHERE id = ?", (r["id"],)).fetchone()
    assert obj["content"] == text                # 原始数据不变
    assert obj["lifecycle"] == "inbox"           # 留在 inbox 等待重试
    assert "processing_error" in json.loads(obj["properties"])["ai"]
