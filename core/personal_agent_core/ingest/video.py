"""视频/音频采集（FR-14 / NG3 / P2）：保存原件 + 转写 + 摘要 + 提取。

转写优先级（逐级降级，任何一级失败都不丢原始文件）：
1. 平台字幕：yt-dlp 下载视频时顺带抓取 CC/AI 字幕（免费、最准）；
2. LLM 语音转写 API：ffmpeg 抽出音频 → OpenAI 兼容 /audio/transcriptions
   （PROS_ASR_BASE_URL / PROS_ASR_MODEL 配置，密钥只走 keyring/环境变量）；
3. 关键帧 + 视觉模型：scene 检测 + 均匀抽帧 → 视觉模型读图总结
   （PROS_VISION_MODEL 配置后启用）；
4. 兜底：只保存原件与关键帧，笔记标注「待转写」，入库不丢数据。

支持音频文件（.mp3/.wav/.m4a/…）与直链音频 URL：跳过抽帧，直接走 ASR。
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlparse

from .common import (IngestError, Progress, find_ffmpeg, http_open, resource_dir,
                     run_yt_dlp, save_note_and_capture, sha256_file)

_SUB_EXTS = (".vtt", ".srt")


def _parse_subtitle(path: Path, max_chars: int = 60000) -> str:
    """把 vtt/srt 解析成纯文本逐字稿（去时间轴、去重）。"""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines, seen = [], set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.upper() == "WEBVTT" or "-->" in line or line.isdigit():
            continue
        line = re.sub(r"<[^>]+>", "", line)  # 去 vtt 内联标签
        if line and line not in seen:
            seen.add(line)
            lines.append(line)
    return "\n".join(lines)[:max_chars]


def _download_video(url: str, res_dir: Path) -> tuple[Path, dict, list[Path]]:
    """yt-dlp 下载视频 + 字幕，返回 (视频路径, 元信息, 字幕文件列表)。"""
    out_tpl = str(res_dir / "video.%(ext)s")
    args = [
        "--write-subs", "--write-auto-subs", "--sub-langs", "zh.*,en.*",
        "--convert-subs", "srt", "--no-playlist",
        "-f", "bv*[height<=480]+ba/b[height<=480]/b",  # 默认 480p 省带宽
        "--print-json", "-o", out_tpl, url,
    ]
    proc = run_yt_dlp(args)
    if proc.returncode != 0:
        raise IngestError(f"视频下载失败：{(proc.stderr or proc.stdout)[-300:]}\n"
                          "也可以手动下载视频后，对本地文件执行 ingest。")
    import json
    info = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                info = json.loads(line)
            except json.JSONDecodeError:
                pass
    videos = sorted(res_dir.glob("video.*"),
                    key=lambda p: p.stat().st_size, reverse=True)
    video_path = next((p for p in videos if p.suffix.lower() not in _SUB_EXTS + (".json",)), None)
    if not video_path:
        raise IngestError("yt-dlp 未产出视频文件：" + proc.stdout[-200:])
    subs = [p for p in res_dir.glob("video.*") if p.suffix.lower() in _SUB_EXTS]
    return video_path, info, subs


def _download_audio(url: str, res_dir: Path) -> Path:
    """直链音频下载（.mp3/.m4a/…），保留原始扩展名。"""
    ext = Path(urlparse(url).path).suffix.lower() or ".mp3"
    dest = res_dir / f"recording{ext}"
    with http_open(url, timeout=600) as resp, open(dest, "wb") as f:
        shutil.copyfileobj(resp, f, 1 << 20)
    return dest


def _extract_audio(ffmpeg: str, video: Path, res_dir: Path) -> Path | None:
    """抽出 16k 单声道 mp3（ASR 友好，体积小）。"""
    audio = res_dir / "audio.mp3"
    proc = subprocess.run(
        [ffmpeg, "-y", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000",
         "-b:a", "64k", str(audio)],
        capture_output=True, timeout=1800)
    return audio if proc.returncode == 0 and audio.exists() else None


def _extract_frames(ffmpeg: str, video: Path, res_dir: Path,
                    max_scene: int = 24, max_grid: int = 12) -> list[Path]:
    """场景切换帧（上限 max_scene）+ 均匀抽帧（max_grid），双策略兜底。"""
    frames_dir = res_dir / "frames"
    frames_dir.mkdir(exist_ok=True)
    subprocess.run([ffmpeg, "-y", "-i", str(video), "-vf", "select='gt(scene,0.25)'",
                    "-fps_mode", "vfr", "-frames:v", str(max_scene),
                    str(frames_dir / "scene_%03d.jpg")],
                   capture_output=True, timeout=1800)
    dur = _duration(ffmpeg, video)
    if dur > 0:
        interval = max(1, int(dur / (max_grid + 1)))
        subprocess.run([ffmpeg, "-y", "-i", str(video), "-vf", f"fps=1/{interval}",
                        str(frames_dir / "grid_%02d.jpg")],
                       capture_output=True, timeout=1800)
    return sorted(frames_dir.glob("*.jpg"))


def _duration(ffmpeg: str, video: Path) -> float:
    proc = subprocess.run([ffmpeg, "-i", str(video)], capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", proc.stderr or "")
    return int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]) if m else 0.0


def ingest_media(conn, cfg, provider, source: str, actor: str = "user",
                 kind: str = "video", progress=None, options: dict | None = None) -> dict:
    """视频/音频统一采集。kind ∈ {video, audio}。"""
    progress = progress or Progress(False)
    options = options or {}
    is_audio = kind == "audio"
    warnings: list[str] = []
    info: dict = {}
    subs: list[Path] = []

    if Path(source).is_file():
        res_dir = resource_dir(cfg, kind, Path(source).stem)
        ext = Path(source).suffix.lower()
        media_name = "recording" if is_audio else "video"
        media_path = res_dir / f"{media_name}{ext}"
        shutil.copy2(source, media_path)
        title = Path(source).stem
        progress(f"已复制本地文件 → {media_path.name}")
    elif is_audio:
        res_dir = resource_dir(cfg, kind, re.sub(r"\W+", "_", source)[-50:])
        progress("下载音频直链…")
        media_path = _download_audio(source, res_dir)
        title = Path(urlparse(source).path).stem or "音频"
    else:
        res_dir = resource_dir(cfg, kind, re.sub(r"\W+", "_", source)[-50:])
        progress("下载视频（含字幕）…")
        media_path, info, subs = _download_video(source, res_dir)
        title = info.get("title") or Path(source).stem

    ffmpeg = find_ffmpeg()

    # 1) 平台字幕
    transcript = ""
    if subs:
        transcript = _parse_subtitle(subs[0])
        if transcript:
            warnings.append("使用平台字幕作为逐字稿")

    # 2) LLM 语音转写 API
    if not transcript:
        if ffmpeg:
            progress("抽取音轨…")
            audio = _extract_audio(ffmpeg, media_path, res_dir)
        elif is_audio:
            audio = media_path  # 音频文件本身可直接送 ASR
        else:
            audio = None
            warnings.append("未找到 ffmpeg（可 pip install imageio-ffmpeg），跳过抽帧")
        if audio and hasattr(provider, "transcribe_audio"):
            progress("语音转写（ASR）…")
            try:
                transcript = provider.transcribe_audio(str(audio)) or ""
            except Exception as e:
                warnings.append(f"语音转写失败（{e}）；音频已保留：{audio.name}")
        elif audio:
            warnings.append("未配置语音转写（PROS_ASR_BASE_URL/PROS_ASR_MODEL），"
                            f"音频已保留：{audio.name}")

    # 3) 关键帧 + 视觉模型（音频跳过）
    frames: list[Path] = []
    if ffmpeg and not is_audio:
        progress("场景检测 + 均匀抽帧…")
        frames = _extract_frames(ffmpeg, media_path, res_dir)
    frame_analysis = ""
    if not transcript and frames and hasattr(provider, "analyze_images"):
        progress(f"视觉模型读取 {min(len(frames), 12)} 张关键帧…")
        try:
            frame_analysis = provider.analyze_images(
                [str(f) for f in frames[:12]],
                "这些是教学/讲座视频的关键帧，请阅读画面中的文字，总结视频的主要内容。") or ""
        except Exception as e:
            warnings.append(f"视觉分析失败（{e}）")

    if not transcript and not frame_analysis:
        warnings.append("未获得逐字稿：原件与关键帧已保存，配置 ASR 或视觉模型后可重新分析")

    summary_src = transcript or frame_analysis
    summary = provider.summarize(summary_src) if summary_src else "（待转写后生成）"

    label = "音频" if is_audio else "视频"
    note = (
        f"# {label}笔记：{title}\n\n"
        f"来源：{source}\n"
        f"原件：{media_path.name}（sha256 {sha256_file(media_path)[:16]}…，"
        f"{media_path.stat().st_size / 1048576:.1f}MB）\n"
        + (f"UP主/作者：{info.get('uploader', '未知')} ｜ 时长：{int(info.get('duration') or 0)} 秒\n"
           if info else "")
        + f"\n## 摘要\n\n{summary}\n\n"
        + (f"## 逐字稿\n\n{transcript}\n\n" if transcript else "")
        + (f"## 关键帧内容分析\n\n{frame_analysis}\n\n" if frame_analysis else "")
        + (f"## 关键帧（{len(frames)} 张，存于 frames/）\n\n" if frames else "")
        + (f"## 采集警告\n\n" + "\n".join(f"- {w}" for w in warnings) if warnings else "")
    )
    result = save_note_and_capture(conn, cfg, kind, f"{label}：{title}", note, source,
                                   res_dir, actor,
                                   extra_tags=options.get("tags"),
                                   properties={"transcript": bool(transcript),
                                               "frames": len(frames),
                                               "media_file": str(media_path)})
    return {"id": result["id"], "title": title, "resources_dir": str(res_dir),
            "transcript": bool(transcript), "frames": len(frames), "warnings": warnings,
            "obsidian_path": result.get("obsidian_path")}


# 向后兼容别名
ingest_video = ingest_media