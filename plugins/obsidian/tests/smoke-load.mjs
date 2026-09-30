/**
 * 产物可加载性冒烟测试。
 *
 * 为什么需要它：
 *  `main.js` 里 `require("obsidian")` 是 external —— 只有真正装进 Obsidian 才会解析。
 *  为了让「能不能加载」在交付前就可验证，这里把 main.js 复制到临时目录，配一个最小 obsidian
 *  桩模块（只提供类与函数外壳），然后真的 require 一次，并核对：
 *    1. 模块顶层求值不报错（能捕获循环依赖、类继承缺失、顶层引用错误等致命问题）；
 *    2. 默认导出确实是一个继承了 Plugin 的类；
 *    3. 视图层依赖的插件 API 全部存在（防止「视图调了不存在的方法」这类只在点击时才炸的问题）。
 *
 * 用法：npm run test:load（需先 npm run build）
 */
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const bundle = path.join(root, "main.js");

if (!existsSync(bundle)) {
  console.error("✗ 未找到 main.js，请先执行 npm run build");
  process.exit(1);
}

// ------------------------------------------------------ 最小 obsidian 桩 ---
const STUB = `
class Base {
  constructor(app) { this.app = app; this.contentEl = stubEl(); this.containerEl = stubEl(); }
}
function stubEl() {
  const node = {
    children: [], style: {}, dataset: {},
    empty() { return this; }, setText() { return this; }, setAttr() { return this; },
    addClass() { return this; }, removeClass() { return this; }, toggleClass() { return this; },
    createEl() { return stubEl(); }, createDiv() { return stubEl(); }, createSpan() { return stubEl(); },
    appendChild() { return this; }, appendText() { return this; }, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, remove() {},
  };
  return node;
}
class Plugin extends Base {
  addCommand() {} addRibbonIcon() {} addSettingTab() {} addStatusBarItem() { return stubEl(); }
  registerView() {} registerEvent() {} registerInterval() { return 0; }
  async loadData() { return null; } async saveData() {}
}
class ItemView extends Base {}
class Modal extends Base { open() {} close() {} }
class PluginSettingTab extends Base { display() {} }
class SuggestModal extends ItemView {}
class Setting { setName() { return this; } setDesc() { return this; } setHeading() { return this; }
  addText(cb) { cb(stubText()); return this; } addTextArea(cb) { cb(stubText()); return this; }
  addToggle(cb) { cb(stubToggle()); return this; } addDropdown(cb) { cb(stubDropdown()); return this; }
  addButton(cb) { cb(stubButton()); return this; } addExtraButton(cb) { cb(stubButton()); return this; }
}
function stubText() { return { inputEl: stubEl(), setValue() { return this; }, setPlaceholder() { return this; }, setDisabled() { return this; }, onChange() { return this; } }; }
function stubToggle() { return { setValue() { return this; }, onChange() { return this; } }; }
function stubDropdown() { return { addOption() { return this; }, setValue() { return this; }, onChange() { return this; } }; }
function stubButton() { return { setButtonText() { return this; }, setIcon() { return this; }, setTooltip() { return this; }, setCta() { return this; }, setWarning() { return this; }, onClick() { return this; }, setDisabled() { return this; } }; }
class Notice { constructor() {} setMessage() {} hide() {} }
module.exports = {
  Plugin, ItemView, Modal, PluginSettingTab, SuggestModal, Setting, Notice,
  MarkdownRenderer: { render: () => Promise.resolve() },
  setIcon: () => {},
  normalizePath: (p) => p,
  requestUrl: () => Promise.resolve({ status: 200, text: "", arrayBuffer: new ArrayBuffer(0), headers: {} }),
};
`;

const stage = mkdtempSync(path.join(tmpdir(), "pros-load-"));
const obsidianDir = path.join(stage, "node_modules", "obsidian");
mkdirSync(obsidianDir, { recursive: true });
writeFileSync(path.join(obsidianDir, "package.json"), JSON.stringify({ name: "obsidian", version: "0.0.0", main: "index.js" }));
writeFileSync(path.join(obsidianDir, "index.js"), STUB);
const stagedBundle = path.join(stage, "main.js");
copyFileSync(bundle, stagedBundle);

// ------------------------------------------------------------------ 断言 ---
const failures = [];
let passed = 0;
const ok = (cond, label) => (cond ? passed++ : failures.push(label));

let mod;
try {
  mod = createRequire(path.join(stage, "noop.js"))(stagedBundle);
} catch (e) {
  console.error(`✗ main.js 加载失败：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
}
ok(true, "main.js 顶层求值成功");

const PluginClass = mod?.default;
ok(typeof PluginClass === "function", "存在默认导出的插件类");
ok(!!PluginClass && Object.getPrototypeOf(PluginClass) !== Function.prototype, "插件类继承自宿主 Plugin 基类");
ok(typeof PluginClass?.prototype?.onload === "function", "插件类实现 onload");
ok(typeof PluginClass?.prototype?.onunload === "function", "插件类实现 onunload");

// 视图层实际调用的 API 面（少一个都会在真实点击时抛 TypeError）
const REQUIRED = [
  "saveSettings", "pingBridge", "emit", "on", "confirm", "openForm", "openSettings",
  "activateView", "beginTask", "endTask",
  "openCapture", "openLinkIngest", "captureClipboard", "captureActiveNote",
  "captureSelection", "pickVaultFileToCapture", "captureVaultPath", "captureExternalFiles",
  "detectSourceType", "lastKnownTitle", "openObject", "openCitation", "openChat",
  "openAuditFor", "openGraphFor", "processObjectWithFeedback",
];
for (const m of REQUIRED) {
  ok(typeof PluginClass?.prototype?.[m] === "function", `插件 API 存在：${m}()`);
}

const size = (await import("node:fs")).statSync(bundle).size;
console.log(`\nmain.js 体积：${(size / 1024).toFixed(1)} KB`);

if (failures.length) {
  console.error(`\n✗ 失败 ${failures.length} 项 / 通过 ${passed} 项`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✅ 可加载性与 API 面全部通过：${passed} 项断言`);
}
