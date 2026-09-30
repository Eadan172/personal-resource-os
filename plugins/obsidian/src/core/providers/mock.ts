/**
 * Mock Provider（对应 Python Core providers/mock.py）。
 *
 * 完全确定性、零网络：默认 Provider，保证「装好插件即可跑通全流程」。
 * 规则实现复用 extraction 模块，因此同输入恒同输出，可作为测试基线。
 * 它不是「假 AI」：分类/摘要/任务/实体都真实产出结构化结果，只是判定规则是启发式的。
 */
import type { ObjectType, TaskPriority } from "../models";
import { extractEntities, findTaskLines } from "../extraction";
import { tokenize, truncate } from "../util";
import type { ChatMessage, ChatProvider, ClassifyResult, CompleteResult, ExtractedTask } from "./base";

/** 类型判定规则（顺序敏感：先具体后泛化）。 */
const TYPE_RULES: [ObjectType, RegExp][] = [
  ["bookmark", /https?:\/\/(www\.)?(bilibili|youtube|youtu\.be|zhihu|juejin|github|arxiv)/i],
  ["document", /论文|报告|白皮书|说明书|文献|综述|手册|教程|指南/],
  ["meeting", /会议|开会|纪要|meeting|例会/],
  ["idea", /想法|灵感|点子|idea|创意/],
  ["event", /日程|活动|参会|演讲|发布会/],
  ["risk", /风险|隐患|问题点|威胁/],
  ["decision", /决定|决策|拍板|结论/],
  ["money", /[¥￥$]\s?\d|\d+\s?元|报价|预算/],
  ["person", /^@|简介|履历|联系方式/],
  ["project", /项目|计划|里程碑|路线图/],
  ["bookmark", /https?:\/\//],
];

export class MockProvider implements ChatProvider {
  readonly name = "mock";
  readonly offline = true;

  classify(text: string): Promise<ClassifyResult> {
    const head = text.slice(0, 4000);
    for (const [type, re] of TYPE_RULES) {
      if (re.test(head)) {
        return Promise.resolve({
          type,
          confidence: 0.8,
          tags: this.tags(head),
          reason: "规则匹配（Mock Provider）",
        });
      }
    }
    return Promise.resolve({ type: "note", confidence: 0.6, tags: this.tags(head), reason: "默认分类（Mock Provider）" });
  }

  summarize(text: string): Promise<string> {
    const clean = text
      .replace(/^---[\s\S]*?---/, "")           // 去 YAML front-matter
      .replace(/^#{1,6}\s*/gm, "")              // 去标题记号
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")     // 去图片
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")  // 保留链接文字
      .trim();
    const firstLine = clean.split("\n").map((s) => s.trim()).find((s) => s.length > 8) ?? "";
    const sentences = clean.split(/[。！？.!?]\s*/).filter((s) => s.trim().length > 10);
    const pick = sentences.slice(0, 2).join("。") || firstLine;
    return Promise.resolve(truncate(pick, 160));
  }

  extractTasks(text: string): Promise<ExtractedTask[]> {
    return Promise.resolve(
      findTaskLines(text.slice(0, 20000)).map<ExtractedTask>((t) => ({
        title: t.title,
        due_at: t.due_at,
        priority: t.priority as TaskPriority,
        span: t.span,
      })),
    );
  }

  /** 确定性回答：逐条列出最相关证据并标号引用（与真实 LLM 的引用格式保持一致）。 */
  answer(question: string, evidence: string[]): Promise<string> {
    if (!evidence.length) return Promise.resolve("我没有在资料库中找到可回答该问题的证据。");
    const parts = ["根据资料库中的证据："];
    evidence.forEach((ev, i) => {
      parts.push(`- ${truncate(ev.replace(/\s+/g, " "), 140)} [${i + 1}]`);
    });
    return Promise.resolve(parts.join("\n"));
  }

  /**
   * Agent 循环的确定性行为：
   *  - 末条消息含 [TOOL_RESULT] → 收尾（避免无限循环）；
   *  - 出现 FORCE_LOOP 标记 → 反复请求工具（供预算/熔断测试）；
   *  - 末条消息含任务候选 → 调用 create_task 一次。
   */
  complete(messages: ChatMessage[]): Promise<CompleteResult> {
    const last = messages.length ? messages[messages.length - 1].content : "";
    if (messages.some((m) => m.content.includes("FORCE_LOOP"))) {
      return Promise.resolve({ tool_calls: [{ name: "search", arguments: { query: "loop" } }] });
    }
    if (last.includes("[TOOL_RESULT]")) return Promise.resolve({ final: "已完成整理。" });
    const tasks = findTaskLines(last.slice(0, 20000));
    if (tasks.length) {
      return Promise.resolve({
        tool_calls: [{
          name: "create_task",
          arguments: { title: tasks[0].title, due_at: tasks[0].due_at, priority: tasks[0].priority },
        }],
      });
    }
    return Promise.resolve({ final: "无需行动。" });
  }

  /** 可选能力（离线确定性模拟）：仅为证明链路可用，不产生真实内容。 */
  transcribeAudio(_data: ArrayBuffer, filename: string): Promise<string> {
    return Promise.resolve(`（Mock 转写）音频文件 ${filename} 的模拟逐字稿。`);
  }

  analyzeImages(images: { filename: string }[]): Promise<string> {
    const names = images.slice(0, 5).map((i) => i.filename).join("、");
    return Promise.resolve(`（Mock 视觉分析）已读取 ${images.length} 张关键帧（${names} 等）。`);
  }

  /** 离线向量：基于 token 的确定性 hash 投影，用于验证混合检索链路（非语义质量保证）。 */
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => projectVector(t, 64)));
  }

  private tags(text: string): string[] {
    const e = extractEntities(text);
    const fromHash = e.tags.map((t) => t.value);
    const fromMention = e.people.map((p) => p.value);
    // 关键词标签只取拉丁词，避免中文 trigram 产生噪声标签
    const keywords = tokenize(text)
      .filter((t) => /^[a-z][a-z0-9+#.-]{1,20}$/.test(t))
      .slice(0, 6);
    return [...new Set([...fromHash, ...fromMention, ...keywords])].slice(0, 8);
  }
}

/** 把文本确定性投影为固定维度向量（供离线相似度计算）。 */
function projectVector(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tk of tokenize(text)) {
    let h = 2166136261;
    for (let i = 0; i < tk.length; i++) {
      h ^= tk.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dim;
    v[idx] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
