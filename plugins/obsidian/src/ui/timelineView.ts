/**
 * 时间线（FR-08 时间线视图）。
 *
 * 用途：把「什么时候收了什么、什么时候发生了什么」摊在一根时间轴上，
 * 便于复盘（这也是阶段总结 summarizer 的输入来源之一）。
 *
 * 排序口径说明：
 *  · 默认按 `created_at`（采集/入库时间）倒序 —— 这是索引库真正可靠的时间戳；
 *  · 若对象带 `event_time_start`（事件真实发生时间），会在条目上额外标注，供人工对照；
 *  · 时间分组按本地时区切天，避免 UTC 跨日导致「今天的内容跑到昨天」。
 */
import { WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import { badge, card, cardHeader, emptyState, originBadge, typeBadge } from "./components";
import { OBJECT_TYPE_LABELS, type ObjectType, type ProsObject } from "../core/models";

type Range = "7d" | "30d" | "90d" | "all";

export class TimelineView extends ProsView {
  private range: Range = "30d";
  private typeFilter = "all";
  private includeDeleted = false;

  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.timeline, "资源管家 · 时间线", "clock");
  }

  protected buildToolbar(header: HTMLElement): void {
    const bar = header.createDiv({ cls: "pros-toolbar" });

    const rangeSel = bar.createEl("select");
    for (const [v, l] of [["7d", "最近 7 天"], ["30d", "最近 30 天"], ["90d", "最近 90 天"], ["all", "全部"]] as [Range, string][]) {
      rangeSel.createEl("option", { text: l, value: v });
    }
    rangeSel.value = this.range;
    rangeSel.addEventListener("change", () => {
      this.range = rangeSel.value as Range;
      void this.refresh();
    });

    const typeSel = bar.createEl("select");
    typeSel.createEl("option", { text: "全部类型", value: "all" });
    for (const [v, l] of Object.entries(OBJECT_TYPE_LABELS)) typeSel.createEl("option", { text: l, value: v });
    typeSel.value = this.typeFilter;
    typeSel.addEventListener("change", () => {
      this.typeFilter = typeSel.value;
      void this.refresh();
    });

    const delLabel = bar.createEl("label", { cls: "pros-check-inline" });
    const delCb = delLabel.createEl("input", { type: "checkbox" });
    delCb.checked = this.includeDeleted;
    delLabel.createSpan({ text: "包含回收站" });
    delCb.addEventListener("change", () => {
      this.includeDeleted = delCb.checked;
      void this.refresh();
    });

    const refresh = bar.createEl("button", { text: "刷新" });
    refresh.addEventListener("click", () => void this.refresh());
  }

  protected async render(): Promise<void> {
    const start = this.rangeStart();
    const rows = await this.plugin.bridge.objects({
      lifecycle: this.includeDeleted ? "all" : undefined,
      types: this.typeFilter === "all" ? undefined : [this.typeFilter],
      start,
      limit: 2000,
      orderBy: "created_desc",
    });
    const items = rows.filter((o) => this.includeDeleted || o.lifecycle !== "deleted");

    const bar = this.body.createDiv({ cls: "pros-statusbar" });
    bar.appendChild(badge(`共 ${items.length} 条`, "default"));
    bar.appendChild(badge(rangeLabel(this.range), "info"));
    const types = new Set(items.map((o) => o.type));
    bar.appendChild(badge(`覆盖 ${types.size} 种类型`, "default"));

    if (!items.length) {
      emptyState(
        this.body,
        "clock",
        "这段时间还没有内容",
        "换个时间范围看看，或者先去采集一些内容。",
        [
          { label: "快速记录", onClick: () => this.plugin.openCapture(), cta: true },
          { label: "采集链接", onClick: () => this.plugin.openLinkIngest() },
        ],
      );
      return;
    }

    // 按本地日期分组
    const groups = new Map<string, ProsObject[]>();
    for (const o of items) {
      const day = localDay(o.created_at);
      const arr = groups.get(day);
      if (arr) arr.push(o);
      else groups.set(day, [o]);
    }

    for (const [day, list] of groups) {
      const box = card(this.body, "pros-timeline-group");
      cardHeader(box, day, [badge(`${list.length} 条`, "default")]);
      const ul = box.createDiv({ cls: "pros-timeline" });
      for (const o of list) this.renderItem(ul, o);
    }
  }

  private renderItem(container: HTMLElement, o: ProsObject): void {
    const row = container.createDiv({ cls: "pros-timeline-item" });
    row.createDiv({ cls: "pros-timeline-dot" });
    const time = row.createDiv({ cls: "pros-timeline-time", text: timeOf(o.created_at) });

    const main = row.createDiv({ cls: "pros-timeline-main" });
    const titleRow = main.createDiv({ cls: "pros-timeline-title" });
    const btn = titleRow.createEl("button", { cls: "pros-link-btn", text: o.title });
    btn.addEventListener("click", () => this.plugin.openObject(o.id));
    titleRow.appendChild(typeBadge(o.type, OBJECT_TYPE_LABELS[o.type as ObjectType] ?? o.type));
    titleRow.appendChild(originBadge(o.origin));
    if (o.lifecycle === "deleted") titleRow.appendChild(badge("回收站", "danger"));
    else if (o.lifecycle === "inbox") titleRow.appendChild(badge("待处理", "warn"));

    const snippet = o.content.replace(/\s+/g, " ").slice(0, 140);
    if (snippet) main.createDiv({ cls: "pros-timeline-snippet", text: snippet });

    const meta = main.createDiv({ cls: "pros-timeline-meta" });
    if (o.event_time_start) {
      meta.createSpan({ cls: "pros-muted", text: `事件时间：${o.event_time_start.slice(0, 16).replace("T", " ")}` });
    }
    if (o.source_uri) meta.createSpan({ cls: "pros-muted", text: `来源：${shorten(o.source_uri)}` });
    if (o.tags.length) meta.createSpan({ cls: "pros-muted", text: o.tags.map((t) => `#${t}`).join(" ") });
  }

  private rangeStart(): string | undefined {
    if (this.range === "all") return undefined;
    const days = this.range === "7d" ? 7 : this.range === "30d" ? 30 : 90;
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
  }
}

function rangeLabel(r: Range): string {
  return { "7d": "最近 7 天", "30d": "最近 30 天", "90d": "最近 90 天", all: "全部时间" }[r];
}

/** 本地时区的 YYYY-MM-DD。 */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function shorten(uri: string): string {
  const s = uri.replace(/^https?:\/\//, "");
  return s.length > 48 ? `${s.slice(0, 48)}…` : s;
}
