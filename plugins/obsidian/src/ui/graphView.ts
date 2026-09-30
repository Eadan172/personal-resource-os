/**
 * 关系图谱（FR-08「Related / Backlinks」的全局可视化）。
 *
 * 实现取舍（为什么不用力导向库）：
 *  · 插件要求零外部依赖、能在 Obsidian 渲染进程里直接跑，因此用「确定性环形布局 + 原生 SVG」；
 *  · 布局确定性带来一个额外好处：同一份数据每次打开位置一致，便于对照与截图；
 *  · 节点与边严格来自索引库中的对象/关系，不在这里做任何推断（AI 的建议以虚线区分）。
 *
 * 性能：默认只渲染前 graphLimit 个节点；关系查询按并发 8 批处理，避免大库把 UI 卡死。
 */
import { WorkspaceLeaf } from "obsidian";
import type PersonalResourceOSPlugin from "../main";
import { ProsView } from "./baseView";
import { VIEW_TYPES } from "../types";
import { badge, emptyState, ProgressNotice, sectionHeader } from "./components";
import { OBJECT_TYPE_LABELS, type ObjectType, type ProsObject, type Relation } from "../core/models";

/** 按对象类型着色的调色板（浅色主题下都可读）。 */
const TYPE_COLORS: Record<string, string> = {
  note: "#6b7280", idea: "#f59e0b", task: "#2563eb", person: "#db2777",
  project: "#7c3aed", event: "#0891b2", bookmark: "#65a30d", document: "#0d9488",
  meeting: "#c2410c", conversation: "#4f46e5", topic: "#059669", concept: "#9333ea",
  decision: "#dc2626", risk: "#b91c1c", money: "#ca8a04", location: "#0284c7",
};

interface GraphNode extends ProsObject {
  x: number;
  y: number;
  degree: number;
}

