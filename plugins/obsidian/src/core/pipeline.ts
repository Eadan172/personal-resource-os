/**
 * Inbox 自动处理管道（对应 Python Core pipeline.py，需求 20-C / 21 / 22-C）。
 *
 * 阶段：分类 → 摘要 → 实体/任务提取 → 关系建议 → 生成结构化笔记 → lifecycle=processed。
 *
 * 铁律：
 *  1. objects.content 永不被 AI 修改（Store 层白名单 + agent 禁写字段双重保证）；
 *  2. 任一环节失败 → 对象留在 inbox 并写入 processing_error，原始数据不受影响；
 *  3. AI 产物与原文分离：AI 结果写 properties.ai 与 extractions，原文原样保留；
 *  4. 关系只写 suggested，等待用户在「审批中心 / 对象详情」确认。
 */
import type { CoreConfig } from "./config";
import type { Extraction, ObjectType, ProsObject, Relation, Task } from "./models";
import type { Store } from "./store";
import type { ChatProvider } from "./providers/base";
import { extractEntities } from "./extraction";
import { renderStructuredNote, targetDirForType, uniquePath } from "./notes";
import { createTask } from "./tasks";
import { newId, nowIso, sha256Text, truncate } from "./util";

export const PROCESSOR = "pros-plugin/pipeline";
export const PROCESSOR_VERSION = "1.0.0";

export interface ProcessResult {
  id: string;
  status: "processed" | "error" | "skipped";
  tasks: number;
  relations: number;
  note_path?: string;
  error?: string;
}

export interface ProcessOptions {
  /** 进度回调（UI 用）。 */
  onProgress?: (msg: string) => void;
  /** 是否写入结构化笔记（默认 true）。 */
  writeNote?: boolean;
  /** 是否创建任务（默认 true）。 */
  createTasks?: boolean;
  /** 关系建议上限（默认 8，避免噪声淹没）。 */
  maxRelations?: number;
  actor?: string;
}

/**
 * 处理单个对象。失败时**不抛出**，而是返回 status=error 并把错误写进对象属性，
 * 保证批处理不会因单条失败而中断、且原始数据完好。
 */
