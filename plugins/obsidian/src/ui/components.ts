/**
 * UI 共享组件与工具。
 *
 * 设计约定（与用户偏好一致：卡片式布局、清晰层级、响应式、浅色主题）：
 *  - 所有样式集中在 styles.css，类名统一 `pros-` 前缀；
 *  - 所有来自资料库/外部网页的文本进 DOM 前必须过 `escapeHtml` 或使用 `setText`（防 XSS）；
 *  - 表格/卡片在窄屏下自动堆叠（CSS 媒体查询负责）。
 */
import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import type { Origin, Relation, Task, TaskPriority, TaskStatus } from "../core/models";

// ------------------------------------------------------------- DOM helpers ---

export interface ElOptions {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string>;
  children?: (HTMLElement | null)[];
}

/** 创建元素（统一的属性/类名/文本入口）。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const classes = Array.isArray(opts.cls) ? opts.cls : opts.cls ? opts.cls.split(/\s+/) : [];
  if (classes.length) node.addClass(...classes);
  if (opts.text !== undefined) node.setText(opts.text);
  for (const [k, v] of Object.entries(opts.attr ?? {})) node.setAttr(k, v);
  for (const c of opts.children ?? []) if (c) node.appendChild(c);
  return node;
}

/** 带图标的元素（图标名使用 Obsidian 内置 lucide 图标集）。 */
export function iconEl(icon: string, cls?: string): HTMLElement {
  const span = el("span", { cls: `pros-icon ${cls ?? ""}`.trim() });
  try {
    setIcon(span, icon);
  } catch {
    span.setText("•");
  }
  return span;
}

/** 小节标题（视图顶部统一使用）。 */
export function sectionHeader(container: HTMLElement, title: string, desc?: string): HTMLElement {
  const head = container.createDiv({ cls: "pros-section-head" });
  head.createEl("h4", { text: title, cls: "pros-section-title" });
  if (desc) head.createEl("p", { text: desc, cls: "pros-muted pros-section-desc" });
  return head;
}

/** 徽标。 */
export function badge(text: string, kind: "default" | "ok" | "warn" | "danger" | "info" | "ai" | "user" = "default"): HTMLElement {
  return el("span", { cls: `pros-badge pros-badge-${kind}`, text });
}

/** 来源徽标：视觉区分「事实 / 用户 / AI 提取 / AI 推断 / AI 建议」（NFR-03 强制要求）。 */
export function originBadge(origin: Origin): HTMLElement {
  const map: Record<Origin, { label: string; kind: "default" | "ok" | "info" | "ai" | "warn" }> = {
    raw: { label: "原始事实", kind: "default" },
    user_edit: { label: "用户编辑", kind: "ok" },
    ai_extracted: { label: "AI 提取", kind: "ai" },
    ai_inferred: { label: "AI 推断", kind: "warn" },
    ai_suggested: { label: "AI 建议", kind: "info" },
  };
  const m = map[origin] ?? map.raw;
  return badge(m.label, m.kind);
}

export function typeBadge(type: string, label: string): HTMLElement {
  return el("span", { cls: "pros-badge pros-badge-type", text: label || type });
}

export function priorityBadge(p: TaskPriority): HTMLElement {
  const kind = p === "P0" ? "danger" : p === "P1" ? "warn" : p === "P2" ? "info" : "default";
  return badge(p, kind);
}

export function statusBadge(s: TaskStatus): HTMLElement {
  const map: Record<TaskStatus, { label: string; kind: "default" | "ok" | "warn" | "info" | "danger" }> = {
    todo: { label: "待办", kind: "info" },
    doing: { label: "进行中", kind: "warn" },
    done: { label: "已完成", kind: "ok" },
    cancelled: { label: "已取消", kind: "default" },
  };
  const m = map[s] ?? map.todo;
  return badge(m.label, m.kind);
}

