/**
 * Provider 工厂（对应 Python Core providers/__init__.py）。
 *
 * 选型规则：
 *  - provider=mock（默认）→ 内置确定性规则引擎，完全离线；
 *  - provider=deepseek/qwen/local/openai_compat → OpenAI 兼容实现；
 *  - 任何情况下都不在此处读取密钥内容，只传递 ProviderContext。
 */
import type { ChatProvider, ProviderContext } from "./base";
import { MockProvider } from "./mock";
import { OpenAICompatProvider } from "./openaiCompat";

export function getProvider(ctx: ProviderContext): ChatProvider {
  const name = (ctx.cfg.provider || "mock").toLowerCase();
  if (name === "mock") return new MockProvider();
  try {
    return new OpenAICompatProvider(ctx);
  } catch (e) {
    // 配置不完整时不让整个插件不可用：退化为离线 Mock，并在控制台提示原因
    console.warn(`[PROS] Provider「${name}」初始化失败，已退化为离线 Mock：`, e);
    return new MockProvider();
  }
}

export type { ChatProvider, ProviderContext } from "./base";
export { MockProvider } from "./mock";
export { OpenAICompatProvider, PRESETS } from "./openaiCompat";
