# ADR-007 “Jev模型”按可插拔 Decision Evaluation Model 处理

- 状态：已接受（待用户确认定义）  日期：2026-09-29
- 背景：选择 38-C 提到决策部分加入“Jev模型”，并要求不得擅自解释、先检索确认。检索未找到公认的“Jev模型”定义（可能为用户内部方法论或拼写变体）。
- 决定：定义 `DecisionEvaluationModel` Protocol 接口，默认 NullDecisionModel（透出不评分）；阶段总结的决策部分通过该接口挂载。待用户给出定义后实现具体模型插件。
- 后果：总结功能不被阻塞；接口位于 core/personal_agent_core/decision.py。
