"""多模态采集（ingest）离线确定性测试：不访问网络、不依赖可选组件。"""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

import hashlib

from personal_agent_core.config import Config, get_secret, secret_status
from personal_agent_core.ingest import detect_type, ingest
from personal_agent_core.ingest.code import (analyze_codebase, download_with_failover,
                                             parse_github, rank_mirrors, verify_zip)
from personal_agent_core.ingest.common import IngestError
from personal_agent_core.ingest.html import extract_article, filter_blocks, looks_like_challenge
from personal_agent_core.ingest.video import _parse_subtitle


@pytest.fixture()
def cfg(tmp_path):
    c = Config(data_dir=tmp_path / "data")
    c.ensure_dirs()
    return c


# ---------- 类型识别 ----------

def test_detect_type_urls():
    assert detect_type("https://www.bilibili.com/video/BV1xx411c7mD/") == "video"
    assert detect_type("https://b23.tv/abc123") == "video"
    assert detect_type("https://github.com/owner/repo") == "code"
    assert detect_type("https://codeload.github.com/owner/repo/zip/refs/heads/main") == "code"
    assert detect_type("https://zhuanlan.zhihu.com/p/123") == "html"
    assert detect_type("https://cloud.tencent.com/developer/article/1") == "html"


def test_detect_type_local(tmp_path):
    v = tmp_path / "a.mp4"; v.write_bytes(b"0")
    z = tmp_path / "b.zip"; z.write_bytes(b"0")
    h = tmp_path / "c.html"; h.write_text("<html>")
    assert detect_type(str(v)) == "video"
    assert detect_type(str(z)) == "code"
    assert detect_type(str(h)) == "html"
    assert detect_type(str(tmp_path)) == "code"
    bad = tmp_path / "d.xyz"; bad.write_bytes(b"0")
    with pytest.raises(IngestError):
        detect_type(str(bad))
    with pytest.raises(IngestError):
        detect_type("not-a-url-or-path")


# ---------- P4：GitHub 链接解析与多镜像下载 ----------

def test_parse_github_variants():
    assert parse_github("https://github.com/o/r") == ("o", "r", "main")
    assert parse_github("https://github.com/o/r/") == ("o", "r", "main")
    assert parse_github("https://github.com/o/r/tree/dev") == ("o", "r", "dev")
    assert parse_github("https://codeload.github.com/o/r/zip/refs/heads/main") == ("o", "r", "main")
    with pytest.raises(IngestError):
        parse_github("https://example.com/o/r")


class _FakeResp:
    def __init__(self, data: bytes, status: int = 200):
        self.data, self.status, self.pos = data, status, 0

    def read(self, n: int = -1) -> bytes:
        if n is None or n < 0:
            n = len(self.data) - self.pos
        out = self.data[self.pos:self.pos + n]
        self.pos += len(out)
        return out

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_failover_first_mirror_broken(tmp_path):
    calls = []

    def fetcher(url, timeout=0, headers=None):
        calls.append(url)
        if "bad" in url:
            raise OSError("dns fail")
        return _FakeResp(b"z" * 500_000)

    dest = tmp_path / "r.zip"
    used, _ = download_with_failover(["https://bad/x", "https://good/x"], dest,
                                     fetcher=fetcher, min_speed=1)
    assert used == "https://good/x"
    assert dest.read_bytes() == b"z" * 500_000


def test_failover_slow_mirror_skipped(tmp_path, monkeypatch):
    import personal_agent_core.ingest.code as code_mod
    clock = iter([0, 100, 0, 0.01])  # 第一个镜像探针耗时 100s → 判慢；第二个 0.01s → 快
    monkeypatch.setattr(code_mod.time, "monotonic", lambda: next(clock))

    def fetcher(url, timeout=0, headers=None):
        return _FakeResp(b"z" * 500_000)

    dest = tmp_path / "r.zip"
    used, _ = download_with_failover(["https://slow/x", "https://fast/x"], dest,
                                     fetcher=fetcher, min_speed=50_000)
    assert used == "https://fast/x"


