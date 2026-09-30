/**
 * LocalBridge：用插件内 TS 核心实现 CoreBridge（零外部进程、双击即用）。
 *
 * 这是「自带轻量核心」模式的实现。所有领域逻辑都在 src/core/ 下，本文件只做编排与
 * 参数适配，不含业务规则，因此 UI 代码在 Local/Http 两种模式下完全一致。
 */
import { Store } from "../core/store";
import { mergeConfig, type CoreConfig } from "../core/config";
import { getProvider } from "../core/providers";
import type { ChatProvider, HttpClient } from "../core/providers/base";
import { captureBinary, captureText, type CaptureBinaryInput, type CaptureInput, type CaptureResult } from "../core/capture";
import { ingest as ingestCore } from "../core/ingest";
import type { IngestResult, ResourceKind, ProgressFn } from "../core/ingest/common";
import { processInbox as processInboxCore, processObject as processObjectCore, enrichRelations, type ProcessResult } from "../core/pipeline";
import { globalIndex, search as searchCore, type SearchHit, type SearchOptions } from "../core/retrieval";
import { ask as askCore, type AskResult } from "../core/rag";
import {
  completeTask, createTask as createTaskCore, deleteTask as deleteTaskCore,
  listTasks, setTaskPriority as setTaskPriorityCore, setTaskStatus as setTaskStatusCore,
} from "../core/tasks";
import { rollback as rollbackCore, rollbackToPoint as rollbackToPointCore, type RollbackResult } from "../core/audit";
import { decideApproval, requestApproval, runAgent as runAgentCore } from "../core/agents";
import {
  actionToTask as actionToTaskCore, rangeFor, renderSummaryMarkdown, summarizeRange,
} from "../core/summary";
import { getDecisionModel } from "../core/decision";
import {
  backup as backupCore, exportJson as exportJsonCore, listBackups as listBackupsCore, restore as restoreCore,
  snapshotBeforeRestore,
} from "../core/backup";
import type {
  AgentDef, AgentRun, Approval, ApprovalKind, AuditEntry, ConnectorState, ProsObject,
  RelationStatus, SummaryRecord, Task, TaskPriority, TaskStatus,
} from "../core/models";
import type { BridgeMeta, CoreBridge, CoreStatus, ProgressCallback, RollbackResultView } from "./types";

export interface LocalBridgeDeps {
  store: Store;
  cfg: CoreConfig;
  http: HttpClient;
  /** 出站前置确认（用户可拒绝外发）。 */
  beforeOutbound?: (info: { host: string; purpose: string; bytes: number }) => Promise<boolean>;
}

export class LocalBridge implements CoreBridge {
  meta: BridgeMeta;
  private store: Store;
  private cfg: CoreConfig;
  private http: HttpClient;
  private provider: ChatProvider;
  private beforeOutbound?: (info: { host: string; purpose: string; bytes: number }) => Promise<boolean>;

  constructor(deps: LocalBridgeDeps) {
    this.store = deps.store;
    this.cfg = mergeConfig(deps.cfg);
    this.http = deps.http;
    this.beforeOutbound = deps.beforeOutbound;
    this.provider = this.buildProvider();
    this.meta = {
      mode: "local",
      version: `plugin-1.0.0 / core-${this.provider.name}`,
      provider: this.provider.name,
      offline: this.provider.offline,
      baseDir: this.cfg.baseDir,
      supportsHeavyIngest: false,
    };
  }

  private buildProvider(): ChatProvider {
    return getProvider({
      cfg: this.cfg,
      http: this.http,
      beforeOutbound: this.beforeOutbound,
    });
  }

  private get decision() {
    return getDecisionModel(this.cfg, this.provider, "rules");
  }

  async ping(): Promise<CoreStatus> {
    return {
      ok: true,
      message: `插件内核心已就绪（Provider：${this.provider.name}${this.provider.offline ? "，完全离线" : ""}）`,
      detail: `索引库：${this.cfg.baseDir}/resource.db.json ｜ 对象 ${this.store.objects.length} 条`,
    };
  }

  async reload(cfg: CoreConfig): Promise<void> {
    this.cfg = mergeConfig(cfg);
    this.store.cfg = this.cfg;
    this.provider = this.buildProvider();
    this.meta = { ...this.meta, provider: this.provider.name, offline: this.provider.offline, baseDir: this.cfg.baseDir };
  }

  // ------------------------------------------------------------ capture ---

  capture(input: CaptureInput, onProgress?: ProgressCallback): Promise<CaptureResult> {
    onProgress?.("写入 Inbox…");
    return captureText(this.store, this.cfg, input);
  }

