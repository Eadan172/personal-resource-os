/**
 * 全局检索（FR-06：Keyword + Semantic + Metadata + 时间过滤 + Rerank）。
 *
 * 结果卡片展示命中片段（高亮命中词）与命中方式（词法/语义/标题），
 * 可一键打开对象详情、或把当前查询直接转成 AI 问答。
 */
import { WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import { badge, card, cardHeader, emptyState, fmtRelative, iconEl, typeBadge } from "./components";
import { OBJECT_TYPE_LABELS, type ObjectType } from "../core/models";

export class SearchView extends ProsView {
  private query = "";
  private typeFilter = "";
  private startDate = "";
  private endDate = "";
  private useVector: boolean;

  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.search, "资源管家 · 检索", "search");
    this.useVector = plugin.settings.ui.vectorSearch;
  }

  protected async render(): Promise<void> {
    const box = this.body.createDiv({ cls: "pros-searchbox" });
    const input = box.createEl("input", { type: "search", placeholder: "输入关键词或自然语言问题…（回车检索）" });
    input.value = this.query;
    const btn = box.createEl("button", { cls: "mod-cta" });
    btn.appendChild(iconEl("search"));
    btn.createSpan({ text: "检索" });

    const advanced = this.body.createDiv({ cls: "pros-filters" });
    const typeSel = advanced.createEl("select");
    typeSel.createEl("option", { text: "全部类型", value: "" });
    for (const [k, label] of Object.entries(OBJECT_TYPE_LABELS)) typeSel.createEl("option", { text: label, value: k });
    typeSel.value = this.typeFilter;
    typeSel.addEventListener("change", () => {
      this.typeFilter = typeSel.value;
      if (this.query) void this.runSearch();
    });

    const start = advanced.createEl("input", { type: "date" });
    start.value = this.startDate;
    start.addEventListener("change", () => {
      this.startDate = start.value;
      if (this.query) void this.runSearch();
    });
    advanced.createSpan({ text: "→", cls: "pros-muted" });
    const end = advanced.createEl("input", { type: "date" });
    end.value = this.endDate;
    end.addEventListener("change", () => {
      this.endDate = end.value;
      if (this.query) void this.runSearch();
    });

    const vlabel = advanced.createEl("label", { cls: "pros-check-inline" });
    const vcb = vlabel.createEl("input", { type: "checkbox" });
    vcb.checked = this.useVector;
    vlabel.createSpan({ text: "语义召回（需 Provider 支持 embedding）" });
    vcb.addEventListener("change", () => {
      this.useVector = vcb.checked;
      if (this.query) void this.runSearch();
    });

    const runner = () => void this.runSearch();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runner();
    });
    btn.addEventListener("click", runner);

    const results = this.body.createDiv({ cls: "pros-results" });

    if (!this.query) {
      emptyState(
        results,
        "search",
        "输入内容开始检索",
        "支持中文（trigram）与英文关键词；可选语义召回；结果带命中位置，可直接跳回原文。",
      );
      input.focus();
      return;
    }

    const askBtn = results.createEl("button", { cls: "pros-link-btn" });
    askBtn.setText(`用 AI 基于资料库回答「${this.query}」→`);
    askBtn.addEventListener("click", () => this.plugin.openChat(this.query));

    const hits = await this.plugin.bridge.search(this.query, {
      types: this.typeFilter ? [this.typeFilter] : undefined,
      start: this.startDate || undefined,
      end: this.endDate || undefined,
      useVector: this.useVector,
      limit: 30,
    });

    if (!hits.length) {
      emptyState(results, "file-question", "没有匹配结果", "试试更短的关键词，或关闭类型/时间筛选。");
      return;
    }

    results.createDiv({ cls: "pros-muted", text: `命中 ${hits.length} 条` });
    for (const h of hits) {
      const c = card(results);
      const { right } = cardHeader(c, h.title, [
        typeBadge(h.type, OBJECT_TYPE_LABELS[h.type as ObjectType] ?? h.type),
        badge(fmtRelative(h.created_at), "default"),
        ...h.matched_by.map((m) =>
          badge(
            { lexical: "词法命中", vector: "语义命中", title: "标题命中" }[m] ?? m,
            m === "vector" ? "ai" : m === "title" ? "ok" : "info",
          ),
        ),
      ]);

      // 命中片段：先转义再用 <mark> 高亮，避免 XSS
      const snippet = c.createEl("p", { cls: "pros-card-snippet pros-snippet" });
      renderHighlight(snippet, h.snippet, this.query);
      c.createDiv({ cls: "pros-muted", text: `命中位置：字符 ${h.span.start} - ${h.span.end}` });

      const open = right.createEl("button", { text: "打开" });
      open.addEventListener("click", () => this.plugin.openObject(h.object_id));
    }
  }

  private async runSearch(): Promise<void> {
    await this.refresh();
  }
}

/** 把命中片段渲染为带 <mark> 的 DOM（严格转义，防 XSS）。 */
export function renderHighlight(container: HTMLElement, snippet: string, query: string): void {
  const terms = [...new Set([query, ...query.split(/\s+/).filter((t) => t.length >= 2)])].filter(Boolean);
  if (!terms.length) {
    container.setText(snippet);
    return;
  }
  const escaped = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) container.appendText(snippet.slice(last, m.index));
    container.createEl("mark", { text: m[0] });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < snippet.length) container.appendText(snippet.slice(last));
}
