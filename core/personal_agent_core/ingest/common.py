"""采集公共工具：类型识别、资源仓库、HTTP、外部工具探测、笔记落库。

出站策略（与 docs/03 信任边界对齐）：
- 采集是用户显式发起的动作（等同于用户在浏览器里输入网址），
  因此采集本身不受 AI 出站 allowlist 限制，但每一次采集都会写审计日志；
- 携带密钥的请求（LLM/ASR/Vision API）仍然严格走 cfg.check_outbound。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

from .. import audit
from ..capture import capture_text
from ..models import new_id, now

USER_AGENT = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

VIDEO_EXTS = {".mp4", ".mkv", ".flv", ".mov", ".avi", ".webm", ".ts", ".m4v"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}
CODE_EXTS = {".zip", ".tar", ".gz", ".tgz"}
HTML_EXTS = {".html", ".htm"}

# 采集支持的资源类型（P2 起新增 audio）
KINDS = ("video", "audio", "html", "code")


class IngestError(RuntimeError):
    """采集失败。message 面向用户，须给出可操作的解决提示。"""


class Progress:
    """面向用户的处理进度反馈（写 stderr，不污染 stdout 的 JSON 结果）。"""

    def __init__(self, enabled: bool = False, prefix: str = "[ingest] "):
        self.enabled = enabled
        self.prefix = prefix

    def __call__(self, msg: str) -> None:
        if self.enabled:
            print(f"{self.prefix}{msg}", file=sys.stderr, flush=True)


_NULL_PROGRESS = Progress(False)


def detect_type(source: str) -> str:
    """按 URL / 本地路径识别资源类型：video | audio | code | html。"""
    if os.path.exists(source):
        p = Path(source)
        if p.is_dir():
            return "code"
        ext = p.suffix.lower()
        if ext in VIDEO_EXTS:
            return "video"
        if ext in AUDIO_EXTS:
            return "audio"
        if ext in CODE_EXTS:
            return "code"
        if ext in HTML_EXTS:
            return "html"
        raise IngestError(f"无法识别的本地文件类型：{p.name}"
                          f"（支持 视频/音频/压缩包/网页）")
    u = urlparse(source)
    host = (u.hostname or "").lower()
    path = u.path.lower()
    if not host:
        raise IngestError(f"不是有效的 URL 或本地路径：{source}")
    if re.search(r"(^|\.)bilibili\.com$", host) and "/video/" in path:
        return "video"
    if host in ("b23.tv", "youtu.be") or re.search(r"(^|\.)youtube\.com$", host):
        return "video"
    if re.search(r"(^|\.)(codeload\.)?github\.com$", host) or re.search(r"(^|\.)github\.io$", host):
        return "code"
    if path.endswith(".zip") and "github" in host:
        return "code"
    # 直链媒体（如播客 .mp3 / 直链 .mp4）
    if path.endswith(tuple(AUDIO_EXTS)):
        return "audio"
    if path.endswith(tuple(VIDEO_EXTS)):
        return "video"
    return "html"


def import_to_obsidian(cfg, note_path: Path, title: str, subdir: str = "inbox") -> str | None:
    """把采集笔记复制进 Obsidian vault（P3：抓取结果自动导入）。

    仅当配置了 vault（PROS_OBSIDIAN_VAULT 或 --vault）时生效；返回目标路径或 None。
    vault 内只写入指定的 subdir 目录，绝不越界写其它位置（TB-1）。
    """
    vault = getattr(cfg, "vault_dir", None)
    if not vault:
        return None
    target_dir = Path(vault) / subdir
    target_dir.mkdir(parents=True, exist_ok=True)
    safe = re.sub(r'[\\/:*?"<>|\r\n]+', "_", title).strip()[:80] or "untitled"
    dest = target_dir / f"{safe}.md"
    shutil.copy2(note_path, dest)
    return str(dest)


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def resource_dir(cfg, kind: str, name_hint: str) -> Path:
    """为一次采集创建资源目录：data/resources/<kind>/<时间戳>-<安全名>/"""
    safe = re.sub(r"[^\w\-.一-鿿]+", "_", name_hint)[:60].strip("_") or "resource"
    d = Path(cfg.data_dir) / "resources" / kind / f"{now()[:10]}-{new_id()[:8]}-{safe}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def http_open(url: str, timeout: int = 30, headers: dict | None = None):
    """用户发起的采集请求（带浏览器 UA）。密钥请求不走这里。"""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def find_ffmpeg() -> str | None:
    """依次尝试：PATH 里的 ffmpeg → imageio-ffmpeg 内置二进制。"""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # 可选依赖
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def run_yt_dlp(args: list[str], timeout: int = 1800) -> subprocess.CompletedProcess:
    """优先 python -m yt_dlp，其次 PATH 里的 yt-dlp。都没有则给安装提示。"""
    import sys
    try:
        import yt_dlp  # noqa: F401
        cmd = [sys.executable or "python", "-m", "yt_dlp"]
    except ImportError:
        exe = shutil.which("yt-dlp")
        if not exe:
            raise IngestError(
                "下载视频需要 yt-dlp（未安装）。请运行：pip install yt-dlp 后重试；"
                "也可以直接用浏览器下载视频文件，再对本地文件执行 ingest。"
            )
        cmd = [exe]
    return subprocess.run(cmd + args, capture_output=True, text=True, timeout=timeout,
                          encoding="utf-8", errors="replace")


def save_note_and_capture(conn, cfg, kind: str, title: str, note: str,
                          source_uri: str, res_dir: Path, actor: str,
                          properties: dict | None = None,
                          extra_tags: list[str] | None = None,
                          obsidian_subdir: str = "inbox") -> dict:
    """笔记写入资源目录（note.md）+ 统一进 Inbox（capture_text）+ 可选导入 Obsidian，并写审计。"""
    note_path = res_dir / "note.md"
    note_path.write_text(note, encoding="utf-8")
    tags = [f"ingest/{kind}", *(extra_tags or [])]
    result = capture_text(conn, note, title=title, source_uri=source_uri,
                          tags=tags, actor=actor)
    obsidian_path = import_to_obsidian(cfg, note_path, title, subdir=obsidian_subdir)
    audit.apply_update(conn, "objects", result["id"], {
        "type": "document",
        "properties": {
            "ingest_kind": kind,
            "resources_dir": str(res_dir),
            "note_path": str(note_path),
            "obsidian_path": obsidian_path,
            "processor": "personal_agent_core.ingest",
            "processor_version": "0.3.0",
            **(properties or {}),
        },
    }, actor)
    audit.record(conn, "outbound_ingest", "objects", result["id"], None,
                 {"source": source_uri, "kind": kind, "at": now()}, actor)
    result["obsidian_path"] = obsidian_path
    return result