export function relationBadge(r: Relation, peerTitle: string): HTMLElement {
  const holder = el("div", { cls: "pros-rel-chip" });
  holder.appendChild(el("span", { cls: "pros-rel-type", text: labelForRelation(r.type) }));
  holder.appendChild(el("span", { cls: "pros-rel-peer", text: peerTitle || r.dst_id.slice(0, 8) }));
  holder.appendChild(
    badge(
      r.status === "suggested" ? "AI 建议·待审核" : r.status === "confirmed" ? "已确认" : "已拒绝",
      r.status === "suggested" ? "info" : r.status === "confirmed" ? "ok" : "default",
    ),
  );
  holder.setAttr("data-rel-id", r.id);
  return holder;
}

export function labelForRelation(type: Relation["type"]): string {
  const map: Record<Relation["type"], string> = {
    related_to: "相关", mentions: "提及", belongs_to: "属于", assigned_to: "指派给",
    depends_on: "依赖", derived_from: "衍生自", contradicts: "冲突", supports: "支持",
    duplicate_of: "疑似重复", references: "引用",
  };
  return map[type] ?? type;
}

/** 空态（含可选操作按钮）。 */
export function emptyState(
  container: HTMLElement,
  icon: string,
  title: string,
  desc: string,
  actions: { label: string; onClick: () => void; cta?: boolean }[] = [],
): HTMLElement {
  const box = container.createDiv({ cls: "pros-empty" });
  box.appendChild(iconEl(icon, "pros-empty-icon"));
  box.createEl("h5", { text: title });
  box.createEl("p", { text: desc, cls: "pros-muted" });
  if (actions.length) {
    const row = box.createDiv({ cls: "pros-empty-actions" });
    for (const a of actions) {
      const btn = row.createEl("button", { text: a.label, cls: a.cta ? "mod-cta" : "" });
      btn.addEventListener("click", a.onClick);
    }
  }
  return box;
}

/** 骨架/加载提示。 */
export function loading(container: HTMLElement, text = "正在处理…"): HTMLElement {
  const box = container.createDiv({ cls: "pros-loading" });
  box.createDiv({ cls: "pros-spinner" });
  box.createSpan({ text });
  return box;
}

/** 两列表格式信息（响应式：窄屏堆叠）。 */
export function kvList(container: HTMLElement, rows: [string, string | HTMLElement][]): HTMLElement {
  const dl = container.createDiv({ cls: "pros-kv" });
  for (const [k, v] of rows) {
    const row = dl.createDiv({ cls: "pros-kv-row" });
    row.createDiv({ cls: "pros-kv-key", text: k });
    const val = row.createDiv({ cls: "pros-kv-val" });
    if (typeof v === "string") val.setText(v);
    else val.appendChild(v);
  }
  return dl;
}

/** 横向统计卡组。 */
export function statCards(
  container: HTMLElement,
  items: { label: string; value: string | number; hint?: string; tone?: "default" | "ok" | "warn" | "danger" | "info" }[],
): HTMLElement {
  const grid = container.createDiv({ cls: "pros-stat-grid" });
  for (const it of items) {
    const card = grid.createDiv({ cls: `pros-stat-card tone-${it.tone ?? "default"}` });
    card.createDiv({ cls: "pros-stat-value", text: String(it.value) });
    card.createDiv({ cls: "pros-stat-label", text: it.label });
    if (it.hint) card.createDiv({ cls: "pros-stat-hint", text: it.hint });
  }
  return grid;
}

/** 标签行。 */
export function tagRow(container: HTMLElement, tags: string[], onPick?: (tag: string) => void): HTMLElement {
  const row = container.createDiv({ cls: "pros-tag-row" });
  for (const t of tags) {
    const chip = row.createSpan({ cls: "pros-tag", text: `#${t}` });
    if (onPick) {
      chip.addClass("pros-clickable");
      chip.addEventListener("click", () => onPick(t));
    }
  }
  return row;
}

// ------------------------------------------------------------------ 提示 ---

/** 长任务进度提示：一个 Notice 实例复用，结束时转为完成态。 */
export class ProgressNotice {
  private notice: Notice | null = null;
  private last = "";

  constructor(private title: string) {}

