/**
 * 可插拔决策评估模型（对应 Python Core decision.py，ADR-007）。
 *
 * 文档结论：Jev（TypeSafe AI 的 System One 决策模型）是**闭源云端 API**，
 * 且非英文准确率未经独立验证，因此定位为「可选 Provider，默认关闭」，
 * 必须有离线兜底实现。本模块提供三种实现：
 *  - RulesDecisionModel：纯规则、完全离线（默认启用）；
 *  - LLMStructuredDecisionModel：用已配置的 Chat 模型做 JSON schema 兜底（离线不可用）；
 *  - JevDecisionModel：占位实现，仅在用户显式启用并配置端点后才会真正发请求。
 *
 * 三种原语与文档 F.4 对齐：Choice（多选一）/ Score（有序评分）/ Noul（是非概率）。
 */
import type { CoreConfig } from "./config";
import { checkOutbound } from "./config";
import type { DecisionAssessment } from "./models";
import type { ChatProvider, HttpClient } from "./providers/base";
import { jsonFrom } from "./providers/base";

export interface DecisionModel {
  readonly name: string;
  readonly requiresOutbound: boolean;
  /** 有界判断：从候选中选一个（最多 255 项）。 */
  choice(state: string, question: string, options: string[]): Promise<DecisionAssessment>;
  /** 有序等级评分。 */
  score(state: string, question: string, scale: string[]): Promise<DecisionAssessment>;
  /** 是非命题的概率。 */
  noul(state: string, proposition: string): Promise<DecisionAssessment>;
}

/** 离线规则模型：适合「行动建议优先级、风险分级、是否需人工审批」等有界判断。 */
export class RulesDecisionModel implements DecisionModel {
  readonly name = "rules";
  readonly requiresOutbound = false;

  async choice(state: string, question: string, options: string[]): Promise<DecisionAssessment> {
    // 规则打分：命中关键词越多越优先；无信号时取第一项
    const scores = options.map((opt) => {
      let s = 0;
      for (const kw of KEYWORDS) if (opt.includes(kw) && state.includes(kw)) s += 2;
      if (/紧急|立刻|马上|逾期/.test(state) && /高|紧急|立刻/.test(opt)) s += 3;
      return s;
    });
    const best = scores.indexOf(Math.max(...scores));
    const total = scores.reduce((a, b) => a + b, 0) || 1;
    const option = options[Math.max(0, best)] ?? options[0] ?? "unknown";
    return {
      decision_id: null,
      assessment: `规则判定选择「${option}」`,
      confidence: Math.min(0.9, 0.3 + (scores[best] ?? 0) / 10),
      model: this.name,
      choice: { option, probability: Math.max(0.1, (scores[best] ?? 0) / total) },
    };
  }

  async score(state: string, question: string, scale: string[]): Promise<DecisionAssessment> {
    const idx = Math.min(scale.length - 1, Math.max(0, scale.length - 1 - riskSignals(state)));
    return {
      decision_id: null,
      assessment: `规则评分：「${scale[idx] ?? "未知"}」`,
      confidence: 0.5,
      model: this.name,
      score: { value: idx, scale },
    };
  }

  async noul(state: string, proposition: string): Promise<DecisionAssessment> {
    // 「是否需要人工审批」类判断：涉及删除/外发/批量写 → 倾向于需要
    const risky = /删除|外发|发送|批量|密钥|付款|转账/.test(state) || /删除|外发|发送|批量/.test(proposition);
    return {
      decision_id: null,
      assessment: risky ? "规则判定：需要人工确认" : "规则判定：可自动执行",
      confidence: 0.6,
      model: this.name,
      noul: { proposition, p_true: risky ? 0.9 : 0.15 },
    };
  }
}

const KEYWORDS = ["今天", "明天", "截止", "客户", "合同", "发布", "上线", "修复", "回复"];

function riskSignals(state: string): number {
  let n = 0;
  if (/逾期|超期/.test(state)) n += 3;
  if (/紧急|立刻|马上/.test(state)) n += 2;
  if (/风险|隐患/.test(state)) n += 1;
  return n;
}

/** 用已配置的 Chat 模型做结构化决策（需要外网）。 */
export class LLMStructuredDecisionModel implements DecisionModel {
  readonly name = "llm_structured";
  readonly requiresOutbound = true;

  constructor(private provider: ChatProvider) {}

