/**
 * Agent Runtime（对应 Python Core agents.py，docs/05 Agent 运行时设计）。
 *
 * 硬约束（全部有 UI 可观测 + 不可被配置绕过）：
 *  - max_steps / timeout_s / max_tokens（来自 Agent 预算，且被 HARD_LIMITS 夹住）；
 *  - 工具白名单：不在 allowed_tools 里的工具直接判失败；
 *  - 审批门：approval_policy[action_class] = confirm 时挂起，写 approvals 队列，
 *    未批准**绝不落库**；deny 直接拒绝该分支；
 *  - 每步 tool call 记录进 run.trace，形成可观测轨迹；
 *  - 所有 mutation 带 agent_run_id 进审计（可整体回溯）。
 */
import type { CoreConfig } from "./config";
import { HARD_LIMITS } from "./config";
import type {
  AgentDef, AgentRun, AgentStep, Approval, ApprovalKind, ProsObject,
} from "./models";
import type { Store } from "./store";
import type { ChatMessage, ChatProvider } from "./providers/base";
import { estimateTokens } from "./providers/base";
import { search } from "./retrieval";
import { createTask } from "./tasks";
import { newId, nowIso, truncate } from "./util";

/** 工具定义：名称 + 动作类别（决定审批策略）+ 实现。 */
interface ToolDef {
  actionClass: "read" | "write" | "outbound";
  run: (store: Store, args: Record<string, unknown>, runId: string) => Promise<unknown>;
}

export const TOOLS: Record<string, ToolDef> = {
  search: {
    actionClass: "read",
    run: async (store, args) => search(store, String(args.query ?? ""), { limit: 5 }),
  },
  read_object: {
    actionClass: "read",
    run: async (store, args) => {
      const o = store.object(String(args.object_id ?? ""));
      return o ? { id: o.id, title: o.title, type: o.type, content: truncate(o.content, 2000) } : null;
    },
  },
  create_task: {
    actionClass: "write",
    run: async (store, args, runId) =>
      createTask(store, {
        title: String(args.title ?? "未命名任务"),
        due_at: (args.due_at as string | null) ?? null,
        priority: (args.priority as "P0" | "P1" | "P2" | "P3") ?? "P2",
        provenance: { via: "agent", tool: "create_task" },
        actor: "agent:runtime",
        agent_run_id: runId,
      }),
  },
  suggest_relation: {
    actionClass: "write",
    run: async (store, args) => {
      const src = String(args.src_id ?? "");
      const dst = String(args.dst_id ?? "");
      if (!store.object(src) || !store.object(dst)) throw new Error("关系两端对象不存在");
      if (store.hasRelation(src, dst)) return "关系已存在，跳过";
      const id = newId("rel_");
      store.insertRelation(
        {
          id, src_id: src, dst_id: dst,
          type: (args.rel_type as "related_to") ?? "related_to",
          status: "suggested", confidence: 0.5,
          provenance: { origin: "ai_suggested", via: "agent" },
          created_at: nowIso(),
        },
        "agent:runtime",
      );
      return id;
    },
  },
};

export interface RunAgentResult {
  run_id: string;
  status: AgentRun["status"];
  error: string | null;
  result: unknown;
  steps: number;
  tokens: number;
}

/**
 * 执行一次 Agent 运行。
 * 返回 waiting_approval 时，run 已挂起，需用户在审批中心决定后调用 decideApproval 继续。
 */
