/**
 * Dashboard：综合工作台（FR-14）。
 *
 * 一屏回答四个问题：现在有什么要处理（Inbox/审批/逾期）、最近发生了什么（时间线）、
 * Agent 在做什么（运行记录）、系统状态如何（核心模式/索引/密钥/出站）。
 */
import { Notice, WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import {
  badge, card, cardHeader, emptyState, fmtRelative, iconEl, kvList, originBadge,
  priorityBadge, ProgressNotice, sectionHeader, statCards, typeBadge,
} from "./components";
import { OBJECT_TYPE_LABELS } from "../core/models";

export class DashboardView extends ProsView {
  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.dashboard, "资源管家 · 工作台", "layout-dashboard");
  }

  protected buildToolbar(header: HTMLElement): void {
    const bar = header.createDiv({ cls: "pros-toolbar" });
    const mk = (icon: string, label: string, fn: () => void, cta = false) => {
      const b = bar.createEl("button", { cls: cta ? "mod-cta" : "" });
      b.appendChild(iconEl(icon));
      b.createSpan({ text: label });
      b.addEventListener("click", fn);
    };
    mk("plus", "快速记录", () => this.plugin.openCapture(), true);
    mk("link", "采集链接", () => this.plugin.openLinkIngest());
    mk("zap", "处理 Inbox", () => void this.processInbox());
    mk("refresh-cw", "重建索引", () => void this.reindex());
  }

  protected async render(): Promise<void> {
    const bridge = this.plugin.bridge;
    const [stats, tasks, approvals, runs, connectors] = await Promise.all([
      bridge.stats(),
      bridge.tasks({ status: "open", limit: 200 }),
      bridge.approvals("pending"),
      bridge.agentRuns(8),
      bridge.connectors(),
    ]);

    // ---- 系统状态条 ----
    const statusBar = this.body.createDiv({ cls: "pros-statusbar" });
    const meta = bridge.meta;
    statusBar.appendChild(badge(meta.mode === "http" ? `核心：Python Core（${meta.coreUrl}）` : "核心：插件内置", meta.mode === "http" ? "ok" : "info"));
    statusBar.appendChild(badge(meta.offline ? "Provider：离线确定性（Mock）" : `Provider：${meta.provider}`, meta.offline ? "info" : "warn"));
    if (approvals.length) statusBar.appendChild(badge(`${approvals.length} 项待审批`, "danger"));

    // ---- 核心指标 ----
    const today = new Date();
    const dueToday = tasks.filter((t) => t.due_at?.slice(0, 10) === today.toISOString().slice(0, 10)).length;
    const overdue = tasks.filter((t) => t.due_at && t.due_at.slice(0, 10) < today.toISOString().slice(0, 10)).length;
    statCards(this.body, [
      { label: "待处理 Inbox", value: stats.inbox, hint: "未 AI 整理", tone: stats.inbox ? "warn" : "ok" },
      { label: "已整理笔记", value: stats.processed, hint: `${stats.total} 条对象` },
      { label: "开放任务", value: stats.openTasks, hint: `今天到期 ${dueToday}` },
      { label: "已逾期", value: overdue, tone: overdue ? "danger" : "ok" },
      { label: "关系建议", value: stats.pendingRelations, hint: "待审核", tone: stats.pendingRelations ? "warn" : "ok" },
      { label: "待审批动作", value: stats.pendingApprovals, hint: "AI 写入需确认", tone: stats.pendingApprovals ? "danger" : "ok" },
    ]);

    // ---- 待处理 Inbox（最多 5 条）----
    const inbox = await bridge.objects({ lifecycle: "inbox", limit: 5 });
    const inboxSection = this.body.createDiv({ cls: "pros-panel" });
    sectionHeader(inboxSection, "待处理 Inbox", "AI 尚未整理的内容（原文已安全入库）");
    if (!inbox.length) {
      emptyState(inboxSection, "inbox", "Inbox 是空的", "所有内容都已整理完毕。", [
        { label: "快速记录", onClick: () => this.plugin.openCapture(), cta: true },
        { label: "采集链接", onClick: () => this.plugin.openLinkIngest() },
      ]);
    } else {
      for (const o of inbox) {
        const c = card(inboxSection);
        const { right } = cardHeader(c, o.title, [
          typeBadge(o.type, OBJECT_TYPE_LABELS[o.type] ?? o.type),
          originBadge(o.origin),
          badge(fmtRelative(o.created_at), "default"),
        ]);
        c.createEl("p", { cls: "pros-card-snippet", text: o.content.replace(/\s+/g, " ").slice(0, 140) });
        const open = right.createEl("button", { text: "打开" });
        open.addEventListener("click", () => this.plugin.openObject(o.id));
        const proc = right.createEl("button", { text: "处理" });
        proc.addEventListener("click", () => void this.processOne(o.id));
      }
      const more = inboxSection.createEl("button", { text: "查看全部 Inbox →", cls: "pros-link-btn" });
      more.addEventListener("click", () => void this.plugin.activateView(VIEW_TYPES.inbox));
    }

    // ---- 待审批 ----
    if (approvals.length) {
      const sec = this.body.createDiv({ cls: "pros-panel pros-panel-alert" });
      sectionHeader(sec, "待审批动作", "AI 建议的写入动作，未批准不会生效");
      for (const a of approvals.slice(0, 4)) {
        const c = card(sec);
        cardHeader(c, `${a.kind} · ${a.action.tool}`, [badge(a.requested_by, "ai")]);
        c.createEl("pre", { cls: "pros-pre", text: JSON.stringify(a.action.arguments, null, 2) });
        const row = c.createDiv({ cls: "pros-card-actions" });
        row.createEl("button", { text: "批准", cls: "mod-cta" }).addEventListener("click", () => void this.decide(a.id, true));
        row.createEl("button", { text: "拒绝" }).addEventListener("click", () => void this.decide(a.id, false));
      }
      const more = sec.createEl("button", { text: "前往审批中心 →", cls: "pros-link-btn" });
      more.addEventListener("click", () => void this.plugin.activateView(VIEW_TYPES.approval));
    }

    // ---- 近期任务 ----
    const taskSection = this.body.createDiv({ cls: "pros-panel" });
    sectionHeader(taskSection, "接下来要做", "按截止时间与优先级排序");
    if (!tasks.length) {
      emptyState(taskSection, "check-circle", "没有开放任务", "内容里含「明天 / 务必」等字样的行会被自动提取为待办。");
    } else {
      for (const t of tasks.slice(0, 6)) {
        const c = card(taskSection, "pros-card-compact");
        const { right } = cardHeader(c, t.title, [
          priorityBadge(t.priority),
          badge(t.due_at ? `截止 ${t.due_at.slice(0, 10)}` : "无截止", t.due_at && t.due_at.slice(0, 10) < today.toISOString().slice(0, 10) ? "danger" : "default"),
          t.created_by_agent ? badge("AI 创建", "ai") : badge("手动", "ok"),
        ]);
        right.createEl("button", { text: "完成" }).addEventListener("click", async () => {
          await this.plugin.bridge.setTaskStatus(t.id, "done");
          new Notice(`已完成：${t.title}`);
          this.plugin.emit("data-changed", { reason: "task-done" });
        });
      }
      const more = taskSection.createEl("button", { text: "前往任务中心 →", cls: "pros-link-btn" });
      more.addEventListener("click", () => void this.plugin.activateView(VIEW_TYPES.tasks));
    }

    // ---- Agent 运行记录 ----
    const runSection = this.body.createDiv({ cls: "pros-panel" });
    sectionHeader(runSection, "Agent 运行记录", "每一步 tool call 与预算消耗均可追溯（NFR-04）");
    if (!runs.length) {
      emptyState(runSection, "bot", "还没有运行记录", "可以让内置 Agent 处理 Inbox，或运行自定义 Agent。");
    } else {
      for (const r of runs) {
        const c = card(runSection, "pros-card-compact");
        cardHeader(c, `${r.agent_name}（${r.trigger}）`, [
          badge(r.status, r.status === "succeeded" ? "ok" : r.status === "waiting_approval" ? "warn" : r.status === "failed" ? "danger" : "info"),
          badge(`步数 ${r.steps}`, "default"),
          badge(`tokens≈${r.tokens_used}`, "default"),
          badge(fmtRelative(r.started_at), "default"),
        ]);
        if (r.error) c.createEl("p", { cls: "pros-error-text", text: r.error });
        if (r.trace.length) {
          const ul = c.createEl("ul", { cls: "pros-trace" });
          for (const s of r.trace.slice(-6)) {
            ul.createEl("li", {
              text: `#${s.index} ${s.tool} [${s.policy}/${s.status}]${s.error ? ` — ${s.error}` : ""}`,
            });
          }
        }
      }
    }

    // ---- 系统信息 ----
    const sysSection = this.body.createDiv({ cls: "pros-panel" });
    sectionHeader(sysSection, "系统信息", "本地优先、零遥测；密钥与出站均受白名单约束");
    const status = await bridge.ping();
    kvList(sysSection, [
      ["核心模式", meta.mode === "http" ? `Python Core（${meta.coreUrl}）` : "插件内置轻量核心"],
      ["核心状态", status.ok ? status.message : `⚠ ${status.message}`],
      ["索引库目录", `${meta.baseDir}/resource.db.json`],
      ["能力范围", meta.supportsHeavyIngest ? "含下载 / 转写 / 抽帧 / 反爬渲染" : "轻量解析（重活需连接 Python Core）"],
      ["出站白名单", this.plugin.settings.core.outboundAllowlist.join("、")],
      ["Connector", connectors.map((c) => `${c.id}${c.enabled ? "（启用）" : "（停用）"}`).join("、")],
      ["最近更新", fmtRelative(stats.lastUpdated)],
    ]);
  }

  private async processInbox(): Promise<void> {
    const prog = new ProgressNotice("处理 Inbox");
    try {
      const results = await this.plugin.bridge.processInbox({
        limit: 30,
        onProgress: (m) => prog.update(m),
      });
      const ok = results.filter((r) => r.status === "processed").length;
      const bad = results.filter((r) => r.status === "error");
      prog.done(`${ok} 条成功${bad.length ? `，${bad.length} 条失败（原文已保留）` : ""}`);
      if (bad.length) new Notice(`失败原因示例：${bad[0].error}`, 6000);
      this.plugin.emit("data-changed", { reason: "process" });
    } catch (e) {
      prog.fail(e);
    }
  }

  private async processOne(id: string): Promise<void> {
    const prog = new ProgressNotice("处理内容");
    try {
      await this.plugin.processObjectWithFeedback(id, prog);
      this.plugin.emit("data-changed", { reason: "process-one" });
    } catch (e) {
      prog.fail(e);
    }
  }

  private async reindex(): Promise<void> {
    const r = await this.plugin.bridge.rebuildIndex();
    new Notice(`索引已重建：${r.objects} 条对象`);
  }

  private async decide(id: string, approve: boolean): Promise<void> {
    try {
      await this.plugin.bridge.decideApproval(id, approve);
      new Notice(approve ? "已批准并执行" : "已拒绝");
      this.plugin.emit("data-changed", { reason: "approval" });
    } catch (e) {
      new Notice(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
