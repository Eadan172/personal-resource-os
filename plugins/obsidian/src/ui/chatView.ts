/**
 * AI 对话（FR-07 RAG 问答 / FR-14 AI Chat + AI Sidebar）。
 *
 * 铁律可视化：
 *  · 每条答案都能展开引用，引用带 object_id + 字符偏移 + 精确切片；
 *  · 无证据时后端返回固定拒答，UI 用醒目标记提示，而不是让模型“编”；
 *  · 点引用可跳回原文位置（打开笔记并把光标定位到偏移处）。
 */
import { MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import { badge, emptyState, iconEl, ProgressNotice, typeBadge } from "./components";
import type { AskResult } from "../core/rag";
import { OBJECT_TYPE_LABELS, type ObjectType } from "../core/models";

interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  result?: AskResult;
  at: string;
}

export class ChatView extends ProsView {
  private turns: ChatTurn[] = [];
  private draft = "";
  private topK = 5;
  private useVector = false;
  private logEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.chat, "资源管家 · AI 问答", "message-square");
    this.useVector = plugin.settings.ui.vectorSearch;
  }

  protected async render(): Promise<void> {
    const meta = this.plugin.bridge.meta;
    const bar = this.body.createDiv({ cls: "pros-statusbar" });
    bar.appendChild(badge(meta.offline ? "Provider：离线确定性（Mock）" : `Provider：${meta.provider}`, meta.offline ? "info" : "warn"));
    bar.appendChild(badge(`引用上限 ${this.topK}`, "default"));

    const cfg = this.body.createDiv({ cls: "pros-filters" });
    const kSel = cfg.createEl("select");
    for (const k of [3, 5, 8, 12]) kSel.createEl("option", { text: `引用上限 ${k}`, value: String(k) });
    kSel.value = String(this.topK);
    kSel.addEventListener("change", () => (this.topK = Number(kSel.value)));

    const vlabel = cfg.createEl("label", { cls: "pros-check-inline" });
    const vcb = vlabel.createEl("input", { type: "checkbox" });
    vcb.checked = this.useVector;
    vlabel.createSpan({ text: "语义召回复排" });
    vcb.addEventListener("change", () => (this.useVector = vcb.checked));

    const exportBtn = cfg.createEl("button", { text: "导出对话到笔记" });
    exportBtn.addEventListener("click", () => void this.exportChat());

    this.logEl = this.body.createDiv({ cls: "pros-chat-log" });

    if (!this.turns.length) {
      emptyState(
        this.logEl,
        "sparkles",
        "基于你自己的资料库提问",
        "回答只使用库内证据并给出引用；没有证据时会明确说「不知道」，不会编造。",
        [
          { label: "我最近关注什么主题？", onClick: () => void this.ask("我最近关注什么主题？") },
          { label: "有哪些未完成的待办？", onClick: () => void this.ask("有哪些未完成的待办？") },
        ],
      );
    }
    for (const t of this.turns) this.renderTurn(t);

    // 输入区
    const inputBar = this.body.createDiv({ cls: "pros-chat-input" });
    const ta = inputBar.createEl("textarea", { cls: "pros-textarea" });
    ta.rows = 2;
    ta.placeholder = "问点什么…（Enter 发送，Shift+Enter 换行）";
    ta.value = this.draft;
    ta.addEventListener("input", () => (this.draft = ta.value));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.ask(this.draft);
      }
    });
    const send = inputBar.createEl("button", { cls: "mod-cta" });
    send.appendChild(iconEl("send"));
    send.createSpan({ text: "发送" });
    send.addEventListener("click", () => void this.ask(this.draft));

    ta.focus();
  }

  /** 外部（检索视图 / 命令）预填问题。 */
  public prefill(question: string): void {
    this.draft = question;
    void this.refresh();
  }

  private renderTurn(turn: ChatTurn): void {
    const wrap = this.logEl.createDiv({ cls: `pros-chat-turn is-${turn.role}` });
    const head = wrap.createDiv({ cls: "pros-chat-head" });
    head.appendChild(badge(turn.role === "user" ? "你" : "Agent", turn.role === "user" ? "ok" : "ai"));
    head.createSpan({ cls: "pros-muted", text: new Date(turn.at).toLocaleTimeString() });

    const body = wrap.createDiv({ cls: "pros-chat-body" });
    if (turn.role === "user") {
      body.setText(turn.text);
      return;
    }

    const r = turn.result;
    if (r?.refused) {
      body.createDiv({ cls: "pros-refuse", text: "⚠ 未找到依据，" + (r.answer || "已拒绝作答") });
    } else {
      // 用 Obsidian 的 Markdown 渲染器渲染回答，保证 [1] 之类的引用标记可读
      const md = body.createDiv({ cls: "pros-markdown" });
      void MarkdownRenderer.render(this.plugin.app, turn.text, md, "", this as never);
    }

    if (r) {
      const meta = wrap.createDiv({ cls: "pros-chat-meta" });
      meta.appendChild(badge(`证据 ${r.evidence_count} 条`, r.evidence_count ? "info" : "warn"));
      meta.appendChild(badge(`引用 ${r.citations.length} 处`, r.citations.length ? "ok" : "warn"));
      meta.appendChild(badge(`Provider：${r.used_provider}`, "default"));

      if (r.citations.length) {
        const list = wrap.createDiv({ cls: "pros-citations" });
        for (const c of r.citations) {
          const item = list.createDiv({ cls: "pros-citation" });
          const top = item.createDiv({ cls: "pros-citation-head" });
          top.appendChild(badge(`[${c.n}]`, "ok"));
          top.createSpan({ text: c.title, cls: "pros-citation-title" });
          top.appendChild(badge(`字符 ${c.span.start}-${c.span.end}`, "default"));
          const open = top.createEl("button", { text: "跳回原文" });
          open.addEventListener("click", () => void this.plugin.openCitation(c));
          item.createEl("blockquote", { cls: "pros-citation-quote", text: c.exact_text });
        }
      }

      if (r.hits?.length) {
        const used = wrap.createDiv({ cls: "pros-uses" });
        used.createSpan({ cls: "pros-muted", text: "检索到的相关内容：" });
        for (const h of r.hits.slice(0, 5)) {
          const chip = used.createEl("button", { cls: "pros-chip" });
          chip.appendChild(typeBadge(h.type, OBJECT_TYPE_LABELS[h.type as ObjectType] ?? h.type));
          chip.createSpan({ text: h.title });
          chip.addEventListener("click", () => this.plugin.openObject(h.object_id));
        }
      }
    }
  }

  private async ask(question: string): Promise<void> {
    const q = (question ?? "").trim();
    if (!q) {
      new Notice("请输入问题");
      return;
    }
    this.turns.push({ role: "user", text: q, at: new Date().toISOString() });
    this.draft = "";
    await this.refresh();

    const prog = new ProgressNotice("问答");
    prog.update("检索证据并生成回答…");
    try {
      const result = await this.plugin.bridge.ask(q, { topK: this.topK, useVector: this.useVector });
      this.turns.push({ role: "assistant", text: result.answer, result, at: new Date().toISOString() });
      prog.done(result.refused ? "无证据，已拒绝作答" : `${result.citations.length} 处引用`);
      await this.refresh();
      this.scrollToBottom();
    } catch (e) {
      prog.fail(e);
      this.turns.push({
        role: "assistant",
        text: `问答失败：${e instanceof Error ? e.message : String(e)}`,
        at: new Date().toISOString(),
      });
      await this.refresh();
    }
  }

  private scrollToBottom(): void {
    const log = this.logEl?.parentElement;
    if (log) log.scrollTop = log.scrollHeight;
  }

  /** 把对话导出成 Markdown 笔记（归档 / 分享）。 */
  private async exportChat(): Promise<void> {
    if (!this.turns.length) {
      new Notice("还没有对话内容");
      return;
    }
    const lines: string[] = [
      "---",
      "type: conversation",
      `created: ${new Date().toISOString()}`,
      "tags:",
      "  - pros/qa",
      "---",
      "",
      `# 资料库问答记录（${new Date().toLocaleString()}）`,
      "",
    ];
    for (const t of this.turns) {
      if (t.role === "user") {
        lines.push(`## 问：${t.text}`, "");
      } else {
        lines.push("### 答", "", t.text, "");
        if (t.result?.citations.length) {
          lines.push("**引用**", "");
          for (const c of t.result.citations) {
            lines.push(`- [${c.n}] ${c.title}（字符 ${c.span.start}-${c.span.end}）：${c.exact_text.slice(0, 120)}`);
          }
          lines.push("");
        }
        if (t.result?.refused) lines.push("> 本条为「无证据拒答」，未产生任何推断内容。", "");
      }
    }
    const path = `${this.plugin.settings.core.notesDir}/问答记录/${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
    await this.plugin.bridge.writeFile(path, lines.join("\n"));
    new Notice(`已导出到 ${path}`);
    await this.plugin.app.workspace.openLinkText(path, "", false);
  }
}