export async function runAgent(
  store: Store,
  cfg: CoreConfig,
  provider: ChatProvider,
  agent: AgentDef,
  inputText: string,
  trigger = "manual",
): Promise<RunAgentResult> {
  // 预算先夹到硬上限，Agent 自身配置无法突破（docs F.2）
  const budgets = {
    max_steps: Math.min(agent.budgets?.max_steps ?? cfg.agentBudgets.max_steps, HARD_LIMITS.max_steps),
    timeout_s: Math.min(agent.budgets?.timeout_s ?? cfg.agentBudgets.timeout_s, HARD_LIMITS.timeout_s),
    max_tokens: Math.min(agent.budgets?.max_tokens ?? cfg.agentBudgets.max_tokens, HARD_LIMITS.max_tokens),
    max_retries: Math.min(agent.budgets?.max_retries ?? cfg.agentBudgets.max_retries, HARD_LIMITS.max_retries),
    max_depth: Math.min(agent.budgets?.max_depth ?? cfg.agentBudgets.max_depth, HARD_LIMITS.max_depth),
  };

  const run: AgentRun = {
    id: newId("run_"),
    agent_name: agent.name,
    trigger,
    status: "running",
    steps: 0,
    tokens_used: 0,
    error: null,
    started_at: nowIso(),
    finished_at: null,
    trace: [],
  };
  store.createAgentRun(run);

  const messages: ChatMessage[] = [
    { role: "system", content: agent.instructions },
    { role: "user", content: inputText },
  ];

  const startedAt = Date.now();
  let status: AgentRun["status"] = "succeeded";
  let error: string | null = null;
  let result: unknown = null;
  let steps = 0;
  let tokens = 0;

  while (true) {
    // --- 预算检查（任一超限 → 优雅终止并留痕）---
    if (steps >= budgets.max_steps) {
      status = "aborted_budget";
      error = `超过 max_steps=${budgets.max_steps}`;
      break;
    }
    if ((Date.now() - startedAt) / 1000 > budgets.timeout_s) {
      status = "aborted_timeout";
      error = `超过 timeout_s=${budgets.timeout_s}`;
      break;
    }

    let resp;
    try {
      resp = await provider.complete(messages, agent.allowed_tools);
    } catch (e) {
      status = "failed";
      error = `模型调用失败：${String(e)}`;
      break;
    }
    tokens += estimateTokens(messages);
    if (tokens > budgets.max_tokens) {
      status = "aborted_budget";
      error = `超过 max_tokens=${budgets.max_tokens}`;
      break;
    }
    run.tokens_used = tokens;

    if ("final" in resp) {
      result = resp.final;
      break;
    }

    let policyHit = false;
    for (const call of resp.tool_calls ?? []) {
      steps++;
      const step: AgentStep = {
        index: steps,
        tool: call.name,
        arguments: call.arguments,
        policy: "auto",
        status: "ok",
        at: nowIso(),
      };

      // --- 工具白名单（最小权限）---
      const tool = TOOLS[call.name];
      if (!tool || !agent.allowed_tools.includes(call.name)) {
        step.policy = "deny";
        step.status = "denied";
        step.error = `工具 ${call.name} 不在白名单`;
        run.trace.push(step);
        status = "failed";
        error = step.error;
        policyHit = true;
        break;
      }

      // --- 写范围检查（Agent 的 allowed_scopes 只读/写声明）---
      const policy = agent.approval_policy[tool.actionClass] ?? "confirm";
      step.policy = policy;
      if (policy === "deny") {
        step.status = "denied";
        step.error = `策略拒绝 ${call.name}（action_class=${tool.actionClass}）`;
        run.trace.push(step);
        status = "failed";
        error = step.error;
        policyHit = true;
        break;
      }
      if (policy === "confirm") {
        // 挂起等待审批：写 approvals 队列，未批准不落库
        const kind: ApprovalKind =
          call.name === "create_task" ? "task_create"
            : call.name === "suggest_relation" ? "relation"
              : "bulk_write";
        const ap: Approval = {
          id: newId("apr_"),
          agent_run_id: run.id,
          kind,
          action: { tool: call.name, arguments: call.arguments },
          payload: { agent: agent.name, input: truncate(inputText, 400) },
          requested_by: `agent:${agent.name}`,
          status: "pending",
          decided_by: null,
          created_at: nowIso(),
          decided_at: null,
        };
        store.addApproval(ap);
        step.status = "pending_approval";
        run.trace.push(step);
        run.status = "waiting_approval";
        run.steps = steps;
        store.updateAgentRun(run.id, run);
        await store.flush();
        return { run_id: run.id, status: "waiting_approval", error: null, result: { approval_id: ap.id }, steps, tokens };
      }

      // --- 自动执行 ---
      try {
        const r = await tool.run(store, call.arguments, run.id);
        step.result = summarizeResult(r);
        messages.push({ role: "tool", content: `[TOOL_RESULT] ${call.name}: ${JSON.stringify(step.result)}` });
      } catch (e) {
        step.status = "error";
        step.error = String(e);
        messages.push({ role: "tool", content: `[TOOL_ERROR] ${call.name}: ${String(e)}` });
      }
      run.trace.push(step);
    }
    if (policyHit) break;
    if (!resp.tool_calls?.length) {
      // 模型既没给 final 也没给工具调用：防止死循环，直接收尾
      result = "模型未返回可执行动作，已结束。";
      break;
    }
  }

  run.status = status;
  run.error = error;
  run.steps = steps;
  run.tokens_used = tokens;
  run.finished_at = nowIso();
  store.updateAgentRun(run.id, run);
  await store.flush();
  return { run_id: run.id, status, error, result, steps, tokens };
}

