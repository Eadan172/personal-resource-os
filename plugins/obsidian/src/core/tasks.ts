/**
 * 任务系统（对应 Python Core tasks.py，docs/04 §3）。
 *
 * 全字段 + 审计 + AI 创建标记（created_by_agent）。
 * 所有写操作走 Store 的受控方法，因此天然可回滚。
 */
import type { Store } from "./store";
import type { Task, TaskPriority, TaskStatus } from "./models";
import { newId, nowIso } from "./util";

export interface CreateTaskInput {
  title: string;
  source_object_id?: string | null;
  due_at?: string | null;
  priority?: TaskPriority;
  project?: string | null;
  assignee?: string | null;
  tags?: string[];
  /** 追溯信息：来自哪条内容、哪段文本（span）、哪个处理器。 */
  provenance?: Record<string, unknown>;
  confidence?: number;
  actor?: string;
  agent_run_id?: string | null;
}

export function createTask(store: Store, input: CreateTaskInput): string {
  const actor = input.actor ?? "user";
  const task: Task = {
    id: newId("tsk_"),
    title: input.title.trim().slice(0, 300),
    source_object_id: input.source_object_id ?? null,
    due_at: input.due_at ?? null,
    priority: input.priority ?? "P2",
    status: "todo",
    project: input.project ?? null,
    assignee: input.assignee ?? null,
    tags: input.tags ?? [],
    provenance: input.provenance ?? {},
    confidence: input.confidence ?? 1,
    created_by_agent: actor.startsWith("agent") ? 1 : 0,
    created_at: nowIso(),
    completed_at: null,
  };
  store.insertTask(task, actor, input.agent_run_id ?? null);
  return task.id;
}

export interface TaskQuery {
  status?: TaskStatus | "open" | "all";
  priority?: TaskPriority;
  project?: string;
  sourceObjectId?: string;
  limit?: number;
}

export function listTasks(store: Store, q: TaskQuery = {}): Task[] {
  const { status = "all", priority, project, sourceObjectId, limit } = q;
  let rows = store.tasks.filter((t) => {
    if (status === "open") {
      if (t.status !== "todo" && t.status !== "doing") return false;
    } else if (status !== "all" && t.status !== status) return false;
    if (priority && t.priority !== priority) return false;
    if (project && t.project !== project) return false;
    if (sourceObjectId && t.source_object_id !== sourceObjectId) return false;
    return true;
  });
  // 排序：未完成优先 → 有截止时间优先 → 截止时间升序 → 优先级
  const prioRank: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  rows = rows.slice().sort((a, b) => {
    const aDone = a.status === "done" || a.status === "cancelled" ? 1 : 0;
    const bDone = b.status === "done" || b.status === "cancelled" ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    const aDue = a.due_at ?? "9999-99-99";
    const bDue = b.due_at ?? "9999-99-99";
    if (aDue !== bDue) return aDue < bDue ? -1 : 1;
    return prioRank[a.priority] - prioRank[b.priority];
  });
  return limit ? rows.slice(0, limit) : rows;
}

export function completeTask(store: Store, taskId: string, actor = "user"): string {
  return store.updateTask(taskId, { status: "done", completed_at: nowIso() }, actor);
}

export function reopenTask(store: Store, taskId: string, actor = "user"): string {
  return store.updateTask(taskId, { status: "todo", completed_at: null }, actor);
}

export function setTaskStatus(store: Store, taskId: string, status: TaskStatus, actor = "user"): string {
  return store.updateTask(
    taskId,
    { status, completed_at: status === "done" ? nowIso() : null },
    actor,
  );
}

export function setTaskPriority(store: Store, taskId: string, priority: TaskPriority, actor = "user"): string {
  return store.updateTask(taskId, { priority }, actor);
}

/**
 * 删除任务。
 * 走 Store 的受控删除（写 before/after 快照），因此误删可在审计视图单条回滚恢复。
 */
export function deleteTask(store: Store, taskId: string, actor = "user"): string {
  return store.deleteTask(taskId, actor);
}

/** 是否逾期（未完成且 due_at 早于今天）。 */
export function isOverdue(task: Task, now = new Date()): boolean {
  if (task.status === "done" || task.status === "cancelled" || !task.due_at) return false;
  const p = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return task.due_at.slice(0, 10) < today;
}

/** 今天到期。 */
export function isDueToday(task: Task, now = new Date()): boolean {
  if (!task.due_at) return false;
  const p = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return task.due_at.slice(0, 10) === today;
}

export function taskStats(store: Store): {
  open: number; doing: number; done: number; overdue: number; dueToday: number; byPriority: Record<string, number>;
} {
  const byPriority: Record<string, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  let open = 0, doing = 0, done = 0, overdue = 0, dueToday = 0;
  for (const t of store.tasks) {
    if (t.status === "todo") open++;
    else if (t.status === "doing") doing++;
    else if (t.status === "done") done++;
    if (t.status === "todo" || t.status === "doing") {
      byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;
      if (isOverdue(t)) overdue++;
      if (isDueToday(t)) dueToday++;
    }
  }
  return { open, doing, done, overdue, dueToday, byPriority };
}
