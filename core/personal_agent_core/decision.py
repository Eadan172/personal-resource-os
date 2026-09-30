"""可插拔决策评估模型接口（ADR-007，“Jev模型”待确认）。

未检索到公认的“Jev模型”定义，按需求 38-C 抽象为接口保留，
默认 NullDecisionModel 透出不评分。确认定义后以插件实现本 Protocol。
"""
from __future__ import annotations

from typing import Protocol


class DecisionEvaluationModel(Protocol):
    name: str

    def evaluate(self, decision: dict, context: dict) -> dict:
        """返回 {decision_id, assessment, confidence, model}。"""
        ...


class NullDecisionModel:
    name = "null"

    def evaluate(self, decision: dict, context: dict) -> dict:
        return {
            "decision_id": decision.get("id"),
            "assessment": "未配置决策评估模型（Jev模型定义待用户确认，见 ADR-007）",
            "confidence": 0.0,
            "model": self.name,
        }
