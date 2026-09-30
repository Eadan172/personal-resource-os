/**
 * 审计与回滚（FR-09 / ADR-005）。
 *
 * 设计要点（这条视图是「一切变更可追溯、可撤销」的可见证据）：
 *  · 每条 mutation 都有 before/after 快照，这里用字段级 diff 展示「到底改了什么」；
 *  · 单条回滚按 op 取逆（新建→回收站 / 更新→回填 before / 删除→恢复），回滚本身也留痕；
 *  · 回滚是不可逆链路里的唯一出口，因此强调二次确认，并在结果里回显新的审计锚点。
 *  · 正文类长文本 diff 会被压缩成一行（避免审计界面被内容淹没），完整快照仍在 resource.db.json 里。
 */
import { WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import {
  badge, card, cardHeader, emptyState, fmtTime, ProgressNotice, sectionHeader,
} from "./components";
import { diff, describeAudit } from "../core/audit";
import type { AuditEntry, AuditOp, AuditTable } from "../core/models";

const OP_LABELS: Record<AuditOp, string> = { create: "新建", update: "更新", delete: "删除", restore: "恢复" };
const TABLE_LABELS: Record<AuditTable, string> = {
  objects: "对象", tasks: "任务", relations: "关系", summaries: "总结",
};

function opTone(op: AuditOp): "ok" | "warn" | "danger" | "info" {
  return op === "create" ? "ok" : op === "update" ? "info" : op === "delete" ? "danger" : "warn";
}

export class AuditView extends ProsView {
  private tableFilter: AuditTable | "all" = "all";
  private opsFilter: AuditOp | "all" = "all";
  private limit = 200;
  /** 当前聚焦的对象（从其它视图跳转过来时设置）。 */
  private focusObjectId: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.audit, "资源管家 · 审计与回滚", "history");
  }

  /** 外部可设置聚焦对象（对象详情页「查看该对象变更历史」）。 */
  public focusOn(objectId: string | null): void {
    this.focusObjectId = objectId;
    void this.refresh();
  }

  protected buildToolbar(header: HTMLElement): void {
    const bar = header.createDiv({ cls: "pros-toolbar" });

    const tableSel = bar.createEl("select");
    for (const [v, l] of [["all", "全部表"], ...Object.entries(TABLE_LABELS)] as [string, string][]) {
      tableSel.createEl("option", { text: l, value: v });
    }
    tableSel.value = this.tableFilter;
    tableSel.addEventListener("change", () => {
      this.tableFilter = tableSel.value as AuditTable | "all";
      void this.refresh();
    });

    const opSel = bar.createEl("select");
    for (const [v, l] of [["all", "全部操作"], ...Object.entries(OP_LABELS)] as [string, string][]) {
      opSel.createEl("option", { text: l, value: v });
    }
    opSel.value = this.opsFilter;
    opSel.addEventListener("change", () => {
      this.opsFilter = opSel.value as AuditOp | "all";
      void this.refresh();
    });

    const limitSel = bar.createEl("select");
    for (const n of [50, 200, 500, 1000]) limitSel.createEl("option", { text: `最近 ${n} 条`, value: String(n) });
    limitSel.value = String(this.limit);
    limitSel.addEventListener("change", () => {
      this.limit = Number(limitSel.value);
      void this.refresh();
    });

    if (this.focusObjectId) {
      const clear = bar.createEl("button", { text: "只看该对象 ✕" });
      clear.addEventListener("click", () => {
        this.focusObjectId = null;
        void this.refresh();
      });
    }

    const refresh = bar.createEl("button", { text: "刷新" });
    refresh.addEventListener("click", () => void this.refresh());
  }

  protected async render(): Promise<void> {
    const entries = await this.plugin.bridge.audit({
      objectType: this.tableFilter === "all" ? undefined : this.tableFilter,
      objectId: this.focusObjectId ?? undefined,
      limit: this.limit,
    });
    const rows = this.opsFilter === "all" ? entries : entries.filter((e) => e.op === this.opsFilter);

    const bar = this.body.createDiv({ cls: "pros-statusbar" });
    bar.appendChild(badge(`共 ${rows.length} 条记录`, "default"));
    bar.appendChild(badge(`${rows.filter((e) => e.reversible).length} 条可回滚`, "info"));
    if (this.focusObjectId) bar.appendChild(badge(`已聚焦对象 ${this.focusObjectId.slice(0, 10)}`, "warn"));

    if (!rows.length) {
      emptyState(
        this.body,
        "history",
        "暂无变更记录",
        "采集、处理、编辑、删除都会自动写入审计。这里为空说明还没有任何 mutation。",
      );
      return;
    }

    sectionHeader(this.body, "变更日志", "按时间倒序。点击「回滚」把该次变更撤销（回滚本身也会留痕）。");
    for (const e of rows) this.renderEntry(e);
  }

  private renderEntry(entry: AuditEntry): void {
    const box = card(this.body, "pros-audit");
    const changes = entry.before != null && entry.after != null ? diff(entry.before, entry.after) : [];
    const metas = [
      badge(OP_LABELS[entry.op] ?? entry.op, opTone(entry.op)),
      badge(TABLE_LABELS[entry.object_type] ?? entry.object_type, "default"),
      badge(entry.actor, entry.actor.startsWith("agent") ? "ai" : entry.actor.startsWith("rollback") ? "warn" : "user"),
    ];
    if (!entry.reversible) metas.push(badge("不可逆", "danger"));

    const { right } = cardHeader(box, describeAudit(entry), metas);
    right.createSpan({ cls: "pros-muted", text: fmtTime(entry.created_at) });

    // 字段级 diff
    if (changes.length) {
      const table = box.createDiv({ cls: "pros-diff" });
      for (const d of changes) {
        const row = table.createDiv({ cls: "pros-diff-row" });
        row.createDiv({ cls: "pros-diff-field", text: d.field });
        row.createDiv({ cls: "pros-diff-before", text: preview(d.before) });
        row.createDiv({ cls: "pros-diff-after", text: preview(d.after) });
      }
    } else if (entry.op === "create" || entry.op === "delete") {
      const snap = (entry.after ?? entry.before) as Record<string, unknown> | null;
      const title = snap && typeof snap === "object" ? String(snap.title ?? snap.id ?? "") : "";
      box.createDiv({ cls: "pros-muted", text: `目标：${title || entry.object_id}` });
    }

    const foot = box.createDiv({ cls: "pros-audit-foot" });
    foot.createSpan({ cls: "pros-muted pros-mono", text: entry.object_id });

    const btn = foot.createEl("button", { text: "回滚本次变更" });
    btn.disabled = !entry.reversible;
    btn.addEventListener("click", () => void this.rollback(entry));
  }

  private async rollback(entry: AuditEntry): Promise<void> {
    const ok = await this.plugin.confirm(
      "确认回滚这条变更？",
      `将撤销：${describeAudit(entry)}。回滚会生成一条新的审计记录，之后仍可再被回滚。`,
      true,
      `对象：${entry.object_id}\n操作：${OP_LABELS[entry.op]}\n执行者：${entry.actor}`,
    );
    if (!ok) return;

    const prog = new ProgressNotice("回滚");
    prog.update("正在撤销…");
    try {
      const r = await this.plugin.bridge.rollback(entry.id);
      prog.done(r.description);
      this.plugin.emit("data-changed", { reason: "rollback" });
      await this.refresh();
    } catch (e) {
      prog.fail(e);
    }
  }
}

/** 把 diff 值压成一行可读文本。 */
function preview(v: unknown): string {
  if (v === null || v === undefined) return "（空）";
  if (typeof v === "string") return v.length ? v : "（空字符串）";
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join(", ") : "（空数组）";
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return String(v);
  }
}
