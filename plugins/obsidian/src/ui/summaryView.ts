/**
 * 阶段总结（FR-10）：日报 / 周报 / 月报 / 自定义区间。
 *
 * 展示十个维度；每条行动建议可一键转 Task；可把总结落盘为 vault 笔记长期归档。
 * 决策评估结果会标注所用模型与置信度（ADR-007：Jev 默认关闭，离线用规则模型）。
 */
import { Notice, WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import { badge, card, cardHeader, emptyState, fmtTime, iconEl, ProgressNotice, sectionHeader } from "./components";
import type { SummaryRecord } from "../core/models";

type Granularity = "daily" | "weekly" | "monthly" | "custom";

export class SummaryView extends ProsView {
  private granularity: Granularity = "weekly";
  private start = "";
  private end = "";
  private current: SummaryRecord | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.summary, "资源管家 · 阶段总结", "file-clock");
  }

  protected buildToolbar(header: HTMLElement): void {
    const bar = header.createDiv({ cls: "pros-toolbar" });
    const gen = bar.createEl("button", { cls: "mod-cta" });
    gen.appendChild(iconEl("play"));
    gen.createSpan({ text: "生成总结" });
    gen.addEventListener("click", () => void this.generate());

    const save = bar.createEl("button");
    save.appendChild(iconEl("save"));
    save.createSpan({ text: "保存为笔记" });
    save.addEventListener("click", () => void this.save());

    const tabs = header.createDiv({ cls: "pros-tabs" });
    const opts: [Granularity, string][] = [
      ["daily", "日报"], ["weekly", "周报"], ["monthly", "月报"], ["custom", "自定义"],
    ];
    for (const [v, label] of opts) {
      const t = tabs.createEl("button", { text: label, cls: this.granularity === v ? "is-active" : "" });
      t.addEventListener("click", () => {
        this.granularity = v;
        void this.refresh();
      });
    }
  }

  protected async render(): Promise<void> {
    // 区间选择
    const filters = this.body.createDiv({ cls: "pros-filters" });
    if (this.granularity === "custom") {
      const s = filters.createEl("input", { type: "date" });
      s.value = this.start;
      s.addEventListener("change", () => (this.start = s.value));
      filters.createSpan({ text: "→", cls: "pros-muted" });
      const e = filters.createEl("input", { type: "date" });
      e.value = this.end;
      e.addEventListener("change", () => (this.end = e.value));
    } else {
      filters.createSpan({
        cls: "pros-muted",
        text: { daily: "统计今天", weekly: "统计本周（周一至周日）", monthly: "统计本月" }[this.granularity] ?? "",
      });
    }

    // 历史总结列表
    const history = await this.plugin.bridge.summaries();
    const histPanel = this.body.createDiv({ cls: "pros-panel" });
    sectionHeader(histPanel, "历史总结", `共 ${history.length} 份（点击查看）`);
    if (!history.length) {
      histPanel.createEl("p", { cls: "pros-muted", text: "还没有生成过总结。" });
    } else {
      const row = histPanel.createDiv({ cls: "pros-chip-row" });
      for (const h of history.slice(0, 20)) {
        const chip = row.createEl("button", { cls: "pros-chip" });
        chip.appendChild(badge({ daily: "日", weekly: "周", monthly: "月", custom: "段" }[h.granularity] ?? "段", "info"));
        chip.createSpan({ text: `${h.range_start} ~ ${h.range_end}` });
        chip.addEventListener("click", () => {
          this.current = h;
          void this.refresh();
        });
      }
    }

    // 当前总结
    const panel = this.body.createDiv({ cls: "pros-panel" });
    if (!this.current) {
      emptyState(panel, "file-clock", "生成你的第一份阶段总结", "总结会覆盖：发生了什么、主题、新发现、已完成、未完成、人物、决策、风险、下一步行动。", [
        { label: "生成总结", onClick: () => void this.generate(), cta: true },
      ]);
      return;
    }
    this.renderSummary(panel, this.current);
  }

  private renderSummary(panel: HTMLElement, s: SummaryRecord): void {
    const c = s.content;
    sectionHeader(panel, `${s.range_start} ~ ${s.range_end}`, `生成于 ${fmtTime(s.created_at)} ｜ ${s.generated_by}`);

    const grid = panel.createDiv({ cls: "pros-summary-grid" });
    const block = (title: string, node: HTMLElement | null, count?: number) => {
      const box = grid.createDiv({ cls: "pros-summary-block" });
      const h = box.createDiv({ cls: "pros-summary-block-title" });
      h.createSpan({ text: title });
      if (count !== undefined) h.appendChild(badge(String(count), count ? "info" : "default"));
      if (node) box.appendChild(node);
      else box.createEl("p", { cls: "pros-muted", text: "（无）" });
    };

    const ul = (items: string[], onOpen?: (i: number) => void) => {
      if (!items.length) return null;
      const l = document.createElement("ul");
      l.addClass("pros-summary-list");
      items.forEach((text, i) => {
        const li = l.createEl("li");
        if (onOpen) {
          const b = li.createEl("button", { cls: "pros-link-btn", text });
          b.addEventListener("click", () => onOpen(i));
        } else {
          li.setText(text);
        }
      });
      return l;
    };

    block("发生了什么", ul(c.what_happened.map((o) => o.title), (i) => this.plugin.openObject(c.what_happened[i].id)), c.what_happened.length);
    block("主题", c.themes.length ? buildTags(c.themes) : null, c.themes.length);
    block("新发现", ul(c.discoveries.map((o) => o.title), (i) => this.plugin.openObject(c.discoveries[i].id)), c.discoveries.length);
    block("已完成", ul(c.completed.map((t) => t.title)), c.completed.length);
    block("未完成", ul(c.pending.map((t) => `${t.title}${t.due_at ? `（截止 ${t.due_at}）` : ""}`)), c.pending.length);
    block("人物", c.people.length ? buildTags(c.people) : null, c.people.length);
    block("决策", ul(c.decisions.map((d) => d.title), (i) => this.plugin.openObject(c.decisions[i].id)), c.decisions.length);
    block("风险", ul(c.risks.map((r) => r.title), (i) => this.plugin.openObject(c.risks[i].id)), c.risks.length);

    // 决策评估
    if (c.decision_assessments.length) {
      const box = grid.createDiv({ cls: "pros-summary-block pros-span-2" });
      box.createDiv({ cls: "pros-summary-block-title", text: "决策评估（可插拔 Decision Model）" });
      for (const a of c.decision_assessments) {
        const row = box.createDiv({ cls: "pros-decision" });
        row.appendChild(badge(a.model === "null" ? "未配置模型" : a.model, a.model === "null" ? "warn" : "ai"));
        row.createSpan({ text: a.assessment });
        row.appendChild(badge(`置信度 ${(a.confidence * 100).toFixed(0)}%`, "default"));
      }
    }

    // 下一步行动（可一键转任务）
    const actBox = grid.createDiv({ cls: "pros-summary-block pros-span-2" });
    actBox.createDiv({ cls: "pros-summary-block-title", text: "下一步行动（可一键转为任务）" });
    for (const a of c.next_actions) {
      const row = actBox.createDiv({ cls: "pros-action-row" });
      row.appendChild(badge(a.kind, a.kind === "overdue" ? "danger" : a.kind === "triage" ? "warn" : "info"));
      row.createSpan({ text: a.title, cls: "pros-action-title" });
      if (a.task_id) {
        const open = row.createEl("button", { text: "查看任务" });
        open.addEventListener("click", () => this.plugin.openObject(a.task_id!));
      } else {
        const toTask = row.createEl("button", { text: "转为任务", cls: "mod-cta" });
        toTask.addEventListener("click", async () => {
          await this.plugin.bridge.actionToTask(a, s.id);
          new Notice(`已创建任务：${a.title}`);
          this.plugin.emit("data-changed", { reason: "summary-action-task" });
        });
      }
    }

    block("统计", null);
    const statBox = grid.lastElementChild as HTMLElement;
    statBox.empty();
    statBox.createDiv({ cls: "pros-summary-block-title", text: "统计" });
    statBox.createEl("p", {
      cls: "pros-muted",
      text: `新增内容 ${c.stats.objects} 条 ｜ 新建任务 ${c.stats.tasks_created} 项 ｜ 类型分布：${
        Object.entries(c.stats.by_type).map(([k, v]) => `${k} ${v}`).join("、") || "无"
      }`,
    });

    // 预览 Markdown
    const details = panel.createEl("details", { cls: "pros-details" });
    details.createEl("summary", { text: "查看 Markdown 预览（可保存为笔记）" });
    void this.plugin.bridge.renderSummary(s).then((md) => {
      details.createEl("pre", { cls: "pros-pre", text: md.slice(0, 6000) });
    });
  }

  private async generate(): Promise<void> {
    if (this.granularity === "custom" && (!this.start || !this.end)) {
      new Notice("请先选择起止日期");
      return;
    }
    const prog = new ProgressNotice("生成总结");
    const pid = this.plugin.beginTask("生成阶段总结…");
    try {
      const rec = await this.plugin.bridge.summarize(
        {
          granularity: this.granularity,
          start: this.granularity === "custom" ? this.start : undefined,
          end: this.granularity === "custom" ? this.end : undefined,
        },
        (m) => prog.update(m),
      );
      this.current = rec;
      prog.done(`覆盖 ${rec.content.stats.objects} 条内容`);
      this.plugin.emit("data-changed", { reason: "summary" });
    } catch (e) {
      prog.fail(e);
    } finally {
      this.plugin.endTask(pid);
    }
  }

  private async save(): Promise<void> {
    if (!this.current) {
      new Notice("请先生成总结");
      return;
    }
    const path = await this.plugin.bridge.saveSummaryToVault(this.current);
    new Notice(`已保存到 ${path}`);
    await this.plugin.app.workspace.openLinkText(path, "", false);
  }
}

function buildTags(items: string[]): HTMLElement {
  const row = document.createElement("div");
  row.addClass("pros-tag-row");
  for (const t of items) row.createSpan({ cls: "pros-tag", text: t.startsWith("#") ? t : `#${t}` });
  return row;
}
