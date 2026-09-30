/**
 * Provider 抽象（对应 Python Core providers/base.py）。
 *
 * 所有 AI 能力都经此接口，保证「不绑定单一 LLM Provider」（NFR-06）：
 *  - chat：分类 / 摘要 / 任务提取 / 引用问答 / Agent 循环；
 *  - embedding：混合检索的语义召回（可选，未配置时退化为纯词法检索）；
 *  - asr / vision：视频音频采集的转写与关键帧读图（可选）。
 *
 * 出站约束：Provider 不直接使用网络 API，而是通过注入的 `HttpClient`，
 * 由宿主统一实现（Obsidian 用 requestUrl；Node 测试用 fetch），
 * 并在发出前调用 `checkOutbound` 校验域名白名单。
 */
import type { CoreConfig } from "../config";
import type { ObjectType, TaskPriority } from "../models";
import type { Span } from "../extraction";

// ------------------------------------------------------------ HTTP 抽象层 ---

export interface HttpRequest {
  url: string;
  /** 通用 HTTP 方法（Core 的 REST 面用到 PATCH/PUT/DELETE）。 */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  headers?: Record<string, string>;
  /** 文本 body（JSON 等）。 */
  body?: string;
  /** 二进制 body（multipart 等，与 body 互斥）。 */
  binaryBody?: ArrayBuffer;
  timeoutMs?: number;
  /** 是否跳过域名白名单校验（仅用于用户显式发起的「采集」，见 ingest）。 */
  skipAllowlist?: boolean;
}

export interface HttpResponse {
  status: number;
  text: string;
  headers?: Record<string, string>;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
  /** 下载二进制（网页配图、视频文件等）。 */
  fetchBinary(url: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<{
    status: number;
    bytes: ArrayBuffer;
    contentType: string;
  }>;
}

// -------------------------------------------------------------- 结果类型 ---

export interface ClassifyResult {
  type: ObjectType;
  confidence: number;
  tags: string[];
  reason?: string;
}

export interface ExtractedTask {
  title: string;
  due_at: string | null;
  priority: TaskPriority;
  span?: Span;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/** Agent 循环的返回：最终答案或工具调用。 */
export type CompleteResult =
  | { final: string }
  | { tool_calls: { name: string; arguments: Record<string, unknown> }[] };

export interface ChatProvider {
  readonly name: string;
  /** 是否为确定性离线 Provider（Mock），UI 上会给出提示。 */
  readonly offline: boolean;

  classify(text: string): Promise<ClassifyResult>;
  summarize(text: string): Promise<string>;
  extractTasks(text: string): Promise<ExtractedTask[]>;
  answer(question: string, evidence: string[]): Promise<string>;
  complete(messages: ChatMessage[], allowedTools?: string[]): Promise<CompleteResult>;

  /** 可选：语义向量（未实现时检索自动退化为纯词法）。 */
  embed?(texts: string[]): Promise<number[][]>;
  /** 可选：语音转写。 */
  transcribeAudio?(data: ArrayBuffer, filename: string): Promise<string>;
  /** 可选：关键帧读图。 */
  analyzeImages?(images: { filename: string; mime: string; data: ArrayBuffer }[], prompt: string): Promise<string>;
}

/** Provider 运行上下文：配置 + HTTP 客户端 + 出站观测回调。 */
export interface ProviderContext {
  cfg: CoreConfig;
  http: HttpClient;
  /**
   * 出站前置钩子：返回 false 表示用户拒绝外发（用于「外发内容明确标注 + 二次确认」）。
   * 未注入时按允许处理。
   */
  beforeOutbound?: (info: { host: string; purpose: string; bytes: number }) => Promise<boolean>;
}

/** Provider 工厂签名，便于按配置切换实现。 */
export type ProviderFactory = (ctx: ProviderContext) => ChatProvider;

/** 计算字符串的粗略 token 数（~4 字符/token），用于 Agent 预算控制。 */
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
}

/** 从可能包含解释文字的输出里提取第一段 JSON（LLM 常见行为）。 */
export function jsonFrom(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const m = candidate.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
