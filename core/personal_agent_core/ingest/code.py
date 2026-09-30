"""代码仓库采集（FR-14 / P4）：GitHub 多镜像下载 + 断点续传 + 离线结构分析。

镜像策略：
- 默认依次尝试：codeload 直连 → gh-proxy.com → ghfast.top → ghproxy.net
  （可用 PROS_GITHUB_MIRRORS 环境变量覆盖，逗号分隔）；
- 每个镜像先探针测速（下载前 200KB，低于 50KB/s 或 20s 超时即放弃）；
- 支持断点续传（Range 请求），已下载部分不重复拉取；
- 全部镜像失败时保留已下载残片，报错信息列出各镜像失败原因。

分析：零依赖启发式（语言分布、行数、README、入口文件、依赖清单），
配置了真实 LLM 时再让模型写一段项目简介；离线也能产出可用的代码笔记。
"""
from __future__ import annotations

import os
import re
import shutil
import time
import zipfile
from pathlib import Path

from .common import (IngestError, http_open, resource_dir, save_note_and_capture,
                     sha256_file)

DEFAULT_MIRRORS = ("",                            # 空前缀 = codeload 直连
                   "https://gh-proxy.com/",
                   "https://ghfast.top/",
                   "https://ghproxy.net/")
_PROBE_BYTES = 200_000        # 探针下载量
_MIN_SPEED = 50_000           # B/s，低于此速度换镜像
_PROBE_TIMEOUT = 20           # 秒
_FULL_TIMEOUT = 1800

_TEXT_EXTS = {".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".go", ".rs", ".c",
              ".h", ".cpp", ".cs", ".rb", ".php", ".md", ".txt", ".yml", ".yaml",
              ".json", ".toml", ".sh", ".sql", ".r", ".m", ".ipynb"}
_ENTRY_NAMES = {"main.py", "app.py", "train.py", "run.py", "manage.py", "index.js",
                "main.ts", "cli.py", "server.py", "Makefile", "Dockerfile",
                "docker-compose.yml", "pyproject.toml", "package.json",
                "requirements.txt", "env.yml", "setup.py", "Cargo.toml", "go.mod"}


def parse_github(url: str) -> tuple[str, str, str]:
    """解析 GitHub 链接 → (owner, repo, ref)。支持仓库页/tree/codeload/archive 链接。"""
    m = re.search(r"codeload\.github\.com/([^/]+)/([^/]+)/zip/(?:refs/heads/)?([\w.\-]+)", url)
    if m:
        return m[1], m[2], m[3]
    m = re.search(r"github\.com/([^/]+)/([^/]+?)(?:\.git)?(?:/(?:tree|archive)/(?:refs/heads/)?([\w.\-]+))?/?$", url)
    if not m:
        raise IngestError(f"无法识别的 GitHub 链接：{url}\n"
                          "支持 https://github.com/owner/repo 或 codeload zip 链接；"
                          "也可以直接采集本地 zip 文件或目录。")
    return m[1], m[2], m[3] or "main"


def codeload_url(owner: str, repo: str, ref: str) -> str:
    return f"https://codeload.github.com/{owner}/{repo}/zip/refs/heads/{ref}"


def download_with_failover(urls: list[str], dest: Path, fetcher=None,
                           min_speed: int = _MIN_SPEED,
                           expected_sha256: str | None = None,
                           progress=None) -> tuple[str, list[str]]:
    """按顺序尝试多个下载源：探针测速 → 全量下载（断点续传）→ 完整性校验。

    - urls 已按优选顺序排列（调用方可用 rank_mirrors 排序）；
    - expected_sha256 非空时校验下载结果，不一致即报错（防止镜像篡改/截断）；
    - 返回 (成功的 url, 警告)。
    """
    fetcher = fetcher or http_open
    warnings, errors = [], []
    for url in urls:
        try:
            # 探针：测前 200KB 的速度
            t0 = time.monotonic()
            with fetcher(url, timeout=_PROBE_TIMEOUT,
                         headers={"Range": f"bytes=0-{_PROBE_BYTES}"}) as resp:
                probe = resp.read(_PROBE_BYTES)
            elapsed = max(time.monotonic() - t0, 0.01)
            speed = len(probe) / elapsed
            if speed < min_speed:
                errors.append(f"{url}：速度过慢（{speed / 1024:.0f}KB/s）")
                continue
            if progress:
                progress(f"从 {url or 'codeload 直连'} 下载（≈{speed / 1024:.0f}KB/s）…")
            # 全量下载（残片续传）
            existing = dest.stat().st_size if dest.exists() else 0
            headers = {"Range": f"bytes={existing}-"} if existing else {}
            with fetcher(url, timeout=_FULL_TIMEOUT, headers=headers) as resp:
                mode = "ab" if existing and getattr(resp, "status", 200) == 206 else "wb"
                with open(dest, mode) as f:
                    shutil.copyfileobj(resp, f, 1 << 20)
            # 完整性校验：期望 sha256
            if expected_sha256:
                actual = sha256_file(dest)
                if actual.lower() != expected_sha256.strip().lower():
                    warnings.append(f"校验失败：sha256 不一致（期望 {expected_sha256[:12]}… "
                                    f"实际 {actual[:12]}…），已重新标记为可疑")
                    errors.append(f"{url}：sha256 校验失败")
                    continue
            return url, warnings
        except Exception as e:
            errors.append(f"{url}：{e}")
            continue
    raise IngestError("所有下载源均失败：\n" + "\n".join(f"  - {e}" for e in errors)
                      + f"\n已保留残片：{dest}（重试会自动续传）\n"
                      "也可以用浏览器下载 zip 后，对本地文件执行 ingest。")


