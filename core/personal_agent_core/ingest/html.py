"""网页采集（FR-14 / P3）：静态抓取优先，反爬/登录墙自动回退到拟人浏览器。

两级策略：
1. 静态抓取（零依赖，urllib + 浏览器 UA）——大多数站点直接成功；
2. 检测到反爬挑战或登录墙（403 / 挑战标记 / 正文为空）→ 拟人浏览器回退：
   模拟真人鼠标轨迹点掉登录二维码弹窗，再读取渲染后的正文（browser.py）。
"""
from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

from .common import (IngestError, http_open, resource_dir, save_note_and_capture,
                     sha256_file)

# 常见反爬/登录墙标记（知乎 zse-ck、Cloudflare、滑动验证等）
_CHALLENGE_MARKERS = (
    "zse-ck", "__cf_chl", "cf-challenge", "安全验证", "滑动验证", "captcha",
    "window._cf_", "geetest", "检测到异常流量", "访问验证",
)
_LOGIN_WALL_MARKERS = (
    "登录后查看", "扫码登录", "登录即可查看", "请登录", "Sign in to continue",
)
_MIN_BODY_CHARS = 200   # 整篇正文少于此长度视为抓取失败
_MIN_BLOCK_CHARS = 40   # 单个正文块少于此长度视为噪声（内容类型过滤）


def looks_like_challenge(html: str, status: int = 200) -> bool:
    """判断返回是否是反爬挑战页 / 登录墙，而不是正文。"""
    if status in (401, 403, 429):
        return True
    if len(html) < 2000 and any(m in html for m in _CHALLENGE_MARKERS + _LOGIN_WALL_MARKERS):
        return True
    return any(m in html for m in _CHALLENGE_MARKERS)


class _ArticleParser(HTMLParser):
    """零依赖正文提取：按块级标签收集文本，取最大文本块作为正文。"""

    _BLOCK = {"p", "div", "section", "article", "h1", "h2", "h3", "h4", "li", "td", "blockquote"}
    _SKIP = {"script", "style", "noscript", "header", "footer", "nav", "form", "button"}

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title = ""
        self.blocks: list[str] = []
        self.images: list[str] = []
        self._cur: list[str] = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1
        if tag == "title":
            self._in_title = True
        if tag in self._BLOCK:
            self._flush()
        if tag == "img" and self._skip_depth == 0:
            d = dict(attrs)
            src = d.get("src") or d.get("data-src") or d.get("data-original") or ""
            if src.startswith("//"):
                src = "https:" + src
            if src.startswith("http") and not src.endswith(".svg"):
                self.images.append(urljoin(self.base_url, src))

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth > 0:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False
        if tag in self._BLOCK:
            self._flush()

    def handle_data(self, data):
        if self._in_title:
            self.title += data.strip()
        if self._skip_depth == 0:
            self._cur.append(data)

    def _flush(self):
        text = re.sub(r"\s+", " ", "".join(self._cur)).strip()
        if text:
            self.blocks.append(text)
        self._cur = []

    def article_text(self, min_block_chars: int = 40) -> str:
        """合并连续的长文本块作为正文（启发式：保留所有 ≥阈值 字的块及其顺序）。"""
        self._flush()
        keep = [b for b in self.blocks if len(b) >= min_block_chars]
        return "\n\n".join(keep)


# 常见广告/推荐位文本特征（内容类型过滤，P3 可配置）
_AD_MARKERS = ("广告", "赞助", "AD ", "Sponsored", "相关推荐", "更多精彩", "猜你喜欢",
               "点击下载", "扫码关注", "版权所有")


def filter_blocks(text: str, drop_markers: tuple[str, ...] = _AD_MARKERS) -> str:
    """按行剔除广告/推荐等无关块。"""
    kept = [ln for ln in text.split("\n")
            if not any(m in ln for m in drop_markers)]
    return "\n".join(kept)


def extract_article(html: str, url: str, min_block_chars: int = 40,
                    drop_markers: tuple[str, ...] | None = _AD_MARKERS) -> dict:
    """从 HTML 提取 {title, text, images}。纯标准库，离线可用。

    min_block_chars：正文块的最小长度阈值（内容类型过滤）。
    drop_markers：需要剔除的广告/推荐行特征；None 表示不做过滤。
    """
    parser = _ArticleParser(url)
    parser.feed(html)
    text = parser.article_text(min_block_chars)
    if drop_markers:
        text = filter_blocks(text, drop_markers)
    return {"title": parser.title.strip(), "text": text, "images": parser.images}


