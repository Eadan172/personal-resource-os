/**
 * Personal Resource OS · Obsidian 插件主类（薄宿主 + 可切换核心）。
 *
 * 架构落点（对应 ADR-001 / TB-1 / TB-5）：
 *   ┌──────────────┐   CoreBridge    ┌────────────────────────────┐
 *   │  src/ui/**   │ ──────────────► │ LocalBridge（插件内 TS 核心）│
 *   │  仅 UI，无领域 │                 │ HttpBridge（127.0.0.1:8765）│
 *   └──────────────┘                 └────────────────────────────┘
 *  · UI 只依赖 `this.bridge`（CoreBridge 接口），因此「换核心」不动一行 UI 代码；
 *  · 插件只做：打开视图 / 弹窗 / 读写 vault 文件 / 提供宿主能力（requestUrl、文件选择）；
 *  · 领域逻辑（分类、检索、RAG、审计、回滚、预算）全部在 core/ 内，且 core/ 不引用 obsidian，
 *    因此同一份核心能被 Node 脚本直接加载做离线断言（见 tests/）。
 *
 * 安全相关的三个统一出口（避免散落在各处导致遗漏）：
 *  1. `beforeOutbound` —— 所有携带密钥的外发在发出前都会经过这里（可拒绝）；
 *  2. `checkOutbound` —— 域名白名单校验在 Provider 层强制，UI 无法绕过；
 *  3. 审计 —— 任何写操作都走 Store 的受控方法，留下 before/after 快照。
 */
import {
  ItemView, Notice, Plugin, WorkspaceLeaf, requestUrl,
} from "obsidian";
import { normalizeSettings, toCoreConfig } from "./settings";
import { VIEW_TYPES, type ProsEvents, type ProsSettings, type ViewType } from "./types";
import { mergeConfig, type CoreConfig } from "./core/config";
import { Store } from "./core/store";
import { ObsidianVaultFs } from "./vault/vaultFs";
import { createBridge, type BridgePreference, type CoreBridge, type CoreStatus } from "./bridge";
import type { HttpClient } from "./core/providers/base";
import { detectType, type ResourceKind } from "./core/ingest/common";
import { confirm as confirmModal, openForm, ProgressNotice, type FormField } from "./ui/components";
import { CaptureModal, VaultFileSuggestModal } from "./ui/captureModal";
import { LinkIngestModal } from "./ui/linkIngestModal";
import { DashboardView } from "./ui/dashboardView";
import { InboxView } from "./ui/inboxView";
import { TaskView } from "./ui/taskView";
import { SearchView } from "./ui/searchView";
import { ChatView } from "./ui/chatView";
import { SummaryView } from "./ui/summaryView";
import { ApprovalView } from "./ui/approvalView";
import { AuditView } from "./ui/auditView";
import { ObjectView } from "./ui/objectView";
import { GraphView } from "./ui/graphView";
import { TimelineView } from "./ui/timelineView";
import { ProsSettingTab } from "./ui/settingsTab";
import type { Citation } from "./core/rag";

/** 观察者热键类型（与 Obsidian 的 Hotkey 结构一致，避免额外类型依赖）。 */
type ProsHotkey = { modifiers: ("Mod" | "Ctrl" | "Meta" | "Shift" | "Alt")[]; key: string };

/** 需要「宽屏主区域」打开的视图（其余默认落在右侧边栏）。 */
const WIDE_VIEWS = new Set<string>([VIEW_TYPES.object, VIEW_TYPES.graph, VIEW_TYPES.timeline]);

type EventHandler = (payload: unknown) => void;

export default class PersonalResourceOSPlugin extends Plugin {
  settings!: ProsSettings;
  bridge!: CoreBridge;
  /** auto 模式下发生「回退到插件内核心」时的说明；null 表示当前无降级提示。 */
  bridgeNote: string | null = null;