def test_failover_all_broken(tmp_path):
    def fetcher(url, timeout=0, headers=None):
        raise OSError("boom")

    with pytest.raises(IngestError, match="所有下载源均失败"):
        download_with_failover(["https://a/x", "https://b/x"], tmp_path / "r.zip",
                               fetcher=fetcher)


def test_resume_with_range(tmp_path):
    seen_headers = []

    def fetcher(url, timeout=0, headers=None):
        seen_headers.append(headers or {})
        status = 206 if (headers or {}).get("Range") else 200
        return _FakeResp(b"world", status=status)

    dest = tmp_path / "r.zip"
    dest.write_bytes(b"hello")
    download_with_failover(["https://good/x"], dest, fetcher=fetcher, min_speed=1)
    assert any(h.get("Range") == "bytes=5-" for h in seen_headers)
    assert dest.read_bytes() == b"helloworld"


# ---------- P4：代码库分析 ----------

def test_analyze_codebase(tmp_path):
    (tmp_path / "README.md").write_text("# Demo\n一个测试项目。", encoding="utf-8")
    (tmp_path / "main.py").write_text("print('hi')\n" * 10, encoding="utf-8")
    (tmp_path / "requirements.txt").write_text("numpy\n", encoding="utf-8")
    pkg = tmp_path / "utils"; pkg.mkdir()
    (pkg / "a.py").write_text("x = 1\n" * 5, encoding="utf-8")
    a = analyze_codebase(tmp_path)
    assert a["files"] == 4
    assert a["by_ext"][".py"] == 2
    # .md/.txt 均在 _TEXT_EXTS 内：README(2) + main.py(10) + requirements.txt(1) + a.py(5)
    assert a["total_lines"] == 18
    assert "main.py" in a["entries"]
    assert "requirements.txt" in a["deps"]
    assert "测试项目" in a["readme"]


def test_ingest_code_local_zip(conn, provider, cfg, tmp_path):
    src = tmp_path / "repo"
    src.mkdir()
    (src / "README.md").write_text("# Demo\n双靶点药物设计。", encoding="utf-8")
    (src / "main.py").write_text("print(1)\n", encoding="utf-8")
    zip_path = tmp_path / "repo.zip"
    with zipfile.ZipFile(zip_path, "w") as z:
        z.write(src / "README.md", "repo-main/README.md")
        z.write(src / "main.py", "repo-main/main.py")
    r = ingest(conn, cfg, provider, str(zip_path))
    assert r["kind"] == "code"
    assert Path(r["root"]).is_dir()
    obj = conn.execute("SELECT * FROM objects WHERE id = ?", (r["id"],)).fetchone()
    assert obj["lifecycle"] == "inbox"
    assert "双靶点药物设计" in obj["content"]
    assert "main.py" in obj["content"]


# ---------- P3：网页正文提取与反爬识别 ----------

_ARTICLE_HTML = """
<html><head><title>测试文章标题</title></head><body>
<nav>导航应该被忽略</nav>
<article>
<p>这是一段足够长的正文内容，用来验证正文提取逻辑是否正常工作，需要超过四十个字才行。</p>
<p>第二段正文同样需要足够长，包含一些关键信息比如 MoleculeOS 与蛋白质设计平台。</p>
<img src="https://img.example.com/chart1.png">
<img data-src="https://img.example.com/chart2.png">
</article>
<script>var x = 1;</script>
</body></html>
"""


def test_extract_article():
    a = extract_article(_ARTICLE_HTML, "https://example.com/p/1")
    assert a["title"] == "测试文章标题"
    assert "MoleculeOS" in a["text"]
    assert "导航应该被忽略" not in a["text"]
    assert a["images"] == ["https://img.example.com/chart1.png",
                           "https://img.example.com/chart2.png"]


def test_looks_like_challenge():
    zhihu_challenge = '<html><head><meta id="zh-zse-ck"></head><body>知乎</body></html>'
    assert looks_like_challenge(zhihu_challenge, 200) is True
    assert looks_like_challenge("anything", 403) is True
    assert looks_like_challenge(_ARTICLE_HTML, 200) is False


