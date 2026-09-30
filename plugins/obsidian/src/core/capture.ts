/**
 * Capture Pipeline（对应 Python Core capture.py，需求 19-H / 20-C）。
 *
 * 一切输入（文本/剪贴板/文件/网页/视频链接）统一进 Inbox：
 *  - 原始内容字节级保留，先落库落盘，再谈 AI（AI 失败不得丢数据，22-C）；
 *  - content_hash 用于去重；重复只写 `duplicate_of` 关系建议（suggested），不自动合并（17-B）；
 *  - 采集产物：<baseDir>/resources/<kind>/<id>-<name>/ 下保存原件与衍生文件。
 */
import type { CoreConfig } from "./config";
import type { DataClass, ProsObject } from "./models";
import type { Store } from "./store";
import { rawNotePath, renderRawNote, writeNote } from "./notes";
import { newId, nowIso, safeFileName, sha256Bytes, sha256Text } from "./util";

/** 资源类型（对应 Python Core ingest 的 KINDS + capture 的文本类）。 */
export type ResourceKind =
  | "text" | "markdown" | "html" | "url" | "pdf" | "office"
  | "image" | "audio" | "video" | "code" | "clipboard" | "file_drop";

/** 输入渠道（对应文档 resource.source_channel）。 */
export type SourceChannel =
  | "obsidian" | "hotkey" | "browser" | "mobile" | "workbuddy"
  | "wechat" | "ima" | "drop" | "manual";

export interface CaptureInput {
  content: string;
  title?: string | null;
  source_uri?: string | null;
  tags?: string[];
  kind?: ResourceKind;
  sourceChannel?: SourceChannel;
  dataClass?: DataClass;
  /** 采集者：user / connector:<id> / agent:<name>；connector 输入会被标记 untrusted。 */
  actor?: string;
  /** 是否把原始内容写入 inbox/*.md（默认 true）。 */
  writeNote?: boolean;
  /** 采集类笔记预先计算好的正文（避免重复计算）。 */
  contentHash?: string;
  /** 附加属性（采集元数据：resources_dir / processor 等）。 */
  properties?: Record<string, unknown>;
  /** 生命周期：采集默认 inbox。 */
  lifecycle?: ProsObject["lifecycle"];
}

export interface CaptureResult {
  id: string;
  title: string;
  duplicate_of: string | null;
  note_path: string | null;
  content_hash: string;
  kind: ResourceKind;
}

/** 从正文推断资源类型（无显式 kind 时）。 */
export function inferKind(content: string, sourceUri?: string | null): ResourceKind {
  if (sourceUri) {
    const u = (sourceUri.split("?")[0] ?? "").toLowerCase();
    if (/\.(md|markdown)$/.test(u)) return "markdown";
    if (/\.html?$/.test(u)) return "html";
    if (/\.pdf$/.test(u)) return "pdf";
    if (/\.(docx?|pptx?|xlsx?|odt)$/.test(u)) return "office";
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(u)) return "image";
    if (/\.(mp3|wav|m4a|aac|flac|ogg|opus|wma)$/.test(u)) return "audio";
    if (/\.(mp4|mkv|flv|mov|avi|webm|ts|m4v)$/.test(u)) return "video";
    if (/\.(zip|tar|gz|tgz)$/.test(u)) return "code";
    if (/^https?:/.test(u)) return "url";
  }
  if (/^\s*#{1,6}\s|\n\s*#{1,6}\s|^\s*[-*]\s/m.test(content)) return "markdown";
  if (/^\s*<(!doctype|html|div|p|article)/i.test(content)) return "html";
  return "text";
}

