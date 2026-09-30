/**
 * Bridge 工厂：按配置选择后端，并支持「自动探测」。
 *
 * 自动模式（默认）：先探测 Python Core 是否在线 ——
 *  · 在线 → 用 HttpBridge（符合 ADR-001：薄宿主 + 独立核心，且获得下载/转写/抽帧能力）；
 *  · 离线 → 用 LocalBridge（插件自带核心，功能闭环但重活降级）。
 * 这样既满足文档架构，又保证「装好插件立刻可用」。
 */
import type { Store } from "../core/store";
import type { CoreConfig } from "../core/config";
import type { HttpClient } from "../core/providers/base";
import { LocalBridge } from "./localBridge";
import { HttpBridge } from "./httpBridge";
import type { CoreBridge } from "./types";

export type BridgePreference = "auto" | "local" | "http";

export interface CreateBridgeOptions {
  preference: BridgePreference;
  cfg: CoreConfig;
  store: Store;
  http: HttpClient;
  coreUrl?: string;
  authToken?: string;
  beforeOutbound?: (info: { host: string; purpose: string; bytes: number }) => Promise<boolean>;
}

export interface CreateBridgeResult {
  bridge: CoreBridge;
  /** 自动模式下发生降级时的说明（供 UI 提示用户）。 */
  note?: string;
}

export async function createBridge(opts: CreateBridgeOptions): Promise<CreateBridgeResult> {
  const makeLocal = () =>
    new LocalBridge({
      store: opts.store,
      cfg: opts.cfg,
      http: opts.http,
      beforeOutbound: opts.beforeOutbound,
    });

  if (opts.preference === "local") return { bridge: makeLocal() };

  const http = new HttpBridge({
    cfg: opts.cfg,
    http: opts.http,
    coreUrl: opts.coreUrl,
    authToken: opts.authToken,
  });

  if (opts.preference === "http") {
    const status = await http.ping();
    if (!status.ok) {
      // 用户显式选择了 Core 但连不上：不退化为 local（避免“以为在用 Core 其实没用”），
      // 而是带着失败状态返回，由 UI 明确提示并允许切回插件内核心。
      return { bridge: http, note: status.message };
    }
    return { bridge: http };
  }

  // auto：探测后再决定
  const status = await http.ping();
  if (status.ok) return { bridge: http };
  return {
    bridge: makeLocal(),
    note: `未检测到 Python Core（${status.message}），已使用插件内轻量核心。重活（视频下载/转写/抽帧/反爬渲染）将降级。`,
  };
}

export { LocalBridge } from "./localBridge";
export { HttpBridge } from "./httpBridge";
export type { CoreBridge, BridgeMeta, CoreStatus, ProgressCallback, RollbackResultView } from "./types";
