/**
 * 阶段总结（对应 Python Core summary.py，需求 §十二 / FR-10）。
 *
 * 覆盖十个维度：发生了什么、主题、新发现、已完成、未完成、人物、决策、风险、
 * 下一步行动、决策评估。行动建议可一键转 Task（带 provenance）。
 *
 * 输出为结构化 JSON（便于 UI 渲染与二次加工），同时可渲染成 Markdown 写入 vault。
 */
import type { CoreConfig } from "./config";
import type { ChatProvider } from "./providers/base";
import type { DecisionModel } from "./decision";
import type { Store } from "./store";
import type {
  DecisionAssessment, NextAction, SummaryContent, SummaryRecord, SummaryRef,
} from "./models";
import { createTask } from "./tasks";
import { newId, nowIso, todayLocal } from "./util";
import { humanTime } from "./util";

export type Granularity = "daily" | "weekly" | "monthly" | "custom";

/** 计算区间（左闭右闭，日期字符串）。 */
export function rangeFor(granularity: Granularity, ref = new Date()): { start: string; end: string } {
  const d = new Date(ref);
  switch (granularity) {
    case "daily":
      return { start: todayLocal(0), end: todayLocal(0) };
    case "weekly": {
      // 以周一为一周开始
      const day = d.getDay() === 0 ? 7 : d.getDay();
      const monday = new Date(d);
      monday.setDate(d.getDate() - (day - 1));
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return { start: fmt(monday), end: fmt(sunday) };
    }
    case "monthly": {
      const first = new Date(d.getFullYear(), d.getMonth(), 1);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      return { start: fmt(first), end: fmt(last) };
    }
    default:
      return { start: todayLocal(-7), end: todayLocal(0) };
  }
}

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 生成区间总结。
 * 注意：所有统计口径是「记录时间（created_at）落在区间内」，与事件时间分开建模（docs/04 §1）。
 */
export async function summarizeRange(
  store: Store,
  cfg: CoreConfig,
  provider: ChatProvider,
  start: string,
  end: string,
  granularity: Granularity = "custom",
  decisionModel?: DecisionModel,
  opts: { onProgress?: (m: string) => void } = {},
): Promise<SummaryRecord> {
  const progress = opts.onProgress ?? (() => undefined);
  progress("统计区间内容…");

  const endExclusive = end.length === 10 ? `${end}T23:59:59` : end;
  const startInclusive = start.length === 10 ? `${start}T00:00:00` : start;

  const objs = store.objects
    .filter((o) => o.lifecycle !== "deleted" && o.created_at >= startInclusive && o.created_at <= endExclusive)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const completed = store.tasks.filter(
    (t) => t.completed_at && t.completed_at >= startInclusive && t.completed_at <= endExclusive,
  );
  const pending = store.tasks.filter((t) => t.status === "todo" || t.status === "doing");
  const tasksCreated = store.tasks.filter(
    (t) => t.created_at >= startInclusive && t.created_at <= endExclusive,
  );

  // 主题：标签词频 Top10
  const tagCount = new Map<string, number>();
  const people = new Set<string>();
  for (const o of objs) {
    for (const t of o.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    if (o.type === "person") people.add(o.title);
    // @提及的人物也计入
    for (const m of o.content.matchAll(/@([\w\u4e00-\u9fff]+)/g)) people.add(m[1]);
  }
  const byType: Record<string, number> = {};
  for (const o of objs) byType[o.type] = (byType[o.type] ?? 0) + 1;

  const decisions = objs.filter((o) => o.type === "decision");
  progress("评估决策…");
  const assessments: DecisionAssessment[] = [];
  if (decisionModel) {
    for (const d of decisions.slice(0, 10)) {
      try {
        const a = await decisionModel.choice(
          `${d.title}\n${d.content.slice(0, 800)}`,
          "这条决策当前应处于什么状态？",
          ["已落地", "推进中", "待补充信息", "建议搁置"],
        );
        assessments.push({ ...a, decision_id: d.id });
      } catch (e) {
        assessments.push({
          decision_id: d.id, assessment: `决策评估失败：${String(e)}`,
          confidence: 0, model: decisionModel.name,
        });
      }
    }
  }

  progress("生成行动建议…");
  const nextActions = suggestActions(pending, objs);

  const content: SummaryContent = {
    range: { start, end },
    what_happened: objs.map<SummaryRef>((o) => ({ id: o.id, title: o.title, type: o.type })),
    themes: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t),
    discoveries: objs
      .filter((o) => o.origin === "ai_extracted" || o.origin === "ai_inferred")
      .map<SummaryRef>((o) => ({ id: o.id, title: o.title, type: o.type })),
    completed: completed.map<SummaryRef>((t) => ({ id: t.id, title: t.title })),
    pending: pending.map((t) => ({ id: t.id, title: t.title, due_at: t.due_at })),
    people: [...people].slice(0, 30),
    decisions: decisions.map<SummaryRef>((d) => ({ id: d.id, title: d.title })),
    decision_assessments: assessments,
    risks: objs.filter((o) => o.type === "risk").map<SummaryRef>((o) => ({ id: o.id, title: o.title })),
    next_actions: nextActions,
    stats: { objects: objs.length, by_type: byType, tasks_created: tasksCreated.length },
  };

  // 让模型补一段自然语言总述（失败不影响结构化结果）
  let narrative = "";
  try {
    if (objs.length) {
      narrative = await provider.summarize(
        `区间 ${start} ~ ${end} 新增 ${objs.length} 条内容，主题：${content.themes.join("、") || "无"}；` +
        `完成 ${completed.length} 项任务，仍有 ${pending.length} 项未完成。` +
        `内容标题：${objs.slice(0, 40).map((o) => o.title).join("；")}`,
      );
    }
  } catch {
    narrative = "";
  }
  if (narrative) (content as SummaryContent & { narrative?: string }).narrative = narrative;

  const record: SummaryRecord = {
    id: newId("sum_"),
    range_start: start,
    range_end: end,
    granularity,
    content,
    generated_by: `agent:summarizer(${provider.name})`,
    created_at: nowIso(),
  };
  store.insertSummary(record, "agent:summarizer");
  await store.flush();
  return record;
}

