/**
 * 离线断言运行器（不依赖 Obsidian 运行时）。
 *
 * 为什么要跑这一套：
 *  Obsidian 插件只能在 Obsidian 里加载，无法在 CI/命令行里直接验证。但 `src/core/**`
 *  被刻意设计为「零宿主依赖」（只用 VaultFs 窄接口 + 自带 sha256，不 import obsidian），
 *  因此可以用 Node 把核心打包后直接跑一遍完整业务闭环（采集 → 处理 → 检索 → 问答 →
 *  任务 → 审计 → 回滚 → 总结 → 备份/恢复 → Agent → 审批），把「能不能跑通」和
 *  「铁律有没有被破坏」在交付前就验证掉。
 *
 * 用法：npm test
 */
import esbuild from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const outDir = mkdtempSync(path.join(tmpdir(), "pros-tests-"));
const outfile = path.join(outDir, "core.spec.bundle.mjs");

await esbuild.build({
  entryPoints: ["tests/core.spec.ts"],
  bundle: true,
  outfile,
  format: "esm",
  platform: "node",
  target: "node18",
  logLevel: "warning",
  // 核心不应引入任何 Node 内建模块；browser 平台可以帮我们把这类误引入直接暴露成构建错误
  define: { "process.env.NODE_ENV": '"test"' },
});

await import(pathToFileURL(outfile).href);
