/**
 * Markdown 渲染与落盘（实现补充模块）。
 *
 * 说明：Python Core 把「生成笔记 + 写入 vault」放在 `ingest/common.save_note_and_capture` 里，
 * 而插件形态下「结构化笔记写入 Obsidian 库」是核心交付物，被 capture / pipeline / summary /
 * ingest 四处共用，因此抽成独立模块，避免四个入口各写一份渲染逻辑。
 *
 * 落盘规则：
 *  - 原始内容 → `<inboxDir>/`，只增不改（TB-1：原始层不可被 AI 覆盖）；
 *  - 结构化笔记 → `<notesDir>/<类型>/`；people / projects / meetings 落到对应专属目录；
 *  - 同名文件不覆盖：自动追加 ` 2`、` 3` 后缀（笔记永远不会互相冲掉）。
 */
import type { VaultFs } from "../vault/vaultFs";
import type { CoreConfig } from "./config";
import type { Extraction, ObjectType, ProsObject, Relation, Task } from "./models";
import { OBJECT_TYPE_LABELS } from "./models";
import { humanTime, safeFileName } from "./util";

/** YAML front-matter：Obsidian 可直接按属性检索/筛选。 */
export interface FrontMatter {
  [key: string]: string | number | string[] | undefined;
}

export function renderFrontMatter(fm: FrontMatter): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      if (!v.length) lines.push("  []");
      for (const item of v) lines.push(`  - ${escapeYaml(String(item))}`);
    } else if (typeof v === "number") {
      lines.push(`${k}: ${v}`);
    } else {
      lines.push(`${k}: ${escapeYaml(String(v))}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function escapeYaml(s: string): string {
  const one = s.replace(/\r?\n/g, " ").trim();
  return /[:#\-[\]{}",&*?|>%@`]/.test(one) || one === "" ? JSON.stringify(one) : one;
}

/** 按类型决定笔记目录（分类归纳的可视化结果）。 */
export function targetDirForType(cfg: CoreConfig, type: ObjectType): string {
  switch (type) {
    case "person": return cfg.peopleDir;
    case "project": return cfg.projectsDir;
    case "meeting": return cfg.meetingsDir;
    default: return `${cfg.notesDir}/${OBJECT_TYPE_LABELS[type] ?? type}`;
  }
}

/** 原始内容文件路径（inbox）。 */
export function rawNotePath(cfg: CoreConfig, obj: ProsObject): string {
  return `${cfg.inboxDir}/${safeFileName(obj.title, 60)}.md`;
}

/**
 * 同名不覆盖：若目标已存在则追加序号。
 * 注意只在「新建」时调用；更新既有笔记应直接写回原路径（properties.note_path）。
 */
export async function uniquePath(fs: VaultFs, desired: string): Promise<string> {
  if (!(await fs.exists(desired))) return desired;
  const m = /^(.*?)(\.md)?$/.exec(desired)!;
  const base = m[1];
  const ext = m[2] ?? "";
  for (let i = 2; i < 200; i++) {
    const candidate = `${base} ${i}${ext}`;
    if (!(await fs.exists(candidate))) return candidate;
  }
  return `${base} ${Date.now()}${ext}`;
}

