/**
 * 配置与密钥边界（对应 Python Core config.py / NFR-01）。
 *
 * 三层边界：
 *  1. 出站 allowlist —— 任何携带密钥的出站请求必须命中域名白名单（默认最小开放）；
 *  2. 密钥读取 —— 由 Provider 通过 `getSecret()` 取得，绝不写进日志、审计、模型上下文；
 *  3. 数据分级 —— private 内容默认禁止外发，UI 需显式提示。
 */
import type { DataClass } from "./models";

export interface CoreConfig {
  /** 索引库与采集原件的根目录（vault 相对路径）。 */
  baseDir: string;
  /** 整理后的笔记落盘目录。 */
  notesDir: string;
  /** 未处理原始文本目录。 */
  inboxDir: string;
  projectsDir: string;
  peopleDir: string;
  meetingsDir: string;

  /** mock | deepseek | qwen | openai_compat | local */
  provider: string;
  model: string;
  baseUrl: string;
  /** 密钥所在位置：plugin（插件 data.json）| core（Python Core keyring）| env */
  keySource: "plugin" | "core" | "env";
  /** 仅当 keySource=plugin 使用；由宿主注入，不进入核心日志。 */
  apiKey: string | null;

  asrBaseUrl: string;
  asrModel: string;
  visionModel: string;

  /** 出站域名白名单。 */
  outboundAllowlist: string[];
  /** 插件是否允许直接出站（false 时全部出站委托 Python Core）。 */
  allowDirectOutbound: boolean;
  /** 真实云端调用前是否二次确认（默认开启，符合“外发需明确标注”）。 */
  confirmBeforeOutbound: boolean;

  /** 新内容默认数据分级。 */
  defaultDataClass: DataClass;
  /** 处理时机：immediate | manual | onSave | nightly */
  processTiming: "immediate" | "manual" | "onSave" | "nightly";

  /** 采集：网页配图上限、抓取深度、额外标签、GitHub 镜像。 */
  ingestMaxImages: number;
  ingestScroll: number;
  ingestTags: string[];
  githubMirrors: string[];

  /** Agent 全局预算（可被单个 Agent 覆盖，不可超过硬上限）。 */
  agentBudgets: {
    max_steps: number;
    timeout_s: number;
    max_tokens: number;
    max_retries: number;
    max_depth: number;
  };
}

/** 出站硬上限：任何配置都无法突破这些值（NFR-04 / docs F.2）。 */
export const HARD_LIMITS = {
  max_steps: 60,
  timeout_s: 900,
  max_tokens: 400000,
  max_retries: 5,
  max_depth: 2,
} as const;

export const DEFAULT_CORE_CONFIG: CoreConfig = {
  baseDir: "_pros",
  notesDir: "notes",
  inboxDir: "inbox",
  projectsDir: "projects",
  peopleDir: "people",
  meetingsDir: "meetings",

  provider: "mock",
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  keySource: "plugin",
  apiKey: null,

  asrBaseUrl: "",
  asrModel: "whisper-1",
  visionModel: "",

  outboundAllowlist: [
    "127.0.0.1",
    "localhost",
    "api.deepseek.com",
    "dashscope.aliyuncs.com",
  ],
  allowDirectOutbound: true,
  confirmBeforeOutbound: true,

  defaultDataClass: "internal",
  processTiming: "immediate",

  ingestMaxImages: 10,
  ingestScroll: 4,
  ingestTags: [],
  githubMirrors: [
    "https://codeload.github.com",
    "https://gh-proxy.com",
    "https://ghfast.top",
    "https://ghproxy.net",
  ],

  agentBudgets: { max_steps: 20, timeout_s: 300, max_tokens: 50000, max_retries: 2, max_depth: 1 },
};

/** 配置合并：用户配置覆盖默认值，并把预算夹到硬上限内。 */
export function mergeConfig(partial?: Partial<CoreConfig> | null): CoreConfig {
  const cfg: CoreConfig = { ...DEFAULT_CORE_CONFIG, ...(partial ?? {}) };
  cfg.agentBudgets = { ...DEFAULT_CORE_CONFIG.agentBudgets, ...(partial?.agentBudgets ?? {}) };
  cfg.agentBudgets = {
    max_steps: Math.min(cfg.agentBudgets.max_steps, HARD_LIMITS.max_steps),
    timeout_s: Math.min(cfg.agentBudgets.timeout_s, HARD_LIMITS.timeout_s),
    max_tokens: Math.min(cfg.agentBudgets.max_tokens, HARD_LIMITS.max_tokens),
    max_retries: Math.min(cfg.agentBudgets.max_retries, HARD_LIMITS.max_retries),
    max_depth: Math.min(cfg.agentBudgets.max_depth, HARD_LIMITS.max_depth),
  };
  if (!cfg.outboundAllowlist?.length) cfg.outboundAllowlist = DEFAULT_CORE_CONFIG.outboundAllowlist;
  return cfg;
}

/** 出站边界检查（TB-3）。未命中白名单直接拒绝，并给出可操作提示。 */
export function checkOutbound(cfg: CoreConfig, url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`出站请求被拒绝：无法解析的 URL（${url}）`);
  }
  if (!cfg.outboundAllowlist.includes(host)) {
    throw new Error(
      `出站请求被拒绝：${host} 不在 allowlist（默认最小开放）。` +
        `如需放行，请在「设置 → 出站白名单」中加入 ${host}。`,
    );
  }
}

/**
 * 读取密钥。优先级：宿主注入的 apiKey（plugin）> 环境变量。
 * 注意：本函数只在调用瞬间取值，不缓存、不写日志（日志一律用 secretStatus 脱敏输出）。
 */
export function getSecret(cfg: CoreConfig): string | null {
  if (cfg.keySource === "plugin" && cfg.apiKey) return cfg.apiKey;
  // 环境变量兜底（桌面端 Obsidian 暴露 process；移动端不存在，故用 any 取值并判空）
  const env = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env;
  return env?.PROS_API_KEY ?? null;
}

/** 密钥状态（仅报告来源，绝不返回明文），用于设置页自检。 */
export function secretStatus(cfg: CoreConfig): {
  key_name: string;
  source: string;
  available: boolean;
  note: string;
} {
  const available = !!getSecret(cfg);
  return {
    key_name: "PROS_API_KEY",
    source: cfg.keySource,
    available,
    note: cfg.keySource === "plugin" && available
      ? "密钥保存在插件数据文件（本地明文，请确保 vault 不被同步到不可信位置）"
      : available
        ? "密钥来自 Python Core（系统凭据库）或环境变量"
        : "未配置密钥：将使用内置 Mock Provider（完全离线、确定性输出）",
  };
}
