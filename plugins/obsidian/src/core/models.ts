/**
 * 领域模型定义（对应 Python Core 的 models.py / docs/04-数据模型.md）。
 *
 * 设计铁律（NFR-03 事实分层）：
 *  - `content` 是原始事实，写入后任何 Agent 都不得覆盖（store 层强制）；
 *  - origin 五值严格区分：raw / user_edit / ai_extracted / ai_inferred / ai_suggested；
 *  - AI 推断不得伪装成事实，UI 需按 origin 视觉区分；
 *  - 结构化字段必须可通过 evidence（span）回溯原文。
 */

export const OBJECT_TYPES = [
  "note", "idea", "task", "person", "project", "event", "bookmark",
  "document", "meeting", "conversation", "topic", "concept",
  "decision", "risk", "money", "location",
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

export const OBJECT_TYPE_LABELS: Record<ObjectType, string> = {
  note: "笔记", idea: "想法", task: "任务", person: "人物", project: "项目",
  event: "事件", bookmark: "书签", document: "文档", meeting: "会议",
  conversation: "对话", topic: "主题", concept: "概念", decision: "决策",
  risk: "风险", money: "金额", location: "地点",
};

export const RELATION_TYPES = [
  "related_to", "mentions", "belongs_to", "assigned_to", "depends_on",
  "derived_from", "contradicts", "supports", "duplicate_of", "references",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const RELATION_TYPE_LABELS: Record<RelationType, string> = {
  related_to: "相关", mentions: "提及", belongs_to: "属于", assigned_to: "指派给",
  depends_on: "依赖", derived_from: "衍生自", contradicts: "冲突", supports: "支持",
  duplicate_of: "疑似重复", references: "引用",
};

export type Origin = "raw" | "user_edit" | "ai_extracted" | "ai_inferred" | "ai_suggested";

export const ORIGIN_LABELS: Record<Origin, string> = {
  raw: "原始事实",
  user_edit: "用户编辑",
  ai_extracted: "AI 提取",
  ai_inferred: "AI 推断",
  ai_suggested: "AI 建议",
};

/** 数据外发分级（docs/03 §4）：private 默认禁止出站。 */
export type DataClass = "public" | "internal" | "private";

export type Lifecycle = "inbox" | "processed" | "archived" | "deleted";

export type TaskPriority = "P0" | "P1" | "P2" | "P3";
export type TaskStatus = "todo" | "doing" | "done" | "cancelled";

export type RelationStatus = "suggested" | "confirmed" | "rejected";

/** 统一对象（docs/04 §1）。 */
export interface ProsObject {
  id: string;
  type: ObjectType;
  title: string;
  /** 原始内容，写入后不可被 AI 覆盖。 */
  content: string;
  source_uri: string | null;
  content_hash: string;
  origin: Origin;
  confidence: number;
  provenance: Record<string, unknown>;
  tags: string[];
  properties: Record<string, unknown>;
  data_class: DataClass;
  event_time_start: string | null;
  event_time_end: string | null;
  lifecycle: Lifecycle;
  created_at: string;
  updated_at: string;
}

/** 关系（AI 只写 suggested，用户审核后 confirmed / rejected）。 */
export interface Relation {
  id: string;
  src_id: string;
  dst_id: string;
  type: RelationType;
  status: RelationStatus;
  confidence: number;
  provenance: Record<string, unknown>;
  created_at: string;
}

/** 任务（docs/04 §3）。 */
export interface Task {
  id: string;
  title: string;
  source_object_id: string | null;
  due_at: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  project: string | null;
  assignee: string | null;
  tags: string[];
  provenance: Record<string, unknown>;
  confidence: number;
  /** 1 = 由 Agent 创建（区别于用户手建）。 */
  created_by_agent: 0 | 1;
  created_at: string;
  completed_at: string | null;
}

export type ExtractionKind =
  | "transcript" | "ocr" | "web_text" | "pdf_text" | "summary" | "entities" | "note";

/** 衍生数据：正文提取 / 转写 / OCR / 摘要等（永不覆盖原始资源）。 */
export interface Extraction {
  id: string;
  source_object_id: string;
  kind: ExtractionKind;
  content: string;
  content_hash: string;
  processor: string;
  processor_version: string;
  created_at: string;
}

export type AuditOp = "create" | "update" | "delete" | "restore";

/** 审计日志：一切 mutation 的 before/after 快照，rollback 的锚点。 */
export interface AuditEntry {
  id: string;
  op: AuditOp;
  object_type: AuditTable;
  object_id: string;
  before: unknown;
  after: unknown;
  /** user / agent:<name> / connector:<id> / rollback:user */
  actor: string;
  agent_run_id: string | null;
  reversible: 0 | 1;
  created_at: string;
}

export type AuditTable = "objects" | "tasks" | "relations" | "summaries";

export type AgentRunStatus =
  | "running" | "succeeded" | "failed"
  | "aborted_budget" | "aborted_timeout" | "waiting_approval" | "cancelled";

export interface AgentRun {
  id: string;
  agent_name: string;
  trigger: string;
  status: AgentRunStatus;
  steps: number;
  tokens_used: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  /** 每步 tool call 与结果摘要（Agent 状态可观测，NFR-04）。 */
  trace: AgentStep[];
}

export interface AgentStep {
  index: number;
  tool: string;
  arguments: Record<string, unknown>;
  policy: "auto" | "confirm" | "deny";
  status: "ok" | "error" | "pending_approval" | "denied";
  result?: unknown;
  error?: string;
  at: string;
}

/** Agent 预算硬约束（不可被配置绕过，docs/05 §2）。 */
export interface AgentBudgets {
  max_steps: number;
  timeout_s: number;
  max_tokens: number;
  max_retries: number;
  max_depth: number;
}

export const DEFAULT_BUDGETS: AgentBudgets = {
  max_steps: 20,
  timeout_s: 300,
  max_tokens: 50000,
  max_retries: 2,
  max_depth: 1,
};

/** 自定义 Agent 定义（FR-12）。 */
export interface AgentDef {
  name: string;
  purpose: string;
  instructions: string;
  allowed_tools: string[];
  allowed_scopes: { read: string[]; write: string[] };
  provider?: string;
  model?: string | null;
  /** manual | event:inbox | cron:0 3 * * * */
  trigger: string;
  output_schema?: string | null;
  approval_policy: { read: "auto" | "confirm" | "deny"; write: "auto" | "confirm" | "deny"; outbound: "auto" | "confirm" | "deny" };
  failure_policy: { on_failure: "keep_raw_and_mark" | "retry" | "abort"; retry: number };
  budgets: AgentBudgets;
  builtin?: boolean;
}

export type ApprovalKind = "relation" | "task_create" | "bulk_write" | "outbound_send" | "connector_action";

/** 待审批中心（未批准的动作绝不落库）。 */
export interface Approval {
  id: string;
  agent_run_id: string | null;
  kind: ApprovalKind;
  action: { tool: string; arguments: Record<string, unknown> };
  payload: Record<string, unknown>;
  requested_by: string;
  status: "pending" | "approved" | "rejected";
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}

/** 阶段总结（FR-10 的十个维度）。 */
export interface SummaryRecord {
  id: string;
  range_start: string;
  range_end: string;
  granularity: "daily" | "weekly" | "monthly" | "custom";
  content: SummaryContent;
  generated_by: string;
  created_at: string;
}

export interface SummaryContent {
  range: { start: string; end: string };
  what_happened: SummaryRef[];
  themes: string[];
  discoveries: SummaryRef[];
  completed: SummaryRef[];
  pending: (SummaryRef & { due_at: string | null })[];
  people: string[];
  decisions: SummaryRef[];
  decision_assessments: DecisionAssessment[];
  risks: SummaryRef[];
  next_actions: NextAction[];
  stats: { objects: number; by_type: Record<string, number>; tasks_created: number };
}

export interface SummaryRef {
  id: string;
  title: string;
  type?: string;
}

export interface NextAction {
  kind: string;
  title: string;
  task_id?: string;
}

/** 决策评估结果（ADR-007）。 */
export interface DecisionAssessment {
  decision_id: string | null;
  assessment: string;
  confidence: number;
  model: string;
  /** choice / score / noul 三种原语的可选载荷。 */
  choice?: { option: string; probability: number };
  score?: { value: number; scale: string[] };
  noul?: { proposition: string; p_true: number };
}

/** 索引数据库（单文件 JSON，落在 vault/_pros/ 下，用户可直接查看）。 */
export interface ProsDB {
  schema_version: number;
  objects: ProsObject[];
  relations: Relation[];
  tasks: Task[];
  extractions: Extraction[];
  audit_log: AuditEntry[];
  agent_runs: AgentRun[];
  approvals: Approval[];
  summaries: SummaryRecord[];
  agents: AgentDef[];
  connectors: ConnectorState[];
  /** 出站域名 allowlist（NFR-01 最小开放）。 */
  outbound_allowlist: string[];
  updated_at: string;
}

export interface ConnectorState {
  id: string;
  kind: "workbuddy" | "wecom" | "ima" | "generic";
  enabled: boolean;
  scopes: string[];
  allowlist_outbound: string[];
  /** 仅记录“是否已配置”，密钥本体存 Obsidian data.json 或 Core keyring。 */
  secret_ref: string | null;
  last_inbound_at: string | null;
  last_error: string | null;
  audit: true;
}

export const SCHEMA_VERSION = 1;

/** 新建一个空的索引库。 */
export function emptyDB(): ProsDB {
  return {
    schema_version: SCHEMA_VERSION,
    objects: [],
    relations: [],
    tasks: [],
    extractions: [],
    audit_log: [],
    agent_runs: [],
    approvals: [],
    summaries: [],
    // 首次运行（库文件尚不存在）也必须带上出厂 Agent，否则 Agent 列表是空的
    agents: builtinAgents(),
    connectors: defaultConnectors(),
    outbound_allowlist: [
      "127.0.0.1", "localhost",
      "api.deepseek.com", "dashscope.aliyuncs.com",
    ],
    updated_at: "",
  };
}

/** 出厂内置 Connector（FR-15，默认全部关闭，需用户显式启用并配置凭据）。 */
export function defaultConnectors(): ConnectorState[] {
  return [
    {
      id: "workbuddy", kind: "workbuddy", enabled: false,
      scopes: ["capture_text", "search", "ask", "list_tasks", "create_task"],
      allowlist_outbound: [], secret_ref: null,
      last_inbound_at: null, last_error: null, audit: true,
    },
    {
      id: "wecom", kind: "wecom", enabled: false,
      scopes: ["capture_text", "search"], allowlist_outbound: [],
      secret_ref: null, last_inbound_at: null, last_error: null, audit: true,
    },
    {
      id: "ima", kind: "ima", enabled: false,
      scopes: ["capture_text", "search", "ask"], allowlist_outbound: [],
      secret_ref: null, last_inbound_at: null, last_error: null, audit: true,
    },
  ];
}

/** 出厂内置 Agent（docs/05 §3）。 */
export function builtinAgents(): AgentDef[] {
  return [
    {
      name: "inbox-organizer",
      purpose: "自动整理 Inbox：分类、摘要、实体与任务提取、关系建议",
      instructions:
        "你是个人资源管家的整理 Agent。只可读取与建议，不得改写原文；" +
        "对每条内容给出分类、摘要、可执行任务与关系建议，所有产物标注来源与置信度。",
      allowed_tools: ["search", "read_object", "create_task", "suggest_relation"],
      allowed_scopes: { read: ["objects"], write: ["tasks", "relations:suggested", "objects.ai_fields"] },
      trigger: "event:inbox",
      approval_policy: { read: "auto", write: "auto", outbound: "confirm" },
      failure_policy: { on_failure: "keep_raw_and_mark", retry: 2 },
      budgets: { ...DEFAULT_BUDGETS },
      builtin: true,
    },
    {
      name: "link-suggester",
      purpose: "关系建议与重复提示（只写 suggested，不自动合并）",
      instructions: "基于标题共现与标签重叠，为对象提出 related_to / duplicate_of 建议，全部为待审核状态。",
      allowed_tools: ["search", "read_object", "suggest_relation"],
      allowed_scopes: { read: ["objects"], write: ["relations:suggested"] },
      trigger: "cron:nightly",
      approval_policy: { read: "auto", write: "auto", outbound: "confirm" },
      failure_policy: { on_failure: "keep_raw_and_mark", retry: 1 },
      budgets: { ...DEFAULT_BUDGETS, max_steps: 30 },
      builtin: true,
    },
    {
      name: "summarizer",
      purpose: "阶段总结 + 行动建议（转任务由用户点击触发）",
      instructions: "按日/周/月汇总：发生了什么、主题、新发现、已完成、未完成、人物、决策、风险、下一步行动。",
      allowed_tools: ["search", "read_object"],
      allowed_scopes: { read: ["objects", "tasks"], write: ["summaries"] },
      trigger: "cron:daily",
      approval_policy: { read: "auto", write: "auto", outbound: "confirm" },
      failure_policy: { on_failure: "keep_raw_and_mark", retry: 1 },
      budgets: { ...DEFAULT_BUDGETS },
      builtin: true,
    },
    {
      name: "reindexer",
      purpose: "增量重建检索索引",
      instructions: "重建 FTS/向量索引，不读写业务数据。",
      allowed_tools: ["search", "read_object"],
      allowed_scopes: { read: ["objects"], write: [] },
      trigger: "cron:daily",
      approval_policy: { read: "auto", write: "deny", outbound: "deny" },
      failure_policy: { on_failure: "abort", retry: 0 },
      budgets: { ...DEFAULT_BUDGETS, max_steps: 5, timeout_s: 120 },
      builtin: true,
    },
  ];
}
