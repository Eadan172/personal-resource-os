/**
 * 网页采集（对应 Python Core ingest/html.py，FR-14 网页类）。
 *
 * 插件内能做到的：
 *  1) 静态抓取正文（零依赖的标签级正文提取 + 广告/推荐位过滤，与 Python 版规则一致）；
 *  2) 下载正文配图到 `<baseDir>/resources/html/.../images/`，笔记内用 Obsidian 嵌入语法引用；
 *  3) 反爬/登录墙识别后给出可操作提示（浏览器渲染需依赖 Playwright，插件内不可用 → 委托 Core）。
 *
 * 与 Python 版的差异：不做拟人浏览器回退（插件无法启动 Chromium 进程），
 * 转而提示用户开启「委托 Python Core」或把页面另存为 HTML 后用「采集本地文件」入口。
 */
import type { CoreConfig } from "../config";
import type { Store } from "../store";
import type { HttpClient } from "../providers/base";
import { captureText } from "../capture";
import {
  embedImage, fetchText, infoSection, IngestError, looksLikeChallenge, NOOP_PROGRESS,
  resourceDir, sections, type IngestResult, type ProgressFn,
} from "./common";

/** 广告/推荐位文本特征（内容类型过滤）。 */
const AD_MARKERS = [
  "广告", "赞助", "Sponsored", "相关推荐", "更多精彩", "猜你喜欢",
  "点击下载", "扫码关注", "版权所有", "热门推荐", "推荐阅读",
];

const MIN_BODY_CHARS = 200;  // 整篇正文低于此长度视为抓取失败
const MIN_BLOCK_CHARS = 40;  // 单块低于此长度视为噪声

export interface Article {
  title: string;
  text: string;
  images: string[];
}

/** HTML 实体解码（只处理常见实体，避免引入第三方库）。 */
function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“",
    rdquo: "”", mdash: "—", ndash: "–", hellip: "…", lt_: "<",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
}

function safeFromCode(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function absolutize(src: string, base: string): string {
  if (!src) return "";
  if (src.startsWith("//")) return `https:${src}`;
  if (/^https?:/i.test(src)) return src;
  try {
    return new URL(src, base).toString();
  } catch {
    return "";
  }
}

/**
 * 零依赖正文提取：先剥离无关键，再把块级结束标签变成换行，最后按块长与广告特征过滤。
 * 该实现与 Python 版 `_ArticleParser` 的判定口径保持一致（块阈值 + 广告剔除）。
 */
export function extractArticle(
  html: string,
  url: string,
  minBlockChars = MIN_BLOCK_CHARS,
  dropMarkers: string[] = AD_MARKERS,
): Article {
  if (!html) return { title: "", text: "", images: [] };

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const ogTitle = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  const title = decodeEntities((ogTitle?.[1] ?? titleMatch?.[1] ?? "").trim());

  // 收集图片（含懒加载属性）
  const images: string[] = [];
  const seenImg = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src =
      /(?:data-src|data-original|data-lazy-src|src)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
    const abs = absolutize(decodeEntities(src), url);
    if (abs && !/\.svg(\?|$)/i.test(abs) && !seenImg.has(abs)) {
      seenImg.add(abs);
      images.push(abs);
    }
  }

  // 剥离无关块
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|header|footer|form|button|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // 块级标签 → 换行（保证段落可切分）
  body = body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|td|th|blockquote|h[1-6]|tr|ul|ol|pre)>/gi, "\n")
    .replace(/<(p|div|section|article|li|td|th|blockquote|h[1-6]|tr|ul|ol|pre)\b[^>]*>/gi, "\n");
  body = body.replace(/<[^>]+>/g, " ");

  const text = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= minBlockChars && !dropMarkers.some((m) => l.includes(m)))
    .join("\n\n");

  return { title: title || url, text, images };
}

/** 下载正文配图，返回 (vault 相对路径数组, 警告)。 */
async function downloadImages(
  http: HttpClient,
  store: Store,
  images: string[],
  dir: string,
  maxImages: number,
  progress: ProgressFn,
): Promise<{ saved: string[]; warnings: string[] }> {
  const saved: string[] = [];
  const warnings: string[] = [];
  if (maxImages <= 0) return { saved, warnings };
  const targets = images.slice(0, maxImages);
  for (let i = 0; i < targets.length; i++) {
    const url = targets[i];
    try {
      progress(`下载配图 ${i + 1}/${targets.length}…`);
      const bin = await http.fetchBinary(url, { timeoutMs: 30000, headers: { Referer: url } });
      if (bin.status < 200 || bin.status >= 300) throw new Error(`HTTP ${bin.status}`);
      if (bin.bytes.byteLength > 15 * 1024 * 1024) {
        warnings.push(`配图过大已跳过：${url.slice(0, 80)}`);
        continue;
      }
      const ext = (url.split("?")[0].split(".").pop() ?? "jpg").toLowerCase().slice(0, 5);
      const name = `img_${String(i + 1).padStart(2, "0")}.${/^[a-z0-9]+$/.test(ext) ? ext : "jpg"}`;
      const vaultPath = `${dir}/images/${name}`;
      await store.fs.writeBinary(vaultPath, bin.bytes);
      saved.push(vaultPath);
    } catch (e) {
      warnings.push(`配图下载失败：${url.slice(0, 80)}（${String(e)}）`);
    }
  }
  return { saved, warnings };
}