  private async judge(prompt: string): Promise<Record<string, unknown> | null> {
    const res = await this.provider.complete([
      {
        role: "system",
        content: "你是决策评估器。只输出 JSON，不要解释。字段：assessment(string), confidence(0-1), pick(string|null), value(number|null), p_true(number|null)。",
      },
      { role: "user", content: prompt },
    ]);
    const text = "final" in res ? res.final : "";
    const parsed = jsonFrom(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  }

  async choice(state: string, question: string, options: string[]): Promise<DecisionAssessment> {
    const r = await this.judge(
      `状态：\n${state.slice(0, 4000)}\n\n问题：${question}\n候选项：\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n请选择最合适的一项。`,
    );
    const pick = String(r?.pick ?? options[0] ?? "unknown");
    return {
      decision_id: null,
      assessment: String(r?.assessment ?? `模型选择「${pick}」`),
      confidence: Number(r?.confidence ?? 0.6),
      model: this.name,
      choice: { option: pick, probability: Number(r?.confidence ?? 0.6) },
    };
  }

  async score(state: string, question: string, scale: string[]): Promise<DecisionAssessment> {
    const r = await this.judge(
      `状态：\n${state.slice(0, 4000)}\n\n问题：${question}\n评分档位：${scale.join(" < ")}\n给出 value = 档位下标。`,
    );
    const value = Math.max(0, Math.min(scale.length - 1, Number(r?.value ?? 0)));
    return {
      decision_id: null,
      assessment: String(r?.assessment ?? `模型评分：${scale[value]}`),
      confidence: Number(r?.confidence ?? 0.6),
      model: this.name,
      score: { value, scale },
    };
  }

  async noul(state: string, proposition: string): Promise<DecisionAssessment> {
    const r = await this.judge(
      `状态：\n${state.slice(0, 4000)}\n\n命题：${proposition}\n给出 p_true（该命题为真的概率 0-1）。`,
    );
    const p = Math.max(0, Math.min(1, Number(r?.p_true ?? 0.5)));
    return {
      decision_id: null,
      assessment: String(r?.assessment ?? `模型判定概率 ${p.toFixed(2)}`),
      confidence: Number(r?.confidence ?? 0.6),
      model: this.name,
      noul: { proposition, p_true: p },
    };
  }
}

/**
 * Jev Provider（ADR-007 落地方式）：默认关闭。
 * 只有用户在设置中显式启用、填写端点并把域名加入 allowlist 后才会发请求；
 * 未配置时抛错，由调用方回退到 RulesDecisionModel（离线兜底）。
 */
export class JevDecisionModel implements DecisionModel {
  readonly name = "jev";
  readonly requiresOutbound = true;

  constructor(private cfg: CoreConfig, private http: HttpClient, private endpoint: string, private apiKeyName = "JEV_API_KEY") {}

  private key(): string {
    const env = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env;
    return env?.[this.apiKeyName] ?? "";
  }

  private async call(primitive: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    checkOutbound(this.cfg, this.endpoint);
    const resp = await this.http.request({
      url: this.endpoint,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.key() ? { Authorization: `Bearer ${this.key()}` } : {}),
      },
      body: JSON.stringify({ primitive, ...payload }),
      timeoutMs: 60000,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Jev 接口返回 ${resp.status}：${resp.text.slice(0, 200)}`);
    }
    return JSON.parse(resp.text) as Record<string, unknown>;
  }

  async choice(state: string, question: string, options: string[]): Promise<DecisionAssessment> {
    const r = await this.call("choice", { state, question, options: options.slice(0, 255) });
    const option = String(r.option ?? options[0] ?? "unknown");
    return {
      decision_id: null,
      assessment: `Jev 选择「${option}」`,
      confidence: Number(r.confidence ?? 0.5),
      model: this.name,
      choice: { option, probability: Number(r.probability ?? r.confidence ?? 0.5) },
    };
  }

  async score(state: string, question: string, scale: string[]): Promise<DecisionAssessment> {
    const r = await this.call("score", { state, question, scale });
    return {
      decision_id: null,
      assessment: `Jev 评分 ${String(r.value ?? "")}`,
      confidence: Number(r.confidence ?? 0.5),
      model: this.name,
      score: { value: Number(r.value ?? 0), scale },
    };
  }

  async noul(state: string, proposition: string): Promise<DecisionAssessment> {
    const r = await this.call("noul", { state, proposition });
    return {
      decision_id: null,
      assessment: `Jev 判定概率 ${String(r.p_true ?? 0.5)}`,
      confidence: Number(r.confidence ?? 0.5),
      model: this.name,
      noul: { proposition, p_true: Number(r.p_true ?? 0.5) },
    };
  }
}

/** 空实现：不评分（保持与 Python Core NullDecisionModel 的兼容语义）。 */
export class NullDecisionModel implements DecisionModel {
  readonly name = "null";
  readonly requiresOutbound = false;
  async choice(): Promise<DecisionAssessment> {
    return { decision_id: null, assessment: "未配置决策评估模型", confidence: 0, model: this.name };
  }
  async score(): Promise<DecisionAssessment> {
    return { decision_id: null, assessment: "未配置决策评估模型", confidence: 0, model: this.name };
  }
  async noul(_state: string, proposition: string): Promise<DecisionAssessment> {
    return {
      decision_id: null,
      assessment: "未配置决策评估模型", confidence: 0, model: this.name,
      noul: { proposition, p_true: 0.5 },
    };
  }
}

/**
 * 决策模型工厂。
 * @param mode rules（默认，离线）| llm（用 Chat 模型）| null（不评分）
 */
export function getDecisionModel(
  cfg: CoreConfig,
  provider: ChatProvider,
  mode: "rules" | "llm" | "null" = "rules",
): DecisionModel {
  if (mode === "null") return new NullDecisionModel();
  if (mode === "llm") return new LLMStructuredDecisionModel(provider);
  return new RulesDecisionModel();
}
