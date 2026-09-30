# Personal Resource OS

> 以本地个人数据为唯一事实源、由 Agent 持续自动整理/连接/维护/执行的个人资源操作系统。
> 架构：Obsidian（薄宿主）+ 独立 Agent Core + MCP Gateway（ADR-001）。

## 快速开始（Windows 开箱即用）

核心零第三方依赖（仅 Python 标准库）；`pytest` 为测试所需。

```bat
:: 1) 装测试依赖（一次性）
pip install pytest keyring

:: 2) 标准命令（三种入口等价，任选其一）
make test              :: CMD：cmd 会在当前目录查找 make.bat，直接敲 make 即可
.\make.ps1 test        :: PowerShell（想要 make test，可先 $env:PATH="$PWD;$env:PATH"）

:: 若已安装 GNU make（MSYS2 / choco / scoop），根目录 Makefile 同样可用：
make test
make e2e
```

> Python 命令在 Windows 通常是 `python`；本仓库的 Makefile / make.bat / make.ps1 已自动适配
> 命令名与 `PYTHONPATH` 分隔符（Windows `;` / POSIX `:`），无需手动设置。

跨平台等价入口（任意终端）：

```bash
python e2e/run_e2e.py    # 闭环 E2E（纯 Python，无需 bash/WSL）
python -m pytest tests/  # 48 个测试，断网 + Mock Provider 确定性通过
```

CLI 闭环示例（自动处理路径分隔符，Windows 直接可用）：

```bat
set PYTHONPATH=core;.
python -m personal_agent_core.cli capture "明天下午3点前记得给@张三发项目周报 #工作"
python -m personal_agent_core.cli process      :: AI 整理 Inbox
python -m personal_agent_core.cli ask "我明天要做什么？"
python -m personal_agent_core.cli tasks
```

Docker：`docker compose up -d`（API 监听 127.0.0.1:8765）。

## 采集（P2/P3/P4）：视频 / 音频 / 网页 / 代码

```bat
:: 自动识别类型；-v 输出处理进度
python -m personal_agent_core.cli ingest "https://www.bilibili.com/video/BV1xx" -v
python -m personal_agent_core.cli ingest "D:\records\meeting.mp3" --vault "D:\MyVault" -v
python -m personal_agent_core.cli ingest "https://zhuanlan.zhihu.com/p/123" --tags "AI,化学" --scroll 10 -v
python -m personal_agent_core.cli ingest "https://github.com/owner/repo" --mirror "https://gh-proxy.com/" -v
python -m personal_agent_core.cli ingest "D:\repo.zip" --sha256 "<期望的sha256>" -v
```

- **视频/音频（P2）**：保存原件 → 平台字幕 → 语音转写（ASR API）→ 关键帧视觉分析，逐级降级，
  任何一步失败都不丢原始文件；产出结构化 Markdown（摘要/逐字稿/关键帧）。
- **网页（P3）**：静态抓取优先，遇反爬/登录墙自动回退**拟人浏览器**（贝塞尔鼠标轨迹 + 关闭二维码弹窗）；
  可配置 `--scroll`（抓取深度）、`--max-images`（配图上限）、`--tags`；自动分类并生成标签；
  `--vault` 可把笔记自动导入 Obsidian 的 `inbox/`。
- **代码（P4）**：多镜像自动测速优选（codeload 直连 / gh-proxy / ghfast / ghproxy），
  支持 `--mirror` 手动切换、断点续传、`--sha256` 完整性校验、zip CRC 校验。

可选依赖（用到才装）：`pip install yt-dlp imageio-ffmpeg playwright && playwright install chromium`。

## 模型与密钥（P2）

