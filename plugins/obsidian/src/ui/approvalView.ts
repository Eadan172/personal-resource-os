/**
 * 审批中心（FR-11 / ADR-006）。
 *
 * 为什么必须有这个界面：
 *  · Agent 的写操作（建任务 / 写关系 / 对外发送 / Connector 动作）在 `approval_policy=confirm`
 *    时会挂起，**未批准绝不落库**。也就是说这个视图就是「AI 不自主改你的库」这条铁律的可见开关。
 *  · 拒绝不是丢弃：审批记录整条保留（status=rejected），审计链完整，随时可回看「谁在什么时候想做什么」。
 *  · 批量审批只作用于当前筛选结果，且每条都会写入审计（actor=user）。
 */
import { WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import {
  badge, card, cardHeader, emptyState, fmtRelative, ProgressNotice, sectionHeader,
} from "./components";
import type { Approval, ApprovalKind } from "../core/models";

const KIND_LABELS: Record<ApprovalKind, string> = {
  relation: "关系写入",
  task_create: "创建任务",
  bulk_write: "批量写入",
  outbound_send: "对外发送",
  connector_action: "Connector 动作",
};

/** 审批动作的风险分级：外发与 Connector 动作用红色，纯本地写入用黄色。 */
function kindTone(kind: ApprovalKind): "danger" | "warn" | "info" {
  if (kind === "outbound_send" || kind === "connector_action") return "danger";
  if (kind === "relation" || kind === "task_create") return "info";
  return "warn";
}

type Filter = "pending" | "approved" | "rejected" | "all";

export class ApprovalView extends ProsView {
  private filter: Filter = "pending";
  private pendingCount = 0;

  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.approval, "资源管家 · 审批中心", "shield-check");
  }

  protected buildToolbar(header: HTMLElement): void {
    const bar = header.createDiv({ cls: "pros-toolbar" });
    const refresh = bar.createEl("button", { text: "刷新" });
    refresh.addEventListener("click", () => void this.refresh());
    const approveAll = bar.createEl("button", { text: "批准当前筛选（全部）", cls: "mod-warning" });
    approveAll.addEventListener("click", () => void this.decideAll(true));
    const rejectAll = bar.createEl("button", { text: "拒绝当前筛选（全部）" });
    rejectAll.addEventListener("click", () => void this.decideAll(false));
  }

  protected async render(): Promise<void> {
    const all = await this.plugin.bridge.approvals();
    this.pendingCount = all.filter((a) => a.status === "pending").length;

    const bar = this.body.createDiv({ cls: "pros-statusbar" });
    bar.appendChild(badge(`待审批 ${this.pendingCount}`, this.pendingCount ? "warn" : "ok"));
    bar.appendChild(badge(`历史共 ${all.length}`, "default"));

    // 筛选标签
    const tabs = this.body.createDiv({ cls: "pros-tabs" });
    const defs: { key: Filter; label: string; count: number }[] = [
      { key: "pending", label: "待审批", count: this.pendingCount },
      { key: "approved", label: "已批准", count: all.filter((a) => a.status === "approved").length },
      { key: "rejected", label: "已拒绝", count: all.filter((a) => a.status === "rejected").length },
      { key: "all", label: "全部", count: all.length },
    ];
    for (const d of defs) {
      const tab = tabs.createEl("button", { cls: `pros-tab ${this.filter === d.key ? "is-active" : ""}` });
      tab.createSpan({ text: d.label });
      tab.createSpan({ cls: "pros-tab-count", text: String(d.count) });
      tab.addEventListener("click", () => {
        this.filter = d.key;
        void this.refresh();
      });
    }

    const rows = this.filter === "all" ? all : all.filter((a) => a.status === this.filter);
    if (!rows.length) {
      const title = this.filter === "pending" ? "没有待审批的动作" : "没有符合条件的记录";
      const desc =
        this.filter === "pending"
          ? "Agent 需要写库或对外发送时，会先出现在这里等你确认；你也可以在设置里调整各 Agent 的审批策略。"
          : "换个筛选条件看看，或回到待审批列表。";
      emptyState(this.body, "shield-check", title, desc, [
        { label: "打开设置", onClick: () => this.plugin.openSettings() },
      ]);
      return;
    }

    sectionHeader(this.body, "审批队列", "批准后动作立即执行并写入审计；拒绝同样留痕，可随时追溯。");
    for (const ap of rows) this.renderApproval(ap);
  }

  private renderApproval(ap: Approval): void {
    const box = card(this.body, `pros-approval is-${ap.status}`);
    const meta = [
      badge(KIND_LABELS[ap.kind] ?? ap.kind, kindTone(ap.kind)),
      badge(
        ap.status === "pending" ? "待审批" : ap.status === "approved" ? "已批准" : "已拒绝",
        ap.status === "pending" ? "warn" : ap.status === "approved" ? "ok" : "default",
      ),
      badge(`请求方 ${ap.requested_by}`, "default"),
    ];
    const { right } = cardHeader(box, describeTool(ap), meta);
    right.createSpan({ cls: "pros-muted", text: fmtRelative(ap.created_at) });

    if (ap.payload && Object.keys(ap.payload).length) {
      const detail = box.createDiv({ cls: "pros-approval-detail" });
      detail.createEl("div", { cls: "pros-muted", text: "载荷预览" });
      detail.createEl("pre", { cls: "pros-pre", text: stringify(ap.payload) });
    }

    if (ap.status === "pending") {
      const actions = box.createDiv({ cls: "pros-card-actions pros-actions-bottom" });
      const ok = actions.createEl("button", { text: "批准并执行", cls: "mod-cta" });
      ok.addEventListener("click", () => void this.decide(ap, true));
      const no = actions.createEl("button", { text: "拒绝" });
      no.addEventListener("click", () => void this.decide(ap, false));
    } else {
      const foot = box.createDiv({ cls: "pros-muted pros-approval-foot" });
      foot.setText(
        `${ap.decided_by ?? "—"} 于 ${fmtRelative(ap.decided_at)}${ap.status === "approved" ? "批准" : "拒绝"}`,
      );
    }
  }

  private async decide(ap: Approval, approve: boolean): Promise<void> {
    const prog = new ProgressNotice(approve ? "批准" : "拒绝");
    prog.update("提交决定…");
    try {
      const r = await this.plugin.bridge.decideApproval(ap.id, approve);
      prog.done(`${approve ? "已执行" : "已拒绝"}（${r.status}）`);
      this.plugin.emit("data-changed", { reason: "approval-decide" });
      await this.refresh();
    } catch (e) {
      prog.fail(e);
    }
  }

  private async decideAll(approve: boolean): Promise<void> {
    const all = await this.plugin.bridge.approvals("pending");
    if (!all.length) return void (await this.refresh());
    const ok = await this.plugin.confirm(
      approve ? "批准全部待审批动作？" : "拒绝全部待审批动作？",
      `${all.length} 条动作将被${approve ? "执行" : "拒绝"}，过程会逐条写入审计（可单条回滚）。`,
      approve,
    );
    if (!ok) return;

    const prog = new ProgressNotice(approve ? "批量批准" : "批量拒绝");
    let i = 0;
    for (const ap of all) {
      i++;
      prog.update(`（${i}/${all.length}）${describeTool(ap)}`);
      try {
        await this.plugin.bridge.decideApproval(ap.id, approve);
      } catch (e) {
        prog.fail(e);
        return;
      }
    }
    prog.done(`共 ${all.length} 条`);
    this.plugin.emit("data-changed", { reason: "approval-bulk" });
    await this.refresh();
  }
}

function describeTool(ap: Approval): string {
  const t = ap.action?.tool ?? "unknown";
  const args = ap.action?.arguments ?? {};
  const hint =
    (args.title as string) ??
    (args.name as string) ??
    (args.query as string) ??
    (args.src_id ? `${String(args.src_id).slice(0, 8)} → ${String(args.dst_id ?? "").slice(0, 8)}` : "");
  return hint ? `${t}：${hint}` : t;
}

function stringify(v: unknown): string {
  try {
    const s = JSON.stringify(v, null, 2);
    return s.length > 2000 ? `${s.slice(0, 2000)}\n…（已截断）` : s;
  } catch {
    return String(v);
  }
}
