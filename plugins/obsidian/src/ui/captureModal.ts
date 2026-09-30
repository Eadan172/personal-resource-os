/**
 * 快速记录弹窗（FR-01 多入口 Capture 的「文本框」入口）。
 *
 * 支持的入口集合（其余入口在 main.ts 注册为命令/事件）：
 *  · 文本框（本弹窗）
 *  · 当前笔记 / 选中内容（命令）
 *  · 剪贴板（命令 / 弹窗按钮）
 *  · 链接采集（linkIngestModal）
 *  · 文件拖入（Inbox 视图拖拽区）
 */
import { App, Modal, Notice, Setting, SuggestModal } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProgressNotice } from "./components";
import type { DataClass } from "../core/models";

export class CaptureModal extends Modal {
  private title = "";
  private content = "";
  private tags = "";
  private dataClass: DataClass;
  private processNow = true;

  constructor(private plugin: PersonalResourceOSPlugin, preset?: { content?: string; title?: string; tags?: string }) {
    super(plugin.app);
    this.content = preset?.content ?? "";
    this.title = preset?.title ?? "";
    this.tags = preset?.tags ?? "";
    this.dataClass = plugin.settings.core.defaultDataClass;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("pros-modal");
    contentEl.createEl("h3", { text: "快速记录到 Inbox" });

    const info = contentEl.createDiv({ cls: "pros-hint-box" });
    info.createSpan({
      text: "原始内容会先原样入库（AI 永不修改原文），再按你的设置自动分类、摘要并生成结构化笔记写入库。",
    });

    new Setting(contentEl)
      .setName("标题")
      .setDesc("留空则自动取正文首行")
      .addText((t) => {
        t.setPlaceholder("例如：产品评审会要点").setValue(this.title).onChange((v) => (this.title = v));
      });

    const area = contentEl.createEl("textarea", { cls: "pros-textarea" });
    area.rows = 12;
    area.placeholder = "在此输入或粘贴内容……\n\n提示：\n· 含「明天 / 3 月 5 日 / 务必」等字样的行会被识别为待办\n· #标签 会进入标签体系，@某人 会被识别为人物";
    area.value = this.content;
    area.addEventListener("input", () => (this.content = area.value));
    area.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void this.submit();
      }
    });

    new Setting(contentEl)
      .setName("标签")
      .setDesc("逗号分隔，可与正文中的 #标签 叠加")
      .addText((t) => t.setPlaceholder("工作, 会议").setValue(this.tags).onChange((v) => (this.tags = v)));

    new Setting(contentEl)
      .setName("数据分级")
      .setDesc("private 内容永不外发给云端模型（即使已配置密钥）")
      .addDropdown((d) =>
        d
          .addOption("public", "public（允许外发）")
          .addOption("internal", "internal（默认）")
          .addOption("private", "private（禁止外发）")
          .setValue(this.dataClass)
          .onChange((v) => (this.dataClass = v as DataClass)),
      );

    new Setting(contentEl)
      .setName("采集后立即处理")
      .setDesc("自动分类 → 摘要 → 提取待办 → 生成结构化笔记")
      .addToggle((t) => t.setValue(this.processNow).onChange((v) => (this.processNow = v)));

    const actions = contentEl.createDiv({ cls: "pros-modal-actions" });
    const paste = actions.createEl("button", { text: "从剪贴板填入" });
    paste.addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (!text) return new Notice("剪贴板为空");
        area.value = text;
        this.content = text;
      } catch {
        new Notice("无法读取剪贴板（请检查系统权限）");
      }
    });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", { text: "采集（Ctrl+Enter）", cls: "mod-cta" });
    submit.addEventListener("click", () => void this.submit());
    area.focus();
  }

  private async submit(): Promise<void> {
    const content = this.content.trim();
    if (!content) {
      new Notice("内容为空");
      return;
    }
    const prog = new ProgressNotice("采集");
    prog.update("写入 Inbox…");
    try {
      const res = await this.plugin.bridge.capture({
        content,
        title: this.title.trim() || null,
        tags: this.tags.split(",").map((s) => s.trim()).filter(Boolean),
        dataClass: this.dataClass,
        kind: undefined,
        sourceChannel: "obsidian",
      });
      prog.update(`已入库：${res.title}`);
      if (res.duplicate_of) new Notice("检测到重复内容：已生成「疑似重复」关系建议（未自动合并）", 5000);

      if (this.processNow) {
        await this.plugin.processObjectWithFeedback(res.id, prog);
      } else {
        prog.done(`Inbox 现有 ${(await this.plugin.bridge.stats()).inbox} 条待处理`);
      }
      this.plugin.emit("data-changed", { reason: "capture" });
      this.close();
    } catch (e) {
      prog.fail(e);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 选择「已有的 vault 文件」进行采集（Obsidian 没有原生文件选择器，用模糊搜索替代）。 */
export class VaultFileSuggestModal extends SuggestModal<string> {
  constructor(
    app: App,
    private items: string[],
    private onPick: (path: string) => void,
  ) {
    super(app);
    this.setPlaceholder("输入文件名筛选……");
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.items.filter((p) => p.toLowerCase().includes(q)).slice(0, 50);
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.setText(path);
  }

  onChooseSuggestion(path: string): void {
    this.onPick(path);
  }
}
