/**
 * 对象详情（FR-08 对象详情：正文 + Related + Backlinks + 关系审核 + 编辑 + 生命周期）。
 *
 * 这一页是「事实分层（NFR-03）」最直观的落点：
 *  · 顶部用 origin 徽标明确标注这条内容是原始事实 / 用户编辑 / AI 提取 / AI 推断 / AI 建议；
 *  · AI 产出的关系一律以 `suggested` 状态出现，需要用户点「确认 / 拒绝」才生效；
 *  · 疑似重复（duplicate_of）只提示、不自动合并；
 *  · 删除走软删除（回收站），随时可恢复；所有变更都能在本页跳到审计与回滚。
 */
import { WorkspaceLeaf, Notice } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import {
  badge, card, cardHeader, emptyState, fmtTime, kvList, labelForRelation,
  originBadge, priorityBadge, ProgressNotice, sectionHeader, statusBadge, typeBadge,
} from "./components";
import {
  OBJECT_TYPE_LABELS, type ObjectType, type Origin, type ProsObject, type Relation, type RelationStatus,
} from "../core/models";

/** 生命周期标签（含回收站）。 */
const LIFECYCLE_LABELS: Record<ProsObject["lifecycle"], string> = {
  inbox: "Inbox 待处理", processed: "已处理", archived: "已归档", deleted: "回收站",
};

const ORIGIN_HINTS: Record<Origin, string> = {
  raw: "原样保存，未被任何 AI 改写",
  user_edit: "由你直接编辑过",
  ai_extracted: "由 AI 从原文中提取（可回溯 span）",
  ai_inferred: "由 AI 推断得出，非原文陈述",
  ai_suggested: "AI 的建议，需你审核后生效",
};

