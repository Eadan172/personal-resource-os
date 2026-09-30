# F. Agent Runtime 设计

目标：Agent 是「Personal Chief-of-Staff」，不是黑盒聊天机器人。可观察、可限制、可审批、可回滚。

## 1. Agent 定义（agents 表，§八字段全集）

```json
{
  "name": "inbox-organizer",
  "purpose": "自动整理 Inbox：分类、摘要、提取任务与关系建议",
  "instructions": "……system prompt……",
  "allowed_tools": ["search", "read_object", "create_task", "suggest_relation", "update_ai_fields"],
  "allowed_scopes": {"objects": ["inbox"], "write": ["tasks", "relations:suggested", "objects.ai_fields"]},
  "provider": "deepseek", "model": "deepseek-chat",
  "trigger": "event:inbox  | cron:0 3 * * * | manual",
  "output_schema": {"type": "object", "properties": {...}},
  "approval_policy": {"create_task": "auto", "suggest_relation": "auto", "delete": "confirm", "outbound": "confirm"},
  "budgets": {"max_steps": 20, "timeout_s": 300, "max_tokens": 50000, "max_retries": 2, "max_depth": 1},
  "failure_policy": {"on_failure": "keep_raw_and_mark", "notify": true}
}
```

## 2. Runtime 执行循环

```
run(agent_def, input):
  run_id = agent_runs.create(status=running)
  loop while steps < max_steps and elapsed < timeout_s and tokens < max_tokens:
      msg = provider.complete(system=instructions, context=scoped_context, tools=allowed_tools)
      if msg is final_answer: break
      for tool_call in msg.tool_calls:
          policy_check(tool_call)            # 最小权限：工具白名单 + 写范围 + 出站范围
          if approval_policy[action_class] == "confirm":
              approvals.create(...); run.status = waiting_approval; return
          result = execute(tool_call)        # 每个 mutation 进 audit_log（带 run_id）
          feed result back
  finalize(run_id, output_schema 校验)
```

硬性约束（全部有测试）：
- **max_steps / timeout / token budget / retry budget / recursion depth** 任一超限 → abort，标记原因，原始数据不受影响。
- Agent 写权限收窄到「允许范围」：`objects.content` 永远不在任何 Agent 的写范围内。
- Agent 状态全程可观察：Dashboard「Agent Run History」展示每步 tool call、token、耗时、diff。

## 3. 内建 Agent（第一阶段）

| Agent | 触发 | 职责 | 审批策略 |
|---|---|---|---|
| inbox-organizer | event:inbox / 手动 / 夜间 | 分类、摘要、实体与任务提取、关系建议 | 任务/关系 auto（均为新建且可回滚）；删除 confirm |
| summarizer | cron 每日/每周/每月 | 阶段总结 + 行动建议（一键转 Task 由用户点击） | 写 summary auto；转 task 由用户触发 |
| relinker | 手动/夜间 | duplicate_of 提示、related_to 建议 | 全部 suggested，用户审核 |
| （二期）researcher | 手动 | 基于库内证据的深度问答 | 只读 |

## 4. 失败安全

- AI 失败 → 对象保持 inbox 状态 + `processing_error` 标记，绝不丢原始数据（选择 22-C）。
- 重试预算用尽 → 进入 Inbox「待手动处理」视图。
- 所有 AI 产物 origin=ai_extracted/ai_inferred/ai_suggested，UI 上视觉区分，不得伪装成事实。

## 5. 决策评估模型接口（“Jev模型”，选择 38-C）

未检索到公认定义，不擅自解释。抽象为可插拔接口（ADR-007）：

```python
class DecisionEvaluationModel(Protocol):
    name: str
    def evaluate(self, decision: Decision, context: EvidenceSet) -> DecisionAssessment: ...
```

默认实现 `NullDecisionModel`（只透出不评分）；待用户确认「Jev模型」具体含义后以插件形式接入。