export async function processObject(
  store: Store,
  cfg: CoreConfig,
  provider: ChatProvider,
  objId: string,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const obj = store.object(objId);
  if (!obj) return { id: objId, status: "skipped", tasks: 0, relations: 0, error: "对象不存在" };
  const actor = opts.actor ?? "agent:inbox-organizer";
  const progress = opts.onProgress ?? (() => undefined);

  try {
    // 1) 分类（模型输出不合规时 Provider 内部已退化为规则，不会抛错）
    progress("正在分类…");
    const cls = await provider.classify(obj.content);
    const finalType: ObjectType = cls.type;

    // 2) 摘要
    progress("正在生成摘要…");
    let summary = "";
    try {
      summary = await provider.summarize(obj.content);
    } catch (e) {
      // 摘要失败不致命：记 warning，继续其它阶段
      summary = truncate(obj.content.replace(/\s+/g, " "), 160);
      progress(`摘要生成失败，已用首段兜底：${String(e)}`);
    }

    // 3) 实体提取（确定性，零网络；失败也会退化为空集）
    progress("正在提取实体…");
    const entities = extractEntities(obj.content);
    const entityJson = JSON.stringify(
      {
        dates: entities.dates.map((d) => ({ value: d.value, span: { start: d.start, end: d.end } })),
        money: entities.money.map((m) => ({ value: m.value, currency: m.currency, span: { start: m.start, end: m.end } })),
        people: entities.people.map((p) => ({ value: p.value, span: { start: p.start, end: p.end } })),
        tags: entities.tags.map((t) => ({ value: t.value, span: { start: t.start, end: t.end } })),
        urls: entities.urls.map((u) => ({ value: u.value, span: { start: u.start, end: u.end } })),
      },
      null,
      2,
    );

    // 4) 任务提取
    progress("正在提取待办…");
    let createdTasks: Task[] = [];
    if (opts.createTasks !== false) {
      let candidates: { title: string; due_at: string | null; priority: Task["priority"]; span?: { start: number; end: number } }[] = [];
      try {
        candidates = await provider.extractTasks(obj.content);
      } catch (e) {
        candidates = entities.tasks.map((t) => ({ title: t.title, due_at: t.due_at, priority: t.priority, span: t.span }));
        progress(`任务提取降级为本地规则：${String(e)}`);
      }
      for (const c of candidates.slice(0, 10)) {
        if (!c.title?.trim()) continue;
        const id = createTask(store, {
          title: c.title,
          source_object_id: obj.id,
          due_at: c.due_at,
          priority: c.priority,
          provenance: { source_object_id: obj.id, span: c.span, processor: provider.name },
          confidence: 0.8,
          actor,
        });
        const t = store.task(id);
        if (t) createdTasks.push(t);
      }
    }

    // 5) 关系建议（只写 suggested）
    progress("正在分析关联…");
    const relCount = opts.createTasks === false ? 0 : suggestRelations(store, obj, opts.maxRelations ?? 8);

    // 6) 写结构化笔记（AI 归纳 + 相关链接 + 任务 + 原文）
    let notePath: string | undefined;
    if (opts.writeNote !== false) {
      progress("正在生成结构化笔记…");
      const relations = enrichRelations(store, obj.id);
      const extras: Extraction[] = [
        {
          id: newId("ext_"), source_object_id: obj.id, kind: "entities", content: entityJson,
          content_hash: sha256Text(entityJson), processor: PROCESSOR, processor_version: PROCESSOR_VERSION,
          created_at: nowIso(),
        },
        {
          id: newId("ext_"), source_object_id: obj.id, kind: "summary", content: summary,
          content_hash: sha256Text(summary), processor: provider.name, processor_version: PROCESSOR_VERSION,
          created_at: nowIso(),
        },
      ];
      for (const e of extras) store.insertExtraction(e);

      const sections = buildKindSections(obj);
      const md = renderStructuredNote(cfg, {
        obj,
        classification: cls,
        summary,
        tasks: createdTasks,
        relations,
        extractions: extras,
        sections,
      });

      const desired = `${targetDirForType(cfg, finalType)}/${obj.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.md`;
      // 已有笔记则原地更新；首次处理才分配新路径（避免产生重复文件）
      const existing = typeof obj.properties["note_path"] === "string" ? String(obj.properties["note_path"]) : null;
      notePath = existing && (await store.fs.exists(existing)) ? existing : await uniquePath(store.fs, desired);
      await store.fs.write(notePath, md);
    }

    // 7) 落库 AI 结果（与原文分离）+ 状态流转
    const props = { ...obj.properties } as Record<string, unknown>;
    props.ai = {
      classification: cls,
      processed_at: nowIso(),
      origin: "ai_extracted",
      processor: provider.name,
      processor_version: PROCESSOR_VERSION,
    };
    if (notePath) props.note_path = notePath;
    delete (props.ai as Record<string, unknown>).processing_error;

    store.updateObject(
      obj.id,
      {
        type: finalType,
        properties: props,
        confidence: Math.max(0, Math.min(1, cls.confidence)),
        origin: "ai_extracted",
        lifecycle: obj.lifecycle === "deleted" ? "deleted" : "processed",
        tags: [...new Set([...(obj.tags ?? []), ...cls.tags])].slice(0, 20),
      },
      actor,
    );
    await store.flush();
    return { id: obj.id, status: "processed", tasks: createdTasks.length, relations: relCount, note_path: notePath };
  } catch (e) {
    // 失败安全：对象留在 inbox，错误可见，原始数据完好
    const props = { ...obj.properties } as Record<string, unknown>;
    const ai = (props.ai ?? {}) as Record<string, unknown>;
    ai.processing_error = String(e);
    ai.failed_at = nowIso();
    props.ai = ai;
    try {
      store.updateObject(obj.id, { properties: props }, actor);
      await store.flush();
    } catch {
      /* 连错误标记都写不进去时不再抛出，避免打断批处理 */
    }
    return { id: obj.id, status: "error", tasks: 0, relations: 0, error: String(e) };
  }
}

