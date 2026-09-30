# ADR-003 不 Fork 任何候选底座

- 状态：已接受  日期：2026-09-29
- 决定：不 fork AFFiNE/Joplin/TriliumNext/Khoj/Obsidian 插件。仅参考 Khoj（scoped agents/automations/citations）与 Trilium（属性/关系系统）的设计。
- 理由：AFFiNE 有 CVE-2026-21853（CVSS 8.8）且架构重（PG+Redis）；Joplin/Trilium/Khoj 为 AGPL-3.0，修改后网络分发有源码公开义务且引入大供应链面；Obsidian 闭源。Fork 大项目长期维护成本高（§十九禁令）。
- 后果：MVP 自研量增大，但信任面最小、审计可行。
