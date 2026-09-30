/**
 * HttpBridge：连接本地 Python Core（127.0.0.1:8765）作为「独立核心」。
 *
 * 这是文档 ADR-001 的原生形态：宿主插件只做 UI，领域逻辑与重活（视频下载、ASR 转写、
 * ffmpeg 抽帧、Playwright 反爬渲染、SQLite FTS5、备份加密）由 Python Core 承担。
 *
 * 设计要点：
 *  - 所有请求都走注入的 `HttpClient`（宿主用 Obsidian 的 requestUrl，绕过 CORS）；
 *  - Core 只监听 loopback，因此默认配置下**不需要 API key**；若用户为 Core 配置了 token，
 *    可通过 `authToken` 传入（放在请求头，不进日志）；
 *  - 字段名在 Core（Python 的 snake_case / SQLite 行）与插件类型之间做一次集中映射，
 *    映射逻辑集中在 `map*` 函数里，Core 演进时只改这一处。
 */
import type { CoreConfig } from "../core/config";
import { mergeConfig } from "../core/config";
import type { HttpClient } from "../core/providers/base";
import type {
  AgentDef, AgentRun, Approval, ApprovalKind, AuditEntry, ConnectorState, DecisionAssessment,
  ProsObject, Relation, RelationStatus, SummaryRecord, Task, TaskPriority, TaskStatus,
} from "../core/models";
import type { CaptureBinaryInput, CaptureInput, CaptureResult, ResourceKind } from "../core/capture";
import type { IngestResult } from "../core/ingest/common";
import type { SearchHit, SearchOptions } from "../core/retrieval";
import type { AskResult } from "../core/rag";
import type { ProcessResult } from "../core/pipeline";
import type { BridgeMeta, CoreBridge, CoreStatus, ProgressCallback, RollbackResultView } from "./types";

export interface HttpBridgeDeps {
  cfg: CoreConfig;
  http: HttpClient;
  /** Core 地址，默认 http://127.0.0.1:8765 */
  coreUrl?: string;
  /** 可选：Core 侧的 API token。 */
  authToken?: string;
}

const DEFAULT_CORE = "http://127.0.0.1:8765";

export class HttpBridge implements CoreBridge {
  meta: BridgeMeta;
  private cfg: CoreConfig;
  private http: HttpClient;
  private base: string;
  private token?: string;

  constructor(deps: HttpBridgeDeps) {
    this.cfg = mergeConfig(deps.cfg);
    this.http = deps.http;
    this.base = (deps.coreUrl || DEFAULT_CORE).replace(/\/+$/, "");
    this.token = deps.authToken;
    this.meta = {
      mode: "http",
      version: "core-http",
      provider: "python-core",
      offline: false,
      baseDir: this.cfg.baseDir,
      coreUrl: this.base,
      supportsHeavyIngest: true,
    };
  }

