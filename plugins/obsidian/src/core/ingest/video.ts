/**
 * 视频 / 音频采集（对应 Python Core ingest/video.py，FR-14 视频类）。
 *
 * 插件内能做的（零外部程序）：
 *  1) B 站：调用公开 view 接口取标题/UP主/时长/简介/封面，再尝试拉取 **平台字幕** 作为逐字稿；
 *  2) YouTube：调用 oEmbed 取标题与作者（字幕接口通常需登录态，失败即降级）；
 *  3) 直链音频：只登记链接与元数据；
 *  4) 全程不下载媒体文件本体（插件无法运行 yt-dlp/ffmpeg），转写留待「委托 Python Core」或后续补充。
 *
 * 降级契约：拿不到逐字稿时，笔记正文写入平台元数据并标注「待转写」，
 * 同时 needs_transcript=true 让 UI 提示用户；入口信息（链接/标题/UP主/时长）永不丢失。
 */
import type { CoreConfig } from "../config";
import type { Store } from "../store";
import type { HttpClient } from "../providers/base";
import { captureText } from "../capture";
import {
  embedImage, fetchJson, infoSection, IngestError, NOOP_PROGRESS, resourceDir,
  sections, type IngestResult, type ProgressFn,
} from "./common";

export interface IngestMediaOptions {
  tags?: string[];
  /** 委托 Core：Core 在线时把下载/转写/抽帧交给它。 */
  delegate?: (url: string, kind: "video" | "audio") => Promise<IngestResult | null>;
  /** 是否下载封面图到本地（默认 true）。 */
  fetchCover?: boolean;
}

interface MediaMeta {
  title: string;
  author: string;
  duration: number;
  description: string;
  cover: string;
  platform: string;
  /** 平台 id（BV 号等）。 */
  vid: string;
  extra: [string, string][];
  transcript: string;
  transcriptSource: string;
}

const BV_RE = /(BV[0-9A-Za-z]{8,12})/;
const YT_ID_RE = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{6,20})/;

/** 从链接中提取平台标识。 */
export function parseVideoId(url: string): { platform: "bilibili" | "youtube" | "other"; id: string } {
  const bv = BV_RE.exec(url);
  if (bv) return { platform: "bilibili", id: bv[1] };
  if (/b23\.tv/i.test(url)) return { platform: "bilibili", id: "" };
  if (/youtu\.?be/i.test(url)) {
    const m = YT_ID_RE.exec(url);
    return { platform: "youtube", id: m?.[1] ?? "" };
  }
  return { platform: "other", id: "" };
}

/** 秒 → 时分秒。 */
function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return "未知";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}小时${String(m).padStart(2, "0")}分${String(s).padStart(2, "0")}秒`
    : `${m}分${String(s).padStart(2, "0")}秒`;
}

/** B 站平台元数据 + 字幕（字幕常需登录态，失败静默降级）。 */
async function fetchBilibili(http: HttpClient, bvid: string, progress: ProgressFn): Promise<MediaMeta> {
  const view = await fetchJson<{
    code: number;
    message?: string;
    data?: {
      bvid: string; aid: number; cid: number; title: string; desc: string; duration: number;
      pic: string; owner?: { name?: string }; tname?: string; pubdate?: number;
      stat?: { view?: number; like?: number; reply?: number };
    };
  }>(http, `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);

  if (view.code !== 0 || !view.data) {
    throw new IngestError(`B 站接口返回错误（code=${view.code}）：${view.message ?? "未知错误"}`);
  }
  const d = view.data;
  const meta: MediaMeta = {
    title: d.title,
    author: d.owner?.name ?? "未知",
    duration: d.duration ?? 0,
    description: d.desc ?? "",
    cover: d.pic ?? "",
    platform: "bilibili",
    vid: d.bvid,
    extra: [
      ["分区", d.tname ?? ""],
      ["播放量", d.stat?.view != null ? String(d.stat.view) : ""],
      ["点赞", d.stat?.like != null ? String(d.stat.like) : ""],
      ["发布时间", d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 10) : ""],
    ],
    transcript: "",
    transcriptSource: "",
  };

  // 尝试拉取平台字幕（AI 字幕 / CC）
  progress("尝试获取平台字幕…");
  try {
    const player = await fetchJson<{
      code: number;
      data?: { subtitle?: { subtitles?: { lan: string; lan_doc: string; subtitle_url: string }[] } };
    }>(http, `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(d.bvid)}&cid=${d.cid}`);
    const subs = player.data?.subtitle?.subtitles ?? [];
    // 优先中文，其次第一个可用
    const picked = subs.find((s) => s.lan.startsWith("zh")) ?? subs[0];
    if (picked) {
      const subUrl = picked.subtitle_url.startsWith("//") ? `https:${picked.subtitle_url}` : picked.subtitle_url;
      const body = await fetchJson<{ body?: { content: string }[] }>(http, subUrl);
      const lines = (body.body ?? []).map((b) => b.content).filter(Boolean);
      if (lines.length) {
        meta.transcript = lines.join("\n");
        meta.transcriptSource = `B 站平台字幕（${picked.lan_doc || picked.lan}）`;
      }
    }
  } catch {
    // 无登录态/接口变动时静默降级（不视为失败）
  }
  return meta;
}

/** YouTube oEmbed（无需密钥）。 */
async function fetchYouTube(http: HttpClient, url: string): Promise<MediaMeta> {
  const oembed = await fetchJson<{ title?: string; author_name?: string; thumbnail_url?: string }>(
    http,
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
  );
  return {
    title: oembed.title ?? "YouTube 视频",
    author: oembed.author_name ?? "未知",
    duration: 0,
    description: "",
    cover: oembed.thumbnail_url ?? "",
    platform: "youtube",
    vid: parseVideoId(url).id,
    extra: [],
    transcript: "",
    transcriptSource: "",
  };
}

