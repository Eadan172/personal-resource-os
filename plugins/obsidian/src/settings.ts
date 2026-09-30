/**
 * 设置读写与迁移。
 *
 * 兼容策略：读取旧版本设置时逐字段补默认值（缺失即补），
 * 避免插件升级后用户配置被重置或字段 undefined 导致运行期报错。
 * 密钥（apiKey）默认保存在插件 data.json —— 这是「自带核心」模式的必然结果，
 * 设置界面会显著提示该风险，并提供「改由 Python Core 的凭据库托管」选项。
 */
import { DEFAULT_CORE_CONFIG, mergeConfig, type CoreConfig } from "./core/config";
import { DEFAULT_SETTINGS, type ProsSettings } from "./types";

/** 补全缺失字段并夹取非法值。 */
export function normalizeSettings(raw: unknown): ProsSettings {
  const r = (raw ?? {}) as Partial<ProsSettings>;
  const core: CoreConfig = mergeConfig({ ...DEFAULT_CORE_CONFIG, ...(r.core ?? {}) });
  const ui = { ...DEFAULT_SETTINGS.ui, ...(r.ui ?? {}) };
  return {
    bridgePreference: (["auto", "local", "http"] as const).includes(r.bridgePreference as "auto")
      ? (r.bridgePreference as ProsSettings["bridgePreference"])
      : DEFAULT_SETTINGS.bridgePreference,
    coreUrl: r.coreUrl?.trim() || DEFAULT_SETTINGS.coreUrl,
    coreToken: r.coreToken ?? "",
    core,
    ui: {
      ...ui,
      graphLimit: Math.max(20, Math.min(2000, Number(ui.graphLimit) || 200)),
    },
  };
}

/** 设置 → 核心配置（供 Bridge 使用）。 */
export function toCoreConfig(settings: ProsSettings): CoreConfig {
  return mergeConfig({
    ...settings.core,
    keySource: settings.core.keySource,
    apiKey: settings.core.apiKey || null,
  });
}

/** 密钥脱敏显示（设置界面只展示尾 4 位）。 */
export function maskSecret(key: string | null | undefined): string {
  if (!key) return "（未配置）";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

/** 目录名称合法性（vault 相对路径，禁止 .. 与绝对路径）。 */
export function validVaultFolder(name: string): boolean {
  const s = (name ?? "").trim();
  if (!s) return false;
  if (s.startsWith("/") || s.startsWith("\\") || /^[a-zA-Z]:/.test(s)) return false;
  return !s.split(/[\\/]/).includes("..");
}