function summarizeResult(r: unknown): unknown {
  if (typeof r === "string") return truncate(r, 200);
  if (Array.isArray(r)) return { count: r.length, sample: r.slice(0, 2) };
  if (r && typeof r === "object") return JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "string" ? truncate(v, 200) : v)));
  return r;
}

/**
 * 审批决定。批准时重放被挂起的工具调用并补记审计（带 agent_run_id），
 * 拒绝时把 run 标记为 failed。两种情况都写 decided_by/decided_at。
 */
export async function decideApproval(
  store: Store,
  approvalId: string,
  approve: boolean,
  actor = "user",
): Promise<{ approval_id: string; status: string; result: unknown }> {
  const ap = store.approval(approvalId);
  if (!ap) throw new Error(`审批 ${approvalId} 不存在`);
  if (ap.status !== "pending") throw new Error("该审批已处理");

  const status = approve ? "approved" : "rejected";
  store.updateApproval(approvalId, { status, decided_by: actor, decided_at: nowIso() });

  let result: unknown = null;
  if (approve) {
    const tool = TOOLS[ap.action.tool];
    if (!tool) throw new Error(`未知工具：${ap.action.tool}`);
    result = await tool.run(store, ap.action.arguments, ap.agent_run_id ?? "manual");
    if (ap.agent_run_id) {
      const run = store.agentRuns.find((r) => r.id === ap.agent_run_id);
      if (run) {
        run.status = "succeeded";
        run.finished_at = nowIso();
        run.trace.push({
          index: run.steps + 1,
          tool: ap.action.tool,
          arguments: ap.action.arguments,
          policy: "confirm",
          status: "ok",
          result: summarizeResult(result),
          at: nowIso(),
        });
        store.updateAgentRun(run.id, run);
      }
    }
  } else if (ap.agent_run_id) {
    const run = store.agentRuns.find((r) => r.id === ap.agent_run_id);
    if (run) {
      run.status = "failed";
      run.error = "审批被拒绝，动作未执行";
      run.finished_at = nowIso();
      store.updateAgentRun(run.id, run);
    }
  }
  await store.flush();
  return { approval_id: approvalId, status, result };
}

/** 手工提交一个待审批动作（用于「Agent 建议写入但需人工确认」的场景）。 */
export function requestApproval(
  store: Store,
  kind: ApprovalKind,
  tool: string,
  args: Record<string, unknown>,
  requestedBy: string,
  payload: Record<string, unknown> = {},
): string {
  const id = newId("apr_");
  store.addApproval({
    id,
    agent_run_id: null,
    kind,
    action: { tool, arguments: args },
    payload,
    requested_by: requestedBy,
    status: "pending",
    decided_by: null,
    created_at: nowIso(),
    decided_at: null,
  });
  return id;
}

/** Agent 运行历史（Dashboard「运行记录」用）。 */
export function runHistory(store: Store, limit = 50): AgentRun[] {
  return store.agentRuns.slice(0, limit);
}

/** 读取某对象的正文用于 Agent 输入（截断，避免超预算）。 */
export function agentInputFor(obj: ProsObject, max = 6000): string {
  return `标题：${obj.title}\n类型：${obj.type}\n标签：${obj.tags.join(", ")}\n\n正文：\n${truncate(obj.content, max)}`;
}
