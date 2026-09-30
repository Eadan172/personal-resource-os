"""Provider 抽象接口。所有 AI 输出必须结构化且可携带证据 span。"""
from __future__ import annotations

from typing import Protocol


class ChatProvider(Protocol):
    name: str

    def classify(self, text: str) -> dict:
        """返回 {type, confidence, tags: []}。type ∈ OBJECT_TYPES。"""
        ...

    def summarize(self, text: str) -> str:
        ...

    def extract_tasks(self, text: str) -> list[dict]:
        """返回 [{title, due_at, priority, span:{start,end}}]。"""
        ...

    def answer(self, question: str, evidence: list[str]) -> str:
        """基于证据回答，用 [1] [2] 引用证据编号。无证据时不得编造。"""
        ...

    def complete(self, messages: list[dict]) -> dict:
        """Agent 循环用。返回 {"final": str} 或 {"tool_calls": [{name, arguments}]}。"""
        ...

    # ---- 可选能力（多模态采集用，未实现时采集自动降级，不报错） ----

    def transcribe_audio(self, path: str) -> str:
        """语音转写：音频文件 → 逐字稿。需要 ASR 端点（PROS_ASR_BASE_URL/PROS_ASR_MODEL）。"""
        ...

    def analyze_images(self, paths: list[str], prompt: str) -> str:
        """视觉分析：读取图片内容并按 prompt 总结。需要视觉模型（PROS_VISION_MODEL）。"""
        ...
