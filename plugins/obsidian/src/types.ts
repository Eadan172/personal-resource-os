/**
 * 插件级类型定义（设置、视图、事件）。
 * 领域模型类型在 src/core/models.ts，此处只放「宿主与 UI 相关」的部分。
 */
import type { CoreConfig } from "./core/config";
import type { BridgePreference } from "./bridge";

export interface ProsUiSettings {
  /** 是否在左侧功能区显示图标。 */
  ribbon: boolean;
  /** 删除/批量操作前二次确认。 */
  confirmDelete: boolean;
  /** 采集后立即自动处理（分类/摘要/生成笔记）。 */
  autoProcessAfterCapture: boolean;
  /** 检索是否启用语义召回（需要 Provider 支持 embedding）。 */
  vectorSearch: boolean;
  /** 关系图谱最多渲染节点数（防止大库卡顿）。 */
  graphLimit: number;
  /** 输出调试日志到控制台。 */
  debug: boolean;
  /** 笔记中是否包含完整原文（关闭后只写摘要与结构化字段）。 */
  includeContentInNotes: boolean;
}

export interface ProsSettings {
  /** 后端选择：auto（自动探测 Core）/ local（插件内核心）/ http（强制用 Core）。 */
  bridgePreference: BridgePreference;
  coreUrl: string;
  /** 可选：Core 的访问 token（仅当 Core 配置了鉴权时使用）。 */
  coreToken: string;
  /** 核心配置（目录、Provider、出站白名单等）。 */
  core: CoreConfig;
  ui: ProsUiSettings;
}

export const DEFAULT_SETTINGS: ProsSettings = {
  bridgePreference: "auto",
  coreUrl: "http://127.0.0.1:8765",
  coreToken: "",
  core: {} as CoreConfig, // 由 settings.ts 用 DEFAULT_CORE_CONFIG 填充
  ui: {
    ribbon: true,
    confirmDelete: true,
    autoProcessAfterCapture: true,
    vectorSearch: false,
    graphLimit: 200,
    debug: false,
    includeContentInNotes: true,
  },
};

/** 视图类型 id（与 Manifest 注册的 view type 一致）。 */
export const VIEW_TYPES = {
  dashboard: "pros-dashboard",
  inbox: "pros-inbox",
  tasks: "pros-tasks",
  search: "pros-search",
  chat: "pros-chat",
  summary: "pros-summary",
  approval: "pros-approval",
  audit: "pros-audit",
  object: "pros-object",
  graph: "pros-graph",
  timeline: "pros-timeline",
} as const;

export type ViewType = (typeof VIEW_TYPES)[keyof typeof VIEW_TYPES];

/** 插件内部事件：桥接层或后台任务广播，视图订阅刷新。 */
export interface ProsEvents {
  /** 索引库发生变化。 */
  'data-changed': { reason: string };
  /** 桥接模式切换。 */
  'bridge-changed': { mode: string };
  /** 长任务进度。 */
  'progress': { message: string; done?: boolean };
  /** 请求打开某个对象详情。 */
  'open-object': { id: string };
}
