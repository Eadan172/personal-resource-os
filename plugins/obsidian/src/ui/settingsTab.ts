/**
 * 设置页（FR-13 / FR-14 / FR-15）。
 *
 * 这是整套「信任边界」的集中控制台，按重要性从上到下排列：
 *  1. 后端（插件内轻量核心 / 本地 Python Core）——决定重活能力与是否真正薄宿主；
 *  2. Provider 与密钥 ——决定「会不会外发」以及外发到谁家；
 *  3. 目录 ——索引库、笔记、收集箱的落点（全部限制在 vault 内）；
 *  4. 出站与数据分级 ——最小开放原则的执行处（白名单 + private 禁发 + 二次确认）；
 *  5. Agent 预算与审批策略 ——硬上限在此处仅展示（配置无法突破，见 HARD_LIMITS）；
 *  6. Connector ——外部入口开关（默认全关，需显式启用）；
 *  7. 数据运维 ——导出 / 备份 / 恢复 / 重建索引。
 *
 * 约定：所有写入都调用 `plugin.saveSettings()`；涉及 Provider 或后端的改动额外触发
 * `reloadBridge: true`，让新配置立刻生效（否则用户会以为改了没生效）。
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { DEFAULT_CORE_CONFIG, HARD_LIMITS, mergeConfig } from "../core/config";
import { DEFAULT_BUDGETS, type AgentDef, type ConnectorState } from "../core/models";
import { maskSecret, validVaultFolder } from "../settings";
import { FormModal, ProgressNotice, confirm, fmtRelative } from "./components";

export class ProsSettingTab extends PluginSettingTab {
  private busy = false;

  constructor(app: App, private plugin: PersonalResourceOSPlugin) {
    super(app, plugin);
  }

  display(): void {
    void this.renderAll();
  }

  private async renderAll(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("pros-settings");

    containerEl.createEl("h2", { text: "个人资源管家 · 设置" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "本插件的铁律：本地数据是唯一事实源；AI 只提出建议；一切外发走白名单并留痕；一切变更可回滚。" +
        "下面每一项都对应一条边界，改动即时生效。",
    });

    this.sectionBridge(containerEl);
    this.sectionProvider(containerEl);
    this.sectionDirs(containerEl);
    this.sectionBoundaries(containerEl);
    this.sectionIngest(containerEl);
    this.sectionRetrieval(containerEl);
    this.sectionUi(containerEl);
    await this.sectionAgents(containerEl);
    await this.sectionConnectors(containerEl);
    this.sectionOps(containerEl);
  }

  // ------------------------------------------------------------ 1. 后端 ---

  private sectionBridge(root: HTMLElement): void {
    root.createEl("h3", { text: "① 后端（Core）" });
    const s = this.plugin.settings;

    new Setting(root)
      .setName("后端模式")
      .setDesc(
        "auto：优先连接本地 Python Core，连不上自动回退到插件内轻量核心；" +
          "local：只用插件内核心（零依赖，但无法下载视频/转写/抽帧）；" +
          "http：强制使用 Python Core（连不上时会明确报错，不会静默退化）。",
      )
      .addDropdown((d) =>
        d
          .addOption("auto", "auto（自动探测，推荐）")
          .addOption("local", "local（仅插件内核心）")
          .addOption("http", "http（强制 Python Core）")
          .setValue(s.bridgePreference)
          .onChange(async (v) => {
            s.bridgePreference = v as typeof s.bridgePreference;
            await this.save(true);
          }),
      );

    new Setting(root)
      .setName("Core 地址")
      .setDesc("Python Core 的本地监听地址（默认 127.0.0.1:8765，仅本机可访问）")
      .addText((t) =>
        t
          .setPlaceholder("http://127.0.0.1:8765")
          .setValue(s.coreUrl)
          .onChange(async (v) => {
            s.coreUrl = v.trim() || "http://127.0.0.1:8765";
            await this.save(true);
          }),
      );

    new Setting(root)
      .setName("Core 访问 Token")
      .setDesc("仅当 Core 侧启用了鉴权时填写；留空表示无鉴权（本机回环地址）")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.coreToken).onChange(async (v) => {
          s.coreToken = v;
          await this.save(true);
        });
      });

    const status = new Setting(root).setName("连接状态").setDesc("点击右侧按钮探测当前后端");
    status.addButton((b) =>
      b.setButtonText("测试连接").onClick(async () => {
        const st = await this.plugin.pingBridge();
        new Notice(st.ok ? `✓ ${st.message}` : `✗ ${st.message}`, st.ok ? 4000 : 8000);
        this.display();
      }),
    );
    this.statusLine(root, "当前后端", () => {
      const m = this.plugin.bridge.meta;
      return `${m.mode === "http" ? "Python Core" : "插件内核心"} ｜ Provider：${m.provider}${m.offline ? "（离线）" : ""} ｜ 索引库：${m.baseDir}`;
    });
    if (this.plugin.bridgeNote) {
      this.noteBox(root, "warn", this.plugin.bridgeNote);
    }
  }

  // -------------------------------------------------------- 2. Provider ---

  private sectionProvider(root: HTMLElement): void {
    root.createEl("h3", { text: "② AI Provider 与密钥" });
    const c = this.plugin.settings.core;

    this.noteBox(
      root,
      "info",
      "未配置密钥时使用内置 Mock Provider：完全离线、输出确定性（用于验证流程是否跑通）。" +
        "配置真实密钥后，AI 才会参与分类/摘要/问答，并且每次外发都会先过下方白名单与二次确认。",
    );

    new Setting(root)
      .setName("Provider")
      .setDesc("deepseek / qwen / openai_compat 为 OpenAI 兼容协议；local 指向你自己的本地模型网关")
      .addDropdown((d) =>
        d
          .addOption("mock", "mock（离线确定性，默认）")
          .addOption("deepseek", "DeepSeek")
          .addOption("qwen", "通义千问（DashScope 兼容模式）")
          .addOption("openai_compat", "其他 OpenAI 兼容服务")
          .addOption("local", "本地模型网关")
          .setValue(c.provider)
          .onChange(async (v) => {
            c.provider = v;
            await this.save(true);
          }),
      );

    new Setting(root).setName("模型名").addText((t) =>
      t.setValue(c.model).onChange(async (v) => {
        c.model = v.trim();
        await this.save(true);
      }),
    );

    new Setting(root)
      .setName("Base URL")
      .setDesc("该域名必须同时存在于下方「出站白名单」中，否则请求会被拒绝")
      .addText((t) =>
        t.setValue(c.baseUrl).onChange(async (v) => {
          c.baseUrl = v.trim();
          await this.save(true);
        }),
      );

    new Setting(root)
      .setName("密钥来源")
      .setDesc("plugin：存在插件数据文件（本地明文，最方便）；core：由 Python Core 的系统凭据库托管（更安全）")
      .addDropdown((d) =>
        d
          .addOption("plugin", "plugin（插件数据文件）")
          .addOption("core", "core（Python Core 凭据库）")
          .addOption("env", "env（环境变量 PROS_API_KEY）")
          .setValue(c.keySource)
          .onChange(async (v) => {
            c.keySource = v as typeof c.keySource;
            await this.save(true);
          }),
      );

    new Setting(root)
      .setName("API Key")
      .setDesc(
        c.keySource === "plugin"
          ? `当前：${maskSecret(c.apiKey)}。本机明文保存，请勿把 vault 同步到不可信位置。`
          : "当前密钥来源不是 plugin，此项被忽略（密钥由 Core / 环境变量提供）",
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-…");
        t.setDisabled(c.keySource !== "plugin");
        t.setValue(c.apiKey ?? "").onChange(async (v) => {
          c.apiKey = v.trim() || null;
          await this.save(true);
        });
      });

    new Setting(root)
      .setName("ASR 转写地址 / 模型")
      .setDesc("留空则不做语音转写；配置后视频采集可自动出文字稿（需 Core 或兼容接口）")
      .addText((t) =>
        t.setPlaceholder("https://…/v1").setValue(c.asrBaseUrl).onChange(async (v) => {
          c.asrBaseUrl = v.trim();
          await this.save(true);
        }),
      )
      .addText((t) =>
        t.setValue(c.asrModel).onChange(async (v) => {
          c.asrModel = v.trim();
          await this.save(true);
        }),
      );

    new Setting(root)
      .setName("视觉模型（关键帧读图）")
      .setDesc("留空则不做图像理解，视频只走字幕/转写路径")
      .addText((t) =>
        t.setValue(c.visionModel).onChange(async (v) => {
          c.visionModel = v.trim();
          await this.save(true);
        }),
      );
  }

  // ------------------------------------------------------------ 3. 目录 ---

  private sectionDirs(root: HTMLElement): void {
    root.createEl("h3", { text: "③ 目录（全部位于 vault 内）" });
    const c = this.plugin.settings.core;

    const dirs: [keyof typeof c, string, string][] = [
      ["baseDir", "索引库根目录", "存放 resource.db.json、采集原件、导出与备份"],
      ["notesDir", "笔记目录", "处理后的结构化笔记落盘位置"],
      ["inboxDir", "收集箱目录", "未处理原文的原始笔记（只增不改）"],
      ["projectsDir", "项目目录", "project 类型对象笔记"],
      ["peopleDir", "人物目录", "person 类型对象笔记"],
      ["meetingsDir", "会议目录", "meeting 类型对象笔记"],
    ];
    for (const [key, name, desc] of dirs) {
      new Setting(root)
        .setName(name)
        .setDesc(`${desc}（vault 相对路径，禁止 .. 与绝对路径）`)
        .addText((t) =>
          t.setValue(String(c[key])).onChange(async (v) => {
            const val = v.trim();
            if (!validVaultFolder(val)) {
              t.inputEl.addClass("pros-input-invalid");
              return;
            }
            t.inputEl.removeClass("pros-input-invalid");
            (c[key] as unknown as string) = val;
            await this.save(true);
          }),
        );
    }

    new Setting(root)
      .setName("打开索引库文件")
      .setDesc("索引库是可直接阅读的 JSON（单文件，便于你随时检查与手动备份）")
      .addButton((b) =>
        b.setButtonText("打开").onClick(() => {
          const path = `${c.baseDir.replace(/\/+$/, "")}/resource.db.json`;
          void this.app.workspace.openLinkText(path, "", false);
        }),
      );
  }

  // -------------------------------------------------------- 4. 信任边界 ---

  private sectionBoundaries(root: HTMLElement): void {
    root.createEl("h3", { text: "④ 出站与数据分级（信任边界）" });
    const c = this.plugin.settings.core;

    new Setting(root)
      .setName("允许插件直接出站")
      .setDesc("关闭后，所有需要网络的调用都委托给 Python Core（更集中管控，但必须 Core 在线）")
      .addToggle((t) =>
        t.setValue(c.allowDirectOutbound).onChange(async (v) => {
          c.allowDirectOutbound = v;
          await this.save(true);
        }),
      );

    new Setting(root)
      .setName("外发前二次确认")
      .setDesc("每次把内容发给云端模型前弹窗确认（强烈建议开启：这是「外发需明确标注」的兜底）")
      .addToggle((t) =>
        t.setValue(c.confirmBeforeOutbound).onChange(async (v) => {
          c.confirmBeforeOutbound = v;
          await this.save(true);
        }),
      );

    new Setting(root)
      .setName("出站域名白名单")
      .setDesc("每行一个域名。不在名单内的域名，携带密钥的请求一律被拒绝（默认最小开放）")
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.inputEl.addClass("pros-textarea");
        t.setValue(c.outboundAllowlist.join("\n")).onChange(async (v) => {
          const list = v
            .split(/[\n,]/)
            .map((x) => x.trim())
            .filter(Boolean);
          c.outboundAllowlist = list.length ? list : [...DEFAULT_CORE_CONFIG.outboundAllowlist];
          await this.save(true);
        });
      });

    new Setting(root)
      .setName("新内容默认数据分级")
      .setDesc("private 内容即使配置了密钥也永不外发（可用于隐私/机密材料）")
      .addDropdown((d) =>
        d
          .addOption("public", "public（允许外发）")
          .addOption("internal", "internal（默认）")
          .addOption("private", "private（禁止外发）")
          .setValue(c.defaultDataClass)
          .onChange(async (v) => {
            c.defaultDataClass = v as typeof c.defaultDataClass;
            await this.save(false);
          }),
      );

    new Setting(root)
      .setName("处理时机")
      .setDesc("immediate：采集后立刻处理；manual：手动点「处理」；nightly：留给定时任务")
      .addDropdown((d) =>
        d
          .addOption("immediate", "immediate（采集后立即）")
          .addOption("manual", "manual（手动）")
          .addOption("onSave", "onSave（笔记保存时）")
          .addOption("nightly", "nightly（夜间批量）")
          .setValue(c.processTiming)
          .onChange(async (v) => {
            c.processTiming = v as typeof c.processTiming;
            await this.save(false);
          }),
      );
  }

  // ------------------------------------------------------------ 5. 采集 ---

  private sectionIngest(root: HTMLElement): void {
    root.createEl("h3", { text: "⑤ 采集参数" });
    const c = this.plugin.settings.core;

    this.numSetting(root, "网页配图上限", "0 表示不下载配图（省流量与空间）", c.ingestMaxImages, 0, 100, async (n) => {
      c.ingestMaxImages = n;
      await this.save(false);
    });
    this.numSetting(root, "网页抓取滚动次数", "静态抓取时的滚动次数（仅 Core 在线时生效）", c.ingestScroll, 0, 30, async (n) => {
      c.ingestScroll = n;
      await this.save(false);
    });

    new Setting(root)
      .setName("默认采集标签")
      .setDesc("逗号分隔，会叠加到每条采集内容上")
      .addText((t) =>
        t.setValue(c.ingestTags.join(", ")).onChange(async (v) => {
          c.ingestTags = v.split(",").map((s) => s.trim()).filter(Boolean);
          await this.save(false);
        }),
      );

    new Setting(root)
      .setName("GitHub 镜像加速")
      .setDesc("每行一个（按顺序尝试）；插件内轻量核心只取元数据与 README，不下载整包")
      .addTextArea((t) => {
        t.inputEl.rows = 5;
        t.inputEl.addClass("pros-textarea");
        t.setValue(c.githubMirrors.join("\n")).onChange(async (v) => {
          c.githubMirrors = v.split("\n").map((s) => s.trim()).filter(Boolean);
          await this.save(false);
        });
      });
  }

  // -------------------------------------------------------- 6. 检索图谱 ---

  private sectionRetrieval(root: HTMLElement): void {
    root.createEl("h3", { text: "⑥ 检索与图谱" });
    const ui = this.plugin.settings.ui;

    new Setting(root)
      .setName("启用语义召回复排")
      .setDesc("需要 Provider 支持 embedding；关闭时使用纯词法检索（中文按 trigram 切分，离线可用）")
      .addToggle((t) =>
        t.setValue(ui.vectorSearch).onChange(async (v) => {
          ui.vectorSearch = v;
          await this.save(false);
        }),
      );

    this.numSetting(root, "关系图谱节点上限", "防止大库渲染卡顿（20–2000）", ui.graphLimit, 20, 2000, async (n) => {
      ui.graphLimit = n;
      await this.save(false);
    });

    new Setting(root)
      .setName("重建检索索引")
      .setDesc("索引在内存中构建；内容改动量大或检索结果异常时可手动重建")
      .addButton((b) =>
        b.setButtonText("重建").onClick(async () => {
          const prog = new ProgressNotice("重建索引");
          prog.update("扫描对象…");
          try {
            const r = await this.plugin.bridge.rebuildIndex();
            prog.done(`${r.objects} 个对象`);
          } catch (e) {
            prog.fail(e);
          }
        }),
      );
  }

  // ------------------------------------------------------------ 7. 界面 ---

  private sectionUi(root: HTMLElement): void {
    root.createEl("h3", { text: "⑦ 界面与行为" });
    const ui = this.plugin.settings.ui;

    const toggles: [keyof typeof ui, string, string][] = [
      ["ribbon", "在左侧功能区显示图标", "关闭后可通过命令面板（Ctrl+P）打开各视图"],
      ["autoProcessAfterCapture", "采集后自动处理", "自动分类、摘要、提取待办并生成结构化笔记"],
      ["confirmDelete", "删除前二次确认", "对所有删除与批量操作生效（强烈建议保持开启）"],
      ["includeContentInNotes", "笔记中包含完整原文", "关闭后只写摘要与结构化字段，笔记更精简"],
      ["debug", "输出调试日志", "在控制台打印详细流程，排障用"],
    ];
    for (const [key, name, desc] of toggles) {
      new Setting(root)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(Boolean(ui[key])).onChange(async (v) => {
            (ui[key] as unknown as boolean) = v;
            await this.save(false);
          }),
        );
    }

    new Setting(root)
      .setName("恢复本页默认值")
      .setDesc("只重置界面相关开关；目录、Provider、白名单与 Agent 配置不受影响")
      .addButton((b) =>
        b.setButtonText("重置界面设置").onClick(async () => {
          const ok = await confirm(this.app, {
            title: "重置界面设置？",
            message: "界面开关会恢复为默认值，其它配置保持不变。",
            cta: "重置",
          });
          if (!ok) return;
          this.plugin.settings.ui = {
            ribbon: true,
            confirmDelete: true,
            autoProcessAfterCapture: true,
            vectorSearch: false,
            graphLimit: 200,
            debug: false,
            includeContentInNotes: true,
          };
          await this.save(true);
          this.display();
        }),
      );
  }

  // ------------------------------------------------------------ 8. Agent ---

  private async sectionAgents(root: HTMLElement): Promise<void> {
    root.createEl("h3", { text: "⑧ Agent 与预算" });

    this.noteBox(
      root,
      "info",
      `预算硬上限（任何配置都无法突破）：单次最多 ${HARD_LIMITS.max_steps} 步 / ${HARD_LIMITS.timeout_s} 秒 / ` +
        `${HARD_LIMITS.max_tokens} tokens、重试 ${HARD_LIMITS.max_retries} 次、嵌套深度 ${HARD_LIMITS.max_depth}。` +
        "超出即中止并把原始内容标记为「待重试」，不会留下半成品。",
    );

    const c = this.plugin.settings.core;
    const budgetFields: [keyof typeof c.agentBudgets, string, number][] = [
      ["max_steps", "全局最大步数", HARD_LIMITS.max_steps],
      ["timeout_s", "全局超时（秒）", HARD_LIMITS.timeout_s],
      ["max_tokens", "全局 token 预算", HARD_LIMITS.max_tokens],
      ["max_retries", "全局重试次数", HARD_LIMITS.max_retries],
      ["max_depth", "全局嵌套深度", HARD_LIMITS.max_depth],
    ];
    for (const [key, name, hard] of budgetFields) {
      this.numSetting(root, name, `上限 ${hard}（超过会被自动夹取）`, c.agentBudgets[key], 0, hard, async (n) => {
        c.agentBudgets = { ...c.agentBudgets, [key]: n };
        await this.save(true);
      });
    }

    const agents = await this.plugin.bridge.agents();
    const head = new Setting(root)
      .setName(`Agent 列表（${agents.length}）`)
      .setDesc("内置 Agent 不可删除；自定义 Agent 可编辑工具白名单、审批策略与触发方式");
    head.addButton((b) =>
      b.setButtonText("新建自定义 Agent").setCta().onClick(() => this.editAgent(null)),
    );

    for (const a of agents) this.agentRow(root, a);
  }

  private agentRow(root: HTMLElement, a: AgentDef): void {
    const desc =
      `${a.purpose}\n` +
      `工具：${a.allowed_tools.join(", ") || "（无）"} ｜ 触发：${a.trigger} ｜ ` +
      `审批（读/写/外发）：${a.approval_policy.read}/${a.approval_policy.write}/${a.approval_policy.outbound} ｜ ` +
      `预算：${a.budgets.max_steps} 步 / ${a.budgets.timeout_s}s`;
    const s = new Setting(root).setName(`${a.name}${a.builtin ? "（内置）" : ""}`).setDesc(desc);
    s.addButton((b) =>
      b.setButtonText("运行").onClick(() => this.runAgentDialog(a)),
    );
    s.addExtraButton((b) =>
      b.setIcon("pencil").setTooltip("编辑").onClick(() => this.editAgent(a)),
    );
    if (!a.builtin) {
      s.addExtraButton((b) =>
        b.setIcon("trash").setTooltip("删除").onClick(async () => {
          const ok = await confirm(this.app, {
            title: `删除 Agent「${a.name}」？`,
            message: "删除后该 Agent 的运行记录仍保留在审计里。",
            danger: true,
            cta: "删除",
          });
          if (!ok) return;
          await this.plugin.bridge.removeAgent(a.name);
          this.display();
        }),
      );
    }
  }

  private editAgent(existing: AgentDef | null): void {
    const base: AgentDef = existing ?? {
      name: "my-agent",
      purpose: "我的自定义整理 Agent",
      instructions: "只读取内容并提出建议，不得改写原文；所有产物标注来源与置信度。",
      allowed_tools: ["search", "read_object"],
      allowed_scopes: { read: ["objects"], write: [] },
      trigger: "manual",
      approval_policy: { read: "auto", write: "confirm", outbound: "confirm" },
      failure_policy: { on_failure: "keep_raw_and_mark", retry: 1 },
      budgets: { ...DEFAULT_BUDGETS },
    };

    new FormModal(this.app, {
      title: existing ? `编辑 Agent：${existing.name}` : "新建自定义 Agent",
      description:
        "工具白名单决定它能碰什么；审批策略决定它是否需要你点头。默认「写操作需确认」，这是最安全的起点。",
      cta: "保存",
      fields: [
        { key: "name", label: "名称", value: base.name, required: true },
        { key: "purpose", label: "用途", value: base.purpose },
        { key: "instructions", label: "系统指令", type: "textarea", value: base.instructions },
        {
          key: "allowed_tools",
          label: "允许的工具",
          value: base.allowed_tools.join(", "),
          description: "可选：search, read_object, create_task, suggest_relation",
        },
        {
          key: "trigger",
          label: "触发方式",
          type: "dropdown",
          value: base.trigger,
          options: [
            { value: "manual", label: "手动（命令/按钮）" },
            { value: "event:inbox", label: "事件：新内容进入 Inbox" },
            { value: "cron:daily", label: "定时：每天" },
            { value: "cron:nightly", label: "定时：每天夜间" },
          ],
        },
        {
          key: "write_policy",
          label: "写操作审批",
          type: "dropdown",
          value: base.approval_policy.write,
          options: [
            { value: "auto", label: "auto（自动执行）" },
            { value: "confirm", label: "confirm（需审批，推荐）" },
            { value: "deny", label: "deny（禁止写）" },
          ],
        },
        {
          key: "outbound_policy",
          label: "外发审批",
          type: "dropdown",
          value: base.approval_policy.outbound,
          options: [
            { value: "auto", label: "auto" },
            { value: "confirm", label: "confirm（推荐）" },
            { value: "deny", label: "deny（禁止外发）" },
          ],
        },
        { key: "max_steps", label: "最大步数", type: "number", value: base.budgets.max_steps, description: `≤ ${HARD_LIMITS.max_steps}` },
        { key: "timeout_s", label: "超时（秒）", type: "number", value: base.budgets.timeout_s, description: `≤ ${HARD_LIMITS.timeout_s}` },
      ],
      onSubmit: async (v) => {
        const tools = String(v.allowed_tools ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const def: AgentDef = {
          ...base,
          name: String(v.name).trim(),
          purpose: String(v.purpose ?? ""),
          instructions: String(v.instructions ?? ""),
          allowed_tools: tools,
          trigger: String(v.trigger),
          approval_policy: {
            read: base.approval_policy.read,
            write: v.write_policy as "auto" | "confirm" | "deny",
            outbound: v.outbound_policy as "auto" | "confirm" | "deny",
          },
          budgets: mergeBudgets(base.budgets, Number(v.max_steps), Number(v.timeout_s)),
          builtin: existing?.builtin ?? false,
        };
        await this.plugin.bridge.upsertAgent(def);
        new Notice(`已保存 Agent「${def.name}」`);
        this.display();
      },
    }).open();
  }

  private runAgentDialog(a: AgentDef): void {
    new FormModal(this.app, {
      title: `运行 Agent：${a.name}`,
      description: "输入本次任务的目标或上下文。Agent 只能使用白名单内的工具，写操作会按审批策略处理。",
      cta: "开始运行",
      fields: [{ key: "input", label: "输入", type: "textarea", value: "", required: true }],
      onSubmit: async (v) => {
        const prog = new ProgressNotice(`Agent ${a.name}`);
        prog.update("运行中…");
        try {
          const r = await this.plugin.bridge.runAgent(a.name, String(v.input));
          prog.done(`状态：${r.status}`);
          new Notice(
            `运行结束：${r.status}${r.error ? `\n${r.error}` : ""}\n结果：${truncate(JSON.stringify(r.result ?? null), 300)}`,
            8000,
          );
          this.plugin.emit("data-changed", { reason: "agent-run" });
        } catch (e) {
          prog.fail(e);
        }
      },
    }).open();
  }

  // -------------------------------------------------------- 9. Connector ---

  private async sectionConnectors(root: HTMLElement): Promise<void> {
    root.createEl("h3", { text: "⑨ Connector（外部入口）" });
    this.noteBox(
      root,
      "warn",
      "Connector 让外部工具（WorkBuddy / 企业微信 / ima）把内容推入你的库。默认全部关闭。" +
        "经 Connector 进入的内容一律视为「不可信输入」，不会直接执行其携带的指令（防提示注入）。",
    );

    let list: ConnectorState[] = [];
    try {
      list = await this.plugin.bridge.connectors();
    } catch (e) {
      this.noteBox(root, "danger", `读取 Connector 失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    for (const c of list) {
      const s = new Setting(root)
        .setName(c.id)
        .setDesc(
          `类型：${c.kind} ｜ 能力：${c.scopes.join(", ") || "（无）"}` +
            `${c.secret_ref ? ` ｜ 凭据：${c.secret_ref}` : " ｜ 凭据：未配置"}` +
            `${c.last_error ? `\n最近错误：${c.last_error}` : ""}` +
            `${c.last_inbound_at ? `\n最近接收：${fmtRelative(c.last_inbound_at)}` : ""}`,
        );
      s.addToggle((t) =>
        t.setValue(c.enabled).onChange(async (v) => {
          if (v && !c.secret_ref) {
            new Notice("启用前请先配置凭据引用（secret_ref），否则外部无法完成鉴权", 6000);
          }
          await this.plugin.bridge.updateConnector({ ...c, enabled: v, audit: true });
          this.plugin.emit("data-changed", { reason: "connector" });
        }),
      );
      s.addExtraButton((b) =>
        b.setIcon("pencil").setTooltip("编辑 scopes / 凭据引用").onClick(() => {
          new FormModal(this.app, {
            title: `编辑 Connector：${c.id}`,
            description: "凭据本体不写在这里：只填「引用名」，真实密钥请放到 Python Core 的凭据库或环境变量。",
            cta: "保存",
            fields: [
              { key: "scopes", label: "允许的能力（逗号分隔）", value: c.scopes.join(", ") },
              {
                key: "secret_ref",
                label: "凭据引用名",
                value: c.secret_ref ?? "",
                placeholder: "例如 PROS_CONNECTOR_WORKBUDDY_TOKEN",
              },
              {
                key: "allowlist_outbound",
                label: "额外出站白名单（逗号分隔）",
                value: c.allowlist_outbound.join(", "),
              },
            ],
            onSubmit: async (v) => {
              await this.plugin.bridge.updateConnector({
                ...c,
                scopes: split(v.scopes),
                secret_ref: String(v.secret_ref ?? "").trim() || null,
                allowlist_outbound: split(v.allowlist_outbound),
                audit: true,
              });
              this.display();
            },
          }).open();
        }),
      );
    }

    root.createEl("p", {
      cls: "setting-item-description",
      text: "提示：Connector 的服务端实现位于 Python Core（/connectors/*）。插件内轻量核心不监听端口，因此 Connector 在 local 模式下不可用。",
    });
  }

  // ------------------------------------------------------------ 10. 运维 ---

  private sectionOps(root: HTMLElement): void {
    root.createEl("h3", { text: "⑩ 数据运维" });
    const c = this.plugin.settings.core;

    new Setting(root)
      .setName("导出索引库（JSON）")
      .setDesc("导出到索引库目录下的 exports/，可用于跨设备迁移或手工分析")
      .addButton((b) =>
        b.setButtonText("导出").onClick(async () => {
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          const path = `${c.baseDir.replace(/\/+$/, "")}/exports/pros-export-${stamp}.json`;
          const prog = new ProgressNotice("导出");
          prog.update("写入中…");
          try {
            const p = await this.plugin.bridge.exportJson(path);
            prog.done(p);
            void this.app.workspace.openLinkText(p, "", false);
          } catch (e) {
            prog.fail(e);
          }
        }),
      );

    new Setting(root)
      .setName("创建备份")
      .setDesc("备份包含索引库与 manifest（含 SHA-256 校验），恢复时会校验完整性")
      .addButton((b) =>
        b.setButtonText("立即备份").setCta().onClick(async () => {
          const prog = new ProgressNotice("备份");
          prog.update("打包中…");
          try {
            const r = await this.plugin.bridge.backup();
            prog.done(r.backup_dir);
          } catch (e) {
            prog.fail(e);
          }
        }),
      );

    void this.plugin.bridge
      .listBackups()
      .then((list) => {
        if (!list.length) return;
        const s = new Setting(root).setName(`已有备份（${list.length}）`).setDesc("选择一项恢复；恢复前会自动快照当前数据");
        s.addDropdown((d) => {
          d.addOption("", "选择备份…");
          // 值用完整路径（restore 需要），显示用目录名（人读更清爽）
          for (const b of list) d.addOption(b, b.split("/").pop() ?? b);
          d.onChange(async (v) => {
            if (!v) return;
            const ok = await confirm(this.app, {
              title: "从备份恢复？",
              message: "当前索引库会被替换（已自动做一次恢复前快照，可再次回滚）。",
              danger: true,
              detail: v,
              cta: "恢复",
            });
            if (!ok) return;
            const prog = new ProgressNotice("恢复");
            prog.update("校验并写入…");
            try {
              await this.plugin.bridge.restore(v);
              prog.done("完成");
              this.plugin.emit("data-changed", { reason: "restore" });
            } catch (e) {
              prog.fail(e);
            }
          });
        });
      })
      .catch(() => undefined);

    root.createEl("p", {
      cls: "setting-item-description",
      text:
        "关于「卸载会不会丢数据」：索引库、采集原件、导出与备份全部落在 vault 内（" +
        `${c.baseDir}/），笔记是普通 Markdown 文件。卸载插件不会删除任何一项。`,
    });
  }

  // ------------------------------------------------------------- 工具方法 ---

  private async save(reloadBridge: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.plugin.settings.core = mergeConfig(this.plugin.settings.core);
      await this.plugin.saveSettings({ reloadBridge });
    } catch (e) {
      new Notice(`设置保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private numSetting(
    parent: HTMLElement,
    name: string,
    desc: string,
    value: number,
    min: number,
    max: number,
    onSet: (n: number) => Promise<void>,
  ): void {
    new Setting(parent)
      .setName(name)
      .setDesc(desc)
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.min = String(min);
        t.inputEl.max = String(max);
        t.setValue(String(value)).onChange((v) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return;
          void onSet(Math.max(min, Math.min(max, Math.round(n))));
        });
      });
  }

  /** 只读状态行（比 Setting 更轻，避免出现“可点但无效”的控件）。 */
  private statusLine(parent: HTMLElement, label: string, value: () => string): void {
    const row = parent.createDiv({ cls: "pros-setting-status" });
    row.createSpan({ cls: "pros-setting-status-label", text: label });
    row.createSpan({ cls: "pros-setting-status-value", text: value() });
  }

  private noteBox(parent: HTMLElement, tone: "info" | "warn" | "danger", text: string): void {
    const box = parent.createDiv({ cls: `pros-note pros-note-${tone}` });
    box.setText(text);
  }
}

// ------------------------------------------------------------- 纯函数 ---

function split(v: unknown): string[] {
  return String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function mergeBudgets(base: AgentDef["budgets"], maxSteps: number, timeoutS: number): AgentDef["budgets"] {
  return {
    ...base,
    max_steps: clamp(Number.isFinite(maxSteps) ? maxSteps : base.max_steps, 1, HARD_LIMITS.max_steps),
    timeout_s: clamp(Number.isFinite(timeoutS) ? timeoutS : base.timeout_s, 5, HARD_LIMITS.timeout_s),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