  update(msg: string): void {
    this.last = msg;
    const text = `${this.title}\n${msg}`;
    if (!this.notice) this.notice = new Notice(text, 0);
    else this.notice.setMessage(text);
  }

  done(msg?: string): void {
    const text = `${this.title} 完成${msg ? `：${msg}` : ""}`;
    if (this.notice) {
      this.notice.setMessage(text);
      const n = this.notice;
      window.setTimeout(() => n.hide(), 2600);
      this.notice = null;
    } else {
      new Notice(text, 3000);
    }
  }

  fail(err: unknown): void {
    const text = `${this.title} 失败：${err instanceof Error ? err.message : String(err)}`;
    if (this.notice) {
      this.notice.setMessage(text);
      const n = this.notice;
      window.setTimeout(() => n.hide(), 6000);
      this.notice = null;
    } else {
      new Notice(text, 6000);
    }
  }
}

// ------------------------------------------------------------------ 弹窗 ---

/** 确认对话框（用于删除/批量/高风险操作）。 */
export class ConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private opts: { title: string; message: string; cta?: string; danger?: boolean; detail?: string },
    private onDone: (ok: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.opts.title });
    contentEl.createEl("p", { text: this.opts.message });
    if (this.opts.detail) {
      contentEl.createEl("pre", { text: this.opts.detail, cls: "pros-pre" });
    }
    const row = contentEl.createDiv({ cls: "pros-modal-actions" });
    const cancel = row.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => {
      this.resolved = true;
      this.onDone(false);
      this.close();
    });
    const ok = row.createEl("button", {
      text: this.opts.cta ?? "确认",
      cls: this.opts.danger ? "mod-warning" : "mod-cta",
    });
    ok.addEventListener("click", () => {
      this.resolved = true;
      this.onDone(true);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) this.onDone(false);
  }
}

export function confirm(app: App, opts: { title: string; message: string; cta?: string; danger?: boolean; detail?: string }): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, opts, resolve).open());
}

/** 通用表单弹窗：字段驱动，返回键值对。 */
export interface FormField {
  key: string;
  label: string;
  type?: "text" | "textarea" | "number" | "toggle" | "dropdown" | "date";
  value?: string | number | boolean;
  placeholder?: string;
  description?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
}

export class FormModal extends Modal {
  private values: Record<string, string | number | boolean> = {};
  private submitted = false;

  constructor(
    app: App,
    private opts: { title: string; description?: string; fields: FormField[]; cta?: string; onSubmit: (v: Record<string, string | number | boolean>) => void | Promise<void> },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.opts.title });
    if (this.opts.description) contentEl.createEl("p", { text: this.opts.description, cls: "pros-muted" });
    for (const f of this.opts.fields) {
      this.values[f.key] = f.value ?? (f.type === "toggle" ? false : "");
      const s = new Setting(contentEl).setName(f.label);
      if (f.description) s.setDesc(f.description);
      if (f.type === "textarea") {
        s.addTextArea((t) => {
          t.setValue(String(f.value ?? "")).onChange((v) => (this.values[f.key] = v));
          if (f.placeholder) t.setPlaceholder(f.placeholder);
          t.inputEl.rows = 6;
          t.inputEl.addClass("pros-textarea");
        });
      } else if (f.type === "toggle") {
        s.addToggle((t) => t.setValue(!!f.value).onChange((v) => (this.values[f.key] = v)));
      } else if (f.type === "number") {
        s.addText((t) => {
          t.inputEl.type = "number";
          t.setValue(String(f.value ?? "")).onChange((v) => (this.values[f.key] = Number(v)));
          if (f.placeholder) t.setPlaceholder(f.placeholder);
        });
      } else if (f.type === "dropdown") {
        s.addDropdown((d) => {
          for (const o of f.options ?? []) d.addOption(o.value, o.label);
          d.setValue(String(f.value ?? f.options?.[0]?.value ?? "")).onChange((v) => (this.values[f.key] = v));
        });
      } else if (f.type === "date") {
        s.addText((t) => {
          t.inputEl.type = "date";
          t.setValue(String(f.value ?? "")).onChange((v) => (this.values[f.key] = v));
        });
      } else {
        s.addText((t) => {
          t.setValue(String(f.value ?? "")).onChange((v) => (this.values[f.key] = v));
          if (f.placeholder) t.setPlaceholder(f.placeholder);
        });
      }
    }
    const row = contentEl.createDiv({ cls: "pros-modal-actions" });
    row.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    row.createEl("button", { text: this.opts.cta ?? "保存", cls: "mod-cta" }).addEventListener("click", () => {
      for (const f of this.opts.fields) {
        if (f.required && !String(this.values[f.key] ?? "").trim()) {
          new Notice(`请填写「${f.label}」`);
          return;
        }
      }
      this.submitted = true;
      void this.opts.onSubmit(this.values);
      this.close();
    });
    // 自动聚焦第一个输入框
    const first = contentEl.querySelector("input, textarea") as HTMLElement | null;
    first?.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    void this.submitted;
  }
}

