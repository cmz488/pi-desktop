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
  [
    "/composer-model-picker.js",
    ["src/ui/chat/composer-model-picker.js", javascript],
  ],
  ["/chat-dialog.js", ["src/ui/chat/chat-dialog.js", javascript]],
  [
    "/preferences-settings.js",
    ["src/ui/chat/preferences-settings.js", javascript],
  ],
  ["/provider-settings.js", ["src/ui/chat/provider-settings.js", javascript]],
  ["/resource-settings.js", ["src/ui/chat/resource-settings.js", javascript]],
  ["/package-settings.js", ["src/ui/chat/package-settings.js", javascript]],
  ["/remote-settings.js", ["src/ui/chat/remote-settings.js", javascript]],
  [
    "/composer-attachments.js",
    ["src/ui/chat/composer-attachments.js", javascript],
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
  ["/chat-shell.css", ["src/ui/chat/chat-shell.css", "text/css"]],
  ["/composer.css", ["src/ui/chat/composer.css", "text/css"]],
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
    "/settings-schema.json",
    ["src/ui/chat/settings-schema.json", "application/json"],
  ],
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

const pages = {
  // 旧聊天页仍在显式 URL 上可达；入口 `/` 已交给移植后的渲染层（见 publicAssets）。
  chat: [
    ["/prototype.html", ["src/ui/chat/index.html", "text/html"]],
    ["/prototype.js", ["src/ui/chat/chat.js", javascript]],
    ["/boot.js", ["src/ui/boot.js", javascript]],
    ["/prototype.css", ["src/ui/chat/chat.css", "text/css"]],
  ],
  workspace: [
    ["/workspace.html", ["src/ui/workspace.html", "text/html"]],
    ["/workspace.js", ["src/ui/workspace.js", javascript]],
    ["/workspace-boot.js", ["src/ui/boot.js", javascript]],
    ["/workspace.css", ["src/ui/workspace.css", "text/css"]],
  ],
};

/**
 * 枚举公共资产；不暴露源码或依赖目录。
 *
 * 入口 `/` 由移植后的渲染层承担（它与旧聊天页／工作区页是两套独立界面，不能共存于同一 URL）。
 * 旧页面仍从 `/prototype.html`、`/workspace.html` 提供，使回归测试与回滚仍可直接访问它们。
 */
export function publicAssets(page) {
  if (page === "next") return new Map([...sharedAssets, ...nextPageAssets]);
  const entries = pages[page === "preview" ? "chat" : page];
  if (!entries) throw new TypeError(`未知页面资产：${page}`);
  return new Map([
    ...sharedAssets,
    ...entries,
    ["/", ["build/ui-next/index.html", "text/html"]],
    ...nextPageAssets,
  ]);
}

