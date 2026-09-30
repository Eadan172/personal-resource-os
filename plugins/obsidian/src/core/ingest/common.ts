/**
 * 采集公共工具（对应 Python Core ingest/common.py）。
 *
 * 与 Python 版的关键差异（已与用户确认的实现方案）：
 *  Obsidian 插件运行在 Electron 渲染进程，**无法**执行 yt-dlp / ffmpeg / playwright 等外部程序，
 *  因此重活（视频下载、ASR 转写、抽帧、反爬浏览器渲染）在 Python Core 在线时委托给 Core 的
 *  `/ingest`；Core 不在线时降级为「插件内轻量解析 + 只保存链接与元数据」，并明确标注「待转写」，
 *  保证原始入口信息永不丢失（22-C 失败安全原则）。
 *
 * 出站策略（与 docs/03 信任边界对齐）：
 *  - 采集是用户显式发起的动作（等同于用户在浏览器里输入网址），因此不受 AI allowlist 限制，
 *    但每一次采集都写审计（op=outbound_ingest）；
 *  - 携带密钥的请求（LLM/ASR/Vision）仍严格走 checkOutbound。
 */
import type { CoreConfig } from "../config";
import type { HttpClient } from "../providers/base";
import { newId, nowIso, safeFileName } from "../util";

export type ResourceKind = "html" | "video" | "audio" | "code";

export const KIND_LABELS: Record<ResourceKind, string> = {
  html: "网页", video: "视频", audio: "音频", code: "代码",
};

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestError";
  }
}

const VIDEO_EXTS = ["mp4", "mkv", "flv", "mov", "avi", "webm", "ts", "m4v"];
const AUDIO_EXTS = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma"];
const CODE_HOSTS = /(^|\.)(github\.com|codeload\.github\.com|gitee\.com|gitlab\.com)$/i;

/**
 * 类型识别（对应 detect_type）。规则与 Python 版保持一致，便于两边行为可预期。
 */
export function detectType(source: string): ResourceKind {
  const s = (source ?? "").trim();
  if (!s) throw new IngestError("采集地址为空");
  let host = "";
  let path = "";
  try {
    const u = new URL(s);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    // 本地路径
    const ext = s.split(".").pop()?.toLowerCase() ?? "";
    if (VIDEO_EXTS.includes(ext)) return "video";
    if (AUDIO_EXTS.includes(ext)) return "audio";
    if (["zip", "tar", "gz", "tgz"].includes(ext)) return "code";
    if (["html", "htm"].includes(ext)) return "html";
    throw new IngestError(`无法识别的地址：${s}（支持 视频/音频/网页/代码 链接或本地文件路径）`);
  }

  if (/bilibili\.com$/i.test(host) && path.includes("/video/")) return "video";
  if (host === "b23.tv" || host === "youtu.be" || /youtube\.com$/i.test(host)) return "video";
  if (CODE_HOSTS.test(host)) return "code";
  if (path.endsWith(".mp3") || path.endsWith(".m4a") || path.endsWith(".wav")) return "audio";
  if (VIDEO_EXTS.some((e) => path.endsWith(`.${e}`))) return "video";
  return "html";
}

/** 为一次采集创建资源目录（vault 相对路径）。 */
export function resourceDir(cfg: CoreConfig, kind: ResourceKind, nameHint: string): string {
  const safe = safeFileName(nameHint, 50);
  return `${cfg.baseDir}/resources/${kind}/${nowIso().slice(0, 10)}-${newId("").slice(0, 8)}-${safe}`;
}

export interface ProgressFn {
  (msg: string): void;
}

export const NOOP_PROGRESS: ProgressFn = () => undefined;

/** 带浏览器 UA 的文本抓取（用户显式采集动作，跳过 AI allowlist）。 */
export async function fetchText(
  http: HttpClient,
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ status: number; text: string }> {
  const resp = await http.request({
    url,
    method: "GET",
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/json,*/*", ...(opts.headers ?? {}) },
    timeoutMs: opts.timeoutMs ?? 30000,
    skipAllowlist: true,
  });
  return { status: resp.status, text: resp.text };
}

/** JSON 抓取（平台元数据 API 用）。 */
export async function fetchJson<T = unknown>(http: HttpClient, url: string, timeoutMs = 30000): Promise<T> {
  const { status, text } = await fetchText(http, url, { timeoutMs, headers: { Accept: "application/json" } });
  if (status < 200 || status >= 300) {
    throw new IngestError(`接口返回 ${status}：${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 常见反爬/登录墙标记（与 Python 版一致）。 */
const CHALLENGE_MARKERS = [
  "zse-ck", "__cf_chl", "cf-challenge", "安全验证", "滑动验证", "captcha",
  "window._cf_", "geetest", "检测到异常流量", "访问验证",
];
const LOGIN_WALL_MARKERS = ["登录后查看", "扫码登录", "登录即可查看", "请登录", "Sign in to continue"];

/** 判断返回的是不是挑战页 / 登录墙，而不是正文。 */
export function looksLikeChallenge(html: string, status = 200): boolean {
  if ([401, 403, 429].includes(status)) return true;
  if (html.length < 2000 && [...CHALLENGE_MARKERS, ...LOGIN_WALL_MARKERS].some((m) => html.includes(m))) return true;
  return CHALLENGE_MARKERS.some((m) => html.includes(m));
}

/** 采集结果的统一返回结构。 */
export interface IngestResult {
  id: string;
  kind: ResourceKind;
  kind_label: string;
  title: string;
  resources_dir: string;
  warnings: string[];
  /** 是否走 Core 委托完成重活。 */
  delegated: boolean;
  /** 是否需要用户后续补做转写（视频/音频）。 */
  needs_transcript: boolean;
}

/** 把采集到的附加区块存进对象属性，供 pipeline 渲染进结构化笔记。 */
export function sections(heading: string, body: string): { heading: string; body: string } {
  return { heading, body };
}

/** 生成「采集信息」区块（统一格式，便于审计与排障）。 */
export function infoSection(rows: [string, string][]): { heading: string; body: string } {
  return sections("采集信息", rows.filter(([, v]) => v).map(([k, v]) => `- **${k}**：${v}`).join("\n"));
}

/** 图片/文件在笔记中的嵌入语法（Obsidian wiki 嵌入，按 vault 根路径解析，最稳）。 */
export function embedImage(vaultPath: string, caption?: string): string {
  return caption ? `![[${vaultPath}|${caption}]]` : `![[${vaultPath}]]`;
}
