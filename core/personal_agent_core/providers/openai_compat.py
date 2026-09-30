"""OpenAI-compatible Provider（DeepSeek / Qwen / 任意兼容端点，需求 23-D/E/H）。

- 密钥只从环境变量读取（config.get_secret），不写日志、不进 DB、不进 prompt。
- 所有请求过出站 allowlist（默认最小开放）。
"""
from __future__ import annotations

import json
import re
import urllib.request

from ..config import Config, get_secret

PRESETS = {
    "deepseek": ("https://api.deepseek.com/v1", "deepseek-chat"),
    "qwen": ("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus"),
    "local": ("http://127.0.0.1:11434/v1", "qwen2.5"),  # Ollama 等本地端点
}


class OpenAICompatProvider:
    def __init__(self, name: str, base_url: str, model: str, api_key: str | None,
                 allowlist_check, timeout: int = 60,
                 asr_base_url: str | None = None, asr_model: str = "whisper-1",
                 vision_model: str | None = None):
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._api_key = api_key
        self._allowlist_check = allowlist_check
        self.timeout = timeout
        # 多模态端点（P2）：密钥只从 config.get_secret 读取，不落到这里之外
        self._asr_base_url = (asr_base_url or self.base_url).rstrip("/")
        self._asr_model = asr_model
        self._vision_model = vision_model or model

    @classmethod
    def from_config(cls, cfg: Config) -> "OpenAICompatProvider":
        url, model = PRESETS.get(cfg.provider, (cfg.base_url, cfg.model or "gpt-4o-mini"))
        if cfg.base_url:
            url = cfg.base_url
        if cfg.model:
            model = cfg.model
        if not url:
            raise ValueError("openai_compat provider 需要 PROS_BASE_URL（或选 deepseek/qwen/local 预设）")
        return cls(cfg.provider, url, model, get_secret(cfg), cfg.check_outbound,
                   asr_base_url=cfg.asr_base_url, asr_model=cfg.asr_model,
                   vision_model=cfg.vision_model)

    def _chat(self, messages: list[dict]) -> str:
        url = f"{self.base_url}/chat/completions"
        self._allowlist_check(url)  # 出站边界
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        body = json.dumps({"model": self.model, "messages": messages, "temperature": 0}).encode()
        req = urllib.request.Request(url, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data = json.loads(resp.read().decode())
        return data["choices"][0]["message"]["content"]

    @staticmethod
    def _json_from(text: str):
        m = re.search(r"\{.*\}|\[.*\]", text, re.S)
        return json.loads(m.group(0)) if m else None

    def classify(self, text: str) -> dict:
        prompt = (
            "把以下内容分类为 note/idea/task/person/project/event/bookmark/document/"
            "meeting/conversation/topic/concept/decision/risk/money/location 之一，"
            '输出 JSON {"type":..., "confidence":0-1, "tags":[]}：\n' + text[:4000]
        )
        parsed = self._json_from(self._chat([{"role": "user", "content": prompt}]))
        return parsed or {"type": "note", "confidence": 0.3, "tags": []}

    def summarize(self, text: str) -> str:
        return self._chat([{"role": "user", "content": "用一句话摘要以下内容：\n" + text[:4000]}]).strip()

    def extract_tasks(self, text: str) -> list[dict]:
        prompt = (
            "从以下内容提取待办任务，输出 JSON 数组 "
            '[{"title":..., "due_at":"YYYY-MM-DD或null", "priority":"P0-P3", '
            '"span":{"start":行内字符起点,"end":终点}}]，没有则输出 []：\n' + text[:4000]
        )
        parsed = self._json_from(self._chat([{"role": "user", "content": prompt}]))
        return parsed if isinstance(parsed, list) else []

    def answer(self, question: str, evidence: list[str]) -> str:
        ev = "\n".join(f"[{i}] {e}" for i, e in enumerate(evidence, 1))
        prompt = (
            "只能基于给定证据回答，引用处标注 [编号]；证据不足就直接回答"
            "「我没有在资料库中找到可回答该问题的证据。」\n证据：\n" + ev + "\n问题：" + question
        )
        return self._chat([{"role": "user", "content": prompt}]).strip()

    def complete(self, messages: list[dict]) -> dict:
        raw = self._chat(messages)
        parsed = self._json_from(raw)
        if isinstance(parsed, dict) and ("tool_calls" in parsed or "final" in parsed):
            return parsed
        return {"final": raw}

    # ---- 多模态能力（视频/音频采集用） ----

    def transcribe_audio(self, path: str) -> str:
        """OpenAI 兼容 /audio/transcriptions 语音转写。

        端点：PROS_ASR_BASE_URL（缺省复用 provider base_url）+ PROS_ASR_MODEL（缺省 whisper-1）。
        密钥只从 config.get_secret 读取（keyring / 环境变量）；出站严格过 allowlist。
        """
        import os
        base = self._asr_base_url
        model = self._asr_model
        url = f"{base}/audio/transcriptions"
        try:
            self._allowlist_check(url)  # 出站边界
        except PermissionError as e:
            raise RuntimeError(f"{e}\n提示：如 ASR 与主模型同域可省略 PROS_ASR_BASE_URL；"
                               f"否则把该域名加入 PROS_OUTBOUND_ALLOWLIST 后重试。") from e
        boundary = "----pros" + os.urandom(8).hex()
        with open(path, "rb") as f:
            audio = f.read()
        parts = []
        for name, value in (("model", model), ("response_format", "text")):
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                         f'name="{name}"\r\n\r\n{value}\r\n'.encode())
        fname = os.path.basename(path)
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; "
                     f'name="file"; filename="{fname}"\r\n'
                     f"Content-Type: application/octet-stream\r\n\r\n".encode()
                     + audio + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        req = urllib.request.Request(url, data=b"".join(parts), headers=headers)
        with urllib.request.urlopen(req, timeout=max(self.timeout, 600)) as resp:
            return resp.read().decode("utf-8", errors="replace").strip()

    def analyze_images(self, paths: list[str], prompt: str) -> str:
        """视觉模型读图（PROS_VISION_MODEL 指定模型，缺省用主模型）。"""
        import base64
        model = self._vision_model
        content: list[dict] = [{"type": "text", "text": prompt}]
        for p in paths:
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            content.append({"type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
        url = f"{self.base_url}/chat/completions"
        self._allowlist_check(url)
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        body = json.dumps({"model": model,
                           "messages": [{"role": "user", "content": content}],
                           "temperature": 0}).encode()
        req = urllib.request.Request(url, data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=max(self.timeout, 300)) as resp:
            data = json.loads(resp.read().decode())
        return data["choices"][0]["message"]["content"]
