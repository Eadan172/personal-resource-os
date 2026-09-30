# ADR-002 核心栈：Python 3.12 + FastAPI + SQLite(FTS5)

- 状态：已接受  日期：2026-09-29
- 候选：TypeScript 全栈 / Python 核心 + TS 宿主 / Go。
- 决定：Agent Core 用 Python 3.12（FastAPI 服务层 + stdlib sqlite3/FTS5 存储）；Obsidian 插件与 Web UI 用 TypeScript/React。
- 理由：AI/Agent/LLM 生态 Python 最成熟（Provider SDK、OCR、转写、embedding）；SQLite+FTS5 零依赖、单文件备份、Windows/Docker 友好，满足「文件 + SQLite 混合存储」（13-E）；测试确定性强。TS 只用于必须 TS 的宿主层。
- 后果：两个语言栈，靠 HTTP API + JSON schema 隔离；向量检索 V1 引入（sqlite-vec 或独立索引）。
