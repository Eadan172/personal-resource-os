"""多模态资源采集（FR-14）：一个入口，自动识别 视频 / 音频 / 网页 / 代码 四类资源。

设计约束：
- 用户主动发起的采集（人负责投入资源），原始文件永远保留在 data/resources/ 下；
- 衍生数据（笔记、转写、截图、分析）与原始文件同目录，并带 content_hash 与时间戳；
- AI 处理失败不得丢原始数据：任何一步失败，已下载的原件仍保留，错误写入返回值；
- 离线可用：无 LLM / 无可选依赖时降级为「保存原件 + 启发式笔记」，不报错丢数据。
"""
from __future__ import annotations

from pathlib import Path

from .common import IngestError, Progress, detect_type
from . import code as code_mod
from . import html as html_mod
from . import video as video_mod

_KIND_LABEL = {"video": "视频", "audio": "音频", "html": "网页", "code": "代码"}


def ingest(conn, cfg, provider, source: str, kind: str | None = None, actor: str = "user",
           progress=None, options: dict | None = None) -> dict:
    """统一采集入口。source 可以是 URL 或本地文件/目录路径。

    options（均可选，供 P2/P3/P4 逐项配置）：
      - max_images: 网页正文配图上限
      - tags: 额外标签（自动叠加 ingest/<kind>）
      - vault: 覆盖 Obsidian vault 目录（PROS_OBSIDIAN_VAULT）
      - mirror: 强制指定 GitHub 下载镜像（P4 手动切换）
      - sha256: 期望的下载文件 sha256，用于校验（P4）
      - scroll: 浏览器渲染滚动次数（P3 抓取深度）
      - format: 笔记存储格式（md，预留）

    返回 {kind, kind_label, id, title, resources_dir, warnings, ...}。
    失败时抛 IngestError，但已下载的原始文件仍保留在 resources_dir。
    """
    options = options or {}
    progress = progress or Progress(False)
    kind = kind or detect_type(source)
    vault = options.get("vault")
    if vault:
        Path(vault).mkdir(parents=True, exist_ok=True)
        cfg.vault_dir = Path(vault)

    common = dict(actor=actor, progress=progress, options=options)
    if kind in ("video", "audio"):
        result = video_mod.ingest_media(conn, cfg, provider, source, kind=kind, **common)
    elif kind == "html":
        result = html_mod.ingest_html(conn, cfg, provider, source, **common)
    elif kind == "code":
        result = code_mod.ingest_code(conn, cfg, provider, source, **common)
    else:  # pragma: no cover - detect_type 已限定取值
        raise IngestError(f"不支持的资源类型：{kind}")

    result["kind"] = kind
    result["kind_label"] = _KIND_LABEL[kind]
    return result


__all__ = ["ingest", "detect_type", "IngestError", "Progress"]