def test_ingest_html_local_file(conn, provider, cfg, tmp_path):
    f = tmp_path / "article.html"
    f.write_text(_ARTICLE_HTML, encoding="utf-8")
    r = ingest(conn, cfg, provider, str(f))
    assert r["kind"] == "html"
    assert r["fetch_mode"] == "static"
    obj = conn.execute("SELECT * FROM objects WHERE id = ?", (r["id"],)).fetchone()
    assert "MoleculeOS" in obj["content"]
    assert (Path(r["resources_dir"]) / "original.html").is_file()


# ---------- P2：视频采集（降级与转写两条路径） ----------

def test_parse_subtitle(tmp_path):
    vtt = tmp_path / "a.vtt"
    vtt.write_text("WEBVTT\n\n00:00.000 --> 00:02.000\n你好世界\n\n"
                   "00:02.000 --> 00:04.000\n你好世界\n\n"
                   "00:04.000 --> 00:06.000\n<c>第二行</c>\n", encoding="utf-8")
    text = _parse_subtitle(vtt)
    assert text == "你好世界\n第二行"


def test_ingest_video_degrades_without_ffmpeg(conn, provider, cfg, tmp_path, monkeypatch):
    import personal_agent_core.ingest.video as video_mod
    monkeypatch.setattr(video_mod, "find_ffmpeg", lambda: None)
    fake = tmp_path / "lecture.mp4"
    fake.write_bytes(b"\x00" * 1024)
    r = ingest(conn, cfg, provider, str(fake))
    assert r["kind"] == "video"
    assert r["transcript"] is False
    # 原始文件必须保留（AI 失败不丢数据）
    assert (Path(r["resources_dir"]) / "video.mp4").read_bytes() == b"\x00" * 1024
    assert any("ffmpeg" in w for w in r["warnings"])
    obj = conn.execute("SELECT * FROM objects WHERE id = ?", (r["id"],)).fetchone()
    assert obj["lifecycle"] == "inbox"  # 降级也正常入库


def test_ingest_video_with_mock_asr(conn, provider, cfg, tmp_path, monkeypatch):
    import personal_agent_core.ingest.video as video_mod
    monkeypatch.setattr(video_mod, "find_ffmpeg", lambda: "/fake/ffmpeg")
    monkeypatch.setattr(video_mod, "_extract_frames", lambda *a, **k: [])

    def fake_extract_audio(ffmpeg, video, res_dir):
        p = res_dir / "audio.mp3"
        p.write_bytes(b"fake-audio")
        return p
    monkeypatch.setattr(video_mod, "_extract_audio", fake_extract_audio)

    fake = tmp_path / "lecture.mp4"
    fake.write_bytes(b"\x00" * 1024)
    r = ingest(conn, cfg, provider, str(fake))
    assert r["transcript"] is True  # MockProvider.transcribe_audio 确定性输出
    obj = conn.execute("SELECT * FROM objects WHERE id = ?", (r["id"],)).fetchone()
    assert "Mock 转写" in obj["content"]


# ---------- P2：音频采集（格式识别 + ASR 直转） ----------

def test_detect_type_audio():
    assert detect_type("https://media.example.com/podcast/ep1.mp3") == "audio"
    assert detect_type("https://cdn.example.com/movie/clip.mp4") == "video"
    local = Path("a.m4a")
    assert local.suffix == ".m4a"


def test_detect_type_audio_local(tmp_path):
    for ext in (".mp3", ".wav", ".m4a", ".flac"):
        f = tmp_path / f"rec{ext}"
        f.write_bytes(b"0")
        assert detect_type(str(f)) == "audio"


def test_ingest_audio_with_mock_asr(conn, provider, cfg, tmp_path, monkeypatch):
    import personal_agent_core.ingest.video as video_mod
    monkeypatch.setattr(video_mod, "find_ffmpeg", lambda: None)  # 音频无需 ffmpeg 也能送 ASR
    fake = tmp_path / "meeting.mp3"
    fake.write_bytes(b"\x00" * 512)
    r = ingest(conn, cfg, provider, str(fake))
    assert r["kind"] == "audio"
    assert r["transcript"] is True
    assert (Path(r["resources_dir"]) / "recording.mp3").is_file()  # 原件保留
    obj = conn.execute("SELECT * FROM objects WHERE id = ?", (r["id"],)).fetchone()
    assert "音频笔记" in obj["content"]


