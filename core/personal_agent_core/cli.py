"""CLI：一条命令跑通 MVP 闭环。

示例：
  python -m personal_agent_core.cli capture "明天下午3点前记得给@张三发项目周报 #工作"
  python -m personal_agent_core.cli process
  python -m personal_agent_core.cli search "项目周报"
  python -m personal_agent_core.cli ask "我明天要做什么？"
  python -m personal_agent_core.cli tasks
  python -m personal_agent_core.cli audit
"""
from __future__ import annotations

import argparse
import json
import sys

from . import audit, backup, capture, db, rag, retrieval, summary, tasks
from .config import load_config, secret_status, set_secret
from .providers import get_provider


def _ctx(args):
    cfg = load_config()
    cfg.ensure_dirs()
    conn = db.init_db(str(cfg.db_path))
    return cfg, conn, get_provider(cfg)


def _print(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="pros", description="Personal Resource OS Core CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("capture"); p.add_argument("content"); p.add_argument("--title"); p.add_argument("--source")
    p = sub.add_parser("file"); p.add_argument("path")
    p = sub.add_parser("ingest", help="采集链接/文件：自动识别 视频/音频/网页/代码")
    p.add_argument("source", help="URL 或本地文件/目录路径")
    p.add_argument("--type", choices=["video", "audio", "html", "code"], help="强制指定类型（默认自动识别）")
    p.add_argument("--mirror", help="P4：强制指定 GitHub 下载镜像前缀（如 https://gh-proxy.com/）")
    p.add_argument("--sha256", help="P4：期望的下载文件 sha256，用于完整性校验")
    p.add_argument("--tags", help="P3：附加标签，逗号分隔")
    p.add_argument("--vault", help="P3：Obsidian vault 目录（采集笔记自动导入该目录的 inbox/）")
    p.add_argument("--max-images", type=int, help="P3：网页正文配图下载上限")
    p.add_argument("--scroll", type=int, help="P3：浏览器渲染滚动次数（抓取深度）")
    p.add_argument("-v", "--verbose", action="store_true", help="输出处理进度到 stderr")
    sub.add_parser("process")
    p = sub.add_parser("search"); p.add_argument("query")
    p = sub.add_parser("ask"); p.add_argument("question")
    p = sub.add_parser("tasks"); p.add_argument("--status")
    p = sub.add_parser("done"); p.add_argument("task_id")
    p = sub.add_parser("audit"); p.add_argument("--limit", type=int, default=20)
    p = sub.add_parser("rollback"); p.add_argument("audit_id")
    p = sub.add_parser("summary"); p.add_argument("--start", required=True); p.add_argument("--end", required=True)
    p = sub.add_parser("export"); p.add_argument("path")
    p = sub.add_parser("backup"); p.add_argument("dir")
    p = sub.add_parser("restore"); p.add_argument("dir"); p.add_argument("--db", required=True)
    p = sub.add_parser("set-key", help="把 API 密钥写入系统凭据库（keyring，P2）")
    p.add_argument("value", help="密钥明文（仅在本地写入凭据库，不落库不进日志）")
    sub.add_parser("key-status", help="查看密钥来源状态（不打印密钥内容）")
    sub.add_parser("serve")

    args = parser.parse_args(argv)
    cfg, conn, provider = _ctx(args)

    if args.cmd == "capture":
        _print(capture.capture_text(conn, args.content, args.title, args.source))
    elif args.cmd == "file":
        _print(capture.capture_file(conn, args.path, cfg.files_dir))
    elif args.cmd == "ingest":
        from .ingest import Progress, ingest
        options = {
            "mirror": args.mirror,
            "sha256": args.sha256,
            "vault": args.vault,
            "scroll": args.scroll,
            "tags": [t.strip() for t in (args.tags or "").split(",") if t.strip()],
        }
        if args.max_images is not None:
            options["max_images"] = args.max_images
        _print(ingest(conn, cfg, provider, args.source, kind=args.type,
                      progress=Progress(args.verbose), options=options))
    elif args.cmd == "process":
        _print(pipeline_results(conn, provider))
    elif args.cmd == "search":
        _print(retrieval.search(conn, args.query))
    elif args.cmd == "ask":
        _print(rag.ask(conn, provider, args.question))
    elif args.cmd == "tasks":
        _print(tasks.list_tasks(conn, args.status))
    elif args.cmd == "done":
        _print({"audit_id": tasks.complete_task(conn, args.task_id)})
    elif args.cmd == "audit":
        _print(audit.history(conn, limit=args.limit))
    elif args.cmd == "rollback":
        _print({"audit_id": audit.rollback(conn, args.audit_id)})
    elif args.cmd == "summary":
        _print(summary.summarize_range(conn, provider, args.start, args.end))
    elif args.cmd == "export":
        _print({"exported": backup.export_json(conn, args.path)})
    elif args.cmd == "backup":
        _print(backup.backup(conn, args.dir))
    elif args.cmd == "restore":
        backup.restore(args.dir, args.db); _print({"restored": args.db})
    elif args.cmd == "set-key":
        _print({"stored": set_secret(cfg.key_env, args.value)})
    elif args.cmd == "key-status":
        _print(secret_status(cfg))
    elif args.cmd == "serve":
        from .api import create_app
        import uvicorn
        uvicorn.run(create_app(cfg, conn, provider), host="127.0.0.1", port=8765)
    return 0


def pipeline_results(conn, provider):
    from . import pipeline
    return pipeline.process_inbox(conn, provider)


if __name__ == "__main__":
    sys.exit(main())
