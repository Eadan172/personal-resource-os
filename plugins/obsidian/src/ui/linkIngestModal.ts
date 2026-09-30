/**
 * 链接采集弹窗（FR-14 / P3 / P4 的 UI 入口）。
 *
 * 支持 网页 / 视频 / 音频 / 代码仓库 四类，自动识别类型并提示将采用的处理路径：
 *  · 有 Python Core：委托 Core 做重活（下载、转写、抽帧、反爬渲染）；
 *  · 无 Core：插件内轻量解析（正文提取 / 平台元数据 / 仓库 README），并标明降级点。
 */
import { App, Modal, Notice, Setting } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProgressNotice } from "./components";
import type { ResourceKind } from "../core/ingest/common";

export class LinkIngestModal extends Modal {
  private source = "";
  private kind: ResourceKind | "auto" = "auto";
  private tags = "";
  private maxImages: number;
  private processNow = true;
  private detected: ResourceKind | null = null;
  private hintEl!: HTMLElement;

  constructor(private plugin: PersonalResourceOSPlugin, preset?: { source?: string }) {
    super(plugin.app);
    this.source = preset?.source ?? "";
    this.maxImages = plugin.settings.core.ingestMaxImages;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("pros-modal");
    contentEl.createEl("h3", { text: "采集链接" });

    contentEl.createDiv({
      cls: "pros-hint-box",
      text:
        "支持：B 站 / YouTube 视频、音频直链、网页文章（知乎等）、GitHub / Gitee / GitLab 仓库。\n" +
        "原件与衍生数据都会归档到索引库目录，采集失败也不会留下半成品。",
    });

    new Setting(contentEl)
      .setName("链接")
      .setDesc("粘贴后自动识别类型")
      .addText((t) => {
        t.setPlaceholder("https://…").setValue(this.source).onChange((v) => {
          this.source = v.trim();
          this.refreshHint();
        });
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void this.submit();
          }
        });
        window.setTimeout(() => t.inputEl.focus(), 50);
      });

    new Setting(contentEl)
      .setName("类型")
      .setDesc("auto 会自动识别；识别不准时可手动指定")
      .addDropdown((d) =>
        d
          .addOption("auto", "自动识别")
          .addOption("html", "网页")
          .addOption("video", "视频")
          .addOption("audio", "音频")
          .addOption("code", "代码仓库")
          .setValue("auto")
          .onChange((v) => {
            this.kind = v as ResourceKind | "auto";
            this.refreshHint();
          }),
      );

    new Setting(contentEl)
      .setName("标签")
      .setDesc("逗号分隔，会自动叠加 ingest/<类型> 标签")
      .addText((t) => t.setPlaceholder("AI, 化学").onChange((v) => (this.tags = v)));

    new Setting(contentEl)
      .setName("网页配图上限")
      .setDesc("0 表示不下载配图（省流量/省空间）")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(this.maxImages)).onChange((v) => (this.maxImages = Math.max(0, Number(v) || 0)));
      });

    new Setting(contentEl)
      .setName("采集后立即处理")
      .setDesc("自动分类、摘要并生成结构化笔记")
      .addToggle((t) => t.setValue(this.processNow).onChange((v) => (this.processNow = v)));

    this.hintEl = contentEl.createDiv({ cls: "pros-hint-box pros-hint-dynamic" });
    this.refreshHint();

    const actions = contentEl.createDiv({ cls: "pros-modal-actions" });
    actions.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
    actions.createEl("button", { text: "开始采集", cls: "mod-cta" }).addEventListener("click", () => void this.submit());
  }

  /** 实时提示将采用的路径（让用户对“会不会用到 Core / 会降级到什么”有预期）。 */
  private refreshHint(): void {
    if (!this.hintEl) return;
    this.hintEl.empty();
    if (!this.source) {
      this.hintEl.setText("等待输入链接…");
      return;
    }
    let kind: ResourceKind | null = null;
    try {
      kind = this.kind === "auto" ? this.plugin.detectSourceType(this.source) : this.kind;
    } catch (e) {
      this.hintEl.setText(`⚠ ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.detected = kind;
    const heavy = kind === "video" || kind === "audio" || kind === "code";
    const core = this.plugin.bridge.meta.supportsHeavyIngest;
    const lines: string[] = [`识别类型：${labelOf(kind)}`];
    if (kind === "html") {
      lines.push(core
        ? "处理路径：委托 Python Core（含反爬/登录墙的浏览器渲染）"
        : "处理路径：插件内静态抓取（遇到反爬/登录墙会给出提示并降级）");
    } else if (heavy && core) {
      lines.push("处理路径：委托 Python Core 完成下载 / 转写 / 抽帧 / 校验");
    } else if (kind === "code") {
      lines.push("处理路径：插件内获取仓库元数据 + README（不下载整包）；启用 Core 可归档完整源码");
    } else {
      lines.push("处理路径：插件内获取平台元数据" + (kind === "video" ? "与平台字幕" : "") + "；无 Core 时不做下载与转写（会标注「待转写」）");
    }
    this.hintEl.setText(lines.join("\n"));
  }

  private async submit(): Promise<void> {
    if (!this.source) {
      new Notice("请先粘贴链接");
      return;
    }
    let kind: ResourceKind;
    try {
      kind = this.kind === "auto" ? this.plugin.detectSourceType(this.source) : this.kind;
    } catch (e) {
      new Notice(e instanceof Error ? e.message : String(e));
      return;
    }

    const prog = new ProgressNotice("采集");
    prog.update("开始采集…");
    try {
      const res = await this.plugin.bridge.ingest(
        this.source,
        {
          kind,
          tags: this.tags.split(",").map((s) => s.trim()).filter(Boolean),
          maxImages: this.maxImages,
        },
        (m) => prog.update(m),
      );
      prog.update(`已采集【${res.kind_label}】${res.title}`);
      if (res.warnings.length) new Notice(res.warnings.join("\n"), 8000);

      if (this.processNow) {
        await this.plugin.processObjectWithFeedback(res.id, prog);
      } else {
        prog.done("已进入 Inbox");
      }
      this.plugin.emit("data-changed", { reason: "ingest" });
      this.close();
    } catch (e) {
      prog.fail(e);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function labelOf(k: ResourceKind): string {
  return { html: "网页", video: "视频", audio: "音频", code: "代码仓库" }[k] ?? k;
}
