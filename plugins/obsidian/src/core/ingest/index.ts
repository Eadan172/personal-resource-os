/**
 * 采集统一入口（对应 Python Core ingest/__init__.py）。
 *
 * 一个入口自动识别 视频 / 音频 / 网页 / 代码 四类资源；
 * 识别失败或插件内能力不足时，由 `delegate` 委托 Python Core（若在线）。
 */
import type { CoreConfig } from "../config";
import type { Store } from "../store";
import type { HttpClient } from "../providers/base";
import { detectType, type IngestResult, type ProgressFn, NOOP_PROGRESS, ResourceKind, KIND_LABELS } from "./common";
import { ingestHtml } from "./html";
import { ingestMedia } from "./video";
import { ingestCode } from "./code";

export interface IngestOptions {
  /** 强制指定类型（缺省自动识别）。 */
  kind?: ResourceKind;
  tags?: string[];
  /** 网页配图上限。 */
  maxImages?: number;
  /** 网页抓取深度（插件内仅用于日志提示；真正渲染由 Core 完成）。 */
  scroll?: number;
  /** 是否下载封面。 */
  fetchCover?: boolean;
  /**
   * 委托 Core 的回调：返回 null 表示 Core 不可用/未处理，调用方继续走插件内降级路径。
   * kind 为 "code" 时表示请求完整源码归档。
   */
  delegate?: (source: string, kind: ResourceKind) => Promise<IngestResult | null>;
}

/**
 * 统一采集入口。
 * @throws IngestError 当类型无法识别或采集彻底失败（此时不会有任何残留脏数据）
 */
export async function ingest(
  store: Store,
  cfg: CoreConfig,
  http: HttpClient,
  source: string,
  options: IngestOptions = {},
  progress: ProgressFn = NOOP_PROGRESS,
): Promise<IngestResult> {
  const kind = options.kind ?? detectType(source);
  progress(`识别为「${KIND_LABELS[kind]}」，开始采集…`);

  let result: IngestResult;
  if (kind === "html") {
    result = await ingestHtml(store, cfg, http, source, {
      maxImages: options.maxImages,
      tags: options.tags,
      delegate: options.delegate ? (url) => options.delegate!(url, "html") : undefined,
    }, progress);
  } else if (kind === "video" || kind === "audio") {
    result = await ingestMedia(store, cfg, http, source, kind, {
      tags: options.tags,
      fetchCover: options.fetchCover,
      delegate: options.delegate
        ? (url, k) => options.delegate!(url, k)
        : undefined,
    }, progress);
  } else {
    result = await ingestCode(store, cfg, http, source, {
      tags: options.tags,
      delegate: options.delegate ? (url) => options.delegate!(url, "code") : undefined,
    }, progress);
  }

  // 写一条采集审计（op=outbound_ingest），与 Python Core 行为一致
  store.recordAudit(
    "create",
    "objects",
    result.id,
    null,
    { op: "outbound_ingest", source, kind: result.kind, at: new Date().toISOString() },
    "user",
  );
  await store.flush();
  return result;
}

export { detectType, IngestError, KIND_LABELS } from "./common";
export type { IngestResult, ProgressFn, ResourceKind } from "./common";
export { extractArticle } from "./html";
export { parseVideoId } from "./video";
export { parseRepo } from "./code";