# ---------- P3：可配置抓取（标签 / 深度 / 内容过滤 / Obsidian 导入） ----------

def test_filter_blocks_drops_ads():
    text = "这是正文第一句\n广告：立刻购买\n更多精彩内容推荐\n这是正文第二句"
    assert filter_blocks(text) == "这是正文第一句\n这是正文第二句"


def test_extract_article_min_block():
    html = "<p>" + "短" * 10 + "</p><p>" + "长" * 100 + "</p>"
    a = extract_article(html, "https://e.com", min_block_chars=50, drop_markers=None)
    assert a["text"] == "长" * 100


def test_ingest_html_options_tags_and_vault(conn, provider, cfg, tmp_path):
    f = tmp_path / "a.html"
    f.write_text(_ARTICLE_HTML, encoding="utf-8")
    vault = tmp_path / "vault"
    r = ingest(conn, cfg, provider, str(f),
               options={"tags": ["自定义"], "vault": str(vault), "max_images": 0})
    assert r["images"] == 0                       # max_images=0 → 不下载配图
    assert "自定义" in r["tags"]                   # 附加标签生效
    assert r["obsidian_path"] and Path(r["obsidian_path"]).is_file()  # 自动导入 vault/inbox
    assert Path(r["obsidian_path"]).parent.name == "inbox"


# ---------- P4：镜像优选 / 完整性校验 ----------

def test_rank_mirrors_orders_by_speed():
    def fetcher(url, timeout=0, headers=None):
        if "bad" in url:
            raise OSError("dns fail")
        return _FakeResp(b"z" * (200_000 if "fast" in url else 100))

    ranked = rank_mirrors(["https://bad/x", "https://slow/x", "https://fast/x"], fetcher)
    urls = [r["url"] for r in ranked]
    assert urls[0] == "https://fast/x"
    assert urls[1] == "https://slow/x"
    assert ranked[-1]["ok"] is False and urls[-1] == "https://bad/x"


def test_download_sha256_match(tmp_path):
    data = b"z" * 500_000
    expected = hashlib.sha256(data).hexdigest()

    def fetcher(url, timeout=0, headers=None):
        return _FakeResp(data)

    dest = tmp_path / "r.zip"
    used, warnings = download_with_failover(["https://good/x"], dest, fetcher=fetcher,
                                            min_speed=1, expected_sha256=expected)
    assert used == "https://good/x"
    assert dest.read_bytes() == data


def test_download_sha256_mismatch_fails(tmp_path):
    def fetcher(url, timeout=0, headers=None):
        return _FakeResp(b"z" * 500_000)

    with pytest.raises(IngestError, match="所有下载源均失败"):
        download_with_failover(["https://good/x"], tmp_path / "r.zip", fetcher=fetcher,
                               min_speed=1, expected_sha256="deadbeef")


def test_ingest_code_local_zip_sha256_mismatch(conn, provider, cfg, tmp_path):
    zip_path = tmp_path / "repo.zip"
    with zipfile.ZipFile(zip_path, "w") as z:
        z.writestr("repo-main/main.py", "print(1)\n")
    with pytest.raises(IngestError, match="sha256 校验失败"):
        ingest(conn, cfg, provider, str(zip_path), options={"sha256": "deadbeef"})


def test_verify_zip(tmp_path):
    good = tmp_path / "g.zip"
    with zipfile.ZipFile(good, "w") as z:
        z.writestr("a.txt", "hi")
    assert verify_zip(good) is None
    bad = tmp_path / "b.zip"
    bad.write_bytes(b"not a zip at all")
    assert verify_zip(bad) == "<不是有效的 zip>"


# ---------- P2：密钥安全存储 ----------

def test_secret_status_env_fallback(monkeypatch):
    monkeypatch.delenv("PROS_API_KEY", raising=False)
    cfg = Config(key_env="PROS_API_KEY")
    st = secret_status(cfg)
    assert st["key_name"] == "PROS_API_KEY"
    assert st["env_set"] is False
    monkeypatch.setenv("PROS_API_KEY", "sk-test")
    assert secret_status(cfg)["env_set"] is True
    assert get_secret(cfg) == "sk-test"       # 无 keyring 或 keyring 为空时回退环境变量
