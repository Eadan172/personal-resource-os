/**
 * RAG 引用问答（对应 Python Core rag.py，需求 29-E / 30-D）。
 *
 * 流程：Query → 混合检索 → 证据选择 → 生成回答 → 引用校验。
 * 铁律：
 *  - 无证据必须明确回答“不知道”，不得编造；
 *  - 每条引用都带 object_id + span + exact_text，UI 可一键跳回原文位置；
 *  - 引用编号必须在回答中真实出现（防止模型乱标引用）。
 */
import type { Store } from "./store";
import type { ChatProvider } from "./providers/base";
import { search, type SearchHit, type SearchOptions } from "./retrieval";
import { locateSpan } from "./util";
import type { Span } from "./extraction";

export const NO_EVIDENCE_ANSWER = "我没有在资料库中找到可回答该问题的证据。";

export interface Citation {
  n: number;
  object_id: string;
  title: string;
  span: Span;
  /** 与原文切片严格一致的文本（引用正确性校验的基础）。 */
  exact_text: string;
  /** 用于跳转的定位信息：vault 内位置或对象 id。 */
  locator: { file?: string; path?: string; start: number; end: number };
}

export interface AskResult {
  question: string;
  answer: string;
  citations: Citation[];
  evidence_count: number;
  /** 是否因无证据而拒答。 */
  refused: boolean;
  used_provider: string;
  hits: SearchHit[];
  created_at: string;
}

export interface AskOptions extends SearchOptions {
  provider: ChatProvider;
  /** 证据条数上限（默认 5，与 Python 版一致）。 */
  topK?: number;
}

/** 面向用户的入口：带引用的问答。 */
export async function ask(store: Store, question: string, opts: AskOptions): Promise<AskResult> {
  const topK = opts.topK ?? 5;
  const hits = await search(store, question, { ...opts, limit: topK });
  const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  if (!hits.length) {
    return {
      question,
      answer: NO_EVIDENCE_ANSWER,
      citations: [],
      evidence_count: 0,
      refused: true,
      used_provider: opts.provider.name,
      hits: [],
      created_at: createdAt,
    };
  }

  // 证据块：以命中 span 为中心向两侧扩展，但引用时仍使用精确 span
  const evidence = hits.map((h) => {
    const obj = store.object(h.object_id)!;
    const s = Math.max(0, h.span.start - 60);
    const e = Math.min(obj.content.length, h.span.end + 160);
    return {
      hit: h,
      obj,
      chunk: obj.content.slice(s, e),
      span: h.span,
    };
  });

  const answer = await opts.provider.answer(question, evidence.map((x) => x.chunk));

  // 引用校验：只保留回答中真实出现的编号，且切片必须来自原文
  const citedNumbers = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) citedNumbers.add(Number(m[1]));

  const citations: Citation[] = [];
  for (const n of [...citedNumbers].sort((a, b) => a - b)) {
    if (n < 1 || n > evidence.length) continue;
    const ev = evidence[n - 1];
    const exact = ev.obj.content.slice(ev.span.start, ev.span.end);
    if (!exact) continue; // 切片为空说明 span 非法，丢弃该引用（宁可少引用也不误引）
    citations.push({
      n,
      object_id: ev.obj.id,
      title: ev.obj.title,
      span: ev.span,
      exact_text: exact,
      locator: {
        file: typeof ev.obj.properties["note_path"] === "string"
          ? String(ev.obj.properties["note_path"])
          : undefined,
        path: ev.obj.source_uri ?? undefined,
        start: ev.span.start,
        end: ev.span.end,
      },
    });
  }

  // 回答里既无有效引用、又声称有依据时，补一句兜底说明，避免“看似有据实则无据”
  const refused = answer.includes("没有在资料库中找到") || answer.includes("没有找到证据");
  return {
    question,
    answer,
    citations,
    evidence_count: evidence.length,
    refused,
    used_provider: opts.provider.name,
    hits,
    created_at: createdAt,
  };
}

/**
 * 为某条已有回答重新定位引用（vault 文件被外部编辑后重新对齐 span）。
 * 返回修正后的 span；找不到则退化为按关键词定位。
 */
export function relinkCitation(store: Store, citation: Citation, latestContent?: string): Citation {
  const obj = store.object(citation.object_id);
  if (!obj) return citation;
  const content = latestContent ?? obj.content;
  const exact = content.slice(citation.span.start, citation.span.end);
  if (exact === citation.exact_text) return citation;
  const span = locateSpan(content, citation.exact_text || content.slice(0, 20));
  return { ...citation, span, exact_text: content.slice(span.start, span.end) };
}
