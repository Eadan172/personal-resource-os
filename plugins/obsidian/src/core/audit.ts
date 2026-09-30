/**
 * 审计 / Diff / 回滚（对应 Python Core audit.py，ADR-005）。
 *
 * 一切 mutation 都经由 Store 的受控方法写入 audit_log（before/after 快照）。
 * 本模块提供：
 *  - `diff(before, after)`：生成可读的字段级差异，展示在审计视图；
 *  - `rollback(store, auditId)`：按 op 取逆，回滚本身也留痕（形成可追溯链）；
 *  - `restorePoint`：把某个对象回滚到任意历史审计点。
 */
import type { AuditEntry, AuditTable } from "./models";
import { UPDATABLE_FIELDS, type Store } from "./store";
import type { ProsObject, Relation, Task } from "./models";
import { newId } from "./util";

export interface FieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}

/** 字段级 diff：只列出真正变化的字段，长文本截断展示。 */
export function diff(before: unknown, after: unknown): FieldDiff[] {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  const out: FieldDiff[] = [];
  for (const k of keys) {
    if (k === "updated_at") continue;
    const bv = b[k];
    const av = a[k];
    if (JSON.stringify(bv) === JSON.stringify(av)) continue;
    out.push({ field: k, before: summarize(bv), after: summarize(av) });
  }
  return out;
}

/** 把长文本/对象压缩成可读的一行，避免审计界面被正文淹没。 */
function summarize(v: unknown): unknown {
  if (typeof v === "string") {
    const s = v.replace(/\s+/g, " ");
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  }
  if (Array.isArray(v)) return v.length > 8 ? [...v.slice(0, 8), `…共 ${v.length} 项`] : v;
  return v;
}

export interface RollbackResult {
  audit_id: string;
  rollback_audit_id: string;
  table: AuditTable;
  target_id: string;
  description: string;
}

/**
 * 回滚单条审计记录（变更日志形态的撤销）。
 *
 * 复现 Python Core 语义：
 *  - create 的逆：objects 走软删除；其余表直接移除记录；
 *  - update 的逆：把 before 中白名单字段写回；
 *  - delete 的逆：objects 恢复 lifecycle；其余表按快照重建；
 *  - restore 的逆：相当于 update 回滚。
 */
export function rollback(store: Store, auditId: string): RollbackResult {
  const entry = store.auditEntry(auditId);
  if (!entry) throw new Error(`审计记录 ${auditId} 不存在`);
  if (!entry.reversible) throw new Error("该操作被标记为不可逆");
  const actor = "rollback:user";

  switch (entry.op) {
    case "create": {
      if (entry.object_type === "objects") {
        const obj = store.object(entry.object_id);
        if (obj) {
          const before = JSON.parse(JSON.stringify(obj)) as ProsObject;
          obj.lifecycle = "deleted";
          const rid = store.recordAudit("delete", "objects", entry.object_id, before, JSON.parse(JSON.stringify(obj)), actor);
          return done(store, auditId, rid, entry, "撤销新建 → 已移入回收站（可恢复）");
        }
      } else {
        const removed = removeRecord(store, entry.object_type, entry.object_id);
        if (removed) {
          const rid = store.recordAudit("delete", entry.object_type, entry.object_id, removed, null, actor);
          return done(store, auditId, rid, entry, "撤销新建 → 已移除该记录");
        }
      }
      throw new Error("目标记录已不存在，无需回滚");
    }

    case "update":
    case "restore": {
      const before = (entry.before ?? {}) as Record<string, unknown>;
      if (entry.object_type === "objects") {
        const obj = store.object(entry.object_id);
        if (!obj) throw new Error("目标对象已不存在");
        const snapshot = JSON.parse(JSON.stringify(obj)) as ProsObject;
        // 仅回写白名单字段，防止 before 里混入不可写字段
        for (const [k, v] of Object.entries(before)) {
          if (UPDATABLE_FIELDS.objects.has(k)) (obj as unknown as Record<string, unknown>)[k] = v;
        }
        const rid = store.recordAudit("update", "objects", entry.object_id, snapshot, JSON.parse(JSON.stringify(obj)), actor);
        return done(store, auditId, rid, entry, "撤销更新 → 已恢复到变更前内容");
      }
      if (entry.object_type === "tasks") {
        const t = store.task(entry.object_id);
        if (!t) throw new Error("目标任务已不存在");
        const snapshot = JSON.parse(JSON.stringify(t)) as Task;
        for (const [k, v] of Object.entries(before)) {
          if (UPDATABLE_FIELDS.tasks.has(k)) (t as unknown as Record<string, unknown>)[k] = v;
        }
        const rid = store.recordAudit("update", "tasks", entry.object_id, snapshot, JSON.parse(JSON.stringify(t)), actor);
        return done(store, auditId, rid, entry, "撤销任务更新");
      }
      if (entry.object_type === "relations") {
        const r = store.relation(entry.object_id);
        if (!r) throw new Error("目标关系已不存在");
        const snapshot = JSON.parse(JSON.stringify(r)) as Relation;
        for (const [k, v] of Object.entries(before)) {
          if (UPDATABLE_FIELDS.relations.has(k)) (r as unknown as Record<string, unknown>)[k] = v;
        }
        const rid = store.recordAudit("update", "relations", entry.object_id, snapshot, JSON.parse(JSON.stringify(r)), actor);
        return done(store, auditId, rid, entry, "撤销关系更新");
      }
      if (entry.object_type === "summaries") {
        const s = store.summary(entry.object_id);
        if (!s) throw new Error("目标总结已不存在");
        const snapshot = JSON.parse(JSON.stringify(s));
        if (before.content !== undefined) (s as unknown as Record<string, unknown>).content = before.content;
        const rid = store.recordAudit("update", "summaries", entry.object_id, snapshot, JSON.parse(JSON.stringify(s)), actor);
        return done(store, auditId, rid, entry, "撤销总结更新");
      }
      throw new Error(`不支持回滚的表：${entry.object_type}`);
    }

    case "delete": {
      if (entry.object_type === "objects") {
        const obj = store.object(entry.object_id);
        if (!obj) throw new Error("目标对象已被物理移除，无法恢复");
        const snapshot = JSON.parse(JSON.stringify(obj)) as ProsObject;
        obj.lifecycle = (entry.before as ProsObject | null)?.lifecycle ?? "inbox";
        const rid = store.recordAudit("restore", "objects", entry.object_id, snapshot, JSON.parse(JSON.stringify(obj)), actor);
        return done(store, auditId, rid, entry, "撤销删除 → 已从回收站恢复");
      }
      const before = entry.before as Record<string, unknown> | null;
      if (!before) throw new Error("该删除操作没有快照，无法恢复");
      const restored = insertRecord(store, entry.object_type, before);
      if (!restored) throw new Error(`不支持恢复的表：${entry.object_type}`);
      const rid = store.recordAudit("restore", entry.object_type, entry.object_id, null, before, actor);
      return done(store, auditId, rid, entry, "撤销删除 → 已按快照重建");
    }

    default:
      throw new Error(`不支持的回滚 op：${String(entry.op)}`);
  }
}

