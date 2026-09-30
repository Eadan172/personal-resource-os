"""导出 / 备份 / 恢复（需求 14-B / 46-D）。

- JSON 全量导出（含 schema_version）。
- 备份：SQLite 在线备份 + manifest（SHA-256 清单）。
- 恢复：先校验 manifest 与 migration 版本，校验失败拒绝写入。
"""
from __future__ import annotations

import json
import shutil
import sqlite3
from pathlib import Path

from . import db
from .models import now, sha256_file

SCHEMA_VERSION = 1
_TABLES = ("objects", "relations", "tasks", "extractions", "audit_log", "agent_runs", "approvals")


def export_json(conn: sqlite3.Connection, path: str) -> str:
    data = {"schema_version": SCHEMA_VERSION, "exported_at": now()}
    for table in _TABLES:
        data[table] = [dict(r) for r in conn.execute(f"SELECT * FROM {table}").fetchall()]
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def backup(conn: sqlite3.Connection, dest_dir: str) -> dict:
    dest = Path(dest_dir) / f"backup-{now().replace(':', '-')}"
    dest.mkdir(parents=True, exist_ok=True)
    db_file = dest / "pros.db"
    target = sqlite3.connect(str(db_file))
    with target:
        conn.backup(target)
    target.close()
    export_json(conn, str(dest / "export.json"))
    manifest = {
        "created_at": now(), "schema_version": SCHEMA_VERSION,
        "files": {p.name: sha256_file(p) for p in sorted(dest.iterdir()) if p.is_file()},
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"backup_dir": str(dest), "manifest": manifest}


def restore(backup_dir: str, target_db_path: str) -> None:
    src = Path(backup_dir)
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"备份 schema_version={manifest.get('schema_version')} 与当前 {SCHEMA_VERSION} 不兼容")
    for name, digest in manifest["files"].items():
        if name == "manifest.json":
            continue
        if sha256_file(src / name) != digest:
            raise ValueError(f"备份文件 {name} 哈希校验失败，拒绝恢复")
    Path(target_db_path).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src / "pros.db", target_db_path)
    # 恢复后确保 migration 到位
    conn = db.connect(target_db_path)
    db.migrate(conn)
    conn.close()
