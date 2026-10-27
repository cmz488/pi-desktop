import { readdir } from "node:fs/promises";
import { UI_NEXT_ASSETS as uiNextAssets } from "../ui-next/generated-assets.mjs";

// Source files may move; these public URLs are shared by all browser hosts.
export const packageRoot = new URL("../../", import.meta.url);
export const assetFile = (file) => new URL(file, packageRoot);
const javascript = "text/javascript";
export const sharedAssets = new Map([
  ["/lazy-data.mjs", ["src/shared/lazy-data.mjs", javascript]],
  [
    "/extension-adapters.mjs",
    ["src/shared/extension-adapters.mjs", javascript],
  ],
  [
    "/agent-browser-view.js",
    ["src/ui/shared/agent-browser-view.js", javascript],
  ],
  ["/workspace-panels.js", ["src/ui/shared/workspace-panels.js", javascript]],
  [
    "/extension-workbench.js",
    ["src/ui/shared/extension-workbench.js", javascript],
  ],
  ["/branch-tree-panel.js", ["src/ui/shared/branch-tree-panel.js", javascript]],
  ["/subagent-history.js", ["src/ui/shared/subagent-history.js", javascript]],
  ["/round-tree-view.js", ["src/ui/shared/round-tree-view.js", javascript]],
  ["/task-panel.js", ["src/ui/shared/task-panel.js", javascript]],
  [
    "/task-panel-management.js",
    ["src/ui/shared/task-panel-management.js", javascript],
  ],
  ["/task-detail-view.js", ["src/ui/shared/task-detail-view.js", javascript]],
  ["/task-vocabulary.js", ["src/ui/shared/task-vocabulary.js", javascript]],
  ["/client-policy.js", ["src/ui/shared/client-policy.js", javascript]],
  ["/task-panel.css", ["src/ui/shared/task-panel.css", "text/css"]],
  ["/host-task-panel.js", ["src/ui/shared/host-task-panel.js", javascript]],
  [
    "/session-panel-loader.js",
    ["src/ui/shared/session-panel-loader.js", javascript],
  ],
  ["/design-tokens.css", ["src/ui/design-tokens.css", "text/css"]],
  ["/dsh-icons.mjs", ["src/ui/shared/dsh-icons.mjs", javascript]],
  ["/session-drafts.mjs", ["src/shared/session-drafts.mjs", javascript]],
  ["/connection.mjs", ["src/shared/connection.mjs", javascript]],
  [
    "/session-inventories.mjs",
    ["src/shared/session-inventories.mjs", javascript],
  ],
  ["/git-command.mjs", ["src/shared/git-command.mjs", javascript]],
  ["/markdown.mjs", ["src/ui/shared/markdown.mjs", javascript]],
  ["/pi-commands.mjs", ["src/shared/pi-commands.mjs", javascript]],
  ["/sidebar-view.mjs", ["src/shared/sidebar-view.mjs", javascript]],
  [
    "/fonts/DepartureMono-Regular.woff2",
    ["assets/fonts/DepartureMono-Regular.woff2", "font/woff2"],
  ],
  [
    "/fonts/CommitMono-400-Regular.otf",
    ["assets/fonts/CommitMono-400-Regular.otf", "font/otf"],
  ],
  [
    "/fonts/SourceSerif4-Italic.woff2",
    ["assets/fonts/SourceSerif4-Italic.woff2", "font/woff2"],
  ],
  ["/vendor/marked.mjs", [import.meta.resolve("marked"), javascript]],
  ["/vendor/purify.mjs", [import.meta.resolve("dompurify"), javascript]],
  ["/vendor/katex.mjs", [import.meta.resolve("katex"), javascript]],
]);
const katexDirectory = new URL("./", import.meta.resolve("katex"));
sharedAssets.set("/vendor/katex.css", [
  new URL("katex.min.css", katexDirectory).href,
  "text/css",
]);
for (const file of await readdir(new URL("fonts/", katexDirectory))) {
  if (/^[\w-]+\.(?:woff2?|ttf)$/.test(file))
    sharedAssets.set(`/vendor/fonts/${file}`, [
      new URL(`fonts/${file}`, katexDirectory).href,
      file.endsWith("woff2")
        ? "font/woff2"
        : file.endsWith("ttf")
          ? "font/ttf"
          : "font/woff",
    ]);
}
/**
 * Percho 渲染层（src/ui-next/）的构建产物页面。
 *
 * 接口：publicAssets("next") 返回该页面的完整资产表。
 * 不变量：产物清单来自构建生成的 generated-assets.mjs，不手写；未构建时为空表，
 *   Host 会以 404 暴露"未构建"，而不是悄悄提供旧文件。
 */
export const nextPageAssets = new Map([
  ...uiNextAssets.map(({ url, file, type }) => [url, [file, type]]),
  // 目录形式的入口：浏览器请求 /ui-next/ 时要拿到 index.html。
  ["/ui-next/", ["build/ui-next/index.html", "text/html"]],
  ["/ui-next", ["build/ui-next/index.html", "text/html"]],
]);

/**
 * 页面壳已移除。
 *
 * 入口 `/` 与浏览器界面由移植后的 Percho 渲染层承担（见 `nextPageAssets`）；旧聊天页与
 * 工作区页没有 URL 入口，因此这里不再登记它们。`sharedAssets` 仍保留：其中的面板与工具模块
 * 是独立的纯逻辑，测试与后续界面继续复用。
 */
const pages = {};

/**
 * 枚举公共资产；不暴露源码或依赖目录。
 *
 * 入口 `/` 由移植后的渲染层承担。旧聊天页与工作区页的页面壳已删除，不再有 URL 入口；
 * 其中的面板与工具模块仍在 `sharedAssets` 里，供测试与后续界面复用。
 */
export function publicAssets(page) {
  // 所有页面都由同一套资产承担：共享模块 + 移植后的渲染层产物 + 入口 `/`。
  // `chat`／`workspace`／`preview` 作为历史名字仍接受，但不再有独立页面壳。
  if (!["next", "chat", "workspace", "preview"].includes(page))
    throw new TypeError(`未知页面资产：${page}`);
  return new Map([
    ...sharedAssets,
    ...nextPageAssets,
    ["/", ["build/ui-next/index.html", "text/html"]],
  ]);
}

