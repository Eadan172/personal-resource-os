/**
 * 存储层（对应 Python Core db.py / docs E.2 表结构）。
 *
 * 单用户本地场景下用「单文件 JSON 库 + vault Markdown」替代 SQLite：
 *  - 结构化数据（对象/关系/任务/衍生/审计/运行/审批/总结）落在 <baseDir>/resource.db.json；
 *  - 正文与笔记落在 vault 的 Markdown 文件里，Obsidian 可直接浏览编辑（事实源）；
 *  - 采集原件与衍生数据落在 <baseDir>/resources/ 下，只增不改。
 *
 * 安全铁律（由本层强制，任何调用方都绕不过）：
 *  1. 白名单字段：只有 UPDATABLE_FIELDS 里的字段可被 update；
 *  2. agent/connector 禁止写 objects.content / content_hash —— 原始事实不可被 AI 覆盖；
 *  3. 删除一律软删除（lifecycle=deleted），可恢复；
 *  4. 每次 mutation 都写 audit_log（before/after 快照），可 rollback。
 */
import type { VaultFs } from "../vault/vaultFs";
import type { CoreConfig } from "./config";
import {
  builtinAgents, defaultConnectors, emptyDB, SCHEMA_VERSION,
} from "./models";
import type {
  AgentDef, AgentRun, Approval, AuditEntry, AuditOp, AuditTable, Extraction, ProsDB,
  ProsObject, Relation, RelationType, SummaryRecord, Task,
} from "./models";
import { newId, nowIso } from "./util";

/** 每张表允许被 update 的字段白名单（与 Python Core audit.UPDATABLE_FIELDS 对齐）。 */
export const UPDATABLE_FIELDS: Record<AuditTable, Set<string>> = {
  objects: new Set([
    "type", "title", "content", "source_uri", "origin", "confidence", "provenance",
    "tags", "properties", "data_class", "event_time_start", "event_time_end",
    "lifecycle", "updated_at",
  ]),
  tasks: new Set([
    "title", "source_object_id", "due_at", "priority", "status", "project",
    "assignee", "tags", "provenance", "confidence", "created_by_agent", "completed_at",
  ]),
  relations: new Set(["type", "status", "confidence", "provenance"]),
  summaries: new Set(["content", "generated_by"]),
};

/** Agent / Connector 一律不可写的字段：原始事实层。 */
export const AGENT_FORBIDDEN_FIELDS: Record<string, Set<string>> = {
  objects: new Set(["content", "content_hash"]),
};

export interface ObjectQuery {
  lifecycle?: ProsObject["lifecycle"] | "all";
  types?: string[];
  tags?: string[];
  start?: string;
  end?: string;
  limit?: number;
  orderBy?: "created_desc" | "created_asc";
}

export class Store {
  readonly fs: VaultFs;
  cfg: CoreConfig;
  db: ProsDB;

  /** 变更通知（UI 用来刷新视图）。 */
  onChange: (() => void) | null = null;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  private constructor(fs: VaultFs, cfg: CoreConfig, db: ProsDB) {
    this.fs = fs;
    this.cfg = cfg;
    this.db = db;
  }

  // ------------------------------------------------------------- 生命周期 ---

  /** 打开（或初始化）索引库；自动补齐出厂 Agent 与 Connector 定义。 */
  static async open(fs: VaultFs, cfg: CoreConfig): Promise<Store> {
    const path = Store.dbPath(cfg);
    let db: ProsDB;
    if (await fs.exists(path)) {
      try {
        db = Store.normalize(JSON.parse(await fs.read(path)) as ProsDB);
      } catch (e) {
        // 索引损坏时不让用户丢数据：把坏文件改名留档，再重建
        const corrupt = `${path}.corrupt-${Date.now()}`;
        await fs.rename(path, corrupt);
        db = emptyDB();
        console.error(`[PROS] 索引库解析失败，已备份到 ${corrupt}：`, e);
      }
    } else {
      db = emptyDB();
    }
    const store = new Store(fs, cfg, db);
    await store.flush();
    return store;
  }