export class ObjectView extends ProsView {
  private objectId: string | null = null;
  private showRaw = false;
  /** 引用跳回时高亮的精确原文（诚实降级：不做假的行号定位）。 */
  private highlight: { start: number; end: number; exact: string } | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.object, "资源管家 · 对象详情", "file-text");
  }

  /** 由外部（列表点击 / 引用跳转）设置当前对象。 */
  public setObject(id: string | null, highlight?: { start: number; end: number; exact: string } | null): void {
    this.objectId = id;
    this.showRaw = false;
    this.highlight = highlight ?? null;
    if (this.body) void this.refresh();
  }

  public get currentId(): string | null {
    return this.objectId;
  }

  protected buildToolbar(header: HTMLElement): void {
    const bar = header.createDiv({ cls: "pros-toolbar" });
    const back = bar.createEl("button", { text: "← Inbox" });
    back.addEventListener("click", () => void this.plugin.activateView(VIEW_TYPES.inbox));
    const refresh = bar.createEl("button", { text: "刷新" });
    refresh.addEventListener("click", () => void this.refresh());
  }

  protected async render(): Promise<void> {
    if (!this.objectId) {
      emptyState(
        this.body,
        "file-text",
        "未选择对象",
        "从 Inbox、检索结果或引用列表点击一条内容，就会在这里展开它的正文、关系与变更历史。",
        [{ label: "去 Inbox", onClick: () => void this.plugin.activateView(VIEW_TYPES.inbox), cta: true }],
      );
      return;
    }

    const obj = await this.plugin.bridge.object(this.objectId);
    if (!obj) {
      emptyState(this.body, "alert-triangle", "对象不存在", `id=${this.objectId} 没有找到对应记录（可能已被物理移除）。`);
      return;
    }

    this.renderHeader(obj);
    this.renderActions(obj);
    this.renderMeta(obj);
    this.renderContent(obj);

    const rel = await this.plugin.bridge.relationsOf(obj.id);
    this.renderRelations(obj, rel.out, rel.in);

    const tasks = await this.plugin.bridge.tasks({ sourceObjectId: obj.id, status: "all" });
    if (tasks.length) this.renderTasks(tasks);

    await this.renderHistory(obj.id);
  }

  // ------------------------------------------------------------- 头部与操作 ---

  private renderHeader(obj: ProsObject): void {
    const head = this.body.createDiv({ cls: "pros-detail-head" });
    const titleRow = head.createDiv({ cls: "pros-detail-title-row" });
    titleRow.createEl("h3", { text: obj.title, cls: "pros-detail-title" });
    const badges = titleRow.createDiv({ cls: "pros-detail-badges" });
    badges.appendChild(typeBadge(obj.type, OBJECT_TYPE_LABELS[obj.type as ObjectType] ?? obj.type));
    badges.appendChild(originBadge(obj.origin));
    badges.appendChild(
      badge(
        LIFECYCLE_LABELS[obj.lifecycle],
        obj.lifecycle === "deleted" ? "danger" : obj.lifecycle === "inbox" ? "warn" : "ok",
      ),
    );
    badges.appendChild(
      badge(
        obj.data_class === "private" ? "private · 禁止外发" : obj.data_class,
        obj.data_class === "private" ? "danger" : obj.data_class === "public" ? "ok" : "default",
      ),
    );
    head.createDiv({ cls: "pros-muted", text: `来源标记：${ORIGIN_HINTS[obj.origin] ?? obj.origin}` });
  }

  private renderActions(obj: ProsObject): void {
    const row = this.body.createDiv({ cls: "pros-action-row" });

    const note = row.createEl("button", { text: "打开笔记" });
    note.addEventListener("click", () => void this.openNote(obj.id));

    const edit = row.createEl("button", { text: "编辑字段" });
    edit.addEventListener("click", () => void this.editFields(obj));

    const editContent = row.createEl("button", { text: "编辑原文" });
    editContent.addEventListener("click", () => void this.editContent(obj));

    if (obj.lifecycle !== "deleted") {
      const process = row.createEl("button", { text: "重新处理", cls: "mod-cta" });
      process.addEventListener("click", () => void this.reprocess(obj.id));

      const archive = row.createEl("button", {
        text: obj.lifecycle === "archived" ? "取消归档" : "归档",
      });
      archive.addEventListener("click", () => void this.setLifecycle(obj, obj.lifecycle === "archived" ? "processed" : "archived"));

      const del = row.createEl("button", { text: "删除（进回收站）", cls: "mod-warning" });
      del.addEventListener("click", () => void this.remove(obj));
    } else {
      const restore = row.createEl("button", { text: "从回收站恢复", cls: "mod-cta" });
      restore.addEventListener("click", () => void this.restore(obj));
    }

    if (obj.source_uri) {
      const src = row.createEl("a", { cls: "pros-link", text: "打开原始链接" });
      src.setAttr("href", obj.source_uri);
      src.setAttr("target", "_blank");
      src.setAttr("rel", "noopener");
    }

    const hist = row.createEl("button", { text: "该对象的变更历史" });
    hist.addEventListener("click", () => void this.plugin.openAuditFor(obj.id));
  }

  // ---------------------------------------------------------------- 元信息 ---

  private renderMeta(obj: ProsObject): void {
    const box = card(this.body);
    cardHeader(box, "元信息");
    kvList(box, [
      ["对象 ID", obj.id],
      ["类型", OBJECT_TYPE_LABELS[obj.type as ObjectType] ?? obj.type],
      ["内容哈希", obj.content_hash.slice(0, 24)],
      ["置信度", obj.confidence.toFixed(2)],
      ["来源地址", obj.source_uri ?? "—"],
      ["采集时间", fmtTime(obj.created_at)],
      ["更新时间", fmtTime(obj.updated_at)],
      ["事件时间", obj.event_time_start ? `${obj.event_time_start}${obj.event_time_end ? ` → ${obj.event_time_end}` : ""}` : "—"],
    ]);
    if (obj.tags.length) {
      const row = box.createDiv({ cls: "pros-tag-row" });
      for (const t of obj.tags) row.createSpan({ cls: "pros-tag", text: `#${t}` });
    }
    const props = Object.entries(obj.properties ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (props.length) {
      const det = box.createEl("details", { cls: "pros-details" });
      det.createEl("summary", { text: `附加属性（${props.length}）` });
      det.createEl("pre", { cls: "pros-pre", text: props.map(([k, v]) => `${k}: ${fmtVal(v)}`).join("\n") });
    }
    const prov = Object.entries(obj.provenance ?? {});
    if (prov.length) {
      const det = box.createEl("details", { cls: "pros-details" });
      det.createEl("summary", { text: "来源追溯（provenance）" });
      det.createEl("pre", { cls: "pros-pre", text: prov.map(([k, v]) => `${k}: ${fmtVal(v)}`).join("\n") });
    }
  }

  // ------------------------------------------------------------------ 正文 ---

  private renderContent(obj: ProsObject): void {
    const box = card(this.body, "pros-content-card");
    const { right } = cardHeader(box, "原文", [
      badge(`${obj.content.length} 字符`, "default"),
      badge(obj.origin === "raw" ? "未被 AI 改写" : "已编辑", obj.origin === "raw" ? "ok" : "warn"),
    ]);
    const toggle = right.createEl("button", { text: this.showRaw ? "只看开头" : "展开全文" });
    toggle.addEventListener("click", () => {
      this.showRaw = !this.showRaw;
      void this.refresh();
    });

    const body = box.createEl("pre", { cls: "pros-content" });
    const limit = this.showRaw ? obj.content.length : 1200;
    const rendered =
      obj.content.length > limit
        ? `${obj.content.slice(0, limit)}\n\n…（共 ${obj.content.length} 字符，点击「展开全文」查看）`
        : obj.content;

    // 引用跳回：把精确切片高亮出来并滚动到可见位置（找不到就安静降级为普通展示）
    const hit = this.highlight?.exact ? rendered.indexOf(this.highlight.exact) : -1;
    if (hit >= 0 && this.highlight) {
      const exact = this.highlight.exact;
      body.appendChild(document.createTextNode(rendered.slice(0, hit)));
      const mark = body.createEl("mark", { cls: "pros-hl", text: exact });
      body.appendChild(document.createTextNode(rendered.slice(hit + exact.length)));
      window.setTimeout(() => mark.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
    } else {
      body.setText(rendered);
    }
  }

  // -------------------------------------------------------------- 关系区块 ---

  private renderRelations(obj: ProsObject, out: (Relation & { peerTitle?: string })[], inn: (Relation & { peerTitle?: string })[]): void {
    const pending = [...out, ...inn].filter((r) => r.status === "suggested");

    const head = sectionHeader(
      this.body,
      "关系",
      "AI 只会提出建议（suggested），确认后才生效；duplicate_of 仅提示，不会自动合并。",
    );
    if (pending.length) {
      const chip = badge(`待审核 ${pending.length}`, "warn");
      head.appendChild(chip);
    }
    if (!out.length && !inn.length) {
      this.body.createDiv({ cls: "pros-muted", text: "暂无关联关系。处理内容后，Agent 会给出关系建议。" });
      return;
    }

    if (out.length) this.renderRelationList("Related（出边）", out, true);
    if (inn.length) this.renderRelationList("Backlinks（入边）", inn, false);
  }

  private renderRelationList(title: string, list: (Relation & { peerTitle?: string })[], outgoing: boolean): void {
    const box = card(this.body);
    cardHeader(box, `${title}（${list.length}）`);
    const ul = box.createDiv({ cls: "pros-rel-list" });
    for (const r of list) {
      const item = ul.createDiv({ cls: `pros-rel-item is-${r.status}` });
      const left = item.createDiv({ cls: "pros-rel-main" });
      left.createSpan({ cls: "pros-rel-type", text: outgoing ? labelForRelation(r.type) : `${labelForRelation(r.type)}（被指向）` });
      const peer = left.createEl("button", { cls: "pros-link-btn", text: r.peerTitle || `${outgoing ? r.dst_id : r.src_id}`.slice(0, 12) });
      peer.addEventListener("click", () => this.plugin.openObject(outgoing ? r.dst_id : r.src_id));
      left.appendChild(badge(`置信度 ${r.confidence.toFixed(2)}`, "default"));
      left.appendChild(
        badge(
          r.status === "suggested" ? "待审核" : r.status === "confirmed" ? "已确认" : "已拒绝",
          r.status === "suggested" ? "info" : r.status === "confirmed" ? "ok" : "default",
        ),
      );
      if (r.type === "duplicate_of") left.appendChild(badge("仅提示，不合并", "warn"));

      const actions = item.createDiv({ cls: "pros-rel-actions" });
      if (r.status !== "confirmed") {
        const ok = actions.createEl("button", { text: "确认", cls: "mod-cta" });
        ok.addEventListener("click", () => void this.setRelation(r, "confirmed"));
      }
      if (r.status !== "rejected") {
        const no = actions.createEl("button", { text: "拒绝" });
        no.addEventListener("click", () => void this.setRelation(r, "rejected"));
      }
      actions.createSpan({ cls: "pros-muted", text: fmtTime(r.created_at) });
    }
  }

  private async setRelation(r: Relation, status: RelationStatus): Promise<void> {
    try {
      await this.plugin.bridge.setRelationStatus(r.id, status);
      this.plugin.emit("data-changed", { reason: "relation-status" });
      await this.refresh();
    } catch (e) {
      new Notice(`关系更新失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ------------------------------------------------------------ 关联任务 ---

  private renderTasks(tasks: { id: string; title: string; status: string; priority: string; due_at: string | null }[]): void {
    const box = card(this.body);
    cardHeader(box, `由该内容派生的任务（${tasks.length}）`);
    const ul = box.createDiv({ cls: "pros-mini-list" });
    for (const t of tasks) {
      const row = ul.createDiv({ cls: "pros-mini-row" });
      row.createSpan({ text: t.title });
      row.appendChild(statusBadge(t.status as never));
      row.appendChild(priorityBadge(t.priority as never));
      row.createSpan({ cls: "pros-muted", text: t.due_at ? `截止 ${t.due_at.slice(0, 10)}` : "无截止" });
      const go = row.createEl("button", { text: "去任务中心" });
      go.addEventListener("click", () => void this.plugin.activateView(VIEW_TYPES.tasks));
    }
  }

  // -------------------------------------------------------------- 变更历史 ---

  private async renderHistory(objectId: string): Promise<void> {
    const entries = await this.plugin.bridge.audit({ objectId, limit: 20 });
    if (!entries.length) return;
    const box = card(this.body);
    const { right } = cardHeader(box, "最近变更", [badge(`${entries.length} 条`, "default")]);
    const more = right.createEl("button", { text: "查看全部" });
    more.addEventListener("click", () => void this.plugin.openAuditFor(objectId));

    const ul = box.createDiv({ cls: "pros-mini-list" });
    for (const e of entries) {
      const row = ul.createDiv({ cls: "pros-mini-row" });
      row.appendChild(badge(e.op, e.op === "create" ? "ok" : e.op === "update" ? "info" : e.op === "delete" ? "danger" : "warn"));
      row.createSpan({ text: e.actor });
      row.createSpan({ cls: "pros-muted", text: fmtTime(e.created_at) });
    }
  }

  // ---------------------------------------------------------------- 操作实现 ---

  private async openNote(id: string): Promise<void> {
    const path = await this.plugin.bridge.notePathOf(id);
    if (!path) return void new Notice("该对象还没有对应的笔记文件（可能采集时关闭了写笔记）");
    await this.plugin.app.workspace.openLinkText(path, "", false);
  }

  private async editFields(obj: ProsObject): Promise<void> {
    await this.plugin.openForm({
      title: "编辑字段",
      description: "原文不会被这里改写；如需修改正文请用「编辑原文」。改动会写入审计，可回滚。",
      fields: [
        { key: "title", label: "标题", value: obj.title, required: true },
        {
          key: "type",
          label: "类型",
          type: "dropdown",
          value: obj.type,
          options: Object.entries(OBJECT_TYPE_LABELS).map(([value, label]) => ({ value, label })),
        },
        { key: "tags", label: "标签", value: obj.tags.join(", "), description: "逗号分隔" },
        {
          key: "data_class",
          label: "数据分级",
          type: "dropdown",
          value: obj.data_class,
          options: [
            { value: "public", label: "public（允许外发）" },
            { value: "internal", label: "internal" },
            { value: "private", label: "private（禁止外发）" },
          ],
        },
        { key: "event_time_start", label: "事件开始时间", type: "date", value: obj.event_time_start ?? undefined },
      ],
      onSubmit: async (v) => {
        await this.plugin.bridge.updateObject(obj.id, {
          title: String(v.title),
          type: v.type as ProsObject["type"],
          tags: String(v.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          data_class: v.data_class as ProsObject["data_class"],
          event_time_start: v.event_time_start ? String(v.event_time_start) : null,
        });
        this.plugin.emit("data-changed", { reason: "object-edit" });
        await this.refresh();
      },
    });
  }

  private async editContent(obj: ProsObject): Promise<void> {
    await this.plugin.openForm({
      title: "编辑原文",
      description: "这是原始事实层：只有你本人可以改写。保存后来源标记会升级为「用户编辑」，改动可回滚。",
      cta: "保存正文",
      fields: [
        { key: "content", label: "正文", type: "textarea", value: obj.content, required: true },
        { key: "note", label: "本次修改备注（可选）", value: "" },
      ],
      onSubmit: async (v) => {
        const content = String(v.content);
        if (content === obj.content) return;
        await this.plugin.bridge.updateObject(obj.id, { content });
        this.plugin.emit("data-changed", { reason: "object-content-edit" });
        await this.refresh();
      },
    });
  }

  private async setLifecycle(obj: ProsObject, lifecycle: ProsObject["lifecycle"]): Promise<void> {
    try {
      await this.plugin.bridge.updateObject(obj.id, { lifecycle });
      this.plugin.emit("data-changed", { reason: "object-lifecycle" });
      await this.refresh();
    } catch (e) {
      new Notice(`更新失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async remove(obj: ProsObject): Promise<void> {
    const ok = await this.plugin.confirm(
      "删除该对象？",
      "将移入回收站（lifecycle=deleted），索引与原件都保留，随时可在审计视图回滚恢复。",
      true,
      obj.title,
    );
    if (!ok) return;
    try {
      await this.plugin.bridge.deleteObject(obj.id);
      this.plugin.emit("data-changed", { reason: "object-delete" });
      new Notice("已移入回收站");
      await this.refresh();
    } catch (e) {
      new Notice(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async restore(obj: ProsObject): Promise<void> {
    try {
      await this.plugin.bridge.restoreObject(obj.id);
      this.plugin.emit("data-changed", { reason: "object-restore" });
      new Notice("已恢复");
      await this.refresh();
    } catch (e) {
      new Notice(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async reprocess(id: string): Promise<void> {
    const prog = new ProgressNotice("重新处理");
    try {
      await this.plugin.processObjectWithFeedback(id, prog);
      this.plugin.emit("data-changed", { reason: "object-reprocess" });
      await this.refresh();
    } catch (e) {
      prog.fail(e);
    }
  }
}

/** 值 → 单行文本（附加属性 / provenance 展示用）。 */
function fmtVal(v: unknown): string {
  if (typeof v === "string") return v.replace(/\s+/g, " ").slice(0, 240);
  if (Array.isArray(v)) return v.map((x) => String(x)).join(", ").slice(0, 240);
  try {
    return JSON.stringify(v).slice(0, 240);
  } catch {
    return String(v);
  }
}