/** 行动建议：未完成任务跟进 + Inbox 清理 + 逾期提醒。 */
export function suggestActions(
  pending: { id: string; title: string; due_at: string | null; status: string }[],
  objs: { lifecycle: string }[],
): NextAction[] {
  const p = (n: number) => String(n).padStart(2, "0");
  const now = new Date();
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;

  const actions: NextAction[] = [];
  const overdue = pending.filter((t) => t.due_at && t.due_at.slice(0, 10) < today);
  for (const t of overdue.slice(0, 5)) {
    actions.push({ kind: "overdue", title: `已逾期，优先处理：${t.title}`, task_id: t.id });
  }
  for (const t of pending.filter((x) => !overdue.includes(x)).slice(0, 5)) {
    actions.push({ kind: "follow_up", title: `跟进未完成任务：${t.title}`, task_id: t.id });
  }
  const inboxCount = objs.filter((o) => o.lifecycle === "inbox").length;
  if (inboxCount) actions.push({ kind: "triage", title: `清理 Inbox 中 ${inboxCount} 条未处理内容` });
  if (!actions.length) actions.push({ kind: "none", title: "当前没有待办压力，可继续投入新内容" });
  return actions;
}

/** 行动建议一键转 Task（带 provenance，可追溯来自哪份总结）。 */
export function actionToTask(
  store: Store,
  action: NextAction,
  summaryId?: string,
  actor = "user",
): string {
  return createTask(store, {
    title: action.title,
    provenance: { origin: "summary.next_actions", kind: action.kind, summary_id: summaryId },
    actor,
  });
}

/** 把总结渲染为 Markdown（写入 vault 便于长期归档与检索）。 */
export function renderSummaryMarkdown(record: SummaryRecord): string {
  const c = record.content;
  const g = { daily: "日报", weekly: "周报", monthly: "月报", custom: "区间总结" }[record.granularity];
  const out: string[] = [];
  out.push("---");
  out.push(`pros_id: ${record.id}`);
  out.push(`type: summary`);
  out.push(`granularity: ${record.granularity}`);
  out.push(`range_start: ${record.range_start}`);
  out.push(`range_end: ${record.range_end}`);
  out.push(`generated: ${record.created_at}`);
  out.push("---");
  out.push("");
  out.push(`# ${g}：${record.range_start} ~ ${record.range_end}`);
  out.push("");
  const narrative = (c as SummaryContent & { narrative?: string }).narrative;
  if (narrative) {
    out.push(`> ${narrative}`);
    out.push("");
  }
  out.push(`**统计**：新增 ${c.stats.objects} 条内容（任务新建 ${c.stats.tasks_created} 项）｜完成 ${c.completed.length} 项｜未完成 ${c.pending.length} 项`);
  out.push("");

  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    out.push(`## ${title}`);
    out.push("");
    for (const i of items) out.push(`- ${i}`);
    out.push("");
  };

  section("发生了什么", c.what_happened.map((o) => `[[${o.title}]]（${o.type ?? ""}）`));
  section("主题", c.themes.map((t) => `#${t}`));
  section("新发现", c.discoveries.map((o) => `[[${o.title}]]`));
  section("已完成", c.completed.map((t) => t.title));
  section("未完成", c.pending.map((t) => `${t.title}${t.due_at ? `（截止 ${t.due_at}）` : ""}`));
  section("人物", c.people);
  section("决策", c.decisions.map((d) => d.title));
  if (c.decision_assessments.length) {
    section(
      "决策评估",
      c.decision_assessments.map(
        (a) => `${a.decision_id ? `\`${a.decision_id.slice(0, 8)}\` ` : ""}${a.assessment}（置信度 ${(a.confidence * 100).toFixed(0)}%，模型 ${a.model}）`,
      ),
    );
  }
  section("风险", c.risks.map((r) => r.title));
  section("下一步行动", c.next_actions.map((a) => a.title));

  out.push("---");
  out.push("");
  out.push(`*生成时间：${humanTime(record.created_at)} ｜ 生成者：${record.generated_by}*`);
  return out.join("\n");
}
