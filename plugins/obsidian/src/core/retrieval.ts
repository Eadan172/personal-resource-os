/**
 * 混合检索（对应 Python Core retrieval.py，需求 28-G）。
 *
 * 三层召回 + 融合 + 规则重排：
 *  1) 词法层：内存倒排索引（trigram 支持中文短查询），即 Python 版 FTS5 的等价物；
 *  2) 语义层：Provider 提供 embed 时做余弦召回（可选，未配置则自动跳过）；
 *  3) 元数据/时间层：类型 / 标签 / 生命周期 / 时间区间过滤（在召回前下推，避免全表捞出）。
 *  融合用 RRF（Reciprocal Rank Fusion），最后做规则重排（标题命中、时效、类型权重）。
 *
 * 返回结果都带 `span`（命中位置），供 UI 跳回原文（需求 30-D）。
 */
import type { CoreConfig } from "./config";
import type { ProsObject } from "./models";
import type { Store } from "./store";
import type { ChatProvider } from "./providers/base";
import { contextAround, locateSpan, tokenize } from "./util";
import type { Span } from "./extraction";

export interface SearchHit {
  object_id: string;
  type: string;
  title: string;
  snippet: string;
  span: Span;
  score: number;
  created_at: string;
  lifecycle: string;
  tags: string[];
  matched_by: ("title" | "lexical" | "vector")[];
}

export interface SearchOptions {
  types?: string[];
  tags?: string[];
  start?: string;
  end?: string;
  lifecycle?: "inbox" | "processed" | "archived" | "all";
  limit?: number;
  /** 是否启用语义召回（需 Provider 支持 embed）。 */
  useVector?: boolean;
  provider?: ChatProvider;
  cfg?: CoreConfig;
}

// ------------------------------------------------------------------ 索引 ---

interface IndexEntry {
  id: string;
  tokens: string[];
  titleLower: string;
  tagsLower: string[];
}

/** 内存倒排索引：`构建 → 查询` 分离，构建结果按库版本号缓存。 */
export class SearchIndex {
  private postings = new Map<string, Set<string>>();
  private entries = new Map<string, IndexEntry>();
  private vectors = new Map<string, number[]>();
  private version = "";

  /** 库变化时重建（比较对象数 + updated_at 的轻量指纹）。 */
  ensure(store: Store): void {
    const v = `${store.objects.length}:${store.db.updated_at ?? ""}`;
    if (v === this.version) return;
    this.build(store);
    this.version = v;
  }

  build(store: Store): void {
    this.postings.clear();
    this.entries.clear();
    for (const o of store.objects) {
      if (o.lifecycle === "deleted") continue;
      const text = `${o.title}\n${o.content}\n${o.tags.join(" ")}`;
      const tokens = tokenize(text);
      const entry: IndexEntry = {
        id: o.id,
        tokens,
        titleLower: o.title.toLowerCase(),
        tagsLower: o.tags.map((t) => t.toLowerCase()),
      };
      this.entries.set(o.id, entry);
      for (const tk of new Set(tokens)) {
        let set = this.postings.get(tk);
        if (!set) {
          set = new Set();
          this.postings.set(tk, set);
        }
        set.add(o.id);
      }
    }
  }

