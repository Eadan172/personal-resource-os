"""Mock Provider：完全确定性，供离线模式与 CI 测试（需求：AI Mock / deterministic test）。

规则实现复用 extraction 模块，保证同输入恒同输出、无网络依赖。
"""
from __future__ import annotations

from .. import extraction

_TYPE_RULES = [
    ("bookmark", ("http://", "https://", "网址", "链接")),
    ("meeting", ("会议", "开会", "meeting", "纪要")),
    ("idea", ("想法", "灵感", "idea", "点子")),
    ("event", ("活动", "日程", " event")),
    ("risk", ("风险", "隐患")),
    ("decision", ("决定", "决策")),
    ("document", ("文档", "报告", "说明书")),
]


class MockProvider:
    name = "mock"

    def __init__(self, base_date=None):
        self.base_date = base_date

    def classify(self, text: str) -> dict:
        lowered = text.lower()
        for obj_type, keywords in _TYPE_RULES:
            if any(k in lowered or k in text for k in keywords):
                return {"type": obj_type, "confidence": 0.8, "tags": [t["value"] for t in extraction.find_tags(text)]}
        return {"type": "note", "confidence": 0.6, "tags": [t["value"] for t in extraction.find_tags(text)]}

    def summarize(self, text: str) -> str:
        first = text.strip().splitlines()[0] if text.strip() else ""
        first = first.split("。")[0]
        return (first[:80] + "…") if len(first) > 80 else first

    def extract_tasks(self, text: str) -> list[dict]:
        return extraction.find_task_lines(text, self.base_date)

    def answer(self, question: str, evidence: list[str]) -> str:
        # 确定性回答：拼接最相关证据并逐条引用
        parts = ["根据资料库中的证据："]
        for i, ev in enumerate(evidence, 1):
            snippet = ev.replace("\n", " ")[:120]
            parts.append(f"{snippet} [{i}]")
        return "\n".join(parts)

    def complete(self, messages: list[dict]) -> dict:
        """Agent 循环的确定性行为：
        - 末条消息含 [TOOL_RESULT] → 收尾
        - 末条消息含 FORCE_LOOP → 永远要求调用工具（用于预算/死循环测试）
        - 用户输入含任务关键词 → 调用 create_task 一次
        """
        last = messages[-1]["content"] if messages else ""
        if any("FORCE_LOOP" in str(m.get("content", "")) for m in messages):
            return {"tool_calls": [{"name": "search", "arguments": {"query": "loop"}}]}
        if "[TOOL_RESULT]" in last:
            return {"final": "已完成整理。"}
        tasks = extraction.find_task_lines(last, self.base_date)
        if tasks:
            return {"tool_calls": [{"name": "create_task", "arguments": {
                "title": tasks[0]["title"], "due_at": tasks[0]["due_at"], "priority": tasks[0]["priority"],
            }}]}
        return {"final": "无需行动。"}

    def transcribe_audio(self, path: str) -> str:
        """确定性模拟转写（离线测试用）：不产生真实内容，只证明链路可用。"""
        import os
        return f"（Mock 转写）音频文件 {os.path.basename(path)} 的模拟逐字稿。"

    def analyze_images(self, paths: list[str], prompt: str) -> str:
        """确定性模拟视觉分析（离线测试用）。"""
        import os
        names = "、".join(os.path.basename(p) for p in paths[:5])
        return f"（Mock 视觉分析）已读取 {len(paths)} 张关键帧（{names} 等）。"