/** 原始内容笔记（capture 阶段写入 inbox）。 */
export function renderRawNote(obj: ProsObject): string {
  return [
    renderFrontMatter({
      pros_id: obj.id,
      type: obj.type,
      origin: obj.origin,
      lifecycle: obj.lifecycle,
      created: obj.created_at,
      source: obj.source_uri ?? undefined,
      tags: obj.tags,
      data_class: obj.data_class,
      content_hash: obj.content_hash,
    }),
    "",
    `# ${obj.title}`,
    "",
    obj.source_uri ? `> 来源：${obj.source_uri}` : "",
    `> 采集时间：${humanTime(obj.created_at)} ｜ 状态：${obj.lifecycle} ｜ 原始内容，AI 不修改`,
    "",
    obj.content,
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** 结构化笔记的输入。 */
export interface StructuredNoteInput {
  obj: ProsObject;
  /** AI 分类结果（写入 front-matter 与「智能归纳」段）。 */
  classification?: { type: ObjectType; confidence: number; tags: string[]; reason?: string };
  summary?: string;
  tasks?: Task[];
  relations?: { out: (Relation & { peerTitle?: string })[]; in: (Relation & { peerTitle?: string })[] };
  extractions?: Extraction[];
  /** 采集类笔记的附加区块（逐字稿、正文、关键帧等），按顺序拼接。 */
  sections?: { heading: string; body: string }[];
  /** 采集警告等。 */
  warnings?: string[];
  /** 是否包含完整原文（默认 true：本地事实源要求正文可离线查看）。 */
  includeContent?: boolean;
  /** 是否包含 AI 产物（摘要/实体/任务）。 */
  includeAI?: boolean;
}

/**
 * 生成结构化笔记：
 *   front-matter → AI 归纳（摘要/标签/实体）→ 相关链接 → 任务 → 附加区块 → 原文。
 * 所有 AI 产物显式标注来源与置信度，绝不与原文混淆（NFR-03）。
 */
export function renderStructuredNote(cfg: CoreConfig, input: StructuredNoteInput): string {
  const { obj, classification, summary, tasks, relations, extractions, sections, warnings } = input;
  const includeContent = input.includeContent !== false;
  const includeAI = input.includeAI !== false;
  const out: string[] = [];

  out.push(renderFrontMatter({
    pros_id: obj.id,
    type: classification?.type ?? obj.type,
    type_label: OBJECT_TYPE_LABELS[classification?.type ?? obj.type],
    origin: obj.origin,
    confidence: typeof obj.confidence === "number" ? Number(obj.confidence.toFixed(2)) : undefined,
    lifecycle: obj.lifecycle,
    created: obj.created_at,
    updated: obj.updated_at,
    source: obj.source_uri ?? undefined,
    tags: [...new Set([...(obj.tags ?? []), ...(classification?.tags ?? [])])],
    data_class: obj.data_class,
    content_hash: obj.content_hash,
    ingest_kind: typeof obj.properties["ingest_kind"] === "string" ? String(obj.properties["ingest_kind"]) : undefined,
  }));
  out.push("");
  out.push(`# ${obj.title}`);
  out.push("");
  out.push(`> 采集时间：${humanTime(obj.created_at)}`);
  if (obj.source_uri) out.push(`> 来源：${obj.source_uri}`);
  out.push(`> 原始内容哈希：\`${obj.content_hash.slice(0, 16)}…\`（用于去重与完整性校验）`);
  out.push("");

  if (includeAI) {
    out.push("## 智能归纳");
    out.push("");
    if (classification) {
      out.push(
        `- **分类**：${OBJECT_TYPE_LABELS[classification.type] ?? classification.type}` +
        `（\`${classification.type}\`，置信度 ${(classification.confidence * 100).toFixed(0)}%` +
        `${classification.reason ? `，${classification.reason}` : ""}）`,
      );
    }
    const tags = [...new Set([...(obj.tags ?? []), ...(classification?.tags ?? [])])];
    if (tags.length) out.push(`- **标签**：${tags.map((t) => `#${t}`).join(" ")}`);
    out.push(`- **来源标记**：AI 提取内容（provenance = ai_extracted），原文未被修改`);
    out.push("");
    if (summary) {
      out.push("### 摘要");
      out.push("");
      out.push(`> ${summary}`);
      out.push("");
    }
  }

  // 相关链接（关系建议 + 已确认关系；双向列出，形成 Obsidian 可点击的链接）
  if (relations && (relations.out.length || relations.in.length)) {
    out.push("## 相关链接");
    out.push("");
    if (relations.out.length) {
      out.push("**本条目指向**");
      out.push("");
      for (const r of relations.out) {
        out.push(`- ${relLabel(r)}[[${r.peerTitle ?? r.dst_id}]]${statusMark(r.status)}`);
      }
      out.push("");
    }
    if (relations.in.length) {
      out.push("**指向本条目（Backlinks）**");
      out.push("");
      for (const r of relations.in) {
        out.push(`- ${relLabel(r)}[[${r.peerTitle ?? r.src_id}]]${statusMark(r.status)}`);
      }
      out.push("");
    }
  }

  if (tasks?.length) {
    out.push("## 提取出的待办");
    out.push("");
    for (const t of tasks) {
      const due = t.due_at ? ` 📅 ${t.due_at}` : "";
      out.push(`- [${t.status === "done" ? "x" : " "}] ${t.title}${due}  \`${t.priority}\``);
    }
    out.push("");
    out.push(`> 任务由 ${tasks[0]?.created_by_agent ? "Agent" : "用户"}创建，可在「任务中心」统一管理。`);
    out.push("");
  }

  if (extractions?.length) {
    const entities = extractions.find((e) => e.kind === "entities");
    if (entities) {
      out.push("## 结构化实体（可回溯原文）");
      out.push("");
      out.push("```json");
      out.push(entities.content);
      out.push("```");
      out.push("");
    }
  }

  for (const s of sections ?? []) {
    if (!s?.body?.trim()) continue;
    out.push(`## ${s.heading}`);
    out.push("");
    out.push(s.body.trim());
    out.push("");
  }

  if (includeContent) {
    out.push("## 原文");
    out.push("");
    out.push(obj.content.trim());
    out.push("");
  }

  if (warnings?.length) {
    out.push("## 采集警告");
    out.push("");
    for (const w of warnings) out.push(`- ${w}`);
    out.push("");
  }

  out.push("---");
  out.push("");
  out.push(
    `*由 Personal Resource OS 生成 ｜ 对象 id \`${obj.id}\` ｜ ` +
    `索引库 \`${cfg.baseDir}/resource.db.json\` 为事实源，AI 产物标记为 ai_extracted*`,
  );
  return out.join("\n");
}

function relLabel(r: Relation): string {
  const map: Record<string, string> = {
    related_to: "相关", mentions: "提及", belongs_to: "属于", assigned_to: "指派给",
    depends_on: "依赖", derived_from: "衍生自", contradicts: "冲突", supports: "支持",
    duplicate_of: "疑似重复", references: "引用",
  };
  return `${map[r.type] ?? r.type}：`;
}

function statusMark(s: Relation["status"]): string {
  if (s === "suggested") return " `AI 建议·待审核`";
  if (s === "rejected") return " `已拒绝`";
  return "";
}

/** 把笔记写入 vault；返回实际写入路径。 */
export async function writeNote(fs: VaultFs, path: string, content: string): Promise<string> {
  await fs.write(path, content);
  return path;
}
