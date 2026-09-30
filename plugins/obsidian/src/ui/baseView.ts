/**
 * 视图基类：统一「标题栏 + 工具条 + 内容区 + 数据变更自动刷新 + 销毁解绑」。
 * 所有具体视图只实现 `render()`，不重复处理生命周期，避免订阅泄漏。
 */
import { ItemView, WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { iconEl, loading } from "./components";

export abstract class ProsView extends ItemView {
  protected body!: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private rendering = false;
  private pending = false;

  constructor(
    leaf: WorkspaceLeaf,
    protected plugin: PersonalResourceOSPlugin,
    private viewType: string,
    private displayText: string,
    /** 图标名（避开 ItemView 自带的 icon 属性，防止与宿主语义冲突）。 */
    private iconName: string,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return this.viewType;
  }
  getDisplayText(): string {
    return this.displayText;
  }
  getIcon(): string {
    return this.iconName;
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("pros-view");
    const header = this.contentEl.createDiv({ cls: "pros-view-header" });
    const titleRow = header.createDiv({ cls: "pros-view-title-row" });
    titleRow.appendChild(iconEl(this.iconName, "pros-view-icon"));
    titleRow.createEl("h2", { text: this.displayText, cls: "pros-view-title" });
    this.buildToolbar(header);
    this.body = this.contentEl.createDiv({ cls: "pros-view-body" });

    // 数据变化自动刷新（带重入保护：渲染中再次触发只标记 pending，结束后补一次）
    this.unsubscribe = this.plugin.on("data-changed", () => void this.refresh());
    await this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  /** 子类可覆写以放置工具条按钮。 */
  protected buildToolbar(_header: HTMLElement): void {
    /* 默认无工具条 */
  }

  /** 对外刷新入口（带重入保护与骨架屏）。 */
  async refresh(): Promise<void> {
    if (this.rendering) {
      this.pending = true;
      return;
    }
    this.rendering = true;
    try {
      this.body.empty();
      loading(this.body, "加载中…");
      this.body.empty();
      await this.render();
    } catch (e) {
      this.body.empty();
      const box = this.body.createDiv({ cls: "pros-error" });
      box.createEl("strong", { text: "渲染失败：" });
      box.createEl("pre", { text: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) });
      console.error("[PROS] 视图渲染失败", e);
    } finally {
      this.rendering = false;
      if (this.pending) {
        this.pending = false;
        void this.refresh();
      }
    }
  }

  /** 具体视图实现渲染逻辑。 */
  protected abstract render(): Promise<void>;
}
