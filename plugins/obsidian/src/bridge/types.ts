/**
 * CoreBridge：UI 与「核心能力」之间的唯一契约。
 *
 * 为什么需要这一层（对应 ADR-001 薄宿主 + 独立核心）：
 *  - UI 只依赖本接口，不感知领域逻辑在哪里执行；
 *  - `LocalBridge` 用插件内 TS 核心实现（零依赖、双击即用）；
 *  - `HttpBridge` 连接本地 Python Core（127.0.0.1:8765），获得下载/转写/抽帧/向量等重活能力。
 *  两者可热切换（设置里切换后桥重建），因此「换核心」不会动到任何 UI 代码。
 */
import type { CoreConfig } from "../core/config";
import type {
  AgentDef, AgentRun, Approval, ApprovalKind, AuditEntry, ConnectorState, ProsObject,
  Relation, RelationStatus, SummaryRecord, Task, TaskPriority, TaskStatus,
} from "../core/models";
import type { CaptureBinaryInput, CaptureInput, CaptureResult, ResourceKind } from "../core/capture";
import type { IngestResult } from "../core/ingest/common";
import type { SearchHit, SearchOptions } from "../core/retrieval";
import type { AskResult } from "../core/rag";
import type { ProcessResult } from "../core/pipeline";
import type { DecisionAssessment } from "../core/models";

export type BridgeMode = "local" | "http";

export interface BridgeMeta {
  mode: BridgeMode;
  /** 核心版本标识（用于设置页显示与排障）。 */
  version: string;
  /** 当前生效的 Provider 名称（mock 表示离线确定性模式）。 */
  provider: string;
  /** 是否完全离线（离线时不会发生任何外发）。 */
  offline: boolean;
  /** 索引库根目录（vault 相对路径）。 */
  baseDir: string;
  /** HTTP 模式下的 Core 地址。 */
  coreUrl?: string;
  /** 该后端是否支持「重活」（下载/转写/抽帧/反爬渲染）。 */
  supportsHeavyIngest: boolean;
}

export interface CoreStatus {
  ok: boolean;
  message: string;
  detail?: string;
}

/** 采集进度回调。 */
export type ProgressCallback = (msg: string) => void;

export interface RollbackResultView {
  audit_id: string;
  rollback_audit_id: string;
  table: string;
  target_id: string;
  description: string;
}

/**
 * 核心能力契约。
 * 命名尽量贴近文档 G.1 的 MCP 工具面（capture / search / ask / task.* / object.* /
 * summary.* / approval.* / audit.*），便于后续直接把这套方法注册成 MCP 工具。
 */
export interface CoreBridge {
  readonly meta: BridgeMeta;

  /** 健康检查（HTTP 模式下探测 Core 是否在线）。 */
  ping(): Promise<CoreStatus>;

  /** 重新加载核心（切换配置后调用）。 */
  reload(cfg: CoreConfig): Promise<void>;

  // ------------------------------------------------------------ capture ---
  capture(input: CaptureInput, onProgress?: ProgressCallback): Promise<CaptureResult>;
  captureBinary(input: CaptureBinaryInput, onProgress?: ProgressCallback): Promise<CaptureResult & { stored_path: string; size: number }>;
  /** 采集链接（网页/视频/音频/代码），自动识别类型。 */
  ingest(source: string, options: { kind?: ResourceKind; tags?: string[]; maxImages?: number }, onProgress?: ProgressCallback): Promise<IngestResult>;

  // ------------------------------------------------------------ pipeline ---
  processInbox(opts?: { limit?: number; onProgress?: ProgressCallback }): Promise<ProcessResult[]>;
  processObject(id: string, onProgress?: ProgressCallback): Promise<ProcessResult>;