  // ------------------------------------------------------------ 基础请求 ---

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["X-PROS-Token"] = this.token;
    return h;
  }

  /** 统一请求：非 2xx 抛出带后端错误信息的异常（UI 直接展示）。 */
  private async call<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, timeoutMs = 300000): Promise<T> {
    let url = `${this.base}${path}`;
    if (method === "GET" && body && typeof body === "object") {
      const qs = new URLSearchParams(
        Object.entries(body as Record<string, unknown>)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]),
      ).toString();
      if (qs) url += `?${qs}`;
    }
    const resp = await this.http.request({
      url,
      method,
      headers: this.headers(),
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      timeoutMs,
      // Core 在 loopback，属于用户本机服务，不属于「云端外发」
      skipAllowlist: true,
    });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`Core 返回 ${resp.status}：${resp.text.slice(0, 300)}`);
    }
    const text = resp.text?.trim();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async ping(): Promise<CoreStatus> {
    try {
      const h = await this.call<{ ok?: boolean; version?: string; provider?: string; objects?: number }>("GET", "/health");
      return {
        ok: true,
        message: `已连接 Python Core（${this.base}）`,
        detail: `核心版本 ${h?.version ?? "unknown"} ｜ Provider ${h?.provider ?? "unknown"} ｜ 对象 ${h?.objects ?? "?"} 条`,
      };
    } catch (e) {
      return {
        ok: false,
        message: `无法连接 Python Core（${this.base}）`,
        detail:
          `${String(e)}\n请确认已启动 Core：\n` +
          "  · Docker：`docker compose up -d`\n" +
          "  · 本地：`python -m personal_agent_core.cli serve`",
      };
    }
  }

  async reload(cfg: CoreConfig): Promise<void> {
    this.cfg = mergeConfig(cfg);
    this.meta = { ...this.meta, baseDir: this.cfg.baseDir };
  }

  // ------------------------------------------------------------ capture ---

  async capture(input: CaptureInput): Promise<CaptureResult> {
    return this.call<CaptureResult>("POST", "/capture", {
      content: input.content,
      title: input.title ?? null,
      source_uri: input.source_uri ?? null,
      tags: input.tags ?? [],
      kind: input.kind ?? null,
      source_channel: input.sourceChannel ?? "obsidian",
      data_class: input.dataClass ?? this.cfg.defaultDataClass,
      properties: input.properties ?? {},
    });
  }

  async captureBinary(input: CaptureBinaryInput): Promise<CaptureResult & { stored_path: string; size: number }> {
    // 二进制以 base64 传输（Core 落盘到自己的资源目录）
    return this.call<CaptureResult & { stored_path: string; size: number }>("POST", "/upload", {
      filename: input.filename,
      data_base64: toBase64(input.bytes),
      mime: input.mime ?? "application/octet-stream",
      title: input.title ?? null,
      source_uri: input.sourceUri ?? null,
      tags: input.tags ?? [],
      kind: input.kind ?? null,
      source_channel: input.sourceChannel ?? "drop",
      text_content: input.textContent ?? null,
    });
  }

  ingest(
    source: string,
    options: { kind?: ResourceKind; tags?: string[]; maxImages?: number },
    onProgress?: ProgressCallback,
  ): Promise<IngestResult> {
    onProgress?.("已提交给 Python Core 处理（大文件可能需要几分钟）…");
    return this.call<IngestResult>("POST", "/ingest", {
      source,
      type: options.kind ?? null,
      tags: options.tags ?? [],
      max_images: options.maxImages ?? null,
      vault: null,
    }, 3600000);
  }

  // ------------------------------------------------------------ pipeline ---

  processInbox(opts: { limit?: number; onProgress?: ProgressCallback } = {}): Promise<ProcessResult[]> {
    opts.onProgress?.("由 Core 处理 Inbox…");
    return this.call<ProcessResult[]>("POST", "/process", { limit: opts.limit ?? 50 });
  }

  processObject(id: string, onProgress?: ProgressCallback): Promise<ProcessResult> {
    onProgress?.("由 Core 处理单条…");
    return this.call<ProcessResult>("POST", `/objects/${encodeURIComponent(id)}/process`);
  }

  // ----------------------------------------------------------- retrieval ---

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const rows = await this.call<Record<string, unknown>[]>("GET", "/search", {
      q: query,
      limit: opts.limit ?? 20,
      types: opts.types,
      tags: opts.tags,
      start: opts.start,
      end: opts.end,
      lifecycle: opts.lifecycle,
    });
    return rows.map((r) => ({
      object_id: String(r.object_id ?? r.id ?? ""),
      type: String(r.type ?? "note"),
      title: String(r.title ?? ""),
      snippet: String(r.snippet ?? ""),
      span: (r.span as { start: number; end: number }) ?? { start: 0, end: 0 },
      score: Number(r.score ?? 0),
      created_at: String(r.created_at ?? ""),
      lifecycle: String(r.lifecycle ?? "processed"),
      tags: (r.tags as string[]) ?? [],
      matched_by: ["lexical"],
    }));
  }

  ask(question: string, opts: { topK?: number; useVector?: boolean } = {}): Promise<AskResult> {
    return this.call<AskResult>("POST", "/ask", { question, top_k: opts.topK ?? 5 });
  }

  // -------------------------------------------------------------- object ---

  async objects(query: Parameters<CoreBridge["objects"]>[0] = {}): Promise<ProsObject[]> {
    const rows = await this.call<Record<string, unknown>[]>("GET", "/objects", {
      lifecycle: query?.lifecycle,
      types: query?.types,
      tags: query?.tags,
      start: query?.start,
      end: query?.end,
      limit: query?.limit,
      order_by: query?.orderBy,
    });
    return rows.map(mapObject);
  }

  async object(id: string): Promise<ProsObject | null> {
    try {
      const r = await this.call<Record<string, unknown>>("GET", `/objects/${encodeURIComponent(id)}`);
      return r ? mapObject(r) : null;
    } catch {
      return null;
    }
  }

  updateObject(id: string, fields: Partial<ProsObject>): Promise<{ audit_id: string }> {
    return this.call<{ audit_id: string }>("PATCH", `/objects/${encodeURIComponent(id)}`, { fields });
  }

  deleteObject(id: string): Promise<{ audit_id: string }> {
    return this.call<{ audit_id: string }>("DELETE", `/objects/${encodeURIComponent(id)}`);
  }

  restoreObject(id: string): Promise<{ audit_id: string }> {
    return this.call<{ audit_id: string }>("POST", `/objects/${encodeURIComponent(id)}/restore`);
  }

  async relationsOf(id: string, status?: RelationStatus) {
    const r = await this.call<{ out: Record<string, unknown>[]; in: Record<string, unknown>[] }>(
      "GET", `/objects/${encodeURIComponent(id)}/relations`, { status },
    );
    const map = (x: Record<string, unknown>) => ({ ...mapRelation(x), peerTitle: String(x.peer_title ?? "") });
    return { out: (r.out ?? []).map(map), in: (r.in ?? []).map(map) };
  }

  setRelationStatus(id: string, status: RelationStatus): Promise<{ audit_id: string }> {
    return this.call<{ audit_id: string }>("PATCH", `/relations/${encodeURIComponent(id)}`, { status });
  }

  async notePathOf(id: string): Promise<string | null> {
    try {
      const r = await this.call<{ note_path: string | null }>("GET", `/objects/${encodeURIComponent(id)}/note-path`);
      return r?.note_path ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- task ---

  async tasks(query: Parameters<CoreBridge["tasks"]>[0] = {}): Promise<Task[]> {
    const rows = await this.call<Record<string, unknown>[]>("GET", "/tasks", {
      status: query?.status,
      priority: query?.priority,
      project: query?.project,
      source_object_id: query?.sourceObjectId,
      limit: query?.limit,
    });
    return rows.map(mapTask);
  }

  createTask(input: Parameters<CoreBridge["createTask"]>[0]): Promise<{ id: string }> {
    return this.call<{ id: string }>("POST", "/tasks", {
      title: input.title,
      due_at: input.due_at ?? null,
      priority: input.priority ?? "P2",
      source_object_id: input.source_object_id ?? null,
      project: input.project ?? null,
      assignee: input.assignee ?? null,
    });
  }

  setTaskStatus(id: string, status: TaskStatus): Promise<{ audit_id: string }> {
    return this.call<{ audit_id: string }>("PATCH", `/tasks/${encodeURIComponent(id)}`, { status });
  }

  setTaskPriority(id: string, priority: TaskPriority): Promise<{ audit_id: string }> {
    return this.call<{ audit_id: string }>("PATCH", `/tasks/${encodeURIComponent(id)}`, { priority });
  }

  deleteTask(id: string): Promise<{ audit_id: string }> {
    return this.call<{ audit_id: string }>("DELETE", `/tasks/${encodeURIComponent(id)}`);
  }

  // --------------------------------------------------------------- audit ---

  audit(opts: { objectType?: string; objectId?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    return this.call<AuditEntry[]>("GET", "/audit", {
      object_type: opts.objectType,
      object_id: opts.objectId,
      limit: opts.limit ?? 200,
    });
  }

  rollback(auditId: string): Promise<RollbackResultView> {
    return this.call<RollbackResultView>("POST", `/rollback/${encodeURIComponent(auditId)}`);
  }

  rollbackToPoint(objectId: string, auditId: string): Promise<RollbackResultView[]> {
    return this.call<RollbackResultView[]>("POST", `/objects/${encodeURIComponent(objectId)}/rollback-to`, { audit_id: auditId });
  }

  // ------------------------------------------------------------ approval ---

  async approvals(status?: Approval["status"]): Promise<Approval[]> {
    return this.call<Approval[]>("GET", "/approvals", { status });
  }

  decideApproval(id: string, approve: boolean) {
    return this.call<{ approval_id: string; status: string; result: unknown }>(
      "POST", `/approvals/${encodeURIComponent(id)}/decide`, { approve },
    );
  }

  requestApproval(
    kind: ApprovalKind, tool: string, args: Record<string, unknown>, payload: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    return this.call<{ id: string }>("POST", "/approvals", { kind, tool, arguments: args, payload });
  }

  // ------------------------------------------------------------- summary ---

  async summaries(): Promise<SummaryRecord[]> {
    return this.call<SummaryRecord[]>("GET", "/summaries");
  }

  summarize(
    input: { granularity: "daily" | "weekly" | "monthly" | "custom"; start?: string; end?: string },
    onProgress?: ProgressCallback,
  ): Promise<SummaryRecord> {
    onProgress?.("由 Core 生成阶段总结…");
    return this.call<SummaryRecord>("POST", "/summary", input, 600000);
  }

  async renderSummary(record: SummaryRecord): Promise<string> {
    return this.call<string>("POST", "/summary/render", { record });
  }

  actionToTask(action: { kind: string; title: string; task_id?: string }, summaryId?: string): Promise<{ id: string }> {
    return this.call<{ id: string }>("POST", "/summary/action-to-task", { action, summary_id: summaryId ?? null });
  }

  saveSummaryToVault(record: SummaryRecord): Promise<string> {
    return this.call<string>("POST", "/summary/save", { record });
  }

  evaluateDecision(state: string, question: string, options: string[]): Promise<DecisionAssessment> {
    return this.call<DecisionAssessment>("POST", "/decision", { state, question, options });
  }

  // --------------------------------------------------------------- agent ---

  async agents(): Promise<AgentDef[]> {
    return this.call<AgentDef[]>("GET", "/agents");
  }

  upsertAgent(def: AgentDef): Promise<void> {
    return this.call<void>("PUT", `/agents/${encodeURIComponent(def.name)}`, def);
  }

  removeAgent(name: string): Promise<void> {
    return this.call<void>("DELETE", `/agents/${encodeURIComponent(name)}`);
  }

  runAgent(name: string, input: string) {
    return this.call<{ run_id: string; status: AgentRun["status"]; error: string | null; result: unknown }>(
      "POST", `/agents/${encodeURIComponent(name)}/run`, { input }, 600000,
    );
  }

  agentRuns(limit = 50): Promise<AgentRun[]> {
    return this.call<AgentRun[]>("GET", "/agent-runs", { limit });
  }

  // ------------------------------------------------------------ connector ---

  connectors(): Promise<ConnectorState[]> {
    return this.call<ConnectorState[]>("GET", "/connectors");
  }

  updateConnector(state: ConnectorState): Promise<void> {
    return this.call<void>("PUT", `/connectors/${encodeURIComponent(state.id)}`, state);
  }

  // ------------------------------------------------------------- ops/io ---

  async stats() {
    return this.call<ReturnType<CoreBridge["stats"]> extends Promise<infer R> ? R : never>("GET", "/stats");
  }

  rebuildIndex(): Promise<{ objects: number; tokens: number }> {
    return this.call<{ objects: number; tokens: number }>("POST", "/reindex");
  }

  exportJson(path: string): Promise<string> {
    return this.call<string>("POST", "/export", { path });
  }

  async backup() {
    const r = await this.call<{ backup_dir: string; manifest: unknown }>("POST", "/backup", {});
    return r;
  }

  listBackups(): Promise<string[]> {
    return this.call<string[]>("GET", "/backups");
  }

  async restore(backupDir: string): Promise<{ restored: boolean }> {
    const r = await this.call<{ restored: boolean }>("POST", "/restore", { dir: backupDir });
    return { restored: r?.restored ?? true };
  }

  async writeFile(path: string, content: string): Promise<string> {
    // 本地文件写入始终由插件侧完成（vault 是宿主的事实源）
    throw new Error(`HttpBridge 不支持直接写 vault 文件（${path}）；请使用插件侧的写入能力`);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

// ------------------------------------------------------------- 字段映射 ---

function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return (v as T) ?? fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** Core 行 → 插件对象类型（集中在处，Core 演进只改这里）。 */
function mapObject(r: Record<string, unknown>): ProsObject {
  return {
    id: String(r.id ?? ""),
    type: (r.type as ProsObject["type"]) ?? "note",
    title: String(r.title ?? ""),
    content: String(r.content ?? ""),
    source_uri: (r.source_uri as string | null) ?? null,
    content_hash: String(r.content_hash ?? ""),
    origin: (r.origin as ProsObject["origin"]) ?? "raw",
    confidence: Number(r.confidence ?? 1),
    provenance: parseJson<Record<string, unknown>>(r.provenance, {}),
    tags: parseJson<string[]>(r.tags, []),
    properties: parseJson<Record<string, unknown>>(r.properties, {}),
    data_class: (r.data_class as ProsObject["data_class"]) ?? "internal",
    event_time_start: (r.event_time_start as string | null) ?? null,
    event_time_end: (r.event_time_end as string | null) ?? null,
    lifecycle: (r.lifecycle as ProsObject["lifecycle"]) ?? "inbox",
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? r.created_at ?? ""),
  };
}

function mapRelation(r: Record<string, unknown>): Relation {
  return {
    id: String(r.id ?? ""),
    src_id: String(r.src_id ?? ""),
    dst_id: String(r.dst_id ?? ""),
    type: (r.type as Relation["type"]) ?? "related_to",
    status: (r.status as Relation["status"]) ?? "suggested",
    confidence: Number(r.confidence ?? 1),
    provenance: parseJson<Record<string, unknown>>(r.provenance, {}),
    created_at: String(r.created_at ?? ""),
  };
}

function mapTask(r: Record<string, unknown>): Task {
  return {
    id: String(r.id ?? ""),
    title: String(r.title ?? ""),
    source_object_id: (r.source_object_id as string | null) ?? null,
    due_at: (r.due_at as string | null) ?? null,
    priority: (r.priority as TaskPriority) ?? "P2",
    status: (r.status as TaskStatus) ?? "todo",
    project: (r.project as string | null) ?? null,
    assignee: (r.assignee as string | null) ?? null,
    tags: parseJson<string[]>(r.tags, []),
    provenance: parseJson<Record<string, unknown>>(r.provenance, {}),
    confidence: Number(r.confidence ?? 1),
    created_by_agent: Number(r.created_by_agent ?? 0) ? 1 : 0,
    created_at: String(r.created_at ?? ""),
    completed_at: (r.completed_at as string | null) ?? null,
  };
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