/** 由正文推导标题：首个非空行（去 Markdown 记号），最长 60 字。 */
export function inferTitle(content: string): string {
  const first = content
    .split("\n")
    .map((l) => l.replace(/^[#>\-*\s]+/, "").trim())
    .find((l) => l.length > 0);
  return (first ?? "未命名").slice(0, 60);
}

/**
 * 采集文本内容（主入口）。
 * 步骤：校验 → 建对象 → 落库 → 写审计 → 写 inbox 笔记 → 查重。
 */
export async function captureText(
  store: Store,
  cfg: CoreConfig,
  input: CaptureInput,
): Promise<CaptureResult> {
  const content = input.content ?? "";
  if (!content.trim()) throw new Error("内容为空，无法采集");

  const kind = input.kind ?? inferKind(content, input.source_uri);
  const title = (input.title?.trim() || inferTitle(content)).slice(0, 120);
  const actor = input.actor ?? "user";
  const contentHash = input.contentHash ?? sha256Text(content);
  const ts = nowIso();

  // Connector 进入的内容一律视为不可信（防提示注入，docs/06 §4）
  const untrusted = actor.startsWith("connector");

  const obj: ProsObject = {
    id: newId("obj_"),
    type: "note",
    title,
    content,
    source_uri: input.source_uri ?? null,
    content_hash: contentHash,
    origin: "raw",
    confidence: 1,
    provenance: {
      origin: "raw",
      source_channel: input.sourceChannel ?? "obsidian",
      kind,
      untrusted,
      captured_at: ts,
    },
    tags: input.tags ?? [],
    properties: { ingest_kind: kind, ...(input.properties ?? {}) },
    data_class: input.dataClass ?? cfg.defaultDataClass,
    event_time_start: null,
    event_time_end: null,
    lifecycle: input.lifecycle ?? "inbox",
    created_at: ts,
    updated_at: ts,
  };

  store.insertObject(obj, actor);

  // 写 inbox 笔记（原始层，只增不改）
  let notePath: string | null = null;
  if (input.writeNote !== false) {
    notePath = await writeNote(store.fs, rawNotePath(cfg, obj), renderRawNote(obj));
    store.updateObject(obj.id, { properties: { ...obj.properties, inbox_path: notePath } }, "user");
  }

  // 查重：只提示，不合并
  const dup = store.objectByHash(contentHash, obj.id);
  if (dup) {
    store.insertRelation(
      {
        id: newId("rel_"),
        src_id: obj.id,
        dst_id: dup.id,
        type: "duplicate_of",
        status: "suggested",
        confidence: 1,
        provenance: { origin: "ai_suggested", reason: "content_hash 完全相同" },
        created_at: ts,
      },
      "system",
    );
  }

  await store.flush();
  return {
    id: obj.id,
    title,
    duplicate_of: dup?.id ?? null,
    note_path: notePath,
    content_hash: contentHash,
    kind,
  };
}

export interface CaptureBinaryInput {
  filename: string;
  bytes: ArrayBuffer;
  mime?: string;
  title?: string;
  sourceUri?: string | null;
  kind?: ResourceKind;
  tags?: string[];
  sourceChannel?: SourceChannel;
  /** 文本类文件可顺带给出解码后的正文，避免再次解析。 */
  textContent?: string | null;
  actor?: string;
}

/**
 * 采集二进制原件（图片/PDF/音视频/压缩包/任意文件拖入）。
 * 原件按 sha256 分桶存到 <baseDir>/resources/<kind>/，永不因 AI 失败丢失。
 */
export async function captureBinary(
  store: Store,
  cfg: CoreConfig,
  input: CaptureBinaryInput,
): Promise<CaptureResult & { stored_path: string; size: number }> {
  const kind = input.kind ?? (inferKind(input.textContent ?? "", input.filename) as ResourceKind);
  const hash = sha256Bytes(new Uint8Array(input.bytes));
  const safe = safeFileName(input.filename, 70);
  const dir = `${cfg.baseDir}/resources/${kind}/${hash.slice(0, 12)}-${safe}`;
  const storedPath = `${dir}/${safe}`;
  await store.fs.writeBinary(storedPath, input.bytes);

  const text = input.textContent?.trim()
    ? input.textContent
    : `（二进制原件，未内联正文）\n\n文件名：${input.filename}\n大小：${input.bytes.byteLength} 字节\n类型：${input.mime ?? "application/octet-stream"}\n存储路径：${storedPath}`;

  const cap = await captureText(store, cfg, {
    content: text,
    title: input.title ?? input.filename,
    source_uri: input.sourceUri ?? storedPath,
    tags: input.tags,
    kind,
    sourceChannel: input.sourceChannel ?? "drop",
    contentHash: hash,
    actor: input.actor,
    properties: {
      original_path: input.filename,
      stored_path: storedPath,
      mime: input.mime ?? "application/octet-stream",
      size: input.bytes.byteLength,
      resources_dir: dir,
    },
  });

  await store.flush();
  return { ...cap, stored_path: storedPath, size: input.bytes.byteLength };
}

/** 采集一个本地路径的文本文件（Obsidian 的 file drop / 命令入口使用）。 */
export async function captureLocalFile(
  store: Store,
  cfg: CoreConfig,
  path: string,
  bytes: ArrayBuffer,
  opts: { mime?: string; sourceChannel?: SourceChannel; tags?: string[] } = {},
): Promise<CaptureResult & { stored_path: string; size: number }> {
  const name = path.split("/").pop() ?? path;
  const isTextish = /\.(md|markdown|txt|html?|json|csv|tsv|ya?ml|log|py|js|ts|java|go|rs|c|cpp|sql)$/i.test(name);
  let text: string | null = null;
  if (isTextish) {
    try {
      text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch {
      text = null;
    }
  }
  return captureBinary(store, cfg, {
    filename: name,
    bytes,
    mime: opts.mime,
    sourceUri: path,
    tags: opts.tags,
    sourceChannel: opts.sourceChannel ?? "drop",
    textContent: text,
    kind: inferKind(text ?? "", name),
  });
}
