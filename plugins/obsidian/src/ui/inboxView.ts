/**
 * Inbox 视图（FR-02 / FR-05）：所有新内容的第一落点。
 *
 * 能力：
 *  · 列表 + 类型/标签筛选 + 生命周期切换（Inbox / 已整理 / 归档 / 回收站）；
 *  · 批量选择 → 批量处理 / 归档 / 软删除（高风险动作二次确认）；
 *  · 拖拽文件到视图内即采集（文件拖入入口）；
 *  · 单条「处理 / 打开笔记 / 删除」。
 */
import { Notice, TFile, WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import {
  badge, card, cardHeader, confirm, emptyState, fmtRelative, iconEl, originBadge,
  ProgressNotice, sectionHeader, tagRow, typeBadge,
} from "./components";
import { OBJECT_TYPE_LABELS, type ProsObject } from "../core/models";

type LifecycleFilter = "inbox" | "processed" | "archived" | "deleted" | "all";

export class InboxView extends ProsView {
  private lifecycle: LifecycleFilter = "inbox";
  private typeFilter = "";
  private tagFilter = "";
  private selected = new Set<string>();
  private query = "";

  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.inbox, "资源管家 · Inbox", "inbox");
  }

  protected buildToolbar(header: HTMLElement): void {
    const bar = header.createDiv({ cls: "pros-toolbar" });
    const mk = (icon: string, label: string, fn: () => void, cta = false) => {
      const b = bar.createEl("button", { cls: cta ? "mod-cta" : "" });
      b.appendChild(iconEl(icon));
      b.createSpan({ text: label });
      b.addEventListener("click", fn);
    };
    mk("plus", "记录", () => this.plugin.openCapture(), true);
    mk("link", "采集链接", () => this.plugin.openLinkIngest());
    mk("zap", "处理全部", () => void this.processAll());

    // 生命周期切换
    const tabs = header.createDiv({ cls: "pros-tabs" });
    const opts: [LifecycleFilter, string][] = [
      ["inbox", "待处理"],
      ["processed", "已整理"],
      ["archived", "已归档"],
      ["deleted", "回收站"],
      ["all", "全部"],
    ];
    for (const [v, label] of opts) {
      const t = tabs.createEl("button", { text: label, cls: this.lifecycle === v ? "is-active" : "" });
      t.addEventListener("click", () => {
        this.lifecycle = v;
        this.selected.clear();
        void this.refresh();
      });
    }
  }

  protected async render(): Promise<void> {
    // 拖拽采集区（文件 drag & drop）
    this.buildDropZone();

    // 筛选条
    const filters = this.body.createDiv({ cls: "pros-filters" });
    const typeSel = filters.createEl("select");
    typeSel.createEl("option", { text: "全部类型", value: "" });
    for (const [k, label] of Object.entries(OBJECT_TYPE_LABELS)) {
      typeSel.createEl("option", { text: label, value: k });
    }
    typeSel.value = this.typeFilter;
    typeSel.addEventListener("change", () => {
      this.typeFilter = typeSel.value;
      void this.refresh();
    });

    const search = filters.createEl("input", { type: "text", placeholder: "在标题/正文中筛选…" });
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      void this.refresh();
    });

    const tagInput = filters.createEl("input", { type: "text", placeholder: "标签筛选（精确）" });
    tagInput.value = this.tagFilter;
    tagInput.addEventListener("change", () => {
      this.tagFilter = tagInput.value.trim();
      void this.refresh();
    });

    const fresh = filters.createEl("button", { text: "重置" });
    fresh.addEventListener("click", () => {
      this.typeFilter = "";
      this.tagFilter = "";
      this.query = "";
      void this.refresh();
    });

    // 拉取数据（筛选在 Store/Core 侧下推，避免全量捞出后在前端过滤）
    const rows = await this.plugin.bridge.objects({
      lifecycle: this.lifecycle,
      types: this.typeFilter ? [this.typeFilter] : undefined,
      tags: this.tagFilter ? [this.tagFilter] : undefined,
      limit: 500,
    });
    const filtered = this.query
      ? rows.filter((o) => `${o.title}\n${o.content}`.toLowerCase().includes(this.query.toLowerCase()))
      : rows;

    const bar = this.body.createDiv({ cls: "pros-listbar" });
    bar.createSpan({ text: `共 ${filtered.length} 条`, cls: "pros-muted" });
    if (this.selected.size) {
      bar.createSpan({ text: `已选 ${this.selected.size} 条`, cls: "pros-muted" });
      bar.createEl("button", { text: "批量处理" }).addEventListener("click", () => void this.batchProcess());
      bar.createEl("button", { text: "批量归档" }).addEventListener("click", () => void this.batchArchive());
      bar.createEl("button", { text: "批量删除", cls: "mod-warning" }).addEventListener("click", () => void this.batchDelete());
      bar.createEl("button", { text: "取消选择" }).addEventListener("click", () => {
        this.selected.clear();
        void this.refresh();
      });
    } else if (filtered.length) {
      bar.createEl("button", { text: "全选" }).addEventListener("click", () => {
        for (const o of filtered) this.selected.add(o.id);
        void this.refresh();
      });
    }

    if (!filtered.length) {
      emptyState(
        this.body,
        "inbox",
        this.lifecycle === "inbox" ? "Inbox 是空的" : "没有匹配的内容",
        "把文件拖到这里、或点击工具栏「记录 / 采集链接」开始。",
        [{ label: "快速记录", onClick: () => this.plugin.openCapture(), cta: true }],
      );
      return;
    }

    const list = this.body.createDiv({ cls: "pros-list" });
    for (const o of filtered) this.renderRow(list, o);
  }

  /** 文件拖入区（FR-01 的「文件拖入」入口）。 */
  private buildDropZone(): void {
    const zone = this.body.createDiv({ cls: "pros-dropzone" });
    zone.appendChild(iconEl("upload-cloud"));
    zone.createSpan({ text: "把文件拖到这里采集（PDF / 图片 / 音视频 / 文本 / zip），或点击选择 vault 内文件" });
    zone.addEventListener("click", () => this.plugin.pickVaultFileToCapture());
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.addClass("is-over");
    });
    zone.addEventListener("dragleave", () => zone.removeClass("is-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.removeClass("is-over");
      const files = (e as DragEvent).dataTransfer?.files;
      if (files?.length) {
        void this.plugin.captureExternalFiles(Array.from(files));
        return;
      }
      // Obsidian 内部拖拽：从 dataTransfer 里取 vault 路径
      const vpath = (e as DragEvent).dataTransfer?.getData("text/plain") ?? "";
      if (vpath) void this.plugin.captureVaultPath(vpath);
      else new Notice("未能识别拖入的对象");
    });
  }

  private renderRow(list: HTMLElement, o: ProsObject): void {
    const c = card(list, this.selected.has(o.id) ? "is-selected" : "");
    const { right } = cardHeader(c, o.title, [
      typeBadge(o.type, OBJECT_TYPE_LABELS[o.type] ?? o.type),
      originBadge(o.origin),
      badge(o.lifecycle, o.lifecycle === "inbox" ? "warn" : o.lifecycle === "deleted" ? "danger" : "ok"),
      badge(fmtRelative(o.created_at), "default"),
      ...(typeof o.properties["ingest_kind"] === "string" ? [badge(`来源：${String(o.properties["ingest_kind"])}`, "info")] : []),
    ]);

    const cb = c.createEl("input", { type: "checkbox", cls: "pros-card-check" });
    cb.checked = this.selected.has(o.id);
    cb.addEventListener("change", () => {
      if (cb.checked) this.selected.add(o.id);
      else this.selected.delete(o.id);
      void this.refresh();
    });

    c.createEl("p", { cls: "pros-card-snippet", text: o.content.replace(/\s+/g, " ").slice(0, 180) });
    if (o.tags.length) tagRow(c, o.tags, (tag) => {
      this.tagFilter = tag;
      void this.refresh();
    });

    // 采集警告 / 处理错误可见（失败安全要求用户能看到失败原因）
    const warnings = Array.isArray(o.properties["warnings"]) ? (o.properties["warnings"] as string[]) : [];
    const ai = (o.properties["ai"] ?? {}) as Record<string, unknown>;
    if (warnings.length) c.createEl("p", { cls: "pros-warn-text", text: `⚠ ${warnings[0]}` });
    if (ai.processing_error) c.createEl("p", { cls: "pros-error-text", text: `处理失败：${String(ai.processing_error)}` });
    if (o.properties["needs_transcript"]) {
      c.createEl("p", { cls: "pros-warn-text", text: "⚠ 尚无逐字稿：连接 Python Core 后可自动转写" });
    }

    const open = right.createEl("button", { text: "打开" });
    open.addEventListener("click", () => this.plugin.openObject(o.id));
    if (o.lifecycle === "inbox" || ai.processing_error) {
      const proc = right.createEl("button", { text: "处理", cls: "mod-cta" });
      proc.addEventListener("click", () => void this.processOne(o.id));
    }
    if (o.lifecycle === "deleted") {
      const restore = right.createEl("button", { text: "恢复" });
      restore.addEventListener("click", async () => {
        await this.plugin.bridge.restoreObject(o.id);
        new Notice("已恢复");
        this.plugin.emit("data-changed", { reason: "restore" });
      });
    } else {
      const del = right.createEl("button", { text: "删除", cls: "mod-warning" });
      del.addEventListener("click", () => void this.deleteOne(o.id, o.title));
    }
  }

  private async processOne(id: string): Promise<void> {
    const prog = new ProgressNotice("处理内容");
    try {
      await this.plugin.processObjectWithFeedback(id, prog);
      this.plugin.emit("data-changed", { reason: "process-one" });
    } catch (e) {
      prog.fail(e);
    }
  }

  private async processAll(): Promise<void> {
    const prog = new ProgressNotice("批量处理 Inbox");
    try {
      const r = await this.plugin.bridge.processInbox({ limit: 50, onProgress: (m) => prog.update(m) });
      const ok = r.filter((x) => x.status === "processed").length;
      prog.done(`${ok}/${r.length} 条成功`);
      this.plugin.emit("data-changed", { reason: "process-all" });
    } catch (e) {
      prog.fail(e);
    }
  }

  private async batchProcess(): Promise<void> {
    const ids = [...this.selected];
    const prog = new ProgressNotice("批量处理");
    let ok = 0;
    for (const id of ids) {
      prog.update(`处理 ${ok + 1}/${ids.length}…`);
      const r = await this.plugin.bridge.processObject(id, (m) => prog.update(m));
      if (r.status === "processed") ok++;
    }
    this.selected.clear();
    prog.done(`${ok}/${ids.length} 条成功`);
    this.plugin.emit("data-changed", { reason: "batch-process" });
  }

  private async batchArchive(): Promise<void> {
    for (const id of [...this.selected]) {
      await this.plugin.bridge.updateObject(id, { lifecycle: "archived" });
    }
    const n = this.selected.size;
    this.selected.clear();
    new Notice(`已归档 ${n} 条`);
    this.plugin.emit("data-changed", { reason: "batch-archive" });
  }

  /** 批量删除强制二次确认（危险操作 + 文档要求：删除走软删除但依然需要确认）。 */
  private async batchDelete(): Promise<void> {
    const ids = [...this.selected];
    if (this.plugin.settings.ui.confirmDelete) {
      const ok = await confirm(this.plugin.app, {
        title: `确认删除 ${ids.length} 条内容？`,
        message: "删除为「软删除」，会进入回收站，可随时恢复；但笔记文件不会被自动删除。",
        detail: ids.map((id) => this.plugin.lastKnownTitle(id) ?? id).join("\n"),
        cta: "确认删除",
        danger: true,
      });
      if (!ok) return;
    }
    for (const id of ids) await this.plugin.bridge.deleteObject(id);
    this.selected.clear();
    new Notice(`已移入回收站 ${ids.length} 条`);
    this.plugin.emit("data-changed", { reason: "batch-delete" });
  }

  private async deleteOne(id: string, title: string): Promise<void> {
    if (this.plugin.settings.ui.confirmDelete) {
      const ok = await confirm(this.plugin.app, {
        title: "确认删除？",
        message: `「${title}」将被移入回收站（软删除，可恢复）。已生成的笔记文件不会被删除。`,
        cta: "移入回收站",
        danger: true,
      });
      if (!ok) return;
    }
    await this.plugin.bridge.deleteObject(id);
    new Notice("已移入回收站");
    this.plugin.emit("data-changed", { reason: "delete" });
  }
}

/** 供 main.ts 复用的文件类型判定（避免重复实现）。 */
export function isCaptureSupported(file: TFile): boolean {
  return !file.extension.includes("/");
}