export class GraphView extends ProsView {
  private includeSuggested = true;
  private confirmedOnly = false;
  private limit = 120;
  private focusId: string | null = null;
  private highlightId: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PersonalResourceOSPlugin) {
    super(leaf, plugin, VIEW_TYPES.graph, "资源管家 · 关系图谱", "share-2");
    this.limit = Math.min(plugin.settings.ui.graphLimit, 300);
  }

  /** 以某个对象为中心看局部图（对象详情页可跳转过来）。 */
  public focusOn(id: string | null): void {
    this.focusId = id;
    if (this.body) void this.refresh();
  }

  protected buildToolbar(header: HTMLElement): void {
    const bar = header.createDiv({ cls: "pros-toolbar" });

    const confLabel = bar.createEl("label", { cls: "pros-check-inline" });
    const confCb = confLabel.createEl("input", { type: "checkbox" });
    confCb.checked = this.confirmedOnly;
    confLabel.createSpan({ text: "只看已确认关系" });
    confCb.addEventListener("change", () => {
      this.confirmedOnly = confCb.checked;
      void this.refresh();
    });

    const sugLabel = bar.createEl("label", { cls: "pros-check-inline" });
    const sugCb = sugLabel.createEl("input", { type: "checkbox" });
    sugCb.checked = this.includeSuggested;
    sugLabel.createSpan({ text: "包含 AI 建议" });
    sugCb.addEventListener("change", () => {
      this.includeSuggested = sugCb.checked;
      void this.refresh();
    });

    const limSel = bar.createEl("select");
    for (const n of [40, 80, 120, 200, 300]) limSel.createEl("option", { text: `节点上限 ${n}`, value: String(n) });
    limSel.value = String(this.limit);
    limSel.addEventListener("change", () => {
      this.limit = Number(limSel.value);
      void this.refresh();
    });

    if (this.focusId) {
      const clear = bar.createEl("button", { text: "看全部 ✕" });
      clear.addEventListener("click", () => {
        this.focusId = null;
        void this.refresh();
      });
    }
    const refresh = bar.createEl("button", { text: "重新布局" });
    refresh.addEventListener("click", () => void this.refresh());
  }

  protected async render(): Promise<void> {
    const all = await this.plugin.bridge.objects({ lifecycle: "all", limit: this.limit });
    const visible = all.filter((o) => o.lifecycle !== "deleted");

    if (!visible.length) {
      emptyState(this.body, "share-2", "还没有可绘制的节点", "先采集一些内容并处理，关系图谱就会自动长出来。", [
        { label: "快速记录", onClick: () => this.plugin.openCapture(), cta: true },
      ]);
      return;
    }

    const rels = await this.collectRelations(visible);
    const { nodes, edges } = this.buildGraph(visible, rels);

    const bar = this.body.createDiv({ cls: "pros-statusbar" });
    bar.appendChild(badge(`节点 ${nodes.length}`, "default"));
    bar.appendChild(badge(`边 ${edges.length}`, "info"));
    bar.appendChild(badge(`建议关系 ${edges.filter((e) => e.status === "suggested").length}`, "warn"));
    if (this.focusId) bar.appendChild(badge("局部视图（1 跳）", "warn"));
    if (all.length >= this.limit) bar.appendChild(badge(`已截断到 ${this.limit} 个节点`, "danger"));

    if (!edges.length) {
      emptyState(
        this.body,
        "unlink",
        "暂无关系",
        "关系来自 Agent 的关系建议与你的确认。在对象详情页确认几条「相关」，这里就会连线。",
        [{ label: "打开 Inbox 处理内容", onClick: () => void this.plugin.activateView(VIEW_TYPES.inbox) }],
      );
      return;
    }

    sectionHeader(this.body, "关系图", "实线＝已确认，虚线＝AI 建议待审核；点击节点打开详情。");
    this.renderSvg(nodes, edges);
    this.renderLegend();
  }

  /** 关系查询：并发 8，避免大库串行等待。 */
  private async collectRelations(objects: ProsObject[]): Promise<Relation[]> {
    const prog = new ProgressNotice("构建图谱");
    prog.update(`读取 ${objects.length} 个节点的关系…`);
    const seen = new Map<string, Relation>();
    const CONCURRENCY = 8;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const idx = cursor++;
        if (idx >= objects.length) return;
        const obj = objects[idx];
        try {
          const r = await this.plugin.bridge.relationsOf(obj.id);
          for (const rel of [...r.out, ...r.in]) seen.set(rel.id, rel);
        } catch {
          /* 单点失败不影响整体 */
        }
        if (idx % 10 === 0) prog.update(`已读取 ${idx + 1}/${objects.length}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, objects.length) }, worker));
    prog.done(`${seen.size} 条关系`);
    return [...seen.values()];
  }

  /** 组图：环形布局 + 过滤 + 只保留两端都在集合内的边。 */
  private buildGraph(objects: ProsObject[], relations: Relation[]): { nodes: GraphNode[]; edges: Relation[] } {
    let edges = relations.filter((r) => this.includeSuggested || r.status === "confirmed");
    if (this.confirmedOnly) edges = edges.filter((r) => r.status === "confirmed");

    const idSet = new Set(objects.map((o) => o.id));
    edges = edges.filter((r) => idSet.has(r.src_id) && idSet.has(r.dst_id));

    // 局部视图：以 focusId 为中心保留 1 跳邻居
    let keep = new Set(objects.map((o) => o.id));
    if (this.focusId && idSet.has(this.focusId)) {
      keep = new Set([this.focusId]);
      for (const e of edges) {
        if (e.src_id === this.focusId) keep.add(e.dst_id);
        if (e.dst_id === this.focusId) keep.add(e.src_id);
      }
    } else {
      // 全局视图：优先保留有连接的节点
      const connected = new Set<string>();
      for (const e of edges) {
        connected.add(e.src_id);
        connected.add(e.dst_id);
      }
      if (connected.size) keep = connected;
    }

    const nodesIn = objects.filter((o) => keep.has(o.id));
    edges = edges.filter((e) => keep.has(e.src_id) && keep.has(e.dst_id));

    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.src_id, (degree.get(e.src_id) ?? 0) + 1);
      degree.set(e.dst_id, (degree.get(e.dst_id) ?? 0) + 1);
    }

    const n = nodesIn.length;
    const R = 300;
    const nodes: GraphNode[] = nodesIn.map((o, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2;
      return {
        ...o,
        x: 400 + R * Math.cos(angle),
        y: 340 + R * Math.sin(angle),
        degree: degree.get(o.id) ?? 0,
      };
    });
    return { nodes, edges };
  }

  private renderSvg(nodes: GraphNode[], edges: Relation[]): void {
    const pos = new Map(nodes.map((n) => [n.id, n]));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 800 680");
    svg.setAttribute("class", "pros-graph");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    // 边
    const edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    for (const e of edges) {
      const a = pos.get(e.src_id);
      const b = pos.get(e.dst_id);
      if (!a || !b) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x));
      line.setAttribute("y2", String(b.y));
      line.setAttribute("stroke", e.status === "confirmed" ? "#94a3b8" : "#fbbf24");
      line.setAttribute("stroke-width", e.status === "confirmed" ? "1.6" : "1.2");
      if (e.status === "suggested") line.setAttribute("stroke-dasharray", "5 4");
      line.setAttribute("data-src", e.src_id);
      line.setAttribute("data-dst", e.dst_id);
      edgeLayer.appendChild(line);
    }
    svg.appendChild(edgeLayer);

    // 节点
    const nodeLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    for (const n of nodes) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "pros-graph-node");
      g.setAttribute("data-id", n.id);
      g.setAttribute("transform", `translate(${n.x},${n.y})`);

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      const r = 6 + Math.min(n.degree, 8) * 1.6;
      circle.setAttribute("r", String(r));
      circle.setAttribute("fill", TYPE_COLORS[n.type] ?? "#64748b");
      circle.setAttribute("fill-opacity", this.highlightId && this.highlightId !== n.id ? "0.35" : "0.95");
      circle.setAttribute("stroke", "#ffffff");
      circle.setAttribute("stroke-width", "1.5");
      g.appendChild(circle);

      if (nodes.length <= 60 || n.degree > 1) {
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("y", String(r + 12));
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("class", "pros-graph-label");
        text.textContent = n.title.length > 12 ? `${n.title.slice(0, 12)}…` : n.title;
        g.appendChild(text);
      }

      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${n.title}\n类型：${OBJECT_TYPE_LABELS[n.type as ObjectType] ?? n.type}\n连接数：${n.degree}`;
      g.appendChild(title);

      g.addEventListener("click", () => this.plugin.openObject(n.id));
      g.addEventListener("mouseenter", () => {
        this.highlightId = n.id;
        this.applyHighlight(svg, n.id);
      });
      g.addEventListener("mouseleave", () => {
        this.highlightId = null;
        this.applyHighlight(svg, null);
      });
      nodeLayer.appendChild(g);
    }
    svg.appendChild(nodeLayer);

    const box = this.body.createDiv({ cls: "pros-graph-wrap" });
    box.appendChild(svg);
    this.applyHighlight(svg, this.highlightId);
  }

  /** 悬停高亮：把与当前节点无关的边与节点淡化（保留 1 跳邻域）。 */
  private applyHighlight(svg: SVGSVGElement, id: string | null): void {
    const related = new Set<string>();
    if (id) related.add(id);
    for (const line of Array.from(svg.querySelectorAll("line"))) {
      const s = line.getAttribute("data-src");
      const d = line.getAttribute("data-dst");
      const hot = !id || s === id || d === id;
      line.setAttribute("stroke-opacity", hot ? "1" : "0.12");
      if (id && hot) {
        if (s) related.add(s);
        if (d) related.add(d);
      }
    }
    for (const g of Array.from(svg.querySelectorAll<SVGGElement>("g.pros-graph-node"))) {
      const nid = g.getAttribute("data-id") ?? "";
      const circle = g.querySelector("circle");
      if (!circle) continue;
      const hot = !id || related.has(nid);
      circle.setAttribute("fill-opacity", hot ? "0.95" : "0.3");
      g.setAttribute("opacity", hot ? "1" : "0.4");
    }
  }

  private renderLegend(): void {
    const box = this.body.createDiv({ cls: "pros-graph-legend" });
    for (const [type, color] of Object.entries(TYPE_COLORS)) {
      const item = box.createDiv({ cls: "pros-legend-item" });
      const dot = item.createSpan({ cls: "pros-legend-dot" });
      dot.style.background = color;
      item.createSpan({ text: OBJECT_TYPE_LABELS[type as ObjectType] ?? type });
    }
    const lineDefs: [string, string, boolean][] = [
      ["已确认关系", "#94a3b8", false],
      ["AI 建议·待审核", "#fbbf24", true],
    ];
    for (const [label, color, dashed] of lineDefs) {
      const item = box.createDiv({ cls: "pros-legend-item" });
      const ln = item.createSpan({ cls: "pros-legend-line" });
      ln.style.background = color;
      if (dashed) ln.addClass("is-dashed");
      item.createSpan({ text: label });
    }
  }
}
