/**
 * 核心工具层（零宿主依赖，纯 TS）。
 *
 * 为什么自带 sha256：插件运行在 Obsidian（Electron 渲染进程）内，构建时把
 * platform 固定为 browser 且不引入任何 Node 内建模块，因此不能使用
 * `node:crypto`。这里实现一份同步的 SHA-256，用于：
 *  - 资源去重（content_hash，文档 E.2 resource.content_hash）
 *  - 备份完整性清单（文档 backup manifest）
 *  - 采集原件校验（sha256 记录，供用户比对）
 * 与 Python Core 的 hashlib.sha256 结果完全一致（同一算法、同一 UTF-8 编码）。
 */

// ---------------------------------------------------------------- SHA-256 ---

const SHA256_H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** 对字节数组做 SHA-256，返回 64 位小写十六进制。 */
export function sha256Bytes(bytes: Uint8Array): string {
  const bitLen = bytes.length * 8;
  // 填充：0x80 + 若干 0 + 8 字节大端长度
  const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);

  const h = SHA256_H0.slice();
  const w = new Uint32Array(64);

  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  let out = "";
  for (const v of h) out += v.toString(16).padStart(8, "0");
  return out;
}

const _encoder = new TextEncoder();

/** 文本 SHA-256（UTF-8），与 Python hashlib.sha256(text.encode()).hexdigest() 等价。 */
export function sha256Text(text: string): string {
  return sha256Bytes(_encoder.encode(text));
}

// ------------------------------------------------------------ 基础工具函数 ---

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * 生成时间有序的唯一 id（对应文档的 `res_01J...` / `obj_...` 风格）。
 * 前缀 + base36 时间戳 + 随机后缀：同一秒内可排序，且无需引入 uuid 依赖。
 */
export function newId(prefix = ""): string {
  const ts = Date.now().toString(36).padStart(8, "0");
  let rand = "";
  for (let i = 0; i < 8; i++) {
    rand += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return `${prefix}${ts}${rand}`;
}

/** ISO8601（秒精度，UTC），与 Python Core 的 models.now() 输出格式一致。 */
export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 仅日期（YYYY-MM-DD，本地时区），用于日期区间过滤与展示。 */
export function todayLocal(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本地日期时间（便于用户阅读的展示格式）。 */
export function humanTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 文件名安全化：剔除 Obsidian / Windows 非法字符，并限制长度。 */
export function safeFileName(name: string, max = 80): string {
  return (
    name
      .replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
      .replace(/^[.\s]+|[.\s]+$/g, "")
      .slice(0, max)
      .trim() || "untitled"
  );
}

/** JSON 深拷贝（结构化克隆不可用时的手动兜底）。 */
export function deepClone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** HTML 转义，所有用户/外部内容进 DOM 前必须过一遍（防 XSS）。 */
export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 截断到指定长度并加省略号（用于摘要/预览）。 */
export function truncate(s: string, max = 120): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 简单的防抖（写盘用，避免频繁 IO）。 */
export function debounce<F extends (...args: never[]) => void>(fn: F, wait = 300): F {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function (this: unknown, ...args: never[]) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  } as unknown as F;
}

// --------------------------------------------------------------- 检索分词 ---

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 判断是否 CJK 字符（中日韩统一表意 + 假名 + 兼容区）。 */
export function isCjk(ch: string): boolean {
  return CJK_RE.test(ch);
}

/**
 * 生成检索 token（对应 Python Core retrieval._fts_query 的 trigram 思路）。
 * - CJK：连续 3 字滑窗（trigram），解决中文短查询召回；
 * - 拉丁：按非字母数字切词，长度 >= 2 才保留；
 * 返回去重后的 token 数组，供倒排索引与查询共用。
 */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  if (!text) return [];
  const lower = text.toLowerCase();

  // 1) 拉丁词
  for (const w of lower.split(/[^0-9a-z\u00c0-\u024f]+/)) {
    if (w.length >= 2) out.add(w);
  }

  // 2) CJK trigram：把连续 CJK 段切成 3 字窗口
  let run = "";
  const flush = () => {
    if (run.length >= 3) {
      for (let i = 0; i + 3 <= run.length; i++) out.add(run.slice(i, i + 3));
    } else if (run.length > 0) {
      out.add(run);
    }
    run = "";
  };
  for (const ch of lower) {
    if (isCjk(ch)) run += ch;
    else flush();
  }
  flush();

  return [...out];
}

/** 计算对象在查询下的命中位置（用于引用 span 与原文跳转）。 */
export function locateSpan(content: string, query: string): { start: number; end: number } {
  if (!content) return { start: 0, end: 0 };
  const idx = content.indexOf(query);
  if (idx >= 0) return { start: idx, end: idx + query.length };
  // 退化策略：从最长前缀开始尝试，保证仍能给出可跳转的位置
  for (let size = Math.min(query.length, 12); size > 1; size--) {
    const i = content.indexOf(query.slice(0, size));
    if (i >= 0) return { start: i, end: i + size };
  }
  // 再退化：用最强的 token 定位
  for (const tk of tokenize(query)) {
    const i = content.toLowerCase().indexOf(tk);
    if (i >= 0) return { start: i, end: i + tk.length };
  }
  return { start: 0, end: Math.min(content.length, 60) };
}

/** 取对象正文中以 span 为中心的一段上下文，用于卡片预览。 */
export function contextAround(content: string, start: number, end: number, pad = 40): string {
  const s = Math.max(0, start - pad);
  const e = Math.min(content.length, end + pad);
  return (s > 0 ? "…" : "") + content.slice(s, e) + (e < content.length ? "…" : "");
}

/** 数组去重（按 key 函数）。 */
export function uniqueBy<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