def probe_mirror(url: str, fetcher=None, probe_bytes: int = _PROBE_BYTES,
                 timeout: int = _PROBE_TIMEOUT) -> dict:
    """探测单个镜像：下载前 N 字节，返回 {url, ok, speed, seconds, bytes}。"""
    fetcher = fetcher or http_open
    t0 = time.monotonic()
    with fetcher(url, timeout=timeout,
                 headers={"Range": f"bytes=0-{probe_bytes}"}) as resp:
        data = resp.read(probe_bytes)
    seconds = max(time.monotonic() - t0, 1e-6)
    return {"url": url, "ok": True, "bytes": len(data), "seconds": seconds,
            "speed": len(data) / seconds}


def rank_mirrors(urls: list[str], fetcher=None) -> list[dict]:
    """并发无关的逐源测速并排序（P4：自动检测最优下载源）。

    返回按 (可用, 速度) 降序排列的探针结果；不可用源排到最后。
    """
    results = []
    for url in urls:
        try:
            results.append(probe_mirror(url, fetcher))
        except Exception as e:
            results.append({"url": url, "ok": False, "speed": 0.0, "error": str(e)})
    return sorted(results, key=lambda r: (r["ok"], r["speed"]), reverse=True)


def verify_zip(path: Path) -> str | None:
    """校验 zip 完整性（CRC）。返回 None 表示完好，否则返回第一个损坏成员名。"""
    try:
        with zipfile.ZipFile(path) as z:
            return z.testzip()
    except zipfile.BadZipFile:
        return "<不是有效的 zip>"


def analyze_codebase(root: Path, max_files: int = 5000) -> dict:
    """零依赖启发式代码分析：语言分布、规模、README、入口文件、依赖。"""
    by_ext: dict[str, int] = {}
    total_lines = 0
    entries, deps = [], []
    readme_text = ""
    n = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "__pycache__",
                                                        ".venv", "venv", "dist", "build")]
        for fn in filenames:
            n += 1
            if n > max_files:
                break
            p = Path(dirpath) / fn
            ext = p.suffix.lower()
            rel = str(p.relative_to(root))
            if ext in _TEXT_EXTS:
                by_ext[ext] = by_ext.get(ext, 0) + 1
                try:
                    total_lines += sum(1 for _ in open(p, encoding="utf-8", errors="ignore"))
                except OSError:
                    pass
            if fn in _ENTRY_NAMES or fn.lower() in _ENTRY_NAMES:
                entries.append(rel)
            if fn in ("requirements.txt", "env.yml", "package.json", "pyproject.toml",
                      "Cargo.toml", "go.mod"):
                deps.append(rel)
            if not readme_text and fn.lower().startswith("readme") and ext in (".md", ".txt", ".rst"):
                try:
                    readme_text = p.read_text(encoding="utf-8", errors="replace")[:4000]
                except OSError:
                    pass
    return {"files": n, "total_lines": total_lines, "by_ext": by_ext,
            "entries": entries[:20], "deps": deps, "readme": readme_text}


def _unpack(zip_path: Path, res_dir: Path) -> Path:
    try:
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(res_dir / "src")
    except zipfile.BadZipFile:
        raise IngestError(f"下载的文件不是有效 zip（可能被镜像截断）：{zip_path}，请重试（支持续传）")
    src = res_dir / "src"
    subs = list(src.iterdir())
    return subs[0] if len(subs) == 1 and subs[0].is_dir() else src