  private store!: Store;
  private vaultFs!: ObsidianVaultFs;
  private http!: HttpClient;
  private listeners = new Map<string, Set<EventHandler>>();
  private lastBaseDir = "";
  private progressSeq = 0;
  /** 正在进行的长任务（id → 描述）；用于状态栏提示，避免与弹窗进度重复打扰。 */
  private runningTasks = new Map<number, string>();
  private titleCache = new Map<string, string>();
  private statusEl: HTMLElement | null = null;

  // ----------------------------------------------------------- 生命周期 ---

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    this.vaultFs = new ObsidianVaultFs(this.app.vault.adapter);
    this.http = createObsidianHttpClient();

    await this.initCore();
    this.registerViews();
    this.registerRibbon();
    this.registerCommands();
    this.addSettingTab(new ProsSettingTab(this.app, this));
    this.registerStatusBar();

    // 索引库变更统一广播（Store.touch/flush 后触发），视图订阅 data-changed 自动刷新
    this.refreshTitleCache();

    this.log(
      `已加载：后端=${this.bridge.meta.mode} Provider=${this.bridge.meta.provider}` +
        ` 索引库=${this.bridge.meta.baseDir}`,
    );
    this.log("设置", this.settings);
  }

  onunload(): void {
    this.listeners.clear();
    this.runningTasks.clear();
  }

  /**
   * 调试日志：**只在设置里开启 debug 时输出**。
   * 为什么不做成无条件输出 —— Obsidian 社区插件目录会扫描构建产物，
   * 无条件的控制台日志属于被标记项；真正需要用户知晓的信息一律走 Notice / 视图，
   * 而 error 级日志只用于「出问题需要排障」的场景（保留，便于用户反馈日志）。
   */
  log(...args: unknown[]): void {
    if (this.settings?.ui?.debug) console.log("[PROS]", ...args);
  }

  // -------------------------------------------------------- 核心与桥接 ---

  /** 首次初始化：打开索引库 + 创建桥接。 */
  private async initCore(): Promise<void> {
    const cfg = toCoreConfig(this.settings);
    this.store = await Store.open(this.vaultFs, cfg);
    this.store.onChange = () => this.emit("data-changed", { reason: "store" });
    this.lastBaseDir = cfg.baseDir;
    await this.rebuildBridge(false);
  }

  /**
   * 重建桥接（设置变更后的热切换）。
   * baseDir 变化时必须重新打开索引库（数据落点完全不同），否则只更新配置对象。
   */
  private async rebuildBridge(persist: boolean): Promise<void> {
    if (persist) await this.saveData(this.settings);
    const cfg: CoreConfig = mergeConfig(toCoreConfig(this.settings));

    if (this.lastBaseDir && this.lastBaseDir !== cfg.baseDir) {
      this.store = await Store.open(this.vaultFs, cfg);
      this.store.onChange = () => this.emit("data-changed", { reason: "store" });
      this.lastBaseDir = cfg.baseDir;
    } else {
      this.store.cfg = cfg;
    }

    const result = await createBridge({
      preference: this.settings.bridgePreference as BridgePreference,
      cfg,
      store: this.store,
      http: this.http,
      coreUrl: this.settings.coreUrl,
      authToken: this.settings.coreToken || undefined,
      beforeOutbound: (info) => this.confirmOutbound(info),
    });
    this.bridge = result.bridge;
    this.bridgeNote = result.note ?? null;
    this.updateStatusBar();
    this.emit("bridge-changed", { mode: this.bridge.meta.mode });
    this.emit("data-changed", { reason: "bridge" });
  }

  /** 保存设置；可选让新配置立即生效（切 Provider / 切后端 / 改目录时必须）。 */
  async saveSettings(opts: { reloadBridge?: boolean } = {}): Promise<void> {
    if (opts.reloadBridge) {
      await this.rebuildBridge(true);
    } else {
      await this.saveData(this.settings);
    }
  }

  /** 探测当前后端连通性（设置页「测试连接」按钮）。 */
  async pingBridge(): Promise<CoreStatus> {
    try {
      return await this.bridge.ping();
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  // ------------------------------------------------------------ 事件总线 ---

  on<K extends keyof ProsEvents>(event: K, cb: (payload: ProsEvents[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set<EventHandler>();
      this.listeners.set(event, set);
    }
    const handler = cb as EventHandler;
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  emit<K extends keyof ProsEvents>(event: K, payload: ProsEvents[K]): void {
    // 数据变化的旁路副作用：刷新标题缓存 + 更新状态栏计数
    if (event === "data-changed") {
      this.refreshTitleCache();
      this.updateStatusBar();
    }
    if (event === "bridge-changed") this.updateStatusBar();

    const set = this.listeners.get(event as string);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (e) {
        console.error(`[PROS] 事件处理失败（${String(event)}）`, e);
      }
    }
  }

  // ---------------------------------------------------------------- UI ---

  private registerViews(): void {
    const defs: [string, (leaf: WorkspaceLeaf) => ItemView][] = [
      [VIEW_TYPES.dashboard, (l) => new DashboardView(l, this)],
      [VIEW_TYPES.inbox, (l) => new InboxView(l, this)],
      [VIEW_TYPES.tasks, (l) => new TaskView(l, this)],
      [VIEW_TYPES.search, (l) => new SearchView(l, this)],
      [VIEW_TYPES.chat, (l) => new ChatView(l, this)],
      [VIEW_TYPES.summary, (l) => new SummaryView(l, this)],
      [VIEW_TYPES.approval, (l) => new ApprovalView(l, this)],
      [VIEW_TYPES.audit, (l) => new AuditView(l, this)],
      [VIEW_TYPES.object, (l) => new ObjectView(l, this)],
      [VIEW_TYPES.graph, (l) => new GraphView(l, this)],
      [VIEW_TYPES.timeline, (l) => new TimelineView(l, this)],
    ];
    for (const [type, factory] of defs) this.registerView(type, factory);
  }

  private registerRibbon(): void {
    if (!this.settings.ui.ribbon) return;
    this.addRibbonIcon("boxes", "个人资源管家：打开 Dashboard", () => void this.activateView(VIEW_TYPES.dashboard));
    this.addRibbonIcon("plus-circle", "个人资源管家：快速记录", () => this.openCapture());
  }

  private registerStatusBar(): void {
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("pros-statusbar-item");
    this.statusEl.addEventListener("click", () => void this.activateView(VIEW_TYPES.dashboard));
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (!this.statusEl || !this.bridge) return;
    // 有长任务时优先展示任务，让用户知道后台在忙什么
    const running = [...this.runningTasks.values()].pop();
    if (running) {
      this.statusEl.setText(`⏳ ${running}`);
      this.statusEl.setAttr("aria-label", "资源管家正在处理，点击打开 Dashboard");
      return;
    }
    const mode = this.bridge.meta.mode === "http" ? "Core" : "内置";
    const offline = this.bridge.meta.offline ? "·离线" : "";
    const stats = this.store?.stats();
    const inbox = stats ? stats.inbox : 0;
    this.statusEl.setText(`资源管家 ${mode}${offline} · Inbox ${inbox}`);
    this.statusEl.setAttr("aria-label", this.bridge.meta.version);
  }

  /** 打开（或聚焦）某个视图；返回视图实例便于外部设置上下文。 */
  async activateView(viewType: ViewType, preferTab = false): Promise<ItemView | null> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType);
    if (existing.length) {
      await workspace.revealLeaf(existing[0]);
      // WorkspaceLeaf.view 的静态类型是基类 View，这里收窄为 ItemView（本插件注册的都是 ItemView）
      return existing[0].view as unknown as ItemView;
    }

    const useTab = preferTab || WIDE_VIEWS.has(viewType);
    let leaf: WorkspaceLeaf | null = null;
    if (useTab) {
      leaf = workspace.getLeaf(true);
    } else {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) leaf = workspace.getLeaf(true);
    }
    if (!leaf) {
      new Notice("无法创建视图（当前工作区不可用）");
      return null;
    }
    await leaf.setViewState({ type: viewType, active: true });
    await workspace.revealLeaf(leaf);
    return leaf.view as unknown as ItemView;
  }

  openSettings(): void {
    // 打开 Obsidian 设置并定位到本插件页
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /** 确认对话框（统一入口，便于以后换成带"记住选择"的实现）。 */
  confirm(title: string, message: string, danger = false, detail?: string): Promise<boolean> {
    return confirmModal(this.app, { title, message, danger, detail, cta: danger ? "确认执行" : "确认" });
  }

  openForm(opts: { title: string; description?: string; fields: FormField[]; cta?: string; onSubmit: (v: Record<string, string | number | boolean>) => void | Promise<void> }): Promise<void> {
    return openForm(this.app, opts);
  }

  // ------------------------------------------------------------ 长任务 ---

  /**
   * 开始一个长任务：在状态栏显示「⏳ 描述」。
   * 刻意不用 Notice —— 具体进度由业务侧的 ProgressNotice 负责，这里只做全局状态提示，
   * 避免同一次操作弹出两个互相覆盖的提示。
   */
  beginTask(message: string): number {
    const id = ++this.progressSeq;
    this.runningTasks.set(id, message);
    this.updateStatusBar();
    return id;
  }

  endTask(id: number): void {
    if (!this.runningTasks.delete(id)) return;
    this.updateStatusBar();
  }

  // ------------------------------------------------------------ 采集入口 ---

  openCapture(preset?: { content?: string; title?: string; tags?: string }): void {
    new CaptureModal(this, preset).open();
  }

  openLinkIngest(preset?: { source?: string }): void {
    new LinkIngestModal(this, preset).open();
  }

  /** 从剪贴板采集（命令入口）。 */
  async captureClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return void new Notice("剪贴板为空");
      this.openCapture({ content: text });
    } catch {
      new Notice("无法读取剪贴板（请检查系统权限）");
    }
  }

  /** 采集当前打开笔记的全部内容。 */
  async captureActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) return void new Notice("没有打开的笔记");
    const content = await this.app.vault.read(file);
    this.openCapture({ content, title: file.basename, tags: "obsidian/note" });
  }

  /** 采集当前选中内容（编辑器选区）。 */
  async captureSelection(): Promise<void> {
    const editor = this.app.workspace.activeEditor?.editor;
    const sel = editor?.getSelection();
    if (!sel?.trim()) return void new Notice("当前没有选中内容");
    this.openCapture({ content: sel });
  }

  /** 采集 vault 内某个文件（Obsidian 用模糊搜索代替原生文件选择器）。 */
  pickVaultFileToCapture(): void {
    const files = this.app.vault.getFiles().map((f) => f.path);
    if (!files.length) return void new Notice("vault 里还没有文件");
    new VaultFileSuggestModal(this.app, files, (path) => void this.captureVaultPath(path)).open();
  }

  async captureVaultPath(path: string): Promise<void> {
    const prog = new ProgressNotice("采集 vault 文件");
    prog.update(`读取 ${path}…`);
    try {
      const bytes = await this.app.vault.adapter.readBinary(path);
      const name = path.split("/").pop() ?? path;
      await this.captureBytes(name, bytes, { sourceUri: path, sourceChannel: "obsidian" });
      prog.done(`已进入 Inbox（${name}）`);
      this.emit("data-changed", { reason: "capture-vault-file" });
    } catch (e) {
      prog.fail(e);
    }
  }

  /** 采集从系统拖入/选择的本地文件（File 对象来自浏览器 input 或 drop 事件）。 */
  async captureExternalFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    const prog = new ProgressNotice("文件采集");
    let ok = 0;
    const failed: string[] = [];
    for (const f of files) {
      prog.update(`读取 ${f.name}…`);
      try {
        const bytes = await f.arrayBuffer();
        await this.captureBytes(f.name, bytes, {
          mime: f.type || undefined,
          sourceUri: null,
          sourceChannel: "drop",
        });
        ok++;
      } catch (e) {
        failed.push(f.name);
        console.error("[PROS] 文件采集失败", f.name, e);
      }
    }
    prog.done(`${ok}/${files.length} 个文件入库${failed.length ? `，失败：${failed.join("、")}` : ""}`);
    this.emit("data-changed", { reason: "capture-files" });
  }

  /** 二进制采集的公共路径：文本类文件顺带解码正文，避免用户拿到一堆"二进制占位"。 */
  private async captureBytes(
    filename: string,
    bytes: ArrayBuffer,
    opts: { mime?: string; sourceUri: string | null; sourceChannel: "obsidian" | "drop" },
  ): Promise<void> {
    const isTextish = /\.(md|markdown|txt|html?|json|csv|tsv|ya?ml|log|py|js|mjs|ts|tsx|jsx|java|go|rs|c|cpp|h|sql|css)$/i.test(filename);
    let textContent: string | null = null;
    if (isTextish) {
      try {
        textContent = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        textContent = null;
      }
    }
    await this.bridge.captureBinary({
      filename,
      bytes,
      mime: opts.mime,
      sourceUri: opts.sourceUri,
      sourceChannel: opts.sourceChannel,
      textContent,
    });
  }

  /** 识别链接类型（供采集弹窗实时提示；无法识别时抛错，由调用方展示）。 */
  detectSourceType(source: string): ResourceKind {
    return detectType(source);
  }

  // -------------------------------------------------------- 对象与处理 ---

  lastKnownTitle(id: string): string | null {
    return this.titleCache.get(id) ?? null;
  }

  private refreshTitleCache(): void {
    void this.bridge
      .objects({ lifecycle: "all", limit: 3000 })
      .then((list) => {
        this.titleCache.clear();
        for (const o of list) this.titleCache.set(o.id, o.title);
      })
      .catch(() => undefined);
  }

  async openObject(id: string, highlight?: { exact: string }): Promise<void> {
    const view = await this.activateView(VIEW_TYPES.object);
    if (view instanceof ObjectView) {
      view.setObject(id, highlight ? { start: 0, end: 0, exact: highlight.exact } : null);
    } else {
      console.warn("[PROS] 对象详情视图未就绪");
    }
  }

  async openAuditFor(objectId: string | null): Promise<void> {
    const view = await this.activateView(VIEW_TYPES.audit);
    if (view instanceof AuditView) view.focusOn(objectId);
  }

  async openGraphFor(objectId: string | null): Promise<void> {
    const view = await this.activateView(VIEW_TYPES.graph);
    if (view instanceof GraphView) view.focusOn(objectId);
  }

  /** 打开 AI 问答并预填问题（检索视图「转问答」入口）。 */
  async openChat(question?: string): Promise<void> {
    const view = await this.activateView(VIEW_TYPES.chat);
    if (view instanceof ChatView && question?.trim()) view.prefill(question.trim());
  }

  /**
   * 引用跳回原文。
   * 诚实降级：vault 笔记是「渲染后的产物」，字符偏移对不上原文，
   * 因此这里打开对象详情并把 exact_text 高亮标出，而不是假装能精确定位到笔记行号。
   */
  async openCitation(c: Citation): Promise<void> {
    const obj = await this.bridge.object(c.object_id);
    if (!obj) return void new Notice(`引用对象不存在：${c.object_id}`);
    let exact = c.exact_text;
    if (exact && !obj.content.includes(exact)) {
      const guess = obj.content.slice(c.span.start, c.span.end);
      exact = guess || "";
    }
    await this.openObject(c.object_id, exact ? { exact } : undefined);
  }

  /** 处理单条对象，并把结果汇总到进度提示里。 */
  async processObjectWithFeedback(id: string, prog: ProgressNotice): Promise<void> {
    prog.update("Agent 处理中：分类 → 摘要 → 实体 → 任务 → 关系…");
    const r = await this.bridge.processObject(id, (m) => prog.update(m));
    if (r.status === "error") {
      prog.fail(r.error ?? "处理失败（原始内容已安全保留）");
      return;
    }
    if (r.status === "skipped") {
      prog.done("已跳过（内容为空或无需处理）");
      return;
    }
    const bits: string[] = [];
    if (r.tasks) bits.push(`新增待办 ${r.tasks} 条`);
    if (r.relations) bits.push(`关系建议 ${r.relations} 条`);
    if (r.note_path) bits.push("已写入结构化笔记");
    prog.done(bits.join("；") || "处理完成");
  }

  // ------------------------------------------------------------ 命令注册 ---

  private registerCommands(): void {
    const cmd = (id: string, name: string, callback: () => unknown, hotkeys?: ProsHotkey[]) =>
      this.addCommand({ id, name, callback: () => void callback(), hotkeys });

    // 视图
    cmd("open-dashboard", "打开：Dashboard", () => this.activateView(VIEW_TYPES.dashboard));
    cmd("open-inbox", "打开：Inbox", () => this.activateView(VIEW_TYPES.inbox));
    cmd("open-tasks", "打开：任务中心", () => this.activateView(VIEW_TYPES.tasks));
    cmd("open-search", "打开：检索", () => this.activateView(VIEW_TYPES.search));
    cmd("open-chat", "打开：AI 问答", () => this.activateView(VIEW_TYPES.chat));
    cmd("open-summary", "打开：阶段总结", () => this.activateView(VIEW_TYPES.summary));
    cmd("open-approvals", "打开：审批中心", () => this.activateView(VIEW_TYPES.approval));
    cmd("open-audit", "打开：审计与回滚", () => this.activateView(VIEW_TYPES.audit));
    cmd("open-graph", "打开：关系图谱", () => this.activateView(VIEW_TYPES.graph));
    cmd("open-timeline", "打开：时间线", () => this.activateView(VIEW_TYPES.timeline));

    // 采集入口（FR-01 多入口）
    cmd("capture-quick", "采集：快速记录（文本框）", () => this.openCapture(), [
      { modifiers: ["Mod", "Shift"], key: "I" },
    ]);
    cmd("capture-link", "采集：链接（网页/视频/代码）", () => this.openLinkIngest(), [
      { modifiers: ["Mod", "Shift"], key: "L" },
    ]);
    cmd("capture-clipboard", "采集：剪贴板", () => this.captureClipboard());
    cmd("capture-active-note", "采集：当前笔记到 Inbox", () => this.captureActiveNote());
    cmd("capture-selection", "采集：当前选中内容", () => this.captureSelection());
    cmd("capture-vault-file", "采集：vault 内文件…", () => this.pickVaultFileToCapture());

    // 处理与维护
    cmd("process-inbox", "处理：处理 Inbox 全部内容", () => this.processInboxAll(), [
      { modifiers: ["Mod", "Shift"], key: "P" },
    ]);
    cmd("reindex", "维护：重建检索索引", () => this.rebuildIndex());
    cmd("backup", "维护：立即备份索引库", () => this.runBackup());
    cmd("export-json", "维护：导出索引库 JSON", () => this.runExport());
    cmd("test-core", "维护：测试后端连接", () => this.testCore());
  }

  private async processInboxAll(): Promise<void> {
    const stats = this.store.stats();
    if (!stats.inbox) return void new Notice("Inbox 里没有待处理内容");
    const ok = await this.confirm(
      "处理 Inbox 全部内容？",
      `将对 ${stats.inbox} 条内容执行：分类、摘要、实体与待办提取、关系建议，并生成结构化笔记。` +
        "原始内容不会被改写；失败项会保留并标记，稍后可重试。",
    );
    if (!ok) return;

    const prog = new ProgressNotice("批量处理");
    prog.update(`共 ${stats.inbox} 条…`);
    try {
      const results = await this.bridge.processInbox({
        limit: 200,
        onProgress: (m) => prog.update(m),
      });
      const done = results.filter((r) => r.status === "processed").length;
      const failed = results.filter((r) => r.status === "error").length;
      prog.done(`成功 ${done} 条${failed ? `，失败 ${failed} 条（已保留原文）` : ""}`);
      this.emit("data-changed", { reason: "process-inbox" });
    } catch (e) {
      prog.fail(e);
    }
  }

  private async rebuildIndex(): Promise<void> {
    const prog = new ProgressNotice("重建索引");
    prog.update("扫描对象…");
    try {
      const r = await this.bridge.rebuildIndex();
      prog.done(`${r.objects} 个对象已索引`);
    } catch (e) {
      prog.fail(e);
    }
  }

  private async runBackup(): Promise<void> {
    const prog = new ProgressNotice("备份");
    prog.update("打包索引库…");
    try {
      const r = await this.bridge.backup();
      prog.done(r.backup_dir);
    } catch (e) {
      prog.fail(e);
    }
  }

  private async runExport(): Promise<void> {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const path = `${this.settings.core.baseDir.replace(/\/+$/, "")}/exports/pros-export-${stamp}.json`;
    const prog = new ProgressNotice("导出");
    try {
      const p = await this.bridge.exportJson(path);
      prog.done(p);
      await this.app.workspace.openLinkText(p, "", false);
    } catch (e) {
      prog.fail(e);
    }
  }

  private async testCore(): Promise<void> {
    const st = await this.pingBridge();
    new Notice(`${st.ok ? "✓" : "✗"} ${st.message}${st.detail ? `\n${st.detail}` : ""}`, st.ok ? 5000 : 9000);
  }

  // -------------------------------------------------------- 外发前置确认 ---

  /**
   * 所有携带密钥/内容的出站请求的前置钩子。
   * 默认策略：`confirmBeforeOutbound` 开启时弹窗；关闭时放行（但仍会被 allowlist 与审计约束）。
   */
  private async confirmOutbound(info: { host: string; purpose: string; bytes: number }): Promise<boolean> {
    if (!this.settings.core.confirmBeforeOutbound) return true;
    return this.confirm(
      "即将向外部服务发送数据",
      `目标：${info.host}\n用途：${info.purpose}\n大小：约 ${info.bytes} 字节\n\n` +
        "拒绝后本次请求会被取消，本地数据不受影响。",
    );
  }
}

// ---------------------------------------------------------------- HTTP ---

/**
 * Obsidian 渲染进程的 HTTP 客户端实现。
 * 用 Obsidian 的 `requestUrl` 而不是 window.fetch：规避 CORS、并让桌面端复用 Electron 网络栈。
 */
function createObsidianHttpClient(): HttpClient {
  return {
    async request(req) {
      const res = await requestUrl({
        url: req.url,
        method: req.method ?? "GET",
        headers: req.headers,
        body: req.binaryBody ?? req.body,
        throw: false,
      });
      return {
        status: res.status,
        text: res.text,
        headers: flattenHeaders(res.headers),
      };
    },
    async fetchBinary(url, opts) {
      const res = await requestUrl({
        url,
        method: "GET",
        headers: opts?.headers,
        throw: false,
      });
      return {
        status: res.status,
        bytes: res.arrayBuffer,
        contentType: res.headers?.["content-type"] ?? res.headers?.["Content-Type"] ?? "",
      };
    },
  };
}

function flattenHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v;
  return out;
}