/** 批量处理 Inbox（手动 / 夜间批处理 / 采集后自动）。 */
export async function processInbox(
  store: Store,
  cfg: CoreConfig,
  provider: ChatProvider,
  opts: ProcessOptions & { limit?: number } = {},
): Promise<ProcessResult[]> {
  const rows = store.queryObjects({ lifecycle: "inbox", orderBy: "created_asc", limit: opts.limit ?? 50 });
  const out: ProcessResult[] = [];
  for (const o of rows) {
    out.push(await processObject(store, cfg, provider, o.id, opts));
  }
  return out;
}

/**
 * 关系建议：标题共现（references）+ 标签重叠（related_to）。
 * 只写 suggested，且跳过已存在的关系，避免重复噪声（需求 17-B / 24-F）。
 */
export function suggestRelations(store: Store, obj: ProsObject, max = 8): number {
  const others = store.objects.filter((o) => o.id !== obj.id && o.lifecycle !== "deleted");
  const objTags = new Set(obj.tags ?? []);
  let created = 0;

  const push = (dstId: string, type: Relation["type"], confidence: number, evidence: Record<string, unknown>) => {
    if (created >= max) return;
    if (store.hasRelation(obj.id, dstId, type)) return;
    store.insertRelation(
      {
        id: newId("rel_"),
        src_id: obj.id,
        dst_id: dstId,
        type,
        status: "suggested",
        confidence,
        provenance: { origin: "ai_suggested", ...evidence },
        created_at: nowIso(),
      },
      "agent:link-suggester",
    );
    created++;
  };

  // 1) 正文出现其它对象标题 → references（带 span 证据）
  for (const other of others) {
    if (created >= max) break;
    const title = other.title?.trim();
    if (!title || title.length < 3) continue;
    const idx = obj.content.indexOf(title);
    if (idx >= 0) {
      push(other.id, "references", 0.6, { span: { start: idx, end: idx + title.length } });
    }
  }

  // 2) 标签重叠 → related_to
  for (const other of others) {
    if (created >= max) break;
    if (store.hasRelation(obj.id, other.id)) continue;
    const shared = (other.tags ?? []).filter((t) => objTags.has(t));
    if (shared.length >= 2) {
      push(other.id, "related_to", Math.min(0.75, 0.4 + shared.length * 0.1), { shared_tags: shared });
    }
  }
  return created;
}

/** 补齐关系两端标题，供笔记渲染与 UI 展示。 */
export function enrichRelations(
  store: Store,
  objectId: string,
  status?: Relation["status"],
): { out: (Relation & { peerTitle?: string })[]; in: (Relation & { peerTitle?: string })[] } {
  const { out, in: inbound } = store.relationsOf(objectId, status);
  return {
    out: out.map((r) => ({ ...r, peerTitle: store.object(r.dst_id)?.title })),
    in: inbound.map((r) => ({ ...r, peerTitle: store.object(r.src_id)?.title })),
  };
}

/**
 * 采集类对象在笔记里追加专属区块（正文/逐字稿/关键帧/项目概况等）。
 * 这些内容由 ingest 阶段写进 properties.sections，pipeline 只负责渲染。
 */
function buildKindSections(obj: ProsObject): { heading: string; body: string }[] {
  const raw = obj.properties["sections"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is { heading: string; body: string } =>
      !!s && typeof (s as { heading?: unknown }).heading === "string" && typeof (s as { body?: unknown }).body === "string")
    .map((s) => ({ heading: s.heading, body: s.body }));
}