  captureBinary(input: CaptureBinaryInput, onProgress?: ProgressCallback) {
    onProgress?.("保存原件并写入 Inbox…");
    return captureBinary(this.store, this.cfg, input);
  }

  ingest(
    source: string,
    options: { kind?: ResourceKind; tags?: string[]; maxImages?: number },
    onProgress?: ProgressCallback,
  ): Promise<IngestResult> {
    const progress: ProgressFn = onProgress ?? (() => undefined);
    return ingestCore(
      this.store,
      this.cfg,
      this.http,
      source,
      {
        kind: options.kind,
        tags: options.tags,
        maxImages: options.maxImages,
        // 本地核心不支持重活，不提供 delegate
      },
      progress,
    );
  }

  // ------------------------------------------------------------ pipeline ---

  processInbox(opts: { limit?: number; onProgress?: ProgressCallback } = {}): Promise<ProcessResult[]> {
    return processInboxCore(this.store, this.cfg, this.provider, {
      limit: opts.limit,
      onProgress: opts.onProgress,
    });
  }

  processObject(id: string, onProgress?: ProgressCallback): Promise<ProcessResult> {
    return processObjectCore(this.store, this.cfg, this.provider, id, { onProgress });
  }

  // ----------------------------------------------------------- retrieval ---

  search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    return searchCore(this.store, query, {
      ...opts,
      provider: this.provider,
      cfg: this.cfg,
      useVector: opts.useVector ?? false,
    });
  }

  ask(question: string, opts: { topK?: number; useVector?: boolean } = {}): Promise<AskResult> {
    return askCore(this.store, question, {
      provider: this.provider,
      cfg: this.cfg,
      topK: opts.topK,
      useVector: opts.useVector ?? false,
    });
  }

  // -------------------------------------------------------------- object ---

  async objects(query: Parameters<CoreBridge["objects"]>[0] = {}): Promise<ProsObject[]> {
    return this.store.queryObjects(query ?? {});
  }

  async object(id: string): Promise<ProsObject | null> {
    return this.store.object(id) ?? null;
  }

  async updateObject(id: string, fields: Partial<ProsObject>): Promise<{ audit_id: string }> {
    const audit_id = this.store.updateObject(id, fields, "user");
    await this.store.flush();
    return { audit_id };
  }

  async deleteObject(id: string): Promise<{ audit_id: string }> {
    const audit_id = this.store.softDeleteObject(id, "user");
    await this.store.flush();
    return { audit_id };
  }

  async restoreObject(id: string): Promise<{ audit_id: string }> {
    const audit_id = this.store.restoreObject(id, "user");
    await this.store.flush();
    return { audit_id };
  }

  async relationsOf(id: string, status?: RelationStatus) {
    return enrichRelations(this.store, id, status);
  }

  async setRelationStatus(id: string, status: RelationStatus): Promise<{ audit_id: string }> {
    const audit_id = this.store.updateRelation(id, { status }, "user");
    await this.store.flush();
    return { audit_id };
  }

  async notePathOf(id: string): Promise<string | null> {
    const o = this.store.object(id);
    const p = o?.properties?.["note_path"];
    if (typeof p === "string" && p) return p;
    const inbox = o?.properties?.["inbox_path"];
    return typeof inbox === "string" && inbox ? inbox : null;
  }

  // ---------------------------------------------------------------- task ---

  async tasks(query: Parameters<CoreBridge["tasks"]>[0] = {}): Promise<Task[]> {
    return listTasks(this.store, query ?? {});
  }

  async createTask(input: Parameters<CoreBridge["createTask"]>[0]): Promise<{ id: string }> {
    const id = createTaskCore(this.store, { ...input, actor: "user" });
    await this.store.flush();
    return { id };
  }

  async setTaskStatus(id: string, status: TaskStatus): Promise<{ audit_id: string }> {
    const audit_id = status === "done"
      ? completeTask(this.store, id, "user")
      : setTaskStatusCore(this.store, id, status, "user");
    await this.store.flush();
    return { audit_id };
  }

  async setTaskPriority(id: string, priority: TaskPriority): Promise<{ audit_id: string }> {
    const audit_id = setTaskPriorityCore(this.store, id, priority, "user");
    await this.store.flush();
    return { audit_id };
  }

  async deleteTask(id: string): Promise<{ audit_id: string }> {
    const audit_id = deleteTaskCore(this.store, id, "user");
    await this.store.flush();
    return { audit_id };
  }

  // --------------------------------------------------------------- audit ---

  async audit(opts: { objectType?: string; objectId?: string; limit?: number } = {}): Promise<AuditEntry[]> {
    return this.store.auditHistory(opts);
  }

  async rollback(auditId: string): Promise<RollbackResultView> {
    const r: RollbackResult = rollbackCore(this.store, auditId);
    await this.store.flush();
    return r;
  }

  async rollbackToPoint(objectId: string, auditId: string): Promise<RollbackResultView[]> {
    const rs = rollbackToPointCore(this.store, objectId, auditId);
    await this.store.flush();
    return rs;
  }

  // ------------------------------------------------------------ approval ---

  async approvals(status?: Approval["status"]): Promise<Approval[]> {
    return status ? this.store.approvals.filter((a) => a.status === status) : this.store.approvals;
  }

  decideApproval(id: string, approve: boolean) {
    return decideApproval(this.store, id, approve, "user");
  }

  async requestApproval(
    kind: ApprovalKind,
    tool: string,
    args: Record<string, unknown>,
    payload: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    const id = requestApproval(this.store, kind, tool, args, "user", payload);
    await this.store.flush();
    return { id };
  }

  // ------------------------------------------------------------- summary ---

  async summaries(): Promise<SummaryRecord[]> {
    return this.store.summaries;
  }

  async summarize(
    input: { granularity: "daily" | "weekly" | "monthly" | "custom"; start?: string; end?: string },
    onProgress?: ProgressCallback,
  ): Promise<SummaryRecord> {
    const range = input.start && input.end
      ? { start: input.start, end: input.end }
      : rangeFor(input.granularity);
    return summarizeRange(
      this.store, this.cfg, this.provider, range.start, range.end, input.granularity,
      this.decision, { onProgress },
    );
  }

  async renderSummary(record: SummaryRecord): Promise<string> {
    return renderSummaryMarkdown(record);
  }

  async actionToTask(action: { kind: string; title: string; task_id?: string }, summaryId?: string): Promise<{ id: string }> {
    const id = actionToTaskCore(this.store, action, summaryId, "user");
    await this.store.flush();
    return { id };
  }

  async saveSummaryToVault(record: SummaryRecord): Promise<string> {
    const g = { daily: "日报", weekly: "周报", monthly: "月报", custom: "总结" }[record.granularity];
    const path = `${this.cfg.notesDir}/总结/${record.range_start}_${record.range_end}_${g}.md`;
    await this.store.fs.write(path, renderSummaryMarkdown(record));
    return path;
  }

  evaluateDecision(state: string, question: string, options: string[]) {
    return this.decision.choice(state, question, options);
  }

  // --------------------------------------------------------------- agent ---

  async agents(): Promise<AgentDef[]> {
    return this.store.agents;
  }

  async upsertAgent(def: AgentDef): Promise<void> {
    this.store.upsertAgent(def);
    await this.store.flush();
  }

  async removeAgent(name: string): Promise<void> {
    this.store.removeAgent(name);
    await this.store.flush();
  }

  runAgent(name: string, input: string) {
    const def = this.store.agent(name);
    if (!def) throw new Error(`Agent「${name}」不存在`);
    return runAgentCore(this.store, this.cfg, this.provider, def, input, def.trigger);
  }

  async agentRuns(limit = 50): Promise<AgentRun[]> {
    return this.store.agentRuns.slice(0, limit);
  }

  // ------------------------------------------------------------ connector ---

  async connectors(): Promise<ConnectorState[]> {
    return this.store.db.connectors;
  }

  async updateConnector(state: ConnectorState): Promise<void> {
    const idx = this.store.db.connectors.findIndex((c) => c.id === state.id);
    if (idx >= 0) this.store.db.connectors[idx] = state;
    else this.store.db.connectors.push(state);
    await this.store.flush();
  }

  // ------------------------------------------------------------- ops/io ---

  async stats() {
    return this.store.stats();
  }

  async rebuildIndex(): Promise<{ objects: number; tokens: number }> {
    globalIndex.build(this.store);
    globalIndex.clearVectors();
    return { objects: this.store.objects.length, tokens: 0 };
  }

  exportJson(path: string): Promise<string> {
    return exportJsonCore(this.store, path);
  }

  async backup() {
    const r = await backupCore(this.store, this.cfg);
    return { backup_dir: r.backup_dir, manifest: r.manifest };
  }

  listBackups(): Promise<string[]> {
    return listBackupsCore(this.store, this.cfg);
  }

  async restore(backupDir: string): Promise<{ restored: boolean }> {
    // 恢复 = 覆盖当前库，属于不可逆操作：先自动做一次「恢复前快照」，
    // 这样即使用户选错了备份，也能再用 pre-restore 里的快照退回来。
    await snapshotBeforeRestore(this.store, this.cfg);
    const r = await restoreCore(this.store, backupDir);
    return { restored: r.restored };
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.store.fs.write(path, content);
    return path;
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
