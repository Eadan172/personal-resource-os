"""SQLite + FTS5 存储层与幂等 migration（需求 46-D）。

- 原始内容（objects.content）写入后 AI 不可改；schema 层在 audit.apply_update 中强制。
- FTS5 使用 trigram 分词以支持中文检索。
"""
from __future__ import annotations

import sqlite3

SCHEMA_V1 = """
CREATE TABLE objects (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source_uri TEXT,
    content_hash TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'raw',
    confidence REAL NOT NULL DEFAULT 1.0,
    provenance TEXT NOT NULL DEFAULT '{}',
    tags TEXT NOT NULL DEFAULT '[]',
    properties TEXT NOT NULL DEFAULT '{}',
    data_class TEXT NOT NULL DEFAULT 'internal',
    event_time_start TEXT,
    event_time_end TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'inbox',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_objects_lifecycle ON objects(lifecycle);
CREATE INDEX idx_objects_type ON objects(type);
CREATE INDEX idx_objects_created ON objects(created_at);
CREATE INDEX idx_objects_hash ON objects(content_hash);

CREATE VIRTUAL TABLE objects_fts USING fts5(
    title, content, content='objects', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER objects_ai AFTER INSERT ON objects BEGIN
    INSERT INTO objects_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER objects_ad AFTER DELETE ON objects BEGIN
    INSERT INTO objects_fts(objects_fts, rowid, title, content)
        VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER objects_au AFTER UPDATE ON objects BEGIN
    INSERT INTO objects_fts(objects_fts, rowid, title, content)
        VALUES ('delete', old.rowid, old.title, old.content);
    INSERT INTO objects_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;

CREATE TABLE relations (
    id TEXT PRIMARY KEY,
    src_id TEXT NOT NULL REFERENCES objects(id),
    dst_id TEXT NOT NULL REFERENCES objects(id),
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'suggested',
    confidence REAL NOT NULL DEFAULT 1.0,
    provenance TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX idx_relations_src ON relations(src_id);
CREATE INDEX idx_relations_dst ON relations(dst_id);

CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_object_id TEXT REFERENCES objects(id),
    due_at TEXT,
    priority TEXT NOT NULL DEFAULT 'P2',
    status TEXT NOT NULL DEFAULT 'todo',
    project TEXT,
    assignee TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    provenance TEXT NOT NULL DEFAULT '{}',
    confidence REAL NOT NULL DEFAULT 1.0,
    created_by_agent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_due ON tasks(due_at);

CREATE TABLE extractions (
    id TEXT PRIMARY KEY,
    source_object_id TEXT NOT NULL REFERENCES objects(id),
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    processor TEXT NOT NULL,
    processor_version TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_extractions_src ON extractions(source_object_id);

CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    op TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    before TEXT,
    after TEXT,
    actor TEXT NOT NULL,
    agent_run_id TEXT,
    reversible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_object ON audit_log(object_type, object_id);

CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    steps INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
    action TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
);
"""

MIGRATIONS = {1: SCHEMA_V1}


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def migrate(conn: sqlite3.Connection) -> int:
    """幂等 migration：返回当前 schema 版本。"""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    row = conn.execute("SELECT MAX(version) AS v FROM schema_migrations").fetchone()
    current = row["v"] or 0
    from .models import now

    for version in sorted(MIGRATIONS):
        if version > current:
            conn.executescript(MIGRATIONS[version])
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                (version, now()),
            )
    conn.commit()
    return max(MIGRATIONS)


def init_db(path: str) -> sqlite3.Connection:
    conn = connect(path)
    migrate(conn)
    return conn