  static dbPath(cfg: CoreConfig): string {
    return `${cfg.baseDir.replace(/\/+$/, "")}/resource.db.json`;
  }

  /** 结构兼容处理：缺失表补齐、schema 版本校正。 */
  private static normalize(raw: Partial<ProsDB>): ProsDB {
    const base = emptyDB();
    const db: ProsDB = {
      ...base,
      ...raw,
      schema_version: SCHEMA_VERSION,
      objects: raw.objects ?? [],
      relations: raw.relations ?? [],
      tasks: raw.tasks ?? [],
      extractions: raw.extractions ?? [],
      audit_log: raw.audit_log ?? [],
      agent_runs: raw.agent_runs ?? [],
      approvals: raw.approvals ?? [],
      summaries: raw.summaries ?? [],
      agents: raw.agents ?? builtinAgents(),
      connectors: raw.connectors ?? defaultConnectors(),
      outbound_allowlist: raw.outbound_allowlist ?? base.outbound_allowlist,
    };
    // 出厂 Agent 必须存在（用户自定义的保留）
    for (const b of builtinAgents()) {
      if (!db.agents.some((a) => a.name === b.name)) db.agents.push(b);
    }
    for (const c of defaultConnectors()) {
      if (!db.connectors.some((x) => x.id === c.id)) db.connectors.push(c);
    }
    return db;
  }

