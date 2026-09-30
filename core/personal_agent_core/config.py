"""配置与密钥边界（需求 §五 / NFR-01）。

- API Key 优先从 OS secret store（Windows 凭据管理器 / macOS Keychain / Secret Service）
  读取，其次回退环境变量；绝不落库、不进日志、不进模型上下文。
- 出站请求必须命中 allowlist，默认最小开放。
- 采集相关默认参数（镜像、配图数、Obsidian vault）集中在此，便于用户一次配置。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

_KEYRING_SERVICE = "personal-resource-os"


@dataclass
class Config:
    data_dir: Path = Path("./data")
    provider: str = "mock"          # mock | deepseek | qwen | openai_compat | local
    model: str | None = None
    base_url: str | None = None     # openai_compat 时必填
    key_env: str = "PROS_API_KEY"   # 密钥名（keyring 用户名 / 环境变量名）
    # 出站 allowlist（域名级），默认只放行本地与主流官方端点
    outbound_allowlist: tuple[str, ...] = (
        "127.0.0.1", "localhost",
        "api.deepseek.com", "dashscope.aliyuncs.com",
    )
    default_data_class: str = "internal"

    # ---- 多模态（P2）：ASR / 视觉模型各自可配 ----
    asr_base_url: str | None = None          # 语音转写端点（缺省复用 base_url）
    asr_model: str = "whisper-1"
    vision_model: str | None = None          # 关键帧读图模型（缺省用主模型）

    # ---- 采集（P3/P4）默认参数 ----
    vault_dir: Path | None = None            # Obsidian vault：采集笔记自动导入目录
    ingest_max_images: int = 10              # 网页正文配图下载上限
    github_mirrors: tuple[str, ...] | None = None  # GitHub 下载镜像（None=内置默认）

    @property
    def db_path(self) -> Path:
        return self.data_dir / "pros.db"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.files_dir.mkdir(parents=True, exist_ok=True)

    def check_outbound(self, url: str) -> None:
        host = urlparse(url).hostname or ""
        if host not in self.outbound_allowlist:
            raise PermissionError(f"出站请求被拒绝：{host} 不在 allowlist（默认最小开放）。"
                                  f"如需放行，请设置 PROS_OUTBOUND_ALLOWLIST={host}")


def load_config(env: dict | None = None) -> Config:
    env = env or os.environ
    cfg = Config(
        data_dir=Path(env.get("PROS_DATA_DIR", "./data")),
        provider=env.get("PROS_PROVIDER", "mock"),
        model=env.get("PROS_MODEL"),
        base_url=env.get("PROS_BASE_URL"),
        key_env=env.get("PROS_KEY_ENV", "PROS_API_KEY"),
        asr_base_url=env.get("PROS_ASR_BASE_URL"),
        asr_model=env.get("PROS_ASR_MODEL", "whisper-1"),
        vision_model=env.get("PROS_VISION_MODEL"),
    )
    extra = env.get("PROS_OUTBOUND_ALLOWLIST")
    if extra:
        cfg.outbound_allowlist = tuple(h.strip() for h in extra.split(",") if h.strip())
    vault = env.get("PROS_OBSIDIAN_VAULT")
    if vault:
        cfg.vault_dir = Path(vault)
    if env.get("PROS_INGEST_MAX_IMAGES"):
        try:
            cfg.ingest_max_images = int(env["PROS_INGEST_MAX_IMAGES"])
        except ValueError:
            pass
    mirrors = env.get("PROS_GITHUB_MIRRORS")
    if mirrors:
        cfg.github_mirrors = tuple(m.strip() for m in mirrors.split(","))
    return cfg


# --------------------------------------------------------------------------- #
# 密钥安全存储（P2）：OS secret store 优先，环境变量兜底
# --------------------------------------------------------------------------- #

def _keyring():
    """可选依赖 keyring；未安装时返回 None（不影响其它功能）。"""
    try:
        import keyring
        return keyring
    except Exception:
        return None


def get_secret(cfg: Config) -> str | None:
    """读取密钥：OS secret store（keyring）优先，其次环境变量。"""
    kr = _keyring()
    if kr is not None:
        try:
            value = kr.get_password(_KEYRING_SERVICE, cfg.key_env)
            if value:
                return value
        except Exception:
            pass
    return os.environ.get(cfg.key_env)


def set_secret(name: str, value: str) -> str:
    """把密钥写入 OS secret store。未安装 keyring 时给出可操作提示。"""
    kr = _keyring()
    if kr is None:
        raise RuntimeError(
            "未安装 keyring，无法写入系统凭据库。请任选其一：\n"
            "  1) pip install keyring 后重试（推荐：密钥进 Windows 凭据管理器）；\n"
            f"  2) 继续使用环境变量：set {name}=<你的密钥>"
        )
    kr.set_password(_KEYRING_SERVICE, name, value)
    return f"keyring://{_KEYRING_SERVICE}/{name}"


def secret_status(cfg: Config) -> dict:
    """返回密钥来源状态（不泄露密钥内容），用于自检与错误提示。"""
    kr = _keyring()
    stored = False
    if kr is not None:
        try:
            stored = bool(kr.get_password(_KEYRING_SERVICE, cfg.key_env))
        except Exception:
            stored = False
    return {
        "key_name": cfg.key_env,
        "keyring_available": kr is not None,
        "stored_in_keyring": stored,
        "env_set": bool(os.environ.get(cfg.key_env)),
        "available": stored or bool(os.environ.get(cfg.key_env)),
    }