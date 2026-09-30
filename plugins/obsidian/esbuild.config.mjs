/**
 * 构建脚本：把 src/ 下的 TypeScript 打包成 Obsidian 要求的 CommonJS `main.js`。
 *
 * 关键点：
 * - format=cjs：Obsidian 只加载 CommonJS 的 main.js；
 * - external:obsidian / electron / @codemirror/* / @lezer/*：这些由宿主提供，不得打包；
 * - platform=browser：插件运行在 Electron 渲染进程，不引入 Node 内建模块（因此
 *   核心逻辑全部用纯 JS/TS 实现，零 Node 依赖，见 src/core/util.ts 的自带 sha256）。
 */
import esbuild from "esbuild";
import process from "node:process";

const prod = process.argv[2] === "production";

const banner = `/*
Personal Resource OS —— Obsidian 插件（预构建产物，请勿直接编辑）。
源码位于 src/，修改后执行：npm run build
由 esbuild 生成，格式 CommonJS，供 Obsidian 直接加载。
*/`;

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  target: "es2018",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  banner: { js: banner },
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("✅ main.js 构建完成（production）");
} else {
  await ctx.watch();
  console.log("👀 监听中……");
}