function done(
  store: Store,
  auditId: string,
  rollbackAuditId: string,
  entry: AuditEntry,
  description: string,
): RollbackResult {
  void store;
  return {
    audit_id: auditId,
    rollback_audit_id: rollbackAuditId,
    table: entry.object_type,
    target_id: entry.object_id,
    description,
  };
}

function removeRecord(store: Store, table: AuditTable, id: string): unknown | null {
  if (table === "tasks") {
    const idx = store.db.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return null;
    const snap = JSON.parse(JSON.stringify(store.db.tasks[idx]));
    store.db.tasks.splice(idx, 1);
    return snap;
  }
  if (table === "relations") {
    const idx = store.db.relations.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    const snap = JSON.parse(JSON.stringify(store.db.relations[idx]));
    store.db.relations.splice(idx, 1);
    return snap;
  }
  if (table === "summaries") {
    const idx = store.db.summaries.findIndex((s) => s.id === id);
    if (idx < 0) return null;
    const snap = JSON.parse(JSON.stringify(store.db.summaries[idx]));
    store.db.summaries.splice(idx, 1);
    return snap;
  }
  return null;
}

function insertRecord(store: Store, table: AuditTable, snapshot: Record<string, unknown>): boolean {
  // 防止重复插入（用户可能重复点击回滚）
  if (table === "tasks" && store.task(String(snapshot.id))) return false;
  if (table === "relations" && store.relation(String(snapshot.id))) return false;
  if (table === "summaries" && store.summary(String(snapshot.id))) return false;
  if (table === "tasks") store.db.tasks.push(snapshot as unknown as Task);
  else if (table === "relations") store.db.relations.push(snapshot as unknown as Relation);
  else if (table === "summaries") store.db.summaries.push(snapshot as unknown as never);
  else return false;
  store.touch();
  return true;
}

/**
 * 把对象回滚到指定审计点（把该审计点之后针对该对象的所有变更逐条撤销，倒序执行）。
 * 用于「误操作批量恢复」场景，是单条 rollback 的组合封装。
 */
export function rollbackToPoint(store: Store, objectId: string, auditId: string): RollbackResult[] {
  const history = store
    .auditHistory({ objectId, limit: 1000 })
    .slice()
    .reverse(); // 时间正序
  const targetIdx = history.findIndex((e) => e.id === auditId);
  if (targetIdx < 0) throw new Error("指定的审计点不属于该对象");
  const results: RollbackResult[] = [];
  // 从最新往回撤销，直到目标点为止（不含目标点本身）
  for (let i = history.length - 1; i > targetIdx; i--) {
    const e = history[i];
    if (!e.reversible) continue;
    // 跳过由回滚自身产生的记录，避免自我抵消
    if (e.actor.startsWith("rollback:")) continue;
    try {
      results.push(rollback(store, e.id));
    } catch {
      // 单条失败不阻塞整体（例如目标记录已被物理删除）
    }
  }
  return results;
}

/** 生成一条人类可读的审计摘要，供列表展示。 */
export function describeAudit(entry: AuditEntry): string {
  const opLabel: Record<string, string> = {
    create: "新建", update: "更新", delete: "删除", restore: "恢复",
  };
  const tableLabel: Record<string, string> = {
    objects: "对象", tasks: "任务", relations: "关系", summaries: "总结",
  };
  const d = entry.before && entry.after ? diff(entry.before, entry.after) : [];
  const fields = d.length ? `（${d.map((x) => x.field).join(", ")}）` : "";
  return `${opLabel[entry.op] ?? entry.op}${tableLabel[entry.object_type] ?? entry.object_type}${fields}`;
}

/** 生成新的审计锚点 id（供外部需要预先占位时使用）。 */
export function nextAuditId(): string {
  return newId("aud_");
}