export function openForm(app: App, opts: ConstructorParameters<typeof FormModal>[1]): Promise<void> {
  return new Promise((resolve) => {
    new FormModal(app, {
      ...opts,
      onSubmit: async (v) => {
        await opts.onSubmit(v);
        resolve();
      },
    }).open();
  });
}

/** 复选框行（批量操作/筛选器共用）。 */
export function checkboxRow(container: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void, count?: number): HTMLElement {
  const row = container.createDiv({ cls: "pros-check-row" });
  const cb = row.createEl("input", { type: "checkbox" });
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  row.createSpan({ text: label });
  if (count !== undefined) row.createSpan({ text: `（${count}）`, cls: "pros-muted" });
  return row;
}

/** 卡片外壳（所有列表项统一外观）。 */
export function card(container: HTMLElement, extraCls = ""): HTMLElement {
  return container.createDiv({ cls: `pros-card ${extraCls}`.trim() });
}

/** 卡片头部：标题 + 徽标 + 右侧操作区。 */
export function cardHeader(parent: HTMLElement, title: string, metas: HTMLElement[] = []): { head: HTMLElement; right: HTMLElement } {
  const head = parent.createDiv({ cls: "pros-card-head" });
  const left = head.createDiv({ cls: "pros-card-head-left" });
  left.createEl("h5", { text: title, cls: "pros-card-title" });
  if (metas.length) {
    const metaRow = left.createDiv({ cls: "pros-card-meta" });
    for (const m of metas) metaRow.appendChild(m);
  }
  const right = head.createDiv({ cls: "pros-card-actions" });
  return { head, right };
}

/** 时间格式化（列表用紧凑格式）。 */
export function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 相对时间（“3 天前”）。 */
export function fmtRelative(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return String(iso);
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return fmtTime(iso).slice(0, 10);
}

/** 把任务按“逾期 / 今天 / 本周 / 以后 / 无日期”分组（任务中心用）。 */
export function groupTasks(tasks: Task[]): { key: string; label: string; items: Task[] }[] {
  const p = (n: number) => String(n).padStart(2, "0");
  const now = new Date();
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const week = `${weekEnd.getFullYear()}-${p(weekEnd.getMonth() + 1)}-${p(weekEnd.getDate())}`;

  const groups: { key: string; label: string; items: Task[] }[] = [
    { key: "overdue", label: "已逾期", items: [] },
    { key: "today", label: "今天到期", items: [] },
    { key: "week", label: "未来 7 天", items: [] },
    { key: "later", label: "更晚", items: [] },
    { key: "nodate", label: "未设日期", items: [] },
  ];
  for (const t of tasks) {
    if (t.status === "done" || t.status === "cancelled") continue;
    const due = t.due_at?.slice(0, 10);
    if (!due) groups[4].items.push(t);
    else if (due < today) groups[0].items.push(t);
    else if (due === today) groups[1].items.push(t);
    else if (due <= week) groups[2].items.push(t);
    else groups[3].items.push(t);
  }
  return groups.filter((g) => g.items.length);
}