/** 通用兜底：只登记链接本身（直链音频/其它平台）。 */
function genericMeta(url: string, kind: "video" | "audio"): MediaMeta {
  const name = (url.split("?")[0].split("/").pop() ?? url).slice(0, 80);
  return {
    title: name || (kind === "audio" ? "音频" : "视频"),
    author: "未知", duration: 0, description: "",
    cover: "", platform: "other", vid: "",
    extra: [], transcript: "", transcriptSource: "",
  };
}

/** 采集视频/音频：元数据 + 字幕（如可得）→ Inbox。 */
export async function ingestMedia(
  store: Store,
  cfg: CoreConfig,
  http: HttpClient,
  source: string,
  kind: "video" | "audio",
  opts: IngestMediaOptions = {},
  progress: ProgressFn = NOOP_PROGRESS,
): Promise<IngestResult> {
  const warnings: string[] = [];
  const parsed = parseVideoId(source);
  let meta: MediaMeta;

  progress("获取平台元数据…");
  if (parsed.platform === "bilibili" && parsed.id) {
    meta = await fetchBilibili(http, parsed.id, progress);
  } else if (parsed.platform === "youtube") {
    try {
      meta = await fetchYouTube(http, source);
    } catch (e) {
      warnings.push(`YouTube 元数据获取失败（${String(e)}）`);
      meta = genericMeta(source, kind);
    }
  } else {
    meta = genericMeta(source, kind);
    if (kind === "video" && !meta.transcript) {
      warnings.push("该平台暂不支持插件内元数据解析，仅登记链接与标题");
    }
  }

  const needsTranscript = !meta.transcript;

  // 封面图下载（可选）
  const dir = resourceDir(cfg, kind, meta.title);
  let coverPath = "";
  if (opts.fetchCover !== false && meta.cover) {
    try {
      progress("下载封面图…");
      const bin = await http.fetchBinary(meta.cover, { timeoutMs: 20000 });
      if (bin.status >= 200 && bin.status < 300 && bin.bytes.byteLength < 10 * 1024 * 1024) {
        coverPath = `${dir}/cover.jpg`;
        await store.fs.writeBinary(coverPath, bin.bytes);
      }
    } catch (e) {
      warnings.push(`封面下载失败：${String(e)}`);
    }
  }

  // 委托 Core（Core 在线时可完成下载 + ASR 转写 + 抽帧）
  if (opts.delegate) {
    progress("检测到 Python Core，尝试委托完整采集（下载/转写/抽帧）…");
    try {
      const delegated = await opts.delegate(source, kind);
      if (delegated) return delegated;
    } catch (e) {
      warnings.push(`委托 Core 失败，已降级为插件内轻量采集：${String(e)}`);
    }
  }

  if (needsTranscript) {
    warnings.push(
      "未获得逐字稿：插件内无法运行 yt-dlp/ffmpeg/ASR。可在「设置 → Core 连接」启用 Python Core 后重新采集，" +
      "或手动把字幕/文稿粘贴进该笔记。",
    );
  }

  // content = 逐字稿（原始事实）；没有则写入元数据 + 明确的待转写标记
  const content = meta.transcript
    || [
      `（待转写）本条为${kind === "audio" ? "音频" : "视频"}链接，插件已保存全部可得元数据。`,
      "",
      `标题：${meta.title}`,
      `作者：${meta.author}`,
      `时长：${fmtDuration(meta.duration)}`,
      meta.description ? `\n平台简介：\n${meta.description}` : "",
    ].filter(Boolean).join("\n");

  const extraSections = [
    sections("平台信息", [
      `- **平台**：${meta.platform}`,
      meta.vid ? `- **视频 ID**：${meta.vid}` : "",
      `- **作者/UP主**：${meta.author}`,
      `- **时长**：${fmtDuration(meta.duration)}`,
      meta.transcriptSource ? `- **逐字稿来源**：${meta.transcriptSource}` : "- **逐字稿来源**：（尚无，待转写）",
      ...meta.extra.filter(([, v]) => v).map(([k, v]) => `- **${k}**：${v}`),
    ].filter(Boolean).join("\n")),
  ];
  if (coverPath) extraSections.push(sections("封面", embedImage(coverPath)));
  if (meta.description) extraSections.push(sections("平台简介", meta.description));
  extraSections.push(infoSection([
    ["原始链接", source],
    ["媒体原件", "未在插件内下载（插件无 yt-dlp/ffmpeg）；启用 Python Core 可归档原件"],
  ]));

  const cap = await captureText(store, cfg, {
    content,
    title: `${kind === "audio" ? "音频" : "视频"}：${meta.title}`.slice(0, 120),
    source_uri: source,
    tags: [`ingest/${kind}`, ...(opts.tags ?? [])],
    kind,
    properties: {
      ingest_kind: kind,
      resources_dir: dir,
      platform: meta.platform,
      vid: meta.vid,
      author: meta.author,
      duration: meta.duration,
      cover_path: coverPath,
      has_transcript: !!meta.transcript,
      needs_transcript: needsTranscript,
      processor: "pros-plugin/ingest/video",
      processor_version: "1.0.0",
      sections: extraSections,
      warnings,
    },
  });

  return {
    id: cap.id,
    kind,
    kind_label: kind === "audio" ? "音频" : "视频",
    title: meta.title,
    resources_dir: dir,
    warnings,
    delegated: false,
    needs_transcript: needsTranscript,
  };
}
