/**
 * 任务中心（FR-08）：AI 与用户创建的任务统一管理。
 *
 * 能力：按逾期/今天/本周分组、状态与优先级筛选、行内切换状态与优先级、
 * 新建任务、删除（带确认）、跳回来源内容（provenance 可追溯）。
 */
import { Notice, WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import {
  badge, card, cardHeader, confirm, emptyState, groupTasks, iconEl, openForm,
  priorityBadge, sectionHeader, statCards, statusBadge,
} from "./components";
import { taskStats } from "../core/tasks";
import type { Task, TaskPriority, TaskStatus } from "../core/models";

export class TaskView extends ProsView {
  private statusFilter: TaskStatus | "open" | "all" = "open";
  private priorityFilter: TaskPriority | "" = "";

  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.tasks, "资源管家 · 任务中心", "check-square");
  }

  protected buildToolbar(header: HTMLElement): void {
    const bar = header.createDiv({ cls: "pros-toolbar" });
    const add = bar.createEl("button", { cls: "mod-cta" });
    add.appendChild(iconEl("plus"));
    add.createSpan({ text: "新建任务" });
    add.addEventListener("click", () => void this.newTask());

    const tabs = header.createDiv({ cls: "pros-tabs" });
    const opts: [TaskStatus | "open" | "all", string][] = [
      ["open", "未完成"], ["todo", "待办"], ["doing", "进行中"], ["done", "已完成"], ["all", "全部"],
    ];
    for (const [v, label] of opts) {
      const t = tabs.createEl("button", { text: label, cls: this.statusFilter === v ? "is-active" : "" });
      t.addEventListener("click", () => {
        this.statusFilter = v;
        void this.refresh();
      });
    }
  }

  protected async render(): Promise<void> {
    const all = await this.plugin.bridge.tasks({ status: "all", limit: 2000 });

    // 统计（复用自己的确定性统计函数，逻辑与 Python Core 一致）
    const fakeStore = { tasks: all } as unknown as Parameters<typeof taskStats>[0];
    const st = taskStats(fakeStore);
    statCards(this.body, [
      { label: "待办", value: st.open, tone: "info" },
      { label: "进行中", value: st.doing, tone: "warn" },
      { label: "已完成", value: st.done, tone: "ok" },
      { label: "已逾期", value: st.overdue, tone: st.overdue ? "danger" : "ok" },
      { label: "今天到期", value: st.dueToday, tone: st.dueToday ? "warn" : "ok" },
    ]);

    // 优先级筛选
    const filters = this.body.createDiv({ cls: "pros-filters" });
    const prio = filters.createEl("select");
    prio.createEl("option", { text: "全部优先级", value: "" });
    for (const p of ["P0", "P1", "P2", "P3"]) prio.createEl("option", { text: p, value: p });
    prio.value = this.priorityFilter;
    prio.addEventListener("change", () => {
      this.priorityFilter = prio.value as TaskPriority | "";
      void this.refresh();
    });
    filters.createSpan({ cls: "pros-muted", text: "任务由内容自动提取或手动创建；AI 创建的任务带「AI 创建」标记" });

    const rows = all.filter((t) => {
      if (this.priorityFilter && t.priority !== this.priorityFilter) return false;
      if (this.statusFilter === "open") return t.status === "todo" || t.status === "doing";
      if (this.statusFilter === "all") return true;
      return t.status === this.statusFilter;
    });

    if (!rows.length) {
      emptyState(this.body, "check-circle", "没有符合条件的任务", "任务会在内容被 AI 整理时自动提取，也可以手动新建。", [
        { label: "新建任务", onClick: () => void this.newTask(), cta: true },
      ]);
      return;
    }

    // 未完成按时间分组；已完成/取消单列
    if (this.statusFilter === "open" || this.statusFilter === "todo" || this.statusFilter === "doing") {
      for (const g of groupTasks(rows)) {
        const sec = this.body.createDiv({ cls: "pros-panel" });
        sectionHeader(sec, `${g.label}（${g.items.length}）`);
        for (const t of g.items) this.renderTask(sec, t);
      }
    } else {
      const sec = this.body.createDiv({ cls: "pros-panel" });
      sectionHeader(sec, `任务（${rows.length}）`);
      for (const t of rows) this.renderTask(sec, t);
    }
  }

  private renderTask(parent: HTMLElement, t: Task): void {
    const c = card(parent, "pros-card-compact");
    const { right } = cardHeader(c, t.title, [
      priorityBadge(t.priority),
      statusBadge(t.status),
      badge(t.due_at ? `截止 ${t.due_at.slice(0, 10)}` : "无截止", "default"),
      t.created_by_agent ? badge("AI 创建", "ai") : badge("手动创建", "ok"),
      t.project ? badge(`项目：${t.project}`, "info") : null,
      t.assignee ? badge(`@${t.assignee}`, "default") : null,
    ].filter(Boolean) as HTMLElement[]);

    if (t.source_object_id) {
      const link = c.createEl("button", { text: "查看来源内容 →", cls: "pros-link-btn" });
      link.addEventListener("click", () => this.plugin.openObject(t.source_object_id!));
    }
    const prov = t.provenance ?? {};
    if (prov["span"] || prov["processor"]) {
      c.createEl("p", {
        cls: "pros-muted pros-prov",
        text: `证据：${prov["processor"] ? `处理器 ${String(prov["processor"])}` : "本地规则"}${
          prov["span"] ? ` ｜ 原文偏移 ${JSON.stringify(prov["span"])}` : ""
        }`,
      });
    }

    const st = right.createEl("select", { cls: "pros-inline-select" });
    for (const s of ["todo", "doing", "done", "cancelled"] as TaskStatus[]) {
      st.createEl("option", { text: { todo: "待办", doing: "进行中", done: "已完成", cancelled: "已取消" }[s], value: s });
    }
    st.value = t.status;
    st.addEventListener("change", async () => {
      await this.plugin.bridge.setTaskStatus(t.id, st.value as TaskStatus);
      new Notice("已更新状态");
      this.plugin.emit("data-changed", { reason: "task-status" });
    });

    const pr = right.createEl("select", { cls: "pros-inline-select" });
    for (const p of ["P0", "P1", "P2", "P3"] as TaskPriority[]) pr.createEl("option", { text: p, value: p });
    pr.value = t.priority;
    pr.addEventListener("change", async () => {
      await this.plugin.bridge.setTaskPriority(t.id, pr.value as TaskPriority);
      new Notice("已更新优先级");
      this.plugin.emit("data-changed", { reason: "task-priority" });
    });

    const del = right.createEl("button", { text: "删除", cls: "mod-warning" });
    del.addEventListener("click", async () => {
      if (this.plugin.settings.ui.confirmDelete) {
        const ok = await confirm(this.plugin.app, {
          title: "确认删除任务？",
          message: `「${t.title}」将被删除（审计记录保留，可通过审计中心回滚恢复）。`,
          cta: "删除",
          danger: true,
        });
        if (!ok) return;
      }
      await this.plugin.bridge.deleteTask(t.id);
      new Notice("任务已删除");
      this.plugin.emit("data-changed", { reason: "task-delete" });
    });
  }

  private async newTask(): Promise<void> {
    await openForm(this.plugin.app, {
      title: "新建任务",
      fields: [
        { key: "title", label: "任务标题", required: true, placeholder: "例如：整理本周会议纪要" },
        { key: "due_at", label: "截止日期", type: "date" },
        { key: "priority", label: "优先级", type: "dropdown", value: "P2", options: ["P0", "P1", "P2", "P3"].map((p) => ({ value: p, label: p })) },
        { key: "project", label: "所属项目", placeholder: "可选" },
        { key: "assignee", label: "负责人", placeholder: "可选" },
      ],
      cta: "创建",
      onSubmit: async (v) => {
        await this.plugin.bridge.createTask({
          title: String(v.title),
          due_at: String(v.due_at || "") || null,
          priority: v.priority as TaskPriority,
          project: String(v.project || "") || null,
          assignee: String(v.assignee || "") || null,
        });
        new Notice("任务已创建");
        this.plugin.emit("data-changed", { reason: "task-create" });
      },
    });
  }
}