  /** 词法召回：按命中 token 数 + 标题命中的加权打分。 */
  lexical(query: string, limit: number): { id: string; score: number }[] {
    const qTokens = tokenize(query);
    if (!qTokens.length) return [];
    const scores = new Map<string, number>();
    const qLower = query.toLowerCase();
    for (const tk of qTokens) {
      const ids = this.postings.get(tk);
      if (!ids) continue;
      for (const id of ids) {
        // 长 token 信息量更大，给更高权重
        const w = 1 + Math.min(tk.length, 6) * 0.15;
        scores.set(id, (scores.get(id) ?? 0) + w);
      }
      // 子串出现在标题里，额外加权（中文查询常命中标题）
      for (const [id, e] of this.entries) {
        if (e.titleLower.includes(qLower)) scores.set(id, (scores.get(id) ?? 0) + 3);
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** 缓存向量（Provider 支持 embed 时填充）。 */
  setVector(id: string, v: number[]): void {
    this.vectors.set(id, v);
  }
  getVector(id: string): number[] | undefined {
    return this.vectors.get(id);
  }
  vectorCount(): number {
    return this.vectors.size;
  }
  clearVectors(): void {
    this.vectors.clear();
  }
  entry(id: string): IndexEntry | undefined {
    return this.entries.get(id);
  }
  /** 已索引对象数（Dashboard 展示索引状态）。 */
  size(): number {
    return this.entries.size;
  }
}

// ------------------------------------------------------------------ 检索 ---

/** 进程内单例索引（单用户场景，无需跨进程共享）。 */
export const globalIndex = new SearchIndex();

/** 执行一次混合检索。 */
export async function search(
  store: Store,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const q = (query ?? "").trim();
  if (!q) return [];
  const limit = opts.limit ?? 20;
  const index = globalIndex;
  index.ensure(store);

  // 元数据过滤下推：先算候选集合，再做召回，避免“全表捞出后在应用层过滤”
  const allowed = new Set<string>(
    store
      .queryObjects({
        lifecycle: opts.lifecycle ?? "all",
        types: opts.types,
        tags: opts.tags,
        start: opts.start,
        end: opts.end,
      })
      .map((o) => o.id),
  );

  // 1) 词法召回（多取一些作为融合池）
  const lexical = index.lexical(q, Math.max(limit * 4, 40)).filter((r) => allowed.has(r.id));
  const lexicalRank = new Map(lexical.map((r, i) => [r.id, i + 1]));

  // 2) 语义召回（可选）
  const vectorRank = new Map<string, number>();
  const matched = new Map<string, Set<"title" | "lexical" | "vector">>();
  if (opts.useVector && opts.provider?.embed) {
    try {
      const pool = lexical.length ? lexical.map((r) => r.id) : [...allowed].slice(0, 200);
      const poolObjs = pool.map((id) => store.object(id)).filter((o): o is ProsObject => !!o);
      const missing = poolObjs.filter((o) => !index.getVector(o.id));
      if (missing.length) {
        const vecs = await opts.provider.embed(missing.map((o) => `${o.title}\n${o.content.slice(0, 2000)}`));
        missing.forEach((o, i) => {
          if (vecs[i]) index.setVector(o.id, vecs[i]);
        });
      }
      const [qv] = await opts.provider.embed([q]);
      if (qv) {
        const scored = poolObjs
          .map((o) => ({ id: o.id, s: cosine(qv, index.getVector(o.id) ?? []) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, limit * 2);
        scored.forEach((x, i) => vectorRank.set(x.id, i + 1));
      }
    } catch (e) {
      // 语义召回失败不影响词法结果（离线/额度不足时静默降级）
      console.warn("[PROS] 语义召回失败，已退化为词法检索：", e);
    }
  }

  // 3) RRF 融合
  const K = 60;
  const fused = new Map<string, number>();
  for (const id of new Set([...lexicalRank.keys(), ...vectorRank.keys()])) {
    let s = 0;
    const lr = lexicalRank.get(id);
    if (lr) {
      s += 1 / (K + lr);
      push(matched, id, "lexical");
    }
    const vr = vectorRank.get(id);
    if (vr) {
      s += 1 / (K + vr);
      push(matched, id, "vector");
    }
    fused.set(id, s);
  }

  // 4) 规则重排 + 生成命中片段
  const hits: SearchHit[] = [];
  for (const [id, base] of fused) {
    const obj = store.object(id);
    if (!obj) continue;
    const span = locateSpan(obj.content, q);
    const e = index.entry(id);
    let score = base;
    if (e?.titleLower.includes(q.toLowerCase())) {
      score += 0.05;
      push(matched, id, "title");
    }
    // 时效加成：越新越靠前（个人知识库场景更符合直觉）
    const ageDays = (Date.now() - new Date(obj.created_at).getTime()) / 86400000;
    score += Math.max(0, 0.02 - ageDays * 0.0002);
    if (obj.tags.some((t) => opts.tags?.includes(t))) score += 0.01;

    hits.push({
      object_id: id,
      type: obj.type,
      title: obj.title,
      snippet: contextAround(obj.content, span.start, span.end, 50),
      span,
      score,
      created_at: obj.created_at,
      lifecycle: obj.lifecycle,
      tags: obj.tags,
      matched_by: [...(matched.get(id) ?? [])],
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function push(m: Map<string, Set<"title" | "lexical" | "vector">>, id: string, by: "title" | "lexical" | "vector"): void {
  let s = m.get(id);
  if (!s) {
    s = new Set();
    m.set(id, s);
  }
  s.add(by);
}

function cosine(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/** 关键词高亮：把命中片段包成 <mark>（调用方需保证已转义）。 */
export function highlightSnippet(snippet: string, query: string): string {
  if (!query) return snippet;
  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return snippet.replace(new RegExp(esc, "gi"), (m) => `\u0001${m}\u0002`);
  } catch {
    return snippet;
  }
}