def _analysis_note(root: Path, provider) -> str:
    a = analyze_codebase(root)
    langs = "、".join(f"{k}×{v}" for k, v in
                      sorted(a["by_ext"].items(), key=lambda x: -x[1])[:8])
    intro = ""
    if a["readme"]:
        intro = provider.summarize(a["readme"])
    return (
        f"## 项目概况\n\n"
        f"- 文件数：{a['files']}（代码行数约 {a['total_lines']:,}）\n"
        f"- 语言分布：{langs or '未知'}\n"
        f"- 入口/关键文件：{('、'.join(a['entries'][:10])) or '未识别'}\n"
        f"- 依赖清单：{('、'.join(a['deps'])) or '未发现'}\n\n"
        + (f"## README 简介（AI 摘要）\n\n{intro}\n\n" if intro else "")
        + (f"## README 节选\n\n{a['readme'][:2000]}\n" if a["readme"] else "")
    )


def ingest_code(conn, cfg, provider, source: str, actor: str = "user",
                progress=None, options: dict | None = None) -> dict:
    from .common import Progress
    progress = progress or Progress(False)
    options = options or {}
    warnings: list[str] = []
    sha256 = None
    used = None

    if Path(source).is_dir():  # 本地目录
        res_dir = resource_dir(cfg, "code", Path(source).name)
        root = Path(source)
        zip_path = None
        title = f"代码库：{Path(source).name}"
    elif Path(source).is_file():  # 本地 zip
        res_dir = resource_dir(cfg, "code", Path(source).stem)
        zip_path = res_dir / Path(source).name
        shutil.copy2(source, zip_path)
        sha256 = sha256_file(zip_path)
        expected = options.get("sha256")
        if expected and expected.strip().lower() != sha256.lower():
            raise IngestError(f"文件 sha256 校验失败：期望 {expected[:16]}…，实际 {sha256[:16]}…\n"
                              f"文件未被删除：{zip_path}")
        bad = verify_zip(zip_path)
        if bad:
            warnings.append(f"压缩包校验异常（成员 {bad}），可能已损坏")
        root = _unpack(zip_path, res_dir)
        title = f"代码库：{Path(source).stem}"
    else:
        owner, repo, ref = parse_github(source)
        res_dir = resource_dir(cfg, "code", f"{owner}-{repo}")
        zip_path = res_dir / f"{repo}-{ref}.zip"
        direct = codeload_url(owner, repo, ref)
        # 镜像来源优先级：命令行手动指定 > 配置 > 内置默认
        manual = options.get("mirror")
        if manual:
            mirrors = (manual,)
            auto = False
        elif getattr(cfg, "github_mirrors", None):
            mirrors = cfg.github_mirrors
            auto = True
        else:
            mirrors = tuple(m.strip() for m in
                            os.environ.get("PROS_GITHUB_MIRRORS", ",".join(DEFAULT_MIRRORS)).split(",")
                            if m.strip() or m == "") or DEFAULT_MIRRORS
            auto = True
        urls = [m + direct if m else direct for m in mirrors]
        if auto and len(urls) > 1:
            progress("自动探测各镜像速度，选择最优下载源…")
            ranked = rank_mirrors(urls)
            for r in ranked:
                tag = f"{r['url'] or 'codeload 直连'}：{'%.0fKB/s' % (r['speed'] / 1024) if r['ok'] else '不可用'}"
                progress(f"  - {tag}")
            urls = [r["url"] for r in ranked]
        progress("下载代码仓库（支持断点续传）…")
        used, warns = download_with_failover(urls, zip_path,
                                             expected_sha256=options.get("sha256"),
                                             progress=progress)
        warnings += warns
        warnings.append(f"下载源：{used or 'codeload 直连'}")
        sha256 = sha256_file(zip_path)
        bad = verify_zip(zip_path)
        if bad:
            warnings.append(f"压缩包校验异常（成员 {bad}），可能被镜像截断，建议重试")
        root = _unpack(zip_path, res_dir)
        title = f"代码库：{owner}/{repo}"

    integrity = "本地文件" if used is None else ("sha256 校验通过" if options.get("sha256")
                                                 else "sha256 已记录（未提供期望值，无法比对）")
    note = (
        f"# {title}\n\n来源：{source}\n"
        + (f"原件：{zip_path.name}（sha256 {sha256}）\n" if zip_path else "")
        + f"完整性：{integrity}\n"
        + f"源码目录：{root}\n\n"
        + _analysis_note(root, provider)
        + (f"\n## 采集警告\n\n" + "\n".join(f"- {w}" for w in warnings) if warnings else "")
    )
    result = save_note_and_capture(conn, cfg, "code", title, note, source, res_dir, actor,
                                   extra_tags=options.get("tags"),
                                   properties={"root": str(root), "sha256": sha256,
                                               "mirror": used})
    return {"id": result["id"], "title": title, "resources_dir": str(res_dir),
            "root": str(root), "sha256": sha256, "mirror": used, "warnings": warnings,
            "obsidian_path": result.get("obsidian_path")}