  /** 标记脏并延迟落盘（防抖，避免高频写）。 */
  touch(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 250);
  }

  /** 立即落盘。 */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.db.updated_at = nowIso();
    await this.fs.write(Store.dbPath(this.cfg), JSON.stringify(this.db, null, 2));
    if (this.dirty) this.dirty = false;
    this.onChange?.();
  }

  // --------------------------------------------------------------- 查询层 ---

  get objects(): ProsObject[] {
    return this.db.objects;
  }
  get relations(): Relation[] {
    return this.db.relations;
  }
  get tasks(): Task[] {
    return this.db.tasks;
  }
  get summaries(): SummaryRecord[] {
    return this.db.summaries;
  }
  get approvals(): Approval[] {
    return this.db.approvals;
  }
  get agentRuns(): AgentRun[] {
    return this.db.agent_runs;
  }
  get agents(): AgentDef[] {
    return this.db.agents;
  }

  object(id: string): ProsObject | undefined {
    return this.db.objects.find((o) => o.id === id);
  }

  /** 含已软删除对象（回收站视图用）。 */
  objectIncludingDeleted(id: string): ProsObject | undefined {
    return this.db.objects.find((o) => o.id === id);
  }

  task(id: string): Task | undefined {
    return this.db.tasks.find((t) => t.id === id);
  }

  relation(id: string): Relation | undefined {
    return this.db.relations.find((r) => r.id === id);
  }

  summary(id: string): SummaryRecord | undefined {
    return this.db.summaries.find((s) => s.id === id);
  }

  agent(name: string): AgentDef | undefined {
    return this.db.agents.find((a) => a.name === name);
  }

  /** 按 content_hash 找重复对象（只提示，不合并）。 */
  objectByHash(hash: string, excludeId?: string): ProsObject | undefined {
    return this.db.objects.find(
      (o) => o.content_hash === hash && o.id !== excludeId && o.lifecycle !== "deleted",
    );
  }

  /** 通用对象查询：生命周期 / 类型 / 标签 / 时间区间 / 排序 / 条数。 */
  queryObjects(q: ObjectQuery = {}): ProsObject[] {
    const { lifecycle = "all", types, tags, start, end, limit, orderBy = "created_desc" } = q;
    let rows = this.db.objects.filter((o) => {
      if (lifecycle !== "all" && o.lifecycle !== lifecycle) return false;
      if (types?.length && !types.includes(o.type)) return false;
      if (tags?.length && !tags.every((t) => o.tags.includes(t))) return false;
      if (start && o.created_at < start) return false;
      if (end) {
        const bound = end.length === 10 ? `${end}T23:59:59Z` : end;
        if (o.created_at > bound) return false;
      }
      return true;
    });
    rows = rows.slice().sort((a, b) =>
      orderBy === "created_asc"
        ? a.created_at.localeCompare(b.created_at)
        : b.created_at.localeCompare(a.created_at),
    );
    return limit ? rows.slice(0, limit) : rows;
  }

  /** 全局计数（Dashboard 用）。 */
  stats(): {
    total: number; inbox: number; processed: number; archived: number; deleted: number;
    byType: Record<string, number>; openTasks: number; overdue: number;
    pendingApprovals: number; pendingRelations: number; lastUpdated: string;
  } {
    const byType: Record<string, number> = {};
    let inbox = 0, processed = 0, archived = 0, deleted = 0;
    for (const o of this.db.objects) {
      if (o.lifecycle === "inbox") inbox++;
      else if (o.lifecycle === "processed") processed++;
      else if (o.lifecycle === "archived") archived++;
      else if (o.lifecycle === "deleted") deleted++;
      if (o.lifecycle !== "deleted") byType[o.type] = (byType[o.type] ?? 0) + 1;
    }
    const today = nowIso();
    const openTasks = this.db.tasks.filter((t) => t.status === "todo" || t.status === "doing").length;
    const overdue = this.db.tasks.filter(
      (t) => (t.status === "todo" || t.status === "doing") && t.due_at && t.due_at < today,
    ).length;
    return {
      total: this.db.objects.length,
      inbox, processed, archived, deleted, byType, openTasks, overdue,
      pendingApprovals: this.db.approvals.filter((a) => a.status === "pending").length,
      pendingRelations: this.db.relations.filter((r) => r.status === "suggested").length,
      lastUpdated: this.db.updated_at,
    };
  }

  // --------------------------------------------------------- 审计与 mutation ---

  /**
   * 写审计。所有 mutation 必须先经过本函数拿到的审计锚点才能落库，
   * 以保证「一切变更可回滚」（ADR-005）。
   */
  recordAudit(
    op: AuditOp,
    table: AuditTable,
    objectId: string,
    before: unknown,
    after: unknown,
    actor: string,
    agentRunId: string | null = null,
    reversible = true,
  ): string {
    const entry: AuditEntry = {
      id: newId("aud_"),
      op, object_type: table, object_id: objectId,
      before: before ?? null, after: after ?? null,
      actor, agent_run_id: agentRunId,
      reversible: reversible ? 1 : 0,
      created_at: nowIso(),
    };
    this.db.audit_log.unshift(entry);
    // 审计日志保留上限，防止无限膨胀（可按需在设置中调整）
    if (this.db.audit_log.length > 20000) this.db.audit_log.length = 20000;
    this.touch();
    return entry.id;
  }

  auditHistory(opts: { objectType?: string; objectId?: string; limit?: number } = {}): AuditEntry[] {
    const { objectType, objectId, limit = 200 } = opts;
    return this.db.audit_log
      .filter((e) => (!objectType || e.object_type === objectType) && (!objectId || e.object_id === objectId))
      .slice(0, limit);
  }

  auditEntry(id: string): AuditEntry | undefined {
    return this.db.audit_log.find((e) => e.id === id);
  }

  /** 新增对象（content 原样落库，不可被后续 AI 覆盖）。 */
  insertObject(obj: ProsObject, actor: string, agentRunId: string | null = null): string {
    this.db.objects.push(obj);
    return this.recordAudit("create", "objects", obj.id, null, obj, actor, agentRunId);
  }

  /**
   * 受控更新：字段白名单 + agent 禁写原始事实 + before/after 留痕。
   * 返回审计 id（rollback 的锚点）。
   */
  updateObject(
    id: string,
    fields: Partial<ProsObject>,
    actor: string,
    agentRunId: string | null = null,
  ): string {
    const obj = this.object(id);
    if (!obj) throw new Error(`对象 ${id} 不存在`);
    const keys = Object.keys(fields);
    const unknown = keys.filter((k) => !UPDATABLE_FIELDS.objects.has(k));
    if (unknown.length) throw new Error(`不允许更新的字段：${unknown.join(", ")}`);
    if (actor.startsWith("agent") || actor.startsWith("connector")) {
      const forbidden = keys.filter((k) => AGENT_FORBIDDEN_FIELDS.objects.has(k));
      if (forbidden.length) {
        throw new Error(`${actor} 禁止修改字段 ${forbidden.join(", ")}（原始事实不可被 AI 覆盖）`);
      }
    }
    const before = JSON.parse(JSON.stringify(obj)) as ProsObject;
    Object.assign(obj, fields);
    obj.updated_at = nowIso();
    // 用户直接改正文时，来源标记升级为 user_edit（AI 产物才需要保留 origin）
    if (fields.content !== undefined && !actor.startsWith("agent") && !actor.startsWith("connector")) {
      obj.origin = "user_edit";
    }
    return this.recordAudit("update", "objects", id, before, JSON.parse(JSON.stringify(obj)), actor, agentRunId);
  }

  /** 软删除（可恢复）。 */
  softDeleteObject(id: string, actor: string): string {
    const obj = this.object(id);
    if (!obj) throw new Error(`对象 ${id} 不存在`);
    const before = JSON.parse(JSON.stringify(obj)) as ProsObject;
    obj.lifecycle = "deleted";
    obj.updated_at = nowIso();
    return this.recordAudit("delete", "objects", id, before, JSON.parse(JSON.stringify(obj)), actor);
  }

  /** 从回收站恢复。 */
  restoreObject(id: string, actor: string): string {
    const obj = this.object(id);
    if (!obj) throw new Error(`对象 ${id} 不存在`);
    const before = JSON.parse(JSON.stringify(obj)) as ProsObject;
    obj.lifecycle = "processed";
    obj.updated_at = nowIso();
    return this.recordAudit("restore", "objects", id, before, JSON.parse(JSON.stringify(obj)), actor);
  }

  insertRelation(rel: Relation, actor: string, agentRunId: string | null = null): string {
    this.db.relations.push(rel);
    return this.recordAudit("create", "relations", rel.id, null, rel, actor, agentRunId);
  }

  updateRelation(id: string, fields: Partial<Relation>, actor: string): string {
    const rel = this.relation(id);
    if (!rel) throw new Error(`关系 ${id} 不存在`);
    const unknown = Object.keys(fields).filter((k) => !UPDATABLE_FIELDS.relations.has(k));
    if (unknown.length) throw new Error(`不允许更新的字段：${unknown.join(", ")}`);
    const before = JSON.parse(JSON.stringify(rel)) as Relation;
    Object.assign(rel, fields);
    return this.recordAudit("update", "relations", id, before, JSON.parse(JSON.stringify(rel)), actor);
  }

  insertTask(task: Task, actor: string, agentRunId: string | null = null): string {
    this.db.tasks.push(task);
    return this.recordAudit("create", "tasks", task.id, null, task, actor, agentRunId);
  }

  updateTask(id: string, fields: Partial<Task>, actor: string, agentRunId: string | null = null): string {
    const task = this.task(id);
    if (!task) throw new Error(`任务 ${id} 不存在`);
    const unknown = Object.keys(fields).filter((k) => !UPDATABLE_FIELDS.tasks.has(k));
    if (unknown.length) throw new Error(`不允许更新的字段：${unknown.join(", ")}`);
    const before = JSON.parse(JSON.stringify(task)) as Task;
    Object.assign(task, fields);
    return this.recordAudit("update", "tasks", id, before, JSON.parse(JSON.stringify(task)), actor, agentRunId);
  }

  /** 任务删除：其他表无 lifecycle，删除为物理删除但保留 before 快照可恢复。 */
  deleteTask(id: string, actor: string): string {
    const idx = this.db.tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`任务 ${id} 不存在`);
    const before = JSON.parse(JSON.stringify(this.db.tasks[idx])) as Task;
    this.db.tasks.splice(idx, 1);
    return this.recordAudit("delete", "tasks", id, before, null, actor);
  }

  insertExtraction(ex: Extraction): void {
    this.db.extractions.push(ex);
    this.touch();
  }

  extractionsOf(objectId: string): Extraction[] {
    return this.db.extractions.filter((e) => e.source_object_id === objectId);
  }

  insertSummary(s: SummaryRecord, actor: string): string {
    this.db.summaries.unshift(s);
    return this.recordAudit("create", "summaries", s.id, null, s, actor);
  }

  updateSummary(id: string, fields: Partial<SummaryRecord>, actor: string): string {
    const s = this.summary(id);
    if (!s) throw new Error(`总结 ${id} 不存在`);
    const before = JSON.parse(JSON.stringify(s)) as SummaryRecord;
    Object.assign(s, fields);
    return this.recordAudit("update", "summaries", id, before, JSON.parse(JSON.stringify(s)), actor);
  }

  /** 关系查询：一个对象的出边/入边（Related / Backlinks 面板用）。 */
  relationsOf(objectId: string, status?: Relation["status"]): { out: Relation[]; in: Relation[] } {
    const match = (r: Relation) => !status || r.status === status;
    return {
      out: this.db.relations.filter((r) => r.src_id === objectId && match(r)),
      in: this.db.relations.filter((r) => r.dst_id === objectId && match(r)),
    };
  }

  /** 已有关系判定（避免重复建议同一对关系）。 */
  hasRelation(srcId: string, dstId: string, type?: RelationType): boolean {
    return this.db.relations.some(
      (r) => r.src_id === srcId && r.dst_id === dstId && (!type || r.type === type),
    );
  }

  // ----------------------------------------------------- Agent 运行 / 审批 ---

  createAgentRun(run: AgentRun): void {
    this.db.agent_runs.unshift(run);
    this.touch();
  }

  updateAgentRun(id: string, fields: Partial<AgentRun>): void {
    const run = this.db.agent_runs.find((r) => r.id === id);
    if (run) Object.assign(run, fields);
    this.touch();
  }

  addApproval(ap: Approval): void {
    this.db.approvals.unshift(ap);
    this.touch();
  }

  updateApproval(id: string, fields: Partial<Approval>): void {
    const ap = this.db.approvals.find((a) => a.id === id);
    if (ap) Object.assign(ap, fields);
    this.touch();
  }

  approval(id: string): Approval | undefined {
    return this.db.approvals.find((a) => a.id === id);
  }

  upsertAgent(def: AgentDef): void {
    const idx = this.db.agents.findIndex((a) => a.name === def.name);
    if (idx >= 0) this.db.agents[idx] = def;
    else this.db.agents.push(def);
    this.touch();
  }

  removeAgent(name: string): void {
    const def = this.agent(name);
    if (def?.builtin) throw new Error("内置 Agent 不可删除，可将其停用（trigger 置为 manual 并移除工具白名单）");
    this.db.agents = this.db.agents.filter((a) => a.name !== name);
    this.touch();
  }

  // ------------------------------------------------------------ 导出/备份 ---

  /** 全量导出（FR-16 数据可携带）。 */
  exportJson(): string {
    return JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        exported_at: nowIso(),
        objects: this.db.objects,
        relations: this.db.relations,
        tasks: this.db.tasks,
        extractions: this.db.extractions,
        audit_log: this.db.audit_log,
        agent_runs: this.db.agent_runs,
        approvals: this.db.approvals,
        summaries: this.db.summaries,
        agents: this.db.agents,
        connectors: this.db.connectors,
      },
      null,
      2,
    );
  }
}
