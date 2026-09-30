/**
 * 确定性结构化提取（对应 Python Core extraction.py，需求 32-J）。
 *
 * 所有提取项都带 source span（start/end 字符偏移），保证可回溯原文（NFR-03）。
 * 两条路径共用本模块：
 *  - MockProvider（离线确定性，零网络）；
 *  - 真实 LLM 的结构化输出在解析失败时也会退化到本模块，保证“AI 挂了也不丢字段”。
 */
import type { TaskPriority } from "./models";

export interface Span {
  start: number;
  end: number;
}
export interface FoundValue extends Span {
  value: string;
}
export interface FoundMoney extends Span {
  value: string;
  currency: "CNY" | "USD";
}
export interface FoundTask {
  title: string;
  due_at: string | null;
  priority: TaskPriority;
  /** 任务文本在原文中的字符区间（用于引用回溯与高亮定位）。 */
  span: Span;
}

const DATE_RE = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/g;
const MONEY_RE = /[¥￥$]\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?元/g;
const MENTION_RE = /@([\w\u4e00-\u9fff]+)/g;
const TAG_RE = /#([\w\u4e00-\u9fff/-]+)/g;
const TASK_HINT = /待办|TODO|todo|记得|需要|务必|尽快|截止|之前完成|别忘了|要|安排|跟进/;
const URGENT_HINT = /紧急|重要|务必|ASAP|asap|立刻|马上/;
const RELATIVE_DAYS: Record<string, number> = { 今天: 0, 明天: 1, 后天: 2 };

function span(m: RegExpExecArray): Span {
  return { start: m.index, end: m.index + m[0].length };
}

function toLocalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 提取绝对日期（YYYY-MM-DD / 2026年1月2日）与相对日期（今天/明天/后天）。 */
export function findDates(text: string, base: Date = new Date()): FoundValue[] {
  const out: FoundValue[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d) {
      out.push({ value: toLocalDate(dt), ...span(m as RegExpExecArray) });
    }
  }
  for (const [word, delta] of Object.entries(RELATIVE_DAYS)) {
    const re = new RegExp(word, "g");
    for (const m of text.matchAll(re)) {
      const dt = new Date(base);
      dt.setDate(dt.getDate() + delta);
      out.push({ value: toLocalDate(dt), ...span(m as RegExpExecArray) });
    }
  }
  return out;
}

/** 提取金额（¥/￥/$ 前缀或“元”后缀）。 */
export function findMoney(text: string): FoundMoney[] {
  const out: FoundMoney[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const raw = m[0];
    const currency: "CNY" | "USD" =
      raw.includes("元") || raw.includes("¥") || raw.includes("￥") ? "CNY" : "USD";
    out.push({ value: m[1] ?? m[2], currency, ...span(m as RegExpExecArray) });
  }
  return out;
}

/** 提取 @提及（人物候选）。 */
export function findMentions(text: string): FoundValue[] {
  const out: FoundValue[] = [];
  for (const m of text.matchAll(MENTION_RE)) out.push({ value: m[1], ...span(m as RegExpExecArray) });
  return out;
}

/** 提取 #标签。 */
export function findTags(text: string): FoundValue[] {
  const out: FoundValue[] = [];
  for (const m of text.matchAll(TAG_RE)) out.push({ value: m[1], ...span(m as RegExpExecArray) });
  return out;
}

/** 提取网址（用于自动识别“链接类”内容）。 */
export function findUrls(text: string): FoundValue[] {
  const out: FoundValue[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s，。；)】"'<>]+/g)) {
    out.push({ value: m[0], ...span(m as RegExpExecArray) });
  }
  return out;
}

/**
 * 任务候选行提取：命中任务提示词的行 → 标题 + 行内日期（due_at）+ 紧急词（优先级）。
 * span 覆盖整行（含缩进），保证在原文中可精确跳转与高亮。
 */
export function findTaskLines(text: string, base: Date = new Date()): FoundTask[] {
  const out: FoundTask[] = [];
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const stripped = line.trim();
    if (stripped && TASK_HINT.test(stripped) && !stripped.startsWith("#")) {
      const dates = findDates(stripped, base);
      const indent = line.length - line.replace(/^[\s\-*]+/, "").length;
      out.push({
        title: stripped.replace(/^[-*>\d.\s]+/, "").replace(/[。；;]+$/, "").slice(0, 200),
        due_at: dates.length ? dates[0].value : null,
        priority: URGENT_HINT.test(stripped) ? "P0" : "P2",
        span: { start: offset + indent, end: offset + line.replace(/\n$/, "").length },
      });
    }
    offset += line.length;
  }
  return out;
}

export interface Entities {
  dates: FoundValue[];
  money: FoundMoney[];
  people: FoundValue[];
  tags: FoundValue[];
  urls: FoundValue[];
  tasks: FoundTask[];
}

/** 一次性提取全部实体（供 pipeline 落库到 extractions/entities）。 */
export function extractEntities(text: string, base: Date = new Date()): Entities {
  return {
    dates: findDates(text, base),
    money: findMoney(text),
    people: findMentions(text),
    tags: findTags(text),
    urls: findUrls(text),
    tasks: findTaskLines(text, base),
  };
}