```bat
:: 密钥写入系统凭据库（Windows 凭据管理器 / macOS Keychain / Secret Service），不进库、不进日志
python -m personal_agent_core.cli set-key sk-xxxx
python -m personal_agent_core.cli key-status     :: 只看来源状态，不打印密钥

set PROS_PROVIDER=deepseek
set PROS_ASR_MODEL=whisper-1                      :: 语音转写模型（可选）
set PROS_VISION_MODEL=                              :: 关键帧读图模型（可选）
set PROS_OBSIDIAN_VAULT=D:\MyVault                  :: 采集笔记自动导入目标
```

## 环境变量一览（可选，默认完全离线）

| 变量 | 说明 | 默认 |
|---|---|---|
| `PROS_PROVIDER` | mock / deepseek / qwen / openai_compat / local(Ollama) | mock |
| `PROS_API_KEY` | 密钥（优先 OS 凭据库，见 `set-key`；也可用环境变量） | — |
| `PROS_OUTBOUND_ALLOWLIST` | 出站域名 allowlist（逗号分隔，最小开放） | 官方端点 |
| `PROS_ASR_BASE_URL` / `PROS_ASR_MODEL` | 语音转写端点 / 模型（P2） | 复用主端点 / whisper-1 |
| `PROS_VISION_MODEL` | 关键帧读图模型（P2） | 主模型 |
| `PROS_OBSIDIAN_VAULT` | 采集笔记自动导入的 Obsidian vault（P3） | 不导入 |
| `PROS_INGEST_MAX_IMAGES` | 网页配图下载上限（P3） | 10 |
| `PROS_GITHUB_MIRRORS` | GitHub 下载镜像前缀（逗号分隔，P4） | 内置 4 源 |

## 文档索引（第一轮交付 A–O）

| 文档 | 内容 |
|---|---|
| docs/01-需求规格.md | A. 正式规格（FR/NFR/验收标准） |
| docs/02-底座审计与比较.md | B. 候选底座审计对比（2026-09 核查）+ M. 安全审计清单 |
| docs/03-技术架构与信任边界.md | C. 架构 + D. Trust Boundary + 数据分级外发策略 |
| docs/04-数据模型.md | E. Object/Relation/Task/Extraction/Audit 模型 |
| docs/05-Agent运行时设计.md | F. Agent 定义/Runtime/预算/审批/失败安全 |
| docs/06-MCP-Gateway与Connector设计.md | G. Gateway（对齐 MCP 2026-07-28）+ WorkBuddy/企微/IMA |
| docs/07-MVP拆解与任务清单.md | H. 目录结构 + I. MVP + J. 任务清单 + K. DoD |
| docs/08-风险清单.md | L. 14 项风险与缓解 |
| docs/09-测试策略.md | N. 测试金字塔与专项测试 |
| adr/ | O. ADR-001…007（含“Jev模型”待确认的处置） |

## P. 第一批可运行代码（已实现并通过测试）

- `core/personal_agent_core/`：capture / pipeline / extraction / retrieval / rag / tasks / audit / agents / summary / backup / decision / providers(mock+openai_compat) / ingest(视频/音频/网页/代码) / api / cli
- `mcp_gateway/`：无状态工具面 + 策略 + Connector 契约（workbuddy/wecom/ima）
- `plugins/obsidian/`：薄适配层骨架（capture / 采集链接命令）
- `tests/`：48 个测试全绿；`e2e/run_e2e.py` 跨平台闭环通过（无需 bash）
- `Makefile` + `make.bat` + `make.ps1`：Windows/Linux/macOS 统一命令入口（P1）

## 安全红线（已落实进代码）

- 原始 `content` 写入后 AI 不可改（schema 级 PermissionError）
- 所有 mutation 有 before/after 审计，可单条回滚；删除=软删除
- 关系默认 `suggested`（建议 + 审核）；重复只提示不合并
- RAG 无证据拒答；引用 span 与原文切片一致
- Agent 硬预算：max_steps / timeout / tokens / 白名单工具 / 审批门
- 密钥优先写 OS 凭据库（keyring），其次环境变量；不落库、不进日志、不进模型上下文
- 出站 allowlist 默认最小开放；采集原件永不因 AI/网络失败丢失；零 telemetry