def _download_images(images: list[str], res_dir: Path, max_images: int = 10,
                     max_bytes: int = 15 * 1024 * 1024) -> tuple[list[str], list[str]]:
    """下载正文配图（图表），返回 (保存的相对路径, 失败警告)。"""
    saved, warnings = [], []
    img_dir = res_dir / "images"
    for i, url in enumerate(images[:max_images], 1):
        try:
            with http_open(url, timeout=30, headers={"Referer": url}) as resp:
                data = resp.read(max_bytes + 1)
            if len(data) > max_bytes:
                warnings.append(f"图片过大已跳过：{url[:80]}")
                continue
            img_dir.mkdir(exist_ok=True)
            ext = (urlparse(url).path.rsplit(".", 1) or ["", "jpg"])[-1][:5] or "jpg"
            name = f"img_{i:02d}.{ext}"
            (img_dir / name).write_bytes(data)
            saved.append(f"images/{name}")
        except Exception as e:  # 单张失败不阻塞
            warnings.append(f"图片下载失败：{url[:80]}（{e}）")
    return saved, warnings


def ingest_html(conn, cfg, provider, url: str, actor: str = "user",
                progress=None, options: dict | None = None) -> dict:
    from .common import Progress
    progress = progress or Progress(False)
    options = options or {}
    _mi = options.get("max_images")
    max_images = int(_mi) if _mi is not None else int(getattr(cfg, "ingest_max_images", 10))
    min_body = int(options.get("min_body_chars", _MIN_BODY_CHARS))
    min_block = int(options.get("min_block_chars", _MIN_BLOCK_CHARS))
    drop_markers = options.get("drop_markers", _AD_MARKERS)

    warnings: list[str] = []
    html, status, fetch_mode = "", 200, "static"

    if Path(url).is_file():  # 本地 html 文件
        html = Path(url).read_text(encoding="utf-8", errors="replace")
    else:
        progress("静态抓取网页…")
        try:
            with http_open(url, timeout=30) as resp:
                status = getattr(resp, "status", 200)
                html = resp.read().decode("utf-8", errors="replace")
        except Exception as e:
            status = getattr(e, "code", 0) or 0
            warnings.append(f"静态抓取失败（{e}），尝试浏览器渲染")

    article = (extract_article(html, url, min_block, drop_markers) if html
               else {"title": "", "text": "", "images": []})

    if not Path(url).is_file() and (looks_like_challenge(html, status)
                                    or len(article["text"]) < min_body):
        from .browser import fetch_with_browser  # 延迟导入（可选依赖）
        progress("检测到反爬/登录墙，回退浏览器渲染…")
        html = fetch_with_browser(url, scroll=options.get("scroll"),
                                  progress=progress)  # 拟人操作：点掉登录/二维码弹窗后取渲染结果
        fetch_mode = "browser"
        article = extract_article(html, url, min_body, drop_markers)
        if len(article["text"]) < min_body:
            raise IngestError(
                "浏览器渲染后仍未提取到正文。该站点可能需要真实登录态，"
                "请在内置浏览器中手动登录后重试，或把网页另存为 html 文件后采集本地文件。"
            )

    title = article["title"] or urlparse(url).path.rsplit("/", 1)[-1] or url
    res_dir = resource_dir(cfg, "html", title)
    raw_path = res_dir / "original.html"
    raw_path.write_text(html, encoding="utf-8")

    progress(f"下载正文配图（上限 {max_images} 张）…")
    saved_imgs, img_warnings = _download_images(article["images"], res_dir, max_images=max_images)
    warnings += img_warnings

    # 标签自动生成 + 内容分类（P3）
    extra_tags = list(options.get("tags") or [])
    content_type = "document"
    if article["text"]:
        try:
            cls = provider.classify(article["text"][:4000]) or {}
            content_type = cls.get("type", "document")
            extra_tags += [t for t in cls.get("tags", []) if t]
        except Exception as e:
            warnings.append(f"自动分类失败（{e}）")

    summary = provider.summarize(article["text"]) if article["text"] else "（未能提取正文）"
    note = (
        f"---\ntype: {content_type}\nsource: {url}\ntags: "
        f"{', '.join([f'ingest/html', *extra_tags])}\n---\n\n"
        f"# {title}\n\n"
        f"来源：{url}\n采集方式：{'浏览器渲染（拟人操作关闭登录弹窗）' if fetch_mode == 'browser' else '静态抓取'}"
        f" ｜ 原件：original.html（sha256 {sha256_file(raw_path)[:16]}…）\n\n"
        f"## 摘要\n\n{summary}\n\n"
        f"## 正文\n\n{article['text']}\n\n"
        f"## 图表（{len(saved_imgs)} 张，已存本地）\n\n"
        + ("\n".join(f"![{p}]({p})" for p in saved_imgs) if saved_imgs else "（无）")
        + (f"\n\n## 采集警告\n\n" + "\n".join(f"- {w}" for w in warnings) if warnings else "")
    )
    result = save_note_and_capture(conn, cfg, "html", title, note, url, res_dir, actor,
                                   extra_tags=extra_tags,
                                   properties={"fetch_mode": fetch_mode,
                                               "image_count": len(saved_imgs),
                                               "content_type": content_type})
    return {"id": result["id"], "title": title, "resources_dir": str(res_dir),
            "fetch_mode": fetch_mode, "images": len(saved_imgs), "warnings": warnings,
            "tags": extra_tags, "obsidian_path": result.get("obsidian_path")}
