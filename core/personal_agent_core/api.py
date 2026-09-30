"""HTTP API（FastAPI，可选依赖）。只监听 127.0.0.1（TB-1 边界）。"""
from __future__ import annotations

try:
    from fastapi import FastAPI
    from pydantic import BaseModel
except ImportError:  # 离线最小环境可无 FastAPI 运行 CLI
    FastAPI = None
    BaseModel = object


def create_app(cfg, conn, provider):
    if FastAPI is None:
        raise RuntimeError("FastAPI 未安装；可继续使用 CLI（python -m personal_agent_core.cli）")
    from . import audit, capture, pipeline, rag, retrieval, summary, tasks

    app = FastAPI(title="Personal Resource OS Core", version="0.1.0")

    class CaptureIn(BaseModel):
        content: str
        title: str | None = None
        source_uri: str | None = None

    class AskIn(BaseModel):
        question: str

    class IngestIn(BaseModel):
        source: str                 # URL 或本地文件/目录路径
        type: str | None = None     # video | audio | html | code，缺省自动识别
        mirror: str | None = None   # P4：强制 GitHub 镜像
        sha256: str | None = None   # P4：期望校验值
        vault: str | None = None    # P3：Obsidian vault 目录
        tags: list[str] | None = None
        scroll: int | None = None   # P3：抓取深度

    class TaskIn(BaseModel):
        title: str
        due_at: str | None = None
        priority: str = "P2"

    @app.post("/capture")
    def api_capture(body: CaptureIn):
        return capture.capture_text(conn, body.content, body.title, body.source_uri)

    @app.get("/inbox")
    def api_inbox():
        rows = conn.execute("SELECT id, title, type, created_at FROM objects WHERE lifecycle='inbox'").fetchall()
        return [dict(r) for r in rows]

    @app.post("/ingest")
    def api_ingest(body: IngestIn):
        """采集链接/文件（视频/音频/网页/代码），统一进 Inbox。原始文件保存在 data/resources/。"""
        from .ingest import ingest
        options = {"mirror": body.mirror, "sha256": body.sha256, "vault": body.vault,
                   "tags": body.tags or [], "scroll": body.scroll}
        return ingest(conn, cfg, provider, body.source, kind=body.type, options=options)

    @app.post("/process")
    def api_process():
        return pipeline.process_inbox(conn, provider)

    @app.get("/search")
    def api_search(q: str):
        return retrieval.search(conn, q)

    @app.post("/ask")
    def api_ask(body: AskIn):
        return rag.ask(conn, provider, body.question)

    @app.get("/tasks")
    def api_tasks(status: str | None = None):
        return tasks.list_tasks(conn, status)

    @app.post("/tasks")
    def api_create_task(body: TaskIn):
        return {"id": tasks.create_task(conn, body.title, due_at=body.due_at, priority=body.priority)}

    @app.post("/tasks/{task_id}/done")
    def api_done(task_id: str):
        return {"audit_id": tasks.complete_task(conn, task_id)}

    @app.get("/audit")
    def api_audit(limit: int = 50):
        return audit.history(conn, limit=limit)

    @app.post("/rollback/{audit_id}")
    def api_rollback(audit_id: str):
        return {"audit_id": audit.rollback(conn, audit_id)}

    @app.get("/summary")
    def api_summary(start: str, end: str):
        return summary.summarize_range(conn, provider, start, end)

    return app
