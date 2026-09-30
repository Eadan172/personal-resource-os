"""Provider Adapter：Chat/Embedding/Reranker/OCR 能力分别配置（需求 23/24）。"""
from __future__ import annotations

from ..config import Config


def get_provider(cfg: Config):
    """按配置返回 Provider 实例。"""
    if cfg.provider == "mock":
        from .mock import MockProvider
        return MockProvider()
    if cfg.provider in ("deepseek", "qwen", "openai_compat", "local"):
        from .openai_compat import OpenAICompatProvider
        return OpenAICompatProvider.from_config(cfg)
    raise ValueError(f"未知 provider: {cfg.provider}")