export interface IngestHtmlOptions {
  /** 配图上限。 */
  maxImages?: number;
  /** 额外标签。 */
  tags?: string[];
  /** 是否同时保存原始 HTML 文件（默认 true，符合「原件保留」原则）。 */
  saveOriginal?: boolean;
  /** 委托 Core 的实现（Core 在线时用于反爬渲染等重活）。 */
  delegate?: (url: string) => Promise<IngestResult | null>;
}

/** 采集网页：抓正文 + 下配图 + 原件归档 + 进 Inbox。 */
export async function ingestHtml(
  store: Store,
  cfg: CoreConfig,
  http: HttpClient,
  url: string,
  opts: IngestHtmlOptions = {},
  progress: ProgressFn = NOOP_PROGRESS,
): Promise<IngestResult> {
  const warnings: string[] = [];
  progress("静态抓取网页…");
  let html = "";
  let status = 200;
  try {
    const r = await fetchText(http, url, { timeoutMs: 30000 });
    status = r.status;
    html = r.text;
  } catch (e) {
    warnings.push(`静态抓取失败（${String(e)}）`);
  }

  let article = extractArticle(html, url);
  let fetchMode = "static";

  // 反爬/登录墙 → 插件内无法渲染，改为委托 Core 或给出可操作提示
  if (!article.text || article.text.length < MIN_BODY_CHARS || looksLikeChallenge(html, status)) {
    if (opts.delegate) {
      progress("检测到反爬/登录墙，尝试委托 Python Core 渲染…");
      const delegated = await opts.delegate(url);
      if (delegated) return delegated;
    }
    if (!article.text) {
      throw new IngestError(
        "未能提取到网页正文。该站点可能需要登录态或启用了反爬保护。\n" +
        "可选做法：\n" +
        "  1) 在「设置 → Core 连接」中启动并连接 Python Core，由 Core 的拟人浏览器渲染抓取；\n" +
        "  2) 用浏览器打开该页面并另存为 HTML，再用「采集本地文件」入口导入。",
      );
    }
    fetchMode = "degraded";
    warnings.push("正文较短或疑似反爬页面，已按现有内容入库；建议启用 Python Core 以获得完整抓取");
  }

  const title = (article.title || url).slice(0, 120);
  const dir = resourceDir(cfg, "html", title);
  const warningsAll = [...warnings];

  // 原件归档：原始 HTML 只增不改（TB-1）
  if (opts.saveOriginal !== false && html) {
    try {
      await store.fs.write(`${dir}/original.html`, html);
    } catch (e) {
      warningsAll.push(`原件保存失败：${String(e)}`);
    }
  }

  progress("下载正文配图…");
  const maxImages = opts.maxImages ?? cfg.ingestMaxImages;
  const imgs = await downloadImages(http, store, article.images, dir, maxImages, progress);
  warningsAll.push(...imgs.warnings);

  // 正文作为 content（原始事实）；图表与采集信息作为附加区块
  const extraSections = [
    sections(
      `图表（${imgs.saved.length} 张，已存本地）`,
      imgs.saved.length ? imgs.saved.map((p) => embedImage(p)).join("\n\n") : "（无）",
    ),
    infoSection([
      ["来源", url],
      ["采集方式", fetchMode === "static" ? "插件静态抓取" : "降级抓取（正文可能不完整）"],
      ["原件", `${dir}/original.html`],
      ["配图", `${imgs.saved.length} 张`],
    ]),
  ];

  const cap = await captureText(store, cfg, {
    content: article.text,
    title,
    source_uri: url,
    tags: [`ingest/html`, ...(opts.tags ?? [])],
    kind: "html",
    sourceChannel: "obsidian",
    properties: {
      ingest_kind: "html",
      resources_dir: dir,
      fetch_mode: fetchMode,
      image_count: imgs.saved.length,
      processor: "pros-plugin/ingest/html",
      processor_version: "1.0.0",
      sections: extraSections,
      warnings: warningsAll,
    },
  });

  return {
    id: cap.id,
    kind: "html",
    kind_label: "网页",
    title,
    resources_dir: dir,
    warnings: warningsAll,
    delegated: false,
    needs_transcript: false,
  };
}