  // ------------------------------------------------------------ retrieval ---
  search(query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  ask(question: string, opts?: { topK?: number; useVector?: boolean }): Promise<AskResult>;

  // -------------------------------------------------------------- object ---
  objects(query?: {
    lifecycle?: ProsObject["lifecycle"] | "all";
    types?: string[];
    tags?: string[];
    start?: string;
    end?: string;
    limit?: number;
    orderBy?: "created_desc" | "created_asc";
  }): Promise<ProsObject[]>;
  object(id: string): Promise<ProsObject | null>;
  updateObject(id: string, fields: Partial<ProsObject>): Promise<{ audit_id: string }>;
  deleteObject(id: string): Promise<{ audit_id: string }>;
  restoreObject(id: string): Promise<{ audit_id: string }>;
  relationsOf(id: string, status?: RelationStatus): Promise<{ out: (Relation & { peerTitle?: string })[]; in: (Relation & { peerTitle?: string })[] }>;
  setRelationStatus(id: string, status: RelationStatus): Promise<{ audit_id: string }>;
  /** 打开对象的笔记文件（UI 调用宿主 API 实现）。 */
  notePathOf(id: string): Promise<string | null>;

  // ---------------------------------------------------------------- task ---
  tasks(query?: { status?: TaskStatus | "open" | "all"; priority?: TaskPriority; project?: string; sourceObjectId?: string; limit?: number }): Promise<Task[]>;
  createTask(input: { title: string; due_at?: string | null; priority?: TaskPriority; source_object_id?: string | null; project?: string | null; assignee?: string | null }): Promise<{ id: string }>;
  setTaskStatus(id: string, status: TaskStatus): Promise<{ audit_id: string }>;
  setTaskPriority(id: string, priority: TaskPriority): Promise<{ audit_id: string }>;
  deleteTask(id: string): Promise<{ audit_id: string }>;

  // --------------------------------------------------------------- audit ---
  audit(opts?: { objectType?: string; objectId?: string; limit?: number }): Promise<AuditEntry[]>;
  rollback(auditId: string): Promise<RollbackResultView>;
  rollbackToPoint(objectId: string, auditId: string): Promise<RollbackResultView[]>;

  // ------------------------------------------------------------ approval ---
  approvals(status?: Approval["status"]): Promise<Approval[]>;
  decideApproval(id: string, approve: boolean): Promise<{ approval_id: string; status: string; result: unknown }>;
  requestApproval(kind: ApprovalKind, tool: string, args: Record<string, unknown>, payload?: Record<string, unknown>): Promise<{ id: string }>;

  // ------------------------------------------------------------- summary ---
  summaries(): Promise<SummaryRecord[]>;
  summarize(input: { granularity: "daily" | "weekly" | "monthly" | "custom"; start?: string; end?: string }, onProgress?: ProgressCallback): Promise<SummaryRecord>;
  renderSummary(record: SummaryRecord): Promise<string>;
  /** 把总结里的行动建议落盘成任务。 */
  actionToTask(action: { kind: string; title: string; task_id?: string }, summaryId?: string): Promise<{ id: string }>;
  /** 把总结写入 vault（notes 目录）。 */
  saveSummaryToVault(record: SummaryRecord): Promise<string>;
  /** 决策评估（ADR-007，可插拔）。 */
  evaluateDecision(state: string, question: string, options: string[]): Promise<DecisionAssessment>;

  // --------------------------------------------------------------- agent ---
  agents(): Promise<AgentDef[]>;
  upsertAgent(def: AgentDef): Promise<void>;
  removeAgent(name: string): Promise<void>;
  runAgent(name: string, input: string): Promise<{ run_id: string; status: AgentRun["status"]; error: string | null; result: unknown }>;
  agentRuns(limit?: number): Promise<AgentRun[]>;

  // ----------------------------------------------------------- connector ---
  connectors(): Promise<ConnectorState[]>;
  updateConnector(state: ConnectorState): Promise<void>;

  // ------------------------------------------------------------- ops/io ---
  stats(): Promise<ReturnType<import("../core/store").Store["stats"]>>;
  rebuildIndex(): Promise<{ objects: number; tokens: number }>;
  exportJson(path: string): Promise<string>;
  backup(): Promise<{ backup_dir: string; manifest: unknown }>;
  listBackups(): Promise<string[]>;
  restore(backupDir: string): Promise<{ restored: boolean }>;
  /** 写入任意 vault 文件（总结/报告导出用）。 */
  writeFile(path: string, content: string): Promise<string>;
  /** 强制落盘。 */
  flush(): Promise<void>;
}
