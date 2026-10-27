import { readClientPolicy } from "./client-policy.js";
import { createChatDialog } from "./chat-dialog.js";
import { createPreferencesSettings } from "./preferences-settings.js";
import { createProviderSettings } from "./provider-settings.js";
import { createResourceSettings } from "./resource-settings.js";
import { createPackageSettings } from "./package-settings.js";
import { createComposerAttachments } from "./composer-attachments.js";
import { createComposerModelPicker } from "./composer-model-picker.js";
import { createWorkspacePanels } from "./workspace-panels.js";
import { createExtensionWorkbench } from "./extension-workbench.js";
import { createBranchTreePanel } from "./branch-tree-panel.js";
import { createTaskPanel } from "./task-panel.js";
import { dshIcon } from "./dsh-icons.mjs";
import { createSessionConnection, openSessionStream } from "./connection.mjs";
import { createSessionInventories } from "./session-inventories.mjs";
import {
  createIndexedFetch,
  projectConversationTimeline,
} from "./lazy-data.mjs";
import { extensionAdapterRegistry } from "./extension-adapters.mjs";
import { createSessionDrafts } from "./session-drafts.mjs";
import { renderMarkdown } from "./markdown.mjs";
import DOMPurify from "./vendor/purify.mjs";

/**
 * 聊天入口：按固定会话读取原生状态，连接草稿、工作台与 Desktop 导航。
 *
 * 接口：同源父窗口可选择当前 generation 的原生会话；会话切换与面板生命周期
 *   见 docs/architecture/interfaces/read-panels.md，轮次命令见 session-tree.md。
 * 不变量：展示投影不替代 SDK 上下文或模型循环；身份失效先于新快照，旧请求
 *   不清另一会话草稿；导航通知不授予管理权限，能力仍取显式 Host 声明。
 * 错误：当前请求失败提示使用者；过期结果忽略，读取断连不等于中止原生任务。
 */
const indexedFetch = createIndexedFetch();
let hostFocused = true;
const piLogo =
  '<svg class="pi-logo" viewBox="165.29 165.29 469.43 469.43" aria-hidden="true"><path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/><path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/><path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z"/></svg>';
/* Layout: ZCode WorkspaceShellLayout / DESIGN.md; drafts: DSH form-model;
 * reconnect cursor: Miyu web/app.js. Exact source mapping: SOURCES.md. */
const paths = {
  chat: '<path d="M4 4h16v12H9l-5 4V4Z"/>',
  plugin: '<path d="M9 3h6v4h4v6h-4v8H9v-8H5V7h4V3Z"/>',
  layers:
    '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  phone:
    '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/>',
  folder: '<path d="M3 6V4h6l2 2h10v14H3V6Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  arrow: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  sidebar:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  commands: '<path d="M4 6h16M4 12h16M4 18h10"/>',
};
const icon = (name) =>
  ({
    folder: "folder",
    arrow: "send",
    search: "search",
    settings: "settings",
    plus: "plus",
    chat: "new-chat",
    sidebar: "sidebar",
    extensions: "extensions",
  })[name]
    ? dshIcon(
        {
          folder: "folder",
          arrow: "send",
          search: "search",
          settings: "settings",
          plus: "plus",
          chat: "new-chat",
          sidebar: "sidebar",
          extensions: "extensions",
        }[name],
      )
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.plugin}</svg>`;
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const live = $('meta[name="pi-desk-mode"]').content === "live";
$("#attach-context").disabled = live;
const scanAddress = new URL(location.href);
const runtimePrefix =
  /^\/agents\/[a-f0-9-]{36}(?=\/)/.exec(location.pathname)?.[0] ?? "";
const runtimePath = (path) => runtimePrefix + path;
const selectionKey = `pi-durable-agent${runtimePrefix}`;
document.body.classList.toggle(
  "desktop-embedded",
  scanAddress.searchParams.has("embed"),
);
const scanAgent = scanAddress.searchParams.get("agent");
let durableAgentId = /^\d+$/.test(scanAgent ?? "")
  ? scanAgent
  : sessionStorage.getItem(selectionKey) || "";
let actionEpoch = 0;
if (/^\d+$/.test(scanAgent ?? "")) {
  sessionStorage.setItem(selectionKey, scanAgent);
  scanAddress.searchParams.delete("agent");
  history.replaceState(
    null,
    "",
    scanAddress.pathname + scanAddress.search + scanAddress.hash,
  );
}
const sessionDrafts = createSessionDrafts();
let workspacePanel;
let nativeHistoryLimit = 50;
const messageDetails = new Map();
let messageDetailBytes = 0;
const messageDetailKey = (row) =>
  `${state?.sessionId}:${row.id}:${row.detailRevision}`;
async function loadMessageDetails(ids) {
  const owner = state?.sessionId;
  for (const id of ids) {
    const row = messageRows.find((row) => String(row.id) === String(id));
    if (!row?.lazy) continue;
    const key = messageDetailKey(row);
    const value = await api(
      `/api/message-detail?messageId=${encodeURIComponent(id)}`,
    );
    if (owner !== state?.sessionId) return;
    const detail = { ...value, detailRevision: row.detailRevision };
    const size = JSON.stringify(detail).length * 2;
    if (size <= 8 * 1024 * 1024) {
      while (
        messageDetails.size >= 16 ||
        messageDetailBytes + size > 8 * 1024 * 1024
      ) {
        const oldest = messageDetails.keys().next().value;
        messageDetailBytes -= messageDetails.get(oldest).size;
        messageDetails.delete(oldest);
      }
      if (!messageDetails.has(key)) {
        messageDetails.set(key, { value: detail, size });
        messageDetailBytes += size;
      }
    }
    const index = messageRows.indexOf(row);
    if (index >= 0) messageRows[index] = detail;
  }
  detailsVersion++;
  if (owner === state?.sessionId) renderMessages(messageRows);
}

function targetedPath(path, owner) {
  if (!durableAgentId && state?.host !== "durable" && path !== "/api/state")
    return runtimePath(path);
  const url = new URL(path, location.href);
  if (
    desktopConfiguration?.agent &&
    [
      "/api/tasks",
      "/api/task-detail",
      "/api/subagent-history",
      "/api/command",
    ].includes(url.pathname)
  )
    url.searchParams.set(
      "generation",
      String(desktopConfiguration.agent.generation ?? 0),
    );
  if (url.pathname === "/api/state") {
    url.searchParams.set("view", "chat");
    url.searchParams.set("historyLimit", nativeHistoryLimit);
  }
  if (!url.searchParams.has("sessionId"))
    url.searchParams.set(
      "sessionId",
      owner ?? (durableAgentId || state?.sessionId || ""),
    );
  return runtimePath(url.pathname + url.search);
}
function chooseDurableAgent(id) {
  if (
    durableAgentId === String(id) &&
    sessionDrafts.read().owner === String(id)
  )
    return false;
  pendingConversation = undefined;
  conversationSwitching = false;
  if (state?.host === "durable") {
    $("#prompt").value = sessionDrafts.select(
      String(id),
      $("#prompt").value,
    ).text;
    composerAttachments.render();
    $("#messages").replaceChildren();
    resetInteraction();
  }
  actionEpoch++;
  durableAgentId = String(id);
  closeModelControls();
  syncChatViews();
  sessionStorage.setItem(selectionKey, durableAgentId);
  closeActionMenu();
  extensionWorkbench?.update([], readPanelContext());
  syncComposerButton();
  return true;
}
const titles = {
  workspace: "会话",
  extensions: "扩展工作台",
  general: "Pi 配置",
  personality: "人格与提示词",
  appearance: "外观",
  skills: "技能与模板",
  mcp: "MCP 服务",
  plugins: "已安装插件",
  providers: "模型提供商",
  marketplace: "插件市场",
  remote: "远程连接",
};
let desktopConfiguration;
function desktopMessage(type, data = {}) {
  window.parent.postMessage(
    { type: `pi-desktop:${type}`, ...data },
    location.origin,
  );
}
function renderComposerContext() {
  // 折叠状态属于外壳，不以内容模式为条件：历史／已停止会话也必须保留
  // 自己的“展开侧边栏”入口，否则外壳与 iframe 两侧的按钮会同时消失。
  if (runtimePrefix && desktopConfiguration?.agent)
    document.body.classList.toggle(
      "host-sidebar-collapsed",
      !!desktopConfiguration.sidebarCollapsed,
    );
  if (state?.capabilities?.nativeHistory) {
    $("#desktop-composer-context").hidden = true;
    $("#composer-permission").hidden = true;
    return;
  }
  if (!runtimePrefix || !desktopConfiguration?.agent) return;
  $("#desktop-composer-context").hidden = false;
  $("#composer-permission").hidden = false;
  $("#analysis-control").hidden = false;
  $("#attach-context").innerHTML = dshIcon("plus");
  const { agent, projects, promptProfiles } = desktopConfiguration;
  const project = $("#composer-project");
  project.replaceChildren(
    new Option("无项目", ""),
    ...projects.map((row) => new Option(row.name, row.id)),
  );
  project.value = agent.projectId ?? "";
  project.title = "选择项目会创建独立会话，并复制当前草稿与附件";
  const prompts = $("#composer-system-prompt");
  prompts.replaceChildren(
    new Option("标准模式", "standard"),
    ...promptProfiles.map((row) => new Option(row.name, row.id)),
    new Option("添加系统提示词…", "__new__"),
    ...(agent.promptProfileId && agent.promptProfileId !== "standard"
      ? [new Option("编辑当前系统提示词…", "__edit__")]
      : []),
  );
  prompts.value = agent.promptProfileId ?? "standard";
  prompts.disabled = !state?.idle;
  $("#composer-approval").value = agent.approvalMode ?? "ask-risky";
  $("#composer-approval").disabled = !state?.idle;
  $("#composer-permission").title = state?.capabilities?.readOnly
    ? "无项目会话保持只读，权限等级控制可用工具的确认方式"
    : "通过 Pi tool_call 钩子确认工具，包括 Codemode/MCP 嵌套调用";
  for (const item of contextSelects) item.sync();
}
$("#composer-project").onchange = (event) => {
  sessionDrafts.edit($("#prompt").value);
  desktopMessage("project", {
    projectId: event.target.value || null,
    draft: sessionDrafts.read(),
  });
  event.target.value = desktopConfiguration.agent.projectId ?? "";
};
$("#composer-system-prompt").onchange = (event) => {
  const value = event.target.value;
  if (value === "__new__" || value === "__edit__")
    desktopMessage("configure-prompt", {
      id:
        value === "__edit__"
          ? desktopConfiguration.agent.promptProfileId
          : undefined,
    });
  else desktopMessage("prompt", { promptProfileId: value });
  event.target.value = desktopConfiguration.agent.promptProfileId ?? "standard";
};
$("#composer-approval").onchange = (event) => {
  desktopMessage("policy", { mode: event.target.value });
  event.target.value = desktopConfiguration.agent.approvalMode ?? "ask-risky";
};

/* The three composer selects are rendered as designed listboxes. The native
 * select stays in the DOM (value/change contract, tests and Desktop host), but
 * is visually replaced by a full-pill trigger plus a themed menu. */
const contextSelects = [];
let openContextSelect;
function enhanceContextSelect(select) {
  const shell = select.closest(".context-selector");
  if (!shell || shell.dataset.enhanced === "true") return;
  shell.dataset.enhanced = "true";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "context-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const text = document.createElement("span");
  text.className = "context-trigger-label";
  trigger.append(text);
  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.hidden = true;
  menu.id = `${select.id}-options`;
  menu.setAttribute("role", "listbox");
  trigger.setAttribute("aria-controls", menu.id);
  trigger.setAttribute("aria-label", select.getAttribute("aria-label") ?? "");
  shell.insertBefore(trigger, select);
  shell.append(menu);
  select.classList.add("context-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");
  let activeIndex = 0;
  const choices = () => [...select.options].filter((row) => !row.disabled);
  function markActive() {
    [...menu.children].forEach((row, index) =>
      row.classList.toggle("is-active", index === activeIndex),
    );
  }
  function renderMenu() {
    menu.replaceChildren();
    const rows = choices();
    activeIndex = Math.max(
      0,
      rows.findIndex((row) => row.value === select.value),
    );
    for (const [index, option] of rows.entries()) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "context-option";
      if (option.value.startsWith("__")) row.classList.add("is-action");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(option.value === select.value));
      row.tabIndex = -1;
      row.dataset.value = option.value;
      row.textContent = option.textContent;
      row.addEventListener("pointermove", () => {
        activeIndex = index;
        markActive();
      });
      row.addEventListener("click", () => choose(option.value));
      menu.append(row);
    }
    markActive();
  }
  function sync() {
    const current = select.selectedOptions[0];
    text.textContent = current?.textContent ?? "";
    trigger.disabled = select.disabled;
    shell.classList.toggle("is-disabled", select.disabled);
    if (!menu.hidden) renderMenu();
  }
  function open(up = false) {
    if (trigger.disabled || !choices().length) return;
    if (openContextSelect && openContextSelect !== api)
      openContextSelect.close();
    renderMenu();
    menu.hidden = false;
    shell.classList.add("menu-open");
    trigger.setAttribute("aria-expanded", "true");
    openContextSelect = api;
    const rows = choices();
    activeIndex = up ? rows.length - 1 : activeIndex;
    markActive();
    menu.children[activeIndex]?.focus({ preventScroll: true });
    menu.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }
  function close(restoreFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    shell.classList.remove("menu-open");
    trigger.setAttribute("aria-expanded", "false");
    if (openContextSelect === api) openContextSelect = undefined;
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  function choose(value) {
    const changed = select.value !== value;
    select.value = value;
    close(true);
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    sync();
  }
  // The whole pill is the hit area: icons, padding and the chevron all open the
  // menu, not only the text inside the native select.
  shell.addEventListener("click", (event) => {
    if (event.target.closest(".context-menu")) return;
    event.preventDefault();
    if (menu.hidden) open();
    else close(true);
  });
  trigger.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      open(event.key === "ArrowUp");
    } else if (event.key === "Escape") close();
  });
  menu.addEventListener("keydown", (event) => {
    const rows = choices();
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      activeIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : (activeIndex + (event.key === "ArrowUp" ? -1 : 1) + rows.length) %
              rows.length;
      markActive();
      menu.children[activeIndex]?.focus({ preventScroll: true });
      menu.children[activeIndex]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      menu.children[activeIndex]?.click();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!shell.contains(event.target)) close();
  });
  window.addEventListener("resize", () => close());
  const api = { sync, close: () => close() };
  contextSelects.push(api);
  sync();
}
for (const select of [
  $("#composer-project"),
  $("#composer-system-prompt"),
  $("#composer-approval"),
])
  enhanceContextSelect(select);
function closeModelControls() {
  composerModelPicker?.close();
}
for (const node of document.querySelectorAll("[data-dsh-icon]"))
  node.innerHTML = dshIcon(node.dataset.dshIcon);
let desktopReady = false;
window.addEventListener("message", (event) => {
  if (
    runtimePrefix &&
    event.origin === location.origin &&
    event.source === window.parent &&
    event.data?.type === "pi-desktop:select-conversation"
  ) {
    const id = event.data.conversationId;
    if (
      state?.host !== "durable" ||
      event.data.generation !==
        (desktopConfiguration?.agent?.generation ?? 0) ||
      !Number.isSafeInteger(id) ||
      id < 0
    )
      return;
    void switchConversation(id).catch((error) => toast(error.message));
    return;
  }
  if (
    runtimePrefix &&
    event.origin === location.origin &&
    event.source === window.parent &&
    event.data?.type === "pi-desktop:restore-draft" &&
    state?.sessionId
  ) {
    const draft = event.data.draft;
    if (typeof draft?.text === "string" && Array.isArray(draft.files)) {
      sessionDrafts.edit(draft.text);
      composerAttachments.restore(draft.files, state.sessionId);
      $("#prompt").value = draft.text;
      composerAttachments.render();
    }
    return;
  }
  if (
    runtimePrefix &&
    event.origin === location.origin &&
    event.source === window.parent &&
    event.data?.type === "pi-desktop:workspace-config"
  ) {
    const focused = event.data.focused !== false;
    if (hostFocused !== focused) {
      hostFocused = focused;
      if (!focused) {
        sessionConnection.pause();
        connected = false;
      } else if (!document.hidden) void sessionConnection.resume();
      syncChatViews();
    }
    const next = {
      agent: event.data.agent,
      project: event.data.project,
      projects: event.data.projects ?? [],
      promptProfiles: event.data.promptProfiles ?? [],
      sidebarCollapsed: !!event.data.sidebarCollapsed,
      nativeBrowser: !!event.data.nativeBrowser,
    };
    if (JSON.stringify(next) === JSON.stringify(desktopConfiguration)) return;
    desktopConfiguration = next;
    $(".desktop-update-all").hidden = false;
    syncChatViews();
    renderComposerContext();
    workspacePanel?.configure(desktopConfiguration);
    return;
  }
  if (
    runtimePrefix &&
    event.origin === location.origin &&
    event.source === window.parent &&
    event.data?.type === "pi-desktop:appearance"
  ) {
    preferencesSettings.applyAppearance();
    return;
  }
  if (
    !runtimePrefix ||
    event.origin !== location.origin ||
    event.source !== window.parent ||
    event.data?.type !== "pi-desktop:view" ||
    !titles[event.data.view]
  )
    return;
  if (state)
    void showView(event.data.view).catch((error) => toast(error.message));
  else location.hash = event.data.view;
});
let view = "workspace",
  state,
  connected = false,
  toastTimer,
  streaming,
  activeInteraction,
  interactionSignature = "";
let historyOwner = "",
  historyIndex = -1,
  historyDraft = "";
const sentHistory = new Map();
let activeCalls = new Map();
let sessions = [],
  messageRows = [],
  selected = null;
let commands = [],
  commandMatches = [],
  commandIndex = 0,
  commandDismissed = "";
let btwThread = null,
  btwBusy = false;
// UUIDv7 IDs share their leading timestamp; display enough for practical selection.
const SESSION_ID_DISPLAY_LENGTH = 18;
const demoMessages = [
  {
    role: "user",
    text: "帮我检查 pi 的模型服务和扩展配置，让手机也可以接着操作。",
  },
  {
    role: "assistant",
    text: "我会先读取项目与配置，再检查需要调整的项。模型、工具和扩展都使用 pi 当前的运行环境。",
  },
  {
    role: "toolResult",
    toolName: "read",
    text: 'package.json\n{\n  "name": "pi-desktop-extension",\n  "pi": { "extensions": ["./index.ts"] }\n}',
  },
  {
    role: "assistant",
    text: "可以从设置中管理模型提供商、Pi 配置和已安装插件。\n\n连接手机后，对话仍由这台电脑上的 pi 执行。",
  },
  {
    role: "custom",
    customType: "desktop-preview",
    text: "扩展工作台演示，不执行插件。",
    details: {
      piDesktop: {
        version: 1,
        label: "演示 · 检查报告",
        title: "一次检查，一份记录",
        status: "示例",
        body: "普通扩展卡片保留在原会话中，可以随时回到这里查看。这是本地界面预览，不是实际检查结果。",
        metrics: ["会话记录", "不执行插件"],
      },
    },
  },
  {
    role: "custom",
    customType: "desktop-preview",
    text: "扩展工作台演示，不执行插件。",
    details: {
      piDesktop: {
        version: 1,
        label: "演示 · 工作区检查",
        title: "让扩展有自己的工作台",
        status: "状态示例",
        body: "扩展用 details.piDesktop 声明页面。最新状态出现在工作台中，工具执行、权限与会话仍由 Pi 管理。",
        progress: { value: 2, total: 3 },
        detailsLabel: "检查步骤",
        items: [
          { label: "模型与配置", status: "示例 · 已检查" },
          { label: "扩展展示", status: "示例 · 已就绪" },
          { label: "远程接入", status: "示例 · 待确认" },
        ],
        metrics: ["仅 UI 预览", "不执行插件"],
        presentation: { mode: "state", key: "desktop-preview/check" },
      },
    },
  },
  {
    role: "user",
    text: "让扩展有自己的页面，对话里只保留关键进展。",
  },
  {
    role: "assistant",
    text: "在「扩展工作台」展开完整页面，对话和工具输出仍留在原位。\n\n页面跟随当前会话更新，执行和权限仍由 Pi 管理。上方卡片仅为界面示例，不会运行插件。",
  },
].map((message, index) => ({
  ...message,
  id: `demo-message-${index}`,
  extensionView: extensionAdapterRegistry.project(message),
}));
for (const element of document.querySelectorAll("[data-icon]"))
  element.innerHTML = icon(element.dataset.icon);
let chatPageActive = true,
  chatViewsIdentity,
  chatViewsActive;
function chatViewIdentity() {
  return JSON.stringify([
    runtimePrefix,
    desktopConfiguration?.agent?.generation,
    actionEpoch,
    durableAgentId || state?.sessionId,
    state?.cwd,
    state?.epoch,
    state?.backend?.id,
  ]);
}
function chatViewsAreActive() {
  return (
    chatPageActive &&
    !document.hidden &&
    hostFocused &&
    (!live || (connected && readClientPolicy(readPanelContext()).ready))
  );
}
const chatDialog = createChatDialog({
  getIdentity: chatViewIdentity,
  onError: (error) => toast(error.message),
});
const preferencesSettings = createPreferencesSettings({
  live,
  embedded: !!runtimePrefix,
  api,
  esc,
  toast,
  openDialog,
  getState: () => state,
  getDesktopConfiguration: () => desktopConfiguration,
  desktopMessage,
  showView,
  refresh: () => refresh(),
});
const providerSettings = createProviderSettings({
  live,
  api,
  esc,
  field,
  openDialog,
  toast,
  getState: () => state,
  refresh: () => refresh(),
  pollInteractions: () => pollInteractions(),
  selectModel: (provider, id) => selectComposerModel(provider, id),
  setDefaults(defaults) {
    state.defaults = defaults;
  },
  async openModels(id) {
    await showView("workspace");
    await composerModelPicker.openModels(id);
  },
  onModelsChanged: () => composerModelPicker.update(),
});
const packageSettings = createPackageSettings({
  live,
  api,
  esc,
  icon,
  field,
  openDialog,
  isDialogCurrent: (token) => chatDialog.isCurrent(token),
  toast,
  getState: () => state,
  getConnected: () => connected,
  refresh: () => refresh(),
  refreshInventories: () =>
    sessionInventories.refresh(state, { force: true, kinds: ["plugins"] }),
});
const resourceSettings = createResourceSettings({
  live,
  api,
  esc,
  icon,
  field,
  openDialog,
  toast,
  getState: () => state,
  getCommands: () => commands,
  loadCommands,
  async useCommand(name) {
    const identity = chatViewIdentity();
    await showView("workspace");
    if (identity !== chatViewIdentity()) return;
    $("#prompt").value = `/${name} `;
    mirrorComposer();
    $("#prompt").focus();
  },
  async beginInteraction(job) {
    activeInteraction = { id: job.id };
    await pollInteractions();
  },
  refresh: () => refresh(),
});
const composerAttachments = createComposerAttachments({
  live,
  embedded: !!runtimePrefix,
  drafts: sessionDrafts,
  api,
  getState: () => state,
  esc,
  toast,
  onChange: () => syncComposerButton(),
  openPreview(file) {
    if (workspacePanel) workspacePanel.openAttachment(file);
    else
      openDialog(
        file.name,
        file.image
          ? `<img class="attachment-preview" src="${esc(file.url)}" alt="${esc(file.name)}">`
          : `<pre class="attachment-text-preview">${esc(file.preview)}</pre>`,
        () => {},
        "关闭",
      );
  },
});
function syncChatViews() {
  const identity = chatViewIdentity(),
    active = chatViewsAreActive();
  if (chatViewsIdentity !== identity) chatDialog.close();
  if (chatViewsIdentity !== identity || (chatViewsActive && !active))
    sessionInventories.invalidate();
  chatViewsIdentity = identity;
  chatViewsActive = active;
  const context = { identity, view, active };
  preferencesSettings.setContext(context);
  preferencesSettings.update();
  providerSettings.setContext(context);
  providerSettings.update();
  packageSettings.setContext(context);
  resourceSettings.setContext(context);
}
async function selectComposerModel(provider, id) {
  if (!live) {
    const row = providerSettings.pickerModels.find(
      (item) => item.id === provider,
    );
    selected = {
      ...(row?.models.find((item) => item.id === id) ?? { id, name: id }),
      provider,
    };
    state.model = selected;
    $("#selected-model").textContent = selected.name;
    providerSettings.update();
    composerModelPicker.update();
    return;
  }
  const identity = chatViewIdentity();
  const result = await api("/api/model", {
    provider,
    id,
    sessionId: state?.sessionId,
  });
  if (identity !== chatViewIdentity()) return;
  await refresh();
  if (identity === chatViewIdentity() && result.deferred)
    toast("模型将在当前任务结束后应用");
}

function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 4200);
}
const TASK_WAIT_REQUEST_MS = 45000;
const forkNavigationRequests = new WeakMap();
function openCreatedSession(result) {
  if (!result?.agentId) return false;
  if (window.parent !== window) {
    const requestId = forkNavigationRequests.get(result);
    if (requestId)
      window.parent.postMessage(
        {
          type: "pi-desktop:fork-result",
          requestId,
          result: {
            agentId: result.agentId,
            generation: result.generation,
            sessionId: result.sessionId,
          },
        },
        location.origin,
      );
  } else {
    const url = new URL("/", location.href);
    url.searchParams.set("agent", result.agentId);
    location.assign(url.href);
  }
  return true;
}
async function api(path, input, { signal, selectSession = true } = {}) {
  const taskWait = path === "/api/command" && input?.command === "wait";
  const requestOwner = durableAgentId;
  const requestEpoch = actionEpoch;
  const forkRequestId =
    runtimePrefix && path === "/api/command" && input?.command === "fork"
      ? crypto.randomUUID()
      : undefined;
  if (forkRequestId)
    window.parent.postMessage(
      {
        type: "pi-desktop:fork-start",
        requestId: forkRequestId,
      },
      location.origin,
    );
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(
        taskWait
          ? new Error("等待连接超时，任务继续运行，可重新等待")
          : undefined,
      ),
    path.startsWith("/api/btw")
      ? 600000
      : path.startsWith("/api/package")
        ? 180000
        : path === "/api/context/files"
          ? 130000
          : path.startsWith("/api/git")
            ? 100000
            : path.startsWith("/api/browser")
              ? 45000
              : taskWait
                ? TASK_WAIT_REQUEST_MS
                : 12000,
  );
  try {
    const data = await indexedFetch(
      targetedPath(path, input?.sessionId),
      input === undefined
        ? { cache: "no-store", signal: controller.signal }
        : {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...input,
              sessionId: input.sessionId ?? state?.sessionId,
            }),
          },
    );
    if (forkRequestId) {
      if (data.agentId) forkNavigationRequests.set(data, forkRequestId);
      else
        window.parent.postMessage(
          { type: "pi-desktop:fork-result", requestId: forkRequestId },
          location.origin,
        );
    }
    if (
      selectSession &&
      !data.agentId &&
      requestEpoch === actionEpoch &&
      requestOwner === durableAgentId &&
      state?.host === "durable" &&
      (data.sessionId ?? data.sessionCommand?.sessionId) &&
      (path === "/api/prompt" ||
        path === "/api/new-session" ||
        path === "/api/switch-session" ||
        (path === "/api/command" &&
          ["create", "fork"].includes(input?.command)))
    )
      chooseDurableAgent(data.sessionId ?? data.sessionCommand?.sessionId);
    if (
      input !== undefined &&
      !["/api/prompt", "/api/abort", "/api/thinking", "/api/remote"].includes(
        path,
      )
    )
      sessionInventories.invalidate();
    return data;
  } catch (error) {
    if (forkRequestId)
      window.parent.postMessage(
        {
          type: "pi-desktop:fork-result",
          requestId: forkRequestId,
        },
        location.origin,
      );
    if (
      error.status === 404 &&
      path === "/api/state" &&
      durableAgentId &&
      requestOwner === durableAgentId &&
      requestEpoch === actionEpoch &&
      !signal?.aborted
    ) {
      durableAgentId = "";
      pendingConversation = undefined;
      conversationSwitching = false;
      sessionStorage.removeItem(selectionKey);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  $(".drawer-backdrop").hidden = true;
}
async function showView(next) {
  if (!titles[next]) return;
  if (
    !readClientPolicy(readPanelContext()).canViewSettings &&
    next !== "workspace"
  )
    next = "workspace";
  const previous = view;
  const changed = view !== next;
  view = next;
  if (changed) chatDialog.close();
  if (runtimePrefix)
    window.parent.postMessage(
      { type: "pi-desktop:view-changed", view: next },
      location.origin,
    );
  closeUsageDetails();
  closeCommands();
  closeModelControls();
  closeActionMenu();
  const workbench = next === "workspace" || next === "extensions";
  // 设置子页之间的切换是同一块面板的换页，不需要整体入场动画；
  // 只有跨过工作台／设置边界时才播放，避免每次打开设置都闪一下。
  const crossing =
    changed &&
    workbench !== (previous === "workspace" || previous === "extensions");
  document.body.classList.toggle("settings-open", !workbench);
  document.body.classList.toggle("extensions-open", next === "extensions");
  $(".settings-back").hidden = workbench;
  $(".topbar [data-action='sidebar']").hidden = !workbench;
  $('[data-action="workspace-tools"]').hidden = next !== "workspace";
  $("#view-workspace").hidden = next !== "workspace";
  $("#view-extensions").hidden = next !== "extensions";
  extensionWorkbench?.setActive(next === "extensions");
  $("#settings-shell").hidden = workbench;
  $(".workspace-view-switch").hidden = !workbench;
  for (const element of document.querySelectorAll("[data-workspace-view]"))
    element.setAttribute("aria-pressed", String(element.dataset.view === next));
  for (const element of document.querySelectorAll(".settings-view"))
    element.hidden = element.id !== `view-${next}`;
  for (const element of document.querySelectorAll("[data-view]"))
    element.classList.toggle("active", element.dataset.view === next);
  if (matchMedia("(max-width:700px)").matches && next !== "workspace")
    $(".settings-nav button.active")?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    });
  $("#page-label").textContent = titles[next];
  $("#session-title").hidden = !workbench;
  $(".slash").hidden = !workbench;
  closeSidebar();
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}#${next}`,
  );
  if (crossing)
    animateViewEnter(
      next === "workspace"
        ? $("#view-workspace")
        : next === "extensions"
          ? $("#view-extensions")
          : $(`#view-${next}`),
    );
  syncChatViews();
  if (live && state && ["plugins", "providers", "marketplace"].includes(next))
    await sessionInventories.refresh(state, {
      kinds: [next === "providers" ? "providers" : "plugins"],
    });
}
function field(label, name, value = "", type = "text", extra = "") {
  return `<label class="field-label">${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
}
function openDialog(...args) {
  return chatDialog.open(...args);
}
const disclosures = new Map();
// Fold bodies keep their own reading position (long tool arguments and output).
// Live updates rebuild those nodes, so offsets are remembered per stable key.
const foldScroll = new Map();
const MAX_REMEMBERED_FOLD_SCROLL = 500;
/* Fold state is this client's own reading state, not Pi data. Keep it in
 * sessionStorage so a page refresh reopens the same folds at the same offset;
 * otherwise the expanded activity collapses and its scroll progress is lost. */
const FOLD_STATE_KEY = "pi-web-fold-state";
const MAX_PERSISTED_CONVERSATIONS = 64;
const conversationScroll = new Map();
const restoredScrollSessions = new Set();
const storedFoldState = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(FOLD_STATE_KEY) ?? "null") ?? {};
  } catch {
    return {};
  }
})();
for (const entry of Array.isArray(storedFoldState.disclosures)
  ? storedFoldState.disclosures
  : [])
  if (Array.isArray(entry) && typeof entry[0] === "string")
    disclosures.set(entry[0], entry[1] === true);
for (const entry of Array.isArray(storedFoldState.scroll)
  ? storedFoldState.scroll
  : [])
  if (
    Array.isArray(entry) &&
    typeof entry[0] === "string" &&
    Number.isFinite(entry[1])
  )
    foldScroll.set(entry[0], entry[1]);
for (const entry of Array.isArray(storedFoldState.conversation)
  ? storedFoldState.conversation
  : [])
  if (
    Array.isArray(entry) &&
    typeof entry[0] === "string" &&
    Number.isFinite(entry[1])
  )
    conversationScroll.set(entry[0], entry[1]);
let extensionWorkbench;
const activityAnimationStarts = new Map();
function toolSummary(value) {
  try {
    const args = JSON.parse(value);
    return String(
      args.command ??
        args.path ??
        args.file_path ??
        args.query ??
        Object.keys(args).join(", "),
    )
      .replace(/\s+/g, " ")
      .slice(0, 100);
  } catch {
    return String(value).replace(/\s+/g, " ").slice(0, 100);
  }
}
function compactActivityText(value, limit = 48) {
  const text = Array.from(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return text.length > limit
    ? `${text.slice(0, limit - 1).join("")}…`
    : text.join("");
}
function compactToolActivity(name, argumentsValue) {
  const argumentsText =
    typeof argumentsValue === "string"
      ? argumentsValue
      : JSON.stringify(argumentsValue ?? {});
  const preview = toolSummary(argumentsText);
  return compactActivityText(
    name === "bash"
      ? preview || name
      : [name, preview].filter(Boolean).join(" · "),
  );
}
function runningActivityText() {
  const call = [...activeCalls.values()].findLast(
    (item) => item.status === "running",
  );
  if (call) return compactToolActivity(call.name, call.arguments);
  if (activeInteraction?.status === "running") return "等待回复";
  if (state?.phase === "thinking") return "思考中";
  const operation = String(state?.operation ?? "")
    .replace(/^执行\s*/, "")
    .replace(/[.…]+$/, "");
  if (/^(?:pi\s*)?正在思考/i.test(operation)) return "思考中";
  if (/^(?:pi\s*)?正在处理/i.test(operation)) return "生成中";
  if (/^(?:等待|waiting\b|wait\b|await\b)/i.test(operation)) return "等待中";
  if (operation) return compactActivityText(operation);
  const workingMessage = String(state?.workingMessage ?? "").trim();
  if (/^(?:等待|waiting\b|wait\b|await\b)/i.test(workingMessage))
    return "等待中";
  return compactActivityText(
    workingMessage || (state?.phase === "output" ? "生成中" : "处理中"),
  );
}
function toolMarkup(block) {
  const result = messageRows.find(
    (row) => row.role === "toolResult" && row.toolCallId === block.id,
  );
  const current = activeCalls.get(block.id);
  const error = result?.isError || current?.isError;
  const status = result
    ? error
      ? "error"
      : "complete"
    : (current?.status ?? (state?.idle ? "interrupted" : "pending"));
  const labels = {
    error: "执行失败",
    complete: "已完成",
    running: "执行中",
    pending: "准备调用",
    interrupted: "未完成",
  };
  const argumentsText = block.arguments ?? current?.arguments ?? "{}";
  const output = result?.text ?? current?.output;
  const extensionView = extensionAdapterRegistry.render(result?.extensionView, {
    placement: "tool",
    disclosures,
  });
  const extensionStatus = extensionAdapterRegistry.summary(
    result?.extensionView,
  );
  const key = `tool:${state?.sessionId}:${block.id}`;
  const source = messageRows.find((row) =>
    row.blocks?.some(
      (item) => item.type === "toolCall" && item.id === block.id,
    ),
  );
  const lazyIds = [source, result]
    .filter((row) => row?.lazy)
    .map((row) => String(row.id));
  const lazy = lazyIds.length
    ? `data-lazy-messages="${esc(JSON.stringify(lazyIds))}"`
    : "";

  return `<details class="tool-card ${status}" ${lazy} data-disclosure="${esc(key)}" ${disclosures.get(key) ? "open" : ""}><summary><span class="tool-state ${status}">${status === "running" ? '<span class="activity-spinner"></span>' : error ? "!" : status === "complete" ? "✓" : "·"}</span><strong>${esc(block.name)}</strong><small>${esc(toolSummary(argumentsText))}</small>${extensionStatus ? `<span class="extension-inline-status">${esc(extensionStatus)}</span>` : ""}<span class="tool-outcome">${labels[status]}</span>${result ? `<button type="button" data-preview="${messageRows.indexOf(result)}">查看 ↗</button>` : ""}</summary><div class="tool-details">${extensionView}<label>参数</label><pre data-scroll-key="${esc(key + ":arguments")}">${esc(argumentsText)}</pre>${output !== undefined ? `<label>输出</label><pre data-scroll-key="${esc(key + ":output")}">${esc(output || "无文本输出")}</pre>` : '<p class="muted">等待工具结果…</p>'}</div></details>`;
}
function activityMarkup(message, block) {
  // Records owned by an operations panel are not repeated as transcript cards.
  const entries = block.entries.filter(
    (entry) =>
      !(entry.block.type === "toolCall" && goalPanelTool(entry.block.name)),
  );
  // An originally empty activity block is the live "waiting" fold, not a
  // goal-only group; only hide a group that became empty by filtering.
  if (!entries.length && block.entries.length) return "";
  const runningTool = entries.findLast(
    (entry) =>
      entry.block.type === "toolCall" &&
      activeCalls.get(entry.block.id)?.status === "running",
  );
  const currentActivity = message.currentActivity === true;
  const thinking =
    currentActivity &&
    !state?.idle &&
    !state?.initializing &&
    state?.phase === "thinking" &&
    entries.some((entry) => entry.block.type === "thinking");
  const running =
    !!runningTool ||
    thinking ||
    (currentActivity && !state?.idle && !state?.initializing);
  const last = entries.at(-1)?.block;
  const key = `context:${state?.sessionId}:${message.id}`;
  const animationKey = `progress:${key}`;
  const summary = runningTool
    ? compactToolActivity(
        runningTool.block.name,
        runningTool.block.arguments ??
          activeCalls.get(runningTool.block.id)?.arguments,
      )
    : thinking
      ? "思考中"
      : running
        ? runningActivityText()
        : last?.type === "toolCall"
          ? compactToolActivity(
              last.name,
              last.arguments ?? activeCalls.get(last.id)?.arguments,
            )
          : last?.type === "thinking"
            ? "思考"
            : compactActivityText(last?.text ?? "");
  const lazyIds = [
    ...new Set(
      entries.flatMap((entry) => [
        ...entry.sources
          .filter((source) => source.lazy)
          .map((source) => String(source.id)),
        ...messageRows
          .filter(
            (row) =>
              row.lazy &&
              row.role === "toolResult" &&
              row.toolCallId === entry.block.id,
          )
          .map((row) => String(row.id)),
      ]),
    ),
  ];
  const content = entries
    .map((entry) =>
      entry.block.type === "toolCall"
        ? toolMarkup(entry.block)
        : entry.block.type === "thinking"
          ? `<section class="thinking-detail"><span class="activity-detail-label">思考</span><div class="markdown-body">${renderMarkdown(entry.block.text || "模型未提供可展示的思考文本")}</div></section>`
          : `<div class="muted">${esc(entry.block.text ?? "")}</div>`,
    )
    .join("");
  const status = running
    ? activityProgress(summary, animationKey)
    : (activityAnimationStarts.delete(animationKey), esc(summary));
  return `<details class="thinking-output context-activity" data-running="${running}" ${lazyIds.length ? `data-lazy-messages="${esc(JSON.stringify(lazyIds))}"` : ""} data-disclosure="${esc(key)}" ${disclosures.get(key) ? "open" : ""}><summary>${icon("commands")}<span class="activity-title">${status}</span><span class="activity-chevron" aria-hidden="true">›</span></summary><div class="activity-details" data-scroll-key="${esc(key + ":details")}">${content}</div></details>`;
}
function activityProgress(value, key) {
  const text = Array.from(String(value || "处理中")).slice(0, 48);
  let started = activityAnimationStarts.get(key);
  if (started === undefined) {
    started = performance.now();
    activityAnimationStarts.set(key, started);
  }
  while (activityAnimationStarts.size > 128) {
    const oldest = activityAnimationStarts.keys().next().value;
    if (oldest === key) break;
    activityAnimationStarts.delete(oldest);
  }
  const offset = Math.floor(Math.max(0, performance.now() - started));
  return `<span class="activity-progress" aria-label="${esc(text.join(""))}" data-animation-elapsed="${offset}" style="--activity-offset:-${offset}ms">${text
    .map(
      (char, index) =>
        `<span aria-hidden="true" style="--activity-step:${index}">${esc(char)}</span>`,
    )
    .join("")}</span>`;
}
/* 历史消息只提供退回，当前位置才提供分支入口；实际上下文与分支仍由原生 API 处理。
 * 当前位置意图附带检查点，防止菜单打开后新消息使它悄悄变成历史分叉。 */
/* 消息、会话栏与输入框共用菜单生命周期；工具栏触发器额外拥有锚点与返回焦点。 */
let actionMenu;
let actionMenuTrigger;
function closeActionMenu(restoreFocus = false) {
  const trigger = actionMenuTrigger;
  actionMenu?.remove();
  actionMenu = undefined;
  actionMenuTrigger = undefined;
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}
function openActionMenu({
  x,
  y,
  className = "action-menu",
  dataset = {},
  trigger,
  heading,
  items,
}) {
  closeActionMenu();
  const menu = document.createElement("div");
  menu.className = className;
  menu.setAttribute("role", "menu");
  Object.assign(menu.dataset, dataset);
  if (trigger) menu.id = trigger.getAttribute("aria-controls");
  if (heading) {
    const label = document.createElement("div");
    label.className = "action-menu-heading";
    label.setAttribute("role", "presentation");
    label.textContent = heading;
    menu.setAttribute("aria-label", heading);
    menu.append(label);
  }
  const buttons = [];
  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    if (item.command) button.dataset.command = item.command;
    button.textContent = item.label;
    button.disabled = item.disabled === true;
    if (item.title) button.title = item.title;
    button.addEventListener("click", () => {
      if (button.disabled || !button.isConnected) return;
      closeActionMenu();
      void item.run?.();
    });
    buttons.push(button);
    menu.append(button);
  }
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  if (trigger) {
    const anchor = trigger.getBoundingClientRect();
    x = anchor.left;
    y = anchor.top - box.height - 8;
    trigger.setAttribute("aria-expanded", "true");
  }
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - box.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - box.height - 8))}px`;
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeActionMenu(true);
      return;
    }
    if (event.key === "Tab" && trigger) {
      closeActionMenu(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const index = buttons.indexOf(document.activeElement);
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  });
  actionMenu = menu;
  actionMenuTrigger = trigger;
  (buttons.find((button) => !button.disabled) ?? buttons[0])?.focus();
}
function canOpenComposerTools() {
  const context = readPanelContext();
  return (
    live &&
    readClientPolicy(context).canOpenTaskWorkbench &&
    taskPanel.available
  );
}
function syncComposerTools() {
  const trigger = $("#composer-tools");
  trigger.hidden = !canOpenComposerTools();
  if (trigger.hidden && actionMenuTrigger === trigger) closeActionMenu();
}
function openComposerTools() {
  const trigger = $("#composer-tools");
  if (actionMenuTrigger === trigger) {
    closeActionMenu(true);
    return;
  }
  if (!canOpenComposerTools()) return;
  closeModelControls();
  closeCommands();
  const epoch = actionEpoch;
  openActionMenu({
    trigger,
    heading: "pi-desktop 侧工具",
    items: [
      {
        label: "子代理",
        title: "打开任务与子代理工作台（desk_subagent）",
        run: () => {
          if (epoch !== actionEpoch || !canOpenComposerTools()) return;
          extensionWorkbench.select(taskPanel.key);
          void showView("extensions").catch((error) => toast(error.message));
        },
      },
    ],
  });
}
/* 命令统一带上目标 id 与可选 sessionId：Host 用严格相等校验目标，数字不能是字符串。 */
async function runAgentCommand(command, input, message) {
  if (["fork", "rewind"].includes(command) && !canManageBranches()) return;
  const owner = readPanelContext().sessionId;
  const epoch = actionEpoch;
  try {
    const result = await api(
      "/api/command",
      {
        command,
        id: Number(input.id ?? durableAgentId),
        ...input,
      },
      { selectSession: false },
    );
    if (readPanelContext().sessionId !== owner || epoch !== actionEpoch) return;
    if (openCreatedSession(result)) return result;
    if (result?.sessionId) chooseDurableAgent(result.sessionId);
    else toast(message);
    return result;
  } catch (error) {
    if (readPanelContext().sessionId === owner && epoch === actionEpoch)
      toast(error.message);
    return undefined;
  }
}
function openMessageMenu(x, y, entryId) {
  const sessionId = readPanelContext().sessionId;
  const target = Object.freeze({ id: Number(sessionId), entryId, sessionId });
  const currentEntryId = (state?.messages ?? [])
    .filter((row) => Number.isSafeInteger(row.entryId))
    .at(-1)?.entryId;
  const atCurrent = currentEntryId === entryId;
  openActionMenu({
    x,
    y,
    className: "action-menu message-menu",
    dataset: { entryId: String(entryId) },
    items: [
      {
        command: "rewind",
        label: "退回到此消息",
        disabled: !canManageBranches(),
        run: () =>
          runAgentCommand("rewind", target, "已退回，上下文从该消息之后重建"),
      },
      {
        command: "fork",
        label: "从当前位置创建分支",
        disabled: !canManageBranches() || !atCurrent,
        title: atCurrent
          ? "从当前活跃上下文创建独立分支"
          : "请先退回到该历史位置，再创建分支",
        run: () =>
          runAgentCommand(
            "fork",
            {
              ...target,
              mode: "tail",
              expectedEntryId: currentEntryId,
            },
            "已创建分支",
          ),
      },
    ],
  });
}
/* 「创建分支」按当前上下文分叉，并切到新会话；「退回分支」退回最后一条用户消息。 */
async function createBranch(row) {
  const sessionId = row.dataset.sessionId;
  const result = await runAgentCommand(
    "fork",
    { id: Number(sessionId), mode: "tail", sessionId },
    "已创建分支",
  );
  if (result) await refreshSessions();
}
async function rewindBranch(row) {
  const sessionId = row.dataset.sessionId;
  await runAgentCommand(
    "rewind",
    { id: Number(sessionId), mode: "last-user", sessionId },
    "已退回该会话的最后一条用户消息",
  );
}
/* 「打开分支树」切到扩展工作台并广播要展示的会话；面板在扩展工作台里注册（见 task-4）。 */
async function openBranchTree(row) {
  if (!branchTree.available) return;
  const sessionId = row.dataset.sessionId;
  await showView("extensions");
  window.dispatchEvent(
    new CustomEvent("pi-desktop:branch-tree", { detail: { sessionId } }),
  );
}
function openSessionMenu(row, x, y) {
  const native = row.dataset.native === "true";
  openActionMenu({
    x,
    y,
    className: "action-menu session-menu",
    dataset: { sessionId: row.dataset.sessionId },
    items: [
      {
        command: "fork",
        label: "创建分支",
        disabled: !canManageBranches(),
        run: () => createBranch(row),
      },
      {
        command: "rewind",
        label: "退回分支",
        disabled: !native || !canManageBranches(),
        title: !canManageBranches()
          ? "当前会话不提供分支管理操作"
          : native
            ? "退回该会话的最后一条用户消息"
            : "该会话没有原生 Pi 记录，退回不可用；分叉不受影响",
        run: () => rewindBranch(row),
      },
      ...(branchTree.available
        ? [
            {
              command: "tree",
              label: "打开分支树",
              run: () => openBranchTree(row),
            },
          ]
        : []),
    ],
  });
}
function appendMessage(message, host = $("#messages"), { rail = false } = {}) {
  const assistant = message.role !== "user";
  const automatic =
    message.role === "user" && message.presentation?.source === "automatic";
  const inputLabel = automatic
    ? "扩展自动输入"
    : message.presentation?.source === "user"
      ? "你"
      : "原生输入（来源未记录）";
  const stateCard = message.extensionState === true;
  let article = host.lastElementChild;
  if (
    !assistant ||
    stateCard ||
    message.extensionView ||
    !article?.classList.contains("assistant-turn")
  ) {
    article = document.createElement("article");
    article.className = `message ${automatic ? "automatic-input" : stateCard ? "extension-state" : assistant ? "assistant-turn" : "user-message"}`;
    if (rail) article.classList.add("extension-rail-card");
    if (message.extensionView) article.dataset.extensionCard = "true";
    article.dataset.turn = message.id ?? `turn-${host.children.length}`;
    // 消息动作（退回／分叉）挂在条目 id 上；流式占位消息没有该字段。
    if (Number.isSafeInteger(message.entryId) && !message.commandOnly)
      article.dataset.entryId = String(message.entryId);
    else delete article.dataset.entryId;
    article.innerHTML = `<span class="${assistant ? "agent-avatar" : "avatar"}">${assistant ? piLogo : automatic ? "扩" : message.presentation?.source === "user" ? "你" : "录"}</span><div class="message-body"><div class="message-label">${esc(message.extensionView?.label ?? (message.role === "custom" ? (message.customType ?? "扩展") : assistant ? "Pi" : inputLabel))}</div></div>`;
    host.append(article);
  }
  const body = article.querySelector(".message-body");
  const blocks =
    message.role === "user"
      ? automatic
        ? []
        : [
            {
              type: "text",
              text:
                message.presentation?.source === "user"
                  ? (message.presentation.original ?? message.text ?? "")
                  : (message.text ?? ""),
            },
            ...(message.blocks ?? []).filter((block) => block.type !== "text"),
          ]
      : message.role === "toolResult"
        ? [{ type: "toolCall", id: message.toolCallId, name: message.toolName }]
        : message.blocks?.length
          ? message.blocks
          : [{ type: "text", text: message.text ?? "" }];
  let output;
  for (const block of blocks) {
    const segment = document.createElement("div");
    if (message.id === "streaming") segment.className = "streaming-segment";
    if (block.type === "text") {
      segment.classList.add("markdown-body");
      if (assistant) {
        segment.classList.add("process-entry");
        segment.innerHTML = renderMarkdown(block.text);
      } else {
        // 用户的标签和 Markdown 字符也是原文，不能经渲染器解释后悄悄消失。
        segment.dataset.inputOriginal = "true";
        segment.classList.add("input-original");
        segment.textContent = block.text;
      }
      output = segment;
    } else if (block.type === "activity") {
      const markup = activityMarkup(message, block);
      if (!markup) continue;
      segment.innerHTML = markup;
    } else if (block.type === "extension") {
      segment.classList.add("extension-message");
      segment.innerHTML =
        extensionAdapterRegistry.render(block.view ?? message.extensionView, {
          disclosures,
        }) || renderMarkdown(block.text ?? message.text ?? "");
    } else if (block.type === "toolCall") {
      if (goalPanelTool(block.name)) continue;
      segment.innerHTML = toolMarkup(block);
    } else {
      segment.classList.add("muted");
      segment.textContent = block.text ?? "";
    }
    body.append(segment);
  }
  if (
    automatic ||
    (message.presentation?.source === "user" &&
      typeof message.presentation.original === "string" &&
      message.presentation.original !== message.text)
  ) {
    const key = `input:${runtimePrefix}:${desktopConfiguration?.agent?.generation ?? 0}:${state?.sessionId}:${message.id}`;
    const fold = document.createElement("details");
    fold.className = "input-injection";
    fold.dataset.inputInjection = "true";
    fold.dataset.disclosure = key;
    fold.open = disclosures.get(key) ?? false;
    const title = document.createElement("summary");
    title.textContent = automatic
      ? "扩展自动输入（非用户原文）"
      : "自动展开与附加上下文（模型输入）";
    const content = document.createElement("pre");
    content.dataset.scrollKey = key;
    content.textContent = message.text ?? "";
    fold.append(title, content);
    body.append(fold);
  }
  if (message.error || ["error", "aborted"].includes(message.stopReason)) {
    const failure = document.createElement("div");
    failure.className = "model-request-error";
    failure.setAttribute("role", "alert");
    const label =
      message.stopReason === "aborted" ? "模型请求已中断" : "模型请求失败";
    const detail =
      message.error || "提供商没有返回有效回答。请检查网络与提供商配置后重试。";
    failure.title = `${label}：${detail}`;
    failure.innerHTML = `<span class="model-request-error-label">${esc(label)}</span><span class="model-request-error-detail">${esc(detail)}</span>`;
    body.append(failure);
  }
  return output;
}
function handleLazyDetails(event) {
  const details = event.target;
  if (!details.matches?.("details[data-lazy-messages]") || !details.open)
    return;
  disclosures.set(details.dataset.disclosure, true);
  const ids = JSON.parse(details.dataset.lazyMessages);
  details.removeAttribute("data-lazy-messages");
  void loadMessageDetails(ids).catch((error) => toast(error.message));
}
$("#messages").addEventListener("toggle", handleLazyDetails, true);
// The isolated renderer harness may ship only #messages; the real page has both.
$("#extension-rail-list")?.addEventListener("toggle", handleLazyDetails, true);
let foldStateWrite;
function writeFoldState() {
  try {
    sessionStorage.setItem(
      FOLD_STATE_KEY,
      JSON.stringify({
        disclosures: [...disclosures].slice(-500),
        scroll: [...foldScroll].slice(-MAX_REMEMBERED_FOLD_SCROLL),
        conversation: [...conversationScroll].slice(
          -MAX_PERSISTED_CONVERSATIONS,
        ),
      }),
    );
  } catch {
    /* Sandboxed hosts can block storage; in-memory state still applies. */
  }
}
function saveFoldState(flush = false) {
  if (flush) {
    clearTimeout(foldStateWrite);
    foldStateWrite = undefined;
    writeFoldState();
    return;
  }
  if (foldStateWrite) return;
  foldStateWrite = setTimeout(() => {
    foldStateWrite = undefined;
    writeFoldState();
  }, 150);
}
/* Opening a fold or scrolling its body must reach storage even when no redraw
 * happens before the refresh. Scroll does not bubble, so listen in capture. */
function rememberFoldInteraction(event) {
  const node = event.target;
  if (event.type === "toggle") {
    if (!node.matches?.("[data-disclosure]")) return;
    disclosures.set(node.dataset.disclosure, node.open);
  } else if (node.id === "messages") {
    const sessionId = state?.sessionId;
    if (!sessionId) return;
    conversationScroll.set(sessionId, node.scrollTop);
    while (conversationScroll.size > MAX_PERSISTED_CONVERSATIONS)
      conversationScroll.delete(conversationScroll.keys().next().value);
  } else if (node.dataset?.scrollKey) {
    if (!node.clientHeight) return;
    foldScroll.set(node.dataset.scrollKey, node.scrollTop);
  } else return;
  saveFoldState();
}
for (const root of [$("#messages"), $("#extension-rail-list")]) {
  if (!root) continue;
  root.addEventListener("toggle", rememberFoldInteraction, true);
  root.addEventListener("scroll", rememberFoldInteraction, true);
}
window.addEventListener("pagehide", () => saveFoldState(true));
function rememberDisclosures() {
  for (const root of [$("#messages"), $("#extension-rail-list")])
    for (const details of root?.querySelectorAll("[data-disclosure]") ?? [])
      disclosures.set(details.dataset.disclosure, details.open);
  while (disclosures.size > 500)
    disclosures.delete(disclosures.keys().next().value);
  saveFoldState();
}
/* An expanded fold is read, not just opened: scrolling its long arguments or
 * output must survive the redraw that streaming triggers. Collapsed folds are
 * not measured, so their last visible offset stays available on reopen. */
function rememberFoldScroll() {
  for (const node of document.querySelectorAll("[data-scroll-key]"))
    if (node.clientHeight)
      foldScroll.set(node.dataset.scrollKey, node.scrollTop);
  while (foldScroll.size > MAX_REMEMBERED_FOLD_SCROLL)
    foldScroll.delete(foldScroll.keys().next().value);
  saveFoldState();
}
function restoreFoldScroll() {
  for (const node of document.querySelectorAll("[data-scroll-key]")) {
    const top = foldScroll.get(node.dataset.scrollKey);
    if (top) node.scrollTop = top;
  }
}
/* Extension cards leave the transcript for their own rail (Herta's utility
 * rail), so a conversation is only speech, thinking and tool records. */
const isExtensionCard = (row) =>
  !!row?.extensionState ||
  (row?.role === "custom" && !!row?.extensionView?.disclosureKey);
let conversationSwitching = false;
// 每次选择有独立身份；A→B→A 时，第一次 A 的迟到失败也不能撤掉最新骨架。
let pendingConversation;
async function switchConversation(id) {
  const sessionId = String(id);
  // 父窗口会重放导航意图；相同目标在途或已经就绪时，不重复触发完整投影。
  if (pendingConversation?.sessionId === sessionId) return;
  if (state?.host === "durable") {
    const changed = chooseDurableAgent(sessionId);
    if (!changed && state.sessionId === sessionId) return;
  }
  const selection = { sessionId };
  pendingConversation = selection;
  conversationSwitching = true;
  renderConversationLoading("正在切换会话…");
  try {
    await api("/api/switch-session", {
      id: sessionId,
      ...(state?.host === "durable" ? { sessionId } : {}),
    });
    if (pendingConversation !== selection) return;
    await refresh();
  } catch (error) {
    if (pendingConversation !== selection) return;
    pendingConversation = undefined;
    conversationSwitching = false;
    if (state?.host === "durable") {
      chooseDurableAgent(state.sessionId);
      // 外壳在点击时已改选目标；当前失败要同时恢复内外两侧，不能只重绘旧消息。
      if (runtimePrefix)
        desktopMessage("session-changed", {
          conversationId: Number(state.sessionId),
          initial: false,
        });
    }
    renderMessages(state?.messages ?? []);
    throw error;
  }
}
function renderConversationLoading(label) {
  const node = $("#messages");
  const wrap = document.createElement("div");
  wrap.className = "conversation-loading";
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-live", "polite");
  const caption = document.createElement("span");
  caption.className = "conversation-loading-label";
  caption.textContent = label;
  wrap.append(caption);
  for (let index = 0; index < 4; index++) {
    const row = document.createElement("div");
    row.className = `skeleton-row ${index % 2 ? "is-user" : "is-assistant"}`;
    row.style.setProperty("--skeleton-step", String(index));
    const bubble = document.createElement("div");
    bubble.className = "skeleton-bubble";
    for (const width of index % 2 ? [46] : [82, 94, 58]) {
      const line = document.createElement("span");
      line.style.setProperty("--skeleton-line", `${width}%`);
      bubble.append(line);
    }
    row.append(bubble);
    wrap.append(row);
  }
  node.replaceChildren(wrap);
  node.scrollTop = 0;
}
function animateViewEnter(element) {
  if (!element || matchMedia("(prefers-reduced-motion: reduce)").matches)
    return;
  element.classList.remove("view-enter");
  void element.offsetWidth;
  element.classList.add("view-enter");
  // animationend bubbles: a child's entrance must not end the page transition.
  element.addEventListener("animationend", (event) => {
    if (event.target === element) element.classList.remove("view-enter");
  });
}
function animateConversationEnter(node) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  [...node.children]
    .filter((row) => row.classList.contains("message"))
    .slice(0, 18)
    .forEach((row, index) => {
      row.classList.add("is-switch-enter");
      row.style.setProperty("--switch-step", String(Math.min(index, 9)));
      row.addEventListener("animationend", (event) => {
        if (event.target !== row) return;
        row.classList.remove("is-switch-enter");
        row.style.removeProperty("--switch-step");
      });
    });
}
let railSignature = "";
function goalPanelTool(name) {
  return (
    !!extensionWorkbench && !!extensionAdapterRegistry.panelForTool?.(name)
  );
}
function renderExtensionRail(cards) {
  const rail = $("#extension-rail");
  const list = $("#extension-rail-list");
  // Without a rail (isolated renderer harness) keep the historical inline
  // placement rather than dropping extension records.
  if (!rail || !list) {
    for (const card of cards) appendMessage(card);
    return;
  }
  // Panel-owned records live in the workbench panel, not as rail cards. The
  // isolated renderer harness has no workbench and keeps the legacy placement.
  if (extensionWorkbench)
    cards = cards.filter(
      (card) => !extensionAdapterRegistry.panelForView?.(card.extensionView),
    );
  rail.hidden = !cards.length;
  document.body.classList.toggle("has-extension-rail", !!cards.length);
  const count = $("#extension-rail-count");
  if (count) count.textContent = cards.length ? String(cards.length) : "";
  // Streaming repaints every frame; only rebuild when the projection moved.
  const signature = `${state?.sessionId ?? ""}::${cards
    .map((card) =>
      JSON.stringify([
        card.id,
        card.text?.length ?? 0,
        card.extensionView?.title,
        card.extensionView?.status,
        card.extensionView?.progress?.value,
        (card.extensionView?.items ?? []).map((item) => item.status),
        card.extensionView?.lazyMessageId,
      ]),
    )
    .join("|")}`;
  if (signature === railSignature && !!list.children.length === !!cards.length)
    return;
  railSignature = signature;
  list.replaceChildren();
  for (const card of cards) appendMessage(card, list, { rail: true });
}
/* Keyed reconciliation for the transcript. A full refresh used to rebuild every
 * row (~0.5 ms per row), so a state_changed refresh on a long conversation cost
 * tens of milliseconds. Rows are grouped exactly the way appendMessage merges
 * assistant turns, and a group whose signature did not change keeps its node:
 * its fold state, its scroll offsets and its loaded details stay untouched. */
const renderedGroups = new Map();
let activeCallsVersion = 0;
/* Loaded details arrive out of band; the renderer bumps this so the affected
 * rows are rebuilt even though their projected shape barely changes. */
let detailsVersion = 0;
/* A cheap size fingerprint of the raw rows. The keyed path only trusts its own
 * signatures when nothing else changed; otherwise it rebuilds, because some
 * rendered content (a tool card's result body) is not in the projected row. */
let lastRowsFingerprint = "";
function rowSignature(row) {
  const blocks = row.blocks ?? [];
  return [
    row.role,
    JSON.stringify(row.presentation ?? null),
    row.lazy ? "l" : "",
    row.streaming ? "s" : "",
    row.currentActivity ? "a" : "",
    row.extensionState ? "e" : "",
    row.isError ? "!" : "",
    row.stopReason ?? "",
    row.error ? 1 : 0,
    row.detailRevision ?? "",
    row.lazy || row.detailRevision ? detailsVersion : "",
    (row.text ?? "").length,
    blocks
      .map((block) => {
        // Folded activity blocks keep their content in `entries`, so a
        // fingerprint of the entries is part of the row signature too.
        const entries = (block.entries ?? [])
          .map((entry) => {
            // Folded activity content lives in the entry's sources, so the
            // fingerprint follows their text instead of just their count.
            const sources = (entry.sources ?? [])
              .map(
                (source) =>
                  `${source.id ?? ""}:${source.text?.length ?? 0}:${source.streaming ? 1 : 0}:${source.arguments?.length ?? 0}`,
              )
              .join("*");
            return `${entry.kind ?? ""}/${entry.text?.length ?? 0}/${entry.arguments?.length ?? 0}/${entry.thinking?.length ?? 0}/${sources}/${JSON.stringify(entry).length}`;
          })
          .join(",");
        // A tool card renders the row that carries its result, so that row is
        // part of the fingerprint even though it is not in this group.
        const paired =
          block.type === "toolCall"
            ? messageRows.find(
                (row) =>
                  row.role === "toolResult" && row.toolCallId === block.id,
              )
            : undefined;
        const result = paired
          ? `${paired.lazy ? "L" : ""}/${(paired.text ?? "").length}/${paired.isError ? 1 : 0}`
          : block.result
            ? `${block.result.text?.length ?? 0}/${block.result.isError ? 1 : 0}/${block.result.lazy ? "L" : ""}`
            : "";
        return `${block.type}:${block.text?.length ?? 0}:${block.arguments?.length ?? 0}:${block.id ?? ""}:${block.name ?? ""}:${entries}:${result}:${block.lazy ? "L" : ""}`;
      })
      .join("|"),
    blocks.some((block) => block.type === "activity") ? activeCallsVersion : "",
  ].join("~");
}
function groupRows(rows) {
  const groups = [];
  for (const row of rows) {
    const assistant = row.role !== "user";
    const standalone = row.extensionState === true || !!row.extensionView;
    const merges =
      assistant && !standalone && groups.length && groups.at(-1).assistant;
    if (merges) groups.at(-1).rows.push(row);
    else groups.push({ key: "", signature: "", assistant, rows: [row] });
  }
  return groups.map((group) => ({
    ...group,
    key: `row:${group.rows[0].id}:${group.rows.length}`,
    signature: group.rows.map(rowSignature).join("~"),
  }));
}
function renderGroup(group) {
  const holder = document.createElement("div");
  for (const row of group.rows) appendMessage(row, holder);
  if (holder.children.length !== 1) return undefined;
  const node = holder.firstElementChild;
  node.dataset.rowKey = group.key;
  return node;
}
function rowsFingerprint() {
  let size = messageRows.length;
  for (const row of messageRows)
    size += (row.text?.length ?? 0) + JSON.stringify(row.blocks ?? []).length;
  return String(size);
}
function applyKeyedRows(items) {
  const node = $("#messages");
  const groups = groupRows(items);
  const fingerprint = rowsFingerprint();
  const mismatch =
    groups.some(
      (group) => renderedGroups.get(group.key)?.signature !== group.signature,
    ) === false && fingerprint !== lastRowsFingerprint;
  lastRowsFingerprint = fingerprint;
  if (mismatch) return false;
  const keys = new Set(groups.map((group) => group.key));
  for (const [key, entry] of [...renderedGroups])
    if (!keys.has(key) || !node.contains(entry.node)) {
      entry.node.remove();
      renderedGroups.delete(key);
    }
  let index = 0;
  for (const group of groups) {
    let entry = renderedGroups.get(group.key);
    if (entry && entry.signature !== group.signature) {
      entry.node.remove();
      renderedGroups.delete(group.key);
      entry = undefined;
    }
    if (!entry) {
      const created = renderGroup(group);
      if (!created) return false;
      entry = { node: created, signature: group.signature };
      renderedGroups.set(group.key, entry);
    }
    const current = node.children[index];
    if (current !== entry.node) node.insertBefore(entry.node, current ?? null);
    if (group.rows.some((row) => row.id === "streaming"))
      streaming = entry.node;
    index++;
  }
  for (let extra = node.children.length - 1; extra >= index; extra--)
    node.children[extra].remove();
  return true;
}
function renderMessages(rows, { liveOnly = false, enter = false } = {}) {
  // 旧详情回执和已排队的动画帧仍可能到达；切换期间不扫描历史，也不重建骨架。
  if (pendingConversation) return;
  const node = $("#messages");
  messageRows = rows ?? [];
  extensionWorkbench?.update(messageRows, readPanelContext());
  if (!messageRows.length && (state?.initializing || conversationSwitching)) {
    renderConversationLoading(
      conversationSwitching ? "正在切换会话…" : "正在载入会话…",
    );
    return;
  }
  const wasSwitching = conversationSwitching;
  conversationSwitching = false;
  const nearBottom =
    node.scrollHeight - node.scrollTop - node.clientHeight < 100;
  const previous = node.scrollTop;
  rememberDisclosures();
  rememberFoldScroll();
  streaming = null;
  /* A keyed refresh patches the transcript in place; it must not clear the
   * DOM first or every group would rebuild. */
  const keyedEligible =
    !liveOnly && !enter && !wasSwitching && !state?.initializing;
  if (liveOnly) {
    // Streaming changes only the current assistant turn. Rebuild that turn so
    // merged thinking/activity groups cannot duplicate or lose persisted parts.
    renderedGroups.clear();
    $(".empty-conversation")?.remove();
    for (const card of node.querySelectorAll(":scope > [data-extension-card]"))
      card.remove();
    if (node.lastElementChild?.classList.contains("assistant-turn"))
      node.lastElementChild.remove();
  } else if (!keyedEligible) {
    renderedGroups.clear();
    node.replaceChildren();
  }
  if (
    !messageRows.length &&
    !state?.streamingMessage &&
    !state?.streamingText &&
    state?.idle !== false
  ) {
    renderedGroups.clear();
    node.innerHTML = `<div class="empty-conversation"><span class="pi-mark">${piLogo}</span><h1>今天，想一起做些什么？</h1><p>写代码、理清思路，或继续上次的工作。</p><div class="empty-actions"><button class="outline-button" data-view="providers">配置模型</button><button class="outline-button" data-view="plugins">管理扩展</button></div></div>`;
  }
  const streamingMessage =
    state?.streamingMessage ??
    (state?.streamingText
      ? { id: "streaming", role: "assistant", text: state.streamingText }
      : state &&
          !state.idle &&
          !state.initializing &&
          state.phase === "thinking"
        ? {
            id: "streaming",
            role: "assistant",
            blocks: [{ type: "thinking", text: "" }],
          }
        : undefined);
  const fullTimeline = projectConversationTimeline(messageRows, {
    streamingMessage,
    activeCalls: [...activeCalls.values()],
    sessionId: state?.sessionId,
  });
  // Project state cards from the whole loaded branch, including earlier turns.
  // A streaming redraw still replaces only the current turn and its state cards.
  const timeline = liveOnly
    ? fullTimeline.slice(
        fullTimeline.findLastIndex((row) => row.role === "user") + 1,
      )
    : fullTimeline;
  const lastUserIndex = messageRows.findLastIndex((row) => row.role === "user");
  const currentTurnIds = new Set(
    messageRows.slice(lastUserIndex + 1).map((row) => String(row.id)),
  );
  const lastTimelineItem = timeline.findLast((row) => !isExtensionCard(row));
  const lastItemIsCurrentActivity = lastTimelineItem?.blocks?.some(
    (item) =>
      item.type === "activity" &&
      item.entries.some((entry) =>
        entry.sources.some(
          (source) => source.streaming || currentTurnIds.has(String(source.id)),
        ),
      ),
  );
  if (lastItemIsCurrentActivity) lastTimelineItem.currentActivity = true;
  renderExtensionRail(timeline.filter(isExtensionCard));
  const items = timeline.filter((message) => !isExtensionCard(message));
  const hasStreamingRow = items.some((row) => row.id === "streaming");
  const hasActivityRow = items.some((row) =>
    row.blocks?.some((block) => block.type === "activity"),
  );
  if (
    state &&
    !state.idle &&
    !state.initializing &&
    !hasStreamingRow &&
    !hasActivityRow
  ) {
    // Waiting and empty provider chunks use the same folded presentation as
    // actual thinking/tools; never append a second, standalone status label.
    items.push({
      id: "activity:pending",
      role: "assistant",
      currentActivity: true,
      blocks: [{ type: "activity", entries: [] }],
    });
  }
  if (keyedEligible && items.length && applyKeyedRows(items)) {
    // Nodes were reused; `streaming` was assigned for the streaming group.
  } else {
    renderedGroups.clear();
    lastRowsFingerprint = rowsFingerprint();
    if (!liveOnly && items.length) node.replaceChildren();
    for (const message of items) {
      const output = appendMessage(message);
      if (message.id === "streaming" && output) streaming = output;
    }
  }
  if (enter) animateConversationEnter(node);
  restoreFoldScroll();
  const sessionId = state?.sessionId;
  const savedTop =
    sessionId && !restoredScrollSessions.has(sessionId)
      ? conversationScroll.get(sessionId)
      : undefined;
  if (sessionId && messageRows.length) restoredScrollSessions.add(sessionId);
  node.scrollTop =
    savedTop != null ? savedTop : nearBottom ? node.scrollHeight : previous;
}
let liveFrame;
function renderLiveConversation() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = undefined;
    renderMessages(messageRows, { liveOnly: true });
  });
}
let desktopSessionSignature = "";
function renderSessions() {
  const current = state?.sessionId;
  if (runtimePrefix && state?.host === "durable") {
    const signature = JSON.stringify([
      current,
      sessions.map(({ id, name }) => [id, name]),
    ]);
    if (signature !== desktopSessionSignature) {
      const initial = desktopSessionSignature === "";
      desktopSessionSignature = signature;
      desktopMessage("session-changed", {
        conversationId: Number(current),
        initial,
      });
    }
  }
  $("#sessions").innerHTML = sessions.length
    ? sessions
        .map(
          (row) =>
            `<button class="session ${row.id === current ? "active" : ""}" data-session-id="${esc(row.id)}" data-native="${row.native === true}"><span>${esc(row.name)}</span><small>${row.running ? "运行中 · " : row.waiting ? "等待交互 · " : row.initializing ? "初始化 · " : ""}${row.cwd ? esc(row.cwd) : `${row.messageCount ?? 0} 条消息`} ${row.modified ? "· " + esc(new Date(row.modified).toLocaleDateString()) : ""}</small></button>`,
        )
        .join("")
    : '<div class="empty">新会话会保存在 pi 会话目录</div>';
}
async function openDurableAgent(edit = false) {
  const target = state?.sessionId;
  const descriptor = await api("/api/agent");
  const active = edit ? descriptor.active : undefined;
  const selection = (name, values, checked) =>
    `<fieldset><legend>${name === "tools" ? "工具" : "Durable 扩展"}</legend><div class="agent-options">${values.map((value) => `<label><input type="checkbox" name="${name}" value="${esc(value)}" ${checked.includes(value) ? "checked" : ""}>${esc(value)}</label>`).join("")}</div></fieldset>`;
  const choices = descriptor.models.map((model) => ({
    provider: model.provider,
    modelId: model.modelId,
    name: model.name,
  }));
  if (
    active?.model &&
    !choices.some(
      (row) =>
        row.provider === active.model.provider &&
        row.modelId === active.model.modelId,
    )
  )
    choices.push({ ...active.model, name: active.model.modelId });
  const content = `<div class="agent-config-form">
    <label>名称<input name="agentName" value="${esc(active?.name ?? "")}" placeholder="新会话"></label>
    <label>项目目录<div class="agent-directory"><input name="agentCwd" required value="${esc(active?.cwd ?? state.cwd)}"><button type="button" id="agent-pick-directory" ${window.piDesk?.pickDirectory ? "" : "hidden"}>选择文件夹</button></div></label>
    <label>模型<select name="agentModel"><option value="">${active?.model ? "保持当前模型" : descriptor.active?.model ? "继承当前模型" : "稍后配置模型"}</option>${choices.map((row) => `<option value="${esc(JSON.stringify({ provider: row.provider, modelId: row.modelId }))}" ${active?.model?.provider === row.provider && active?.model?.modelId === row.modelId ? "selected" : ""}>${esc(row.provider)} / ${esc(row.name)}</option>`).join("")}</select></label>
    <label>额外指令<textarea name="agentInstructions" rows="3">${esc(active?.instructions ?? "")}</textarea></label>
    <label>Shell 路径<input name="agentShell" value="${esc(active?.shellPath ?? "")}" placeholder="使用系统默认 Shell"></label>
    <label>工具环境变量<textarea name="agentEnv" rows="3" placeholder='{"NAME":"value"}'></textarea><small>${active?.environmentKeys.length ? "已配置 " + esc(active.environmentKeys.join(", ")) + "；留空保留，填写 JSON 替换。" : "留空使用宿主环境。"}</small></label>
    ${selection("tools", descriptor.tools, active?.tools ?? descriptor.active?.tools ?? descriptor.tools)}
    ${selection("extensions", descriptor.extensions, active?.extensions ?? descriptor.extensions.filter((name) => !name.startsWith("desk-native:")))}
  </div>`;
  openDialog(
    edit ? "配置 Agent" : "新建 Agent",
    content,
    async () => {
      const form = new FormData($("#dialog-form"));
      const input = {
        command: edit ? "configure" : "create",
        sessionId: target,
        name: form.get("agentName"),
        cwd: form.get("agentCwd"),
        instructions: form.get("agentInstructions"),
        shellPath: form.get("agentShell"),
        tools: form.getAll("tools"),
        extensions: form.getAll("extensions"),
      };
      if (active) {
        input.id = active.id;
        input.revision = active.revision;
      }
      if (form.get("agentModel"))
        input.model = JSON.parse(form.get("agentModel"));
      if (form.get("agentEnv").trim())
        input.shellEnv = JSON.parse(form.get("agentEnv"));
      const result = await api("/api/command", input);
      if (!edit) chooseDurableAgent(result.id);
      await refresh();
    },
    edit ? "保存配置" : "创建 Agent",
  );
  $("#agent-pick-directory")?.addEventListener("click", async () => {
    const field = $("#dialog-form").elements.agentCwd;
    try {
      const path = await window.piDesk.pickDirectory();
      if (path && field.isConnected) field.value = path;
    } catch (error) {
      toast(error.message);
    }
  });
}

async function refreshSessions() {
  if (live) sessions = (await api("/api/sessions")).rows;
  renderSessions();
}
const sessionInventories = createSessionInventories({
  load: (kind, owner, { signal }) =>
    api(
      `/api/${kind === "modelChoices" ? "providers?view=picker&" : `${kind}?`}sessionId=${encodeURIComponent(owner ?? "")}`,
      undefined,
      { signal },
    ),
  onError(kind, error) {
    if (
      kind === "modelChoices" ||
      view === kind ||
      (kind === "plugins" && view === "marketplace")
    )
      toast(`清单加载失败：${error.message}`);
  },
  apply(kind, value, owner) {
    if (
      owner !== state?.sessionId ||
      (state?.host === "durable" && owner !== durableAgentId)
    )
      return;
    if (kind === "plugins") packageSettings.applyInventory(value);
    else providerSettings.applyInventory(kind, value);
  },
});
const sessionConnection = createSessionConnection({
  readSnapshot: ({ signal }) => api("/api/state", undefined, { signal }),
  applySnapshot: (snapshot) => refreshOnce(snapshot),
  onEvent: applyRecord,
  isOnline: () => navigator.onLine !== false,
  onStatus(status) {
    connected = status === "connected";
    $("#connection-status").dataset.state = status;
    $("#connection-status").textContent =
      {
        connected: "Pi 已连接",
        reconnecting: "重连中",
        offline: "网络离线",
        unauthorized: "授权已失效，请重新扫码",
      }[status] ?? "连接 Pi…";
    syncComposerButton();
    syncChatViews();
    gitPane.update();
  },
  openStream({ epoch, after }, handlers) {
    return openSessionStream(
      runtimePath(
        `/api/events?after=${after}&epoch=${encodeURIComponent(epoch)}`,
      ),
      handlers,
    );
  },
});
/* 会话栏的「打开分支树」：选中内置页，并把目标会话交给面板。 */
window.addEventListener("pi-desktop:branch-tree", (event) => {
  if (!readClientPolicy(readPanelContext()).canReadBranches) return;
  if (event.detail?.sessionId) branchTree.setSession(event.detail.sessionId);
  extensionWorkbench?.update(messageRows, readPanelContext());
  if (!extensionWorkbench?.select(branchTree.key))
    toast("分支树面板不可用，请刷新页面后重试");
  void branchTree.refresh();
});

const refresh = () => sessionConnection.refresh();
let usageReturn;
function closeUsageDetails(restore = false) {
  $("#usage-details").hidden = true;
  for (const node of document.querySelectorAll("[data-usage-details]"))
    node.setAttribute("aria-expanded", "false");
  if (restore) usageReturn?.focus();
}
for (const node of document.querySelectorAll("[data-usage-details]"))
  node.addEventListener("click", () => {
    const open = $("#usage-details").hidden;
    closeUsageDetails();
    if (open) {
      usageReturn = node;
      $("#usage-details").hidden = false;
      node.setAttribute("aria-expanded", "true");
      $("#usage-details").focus();
    }
  });
$("#usage-close").onclick = () => closeUsageDetails(true);
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#usage-details, [data-usage-details]"))
    closeUsageDetails();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#usage-details").hidden) {
    event.preventDefault();
    closeUsageDetails(true);
  }
});
function renderUsageDetails(metrics) {
  const usage = state.usage;
  $("#usage-context-note").textContent =
    usage?.tokens == null
      ? "上下文用量待模型响应后确认。"
      : `${usage.estimated ? "估算上下文" : "上下文"}：${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} Token (${usage.percent.toFixed(1)}%)`;
  const list = $("#usage-breakdown");
  list.replaceChildren();
  for (const [label, count] of [
    ["累计 Token", metrics.total],
    ["未缓存输入", metrics.input],
    ["输出", metrics.output],
    ["缓存读取", metrics.cacheRead],
    ["缓存写入", metrics.cacheWrite],
  ]) {
    const term = document.createElement("dt");
    term.textContent = label;
    const value = document.createElement("dd");
    value.textContent = count == null ? "—" : count.toLocaleString();
    list.append(term, value);
  }
}
async function refreshOnce(snapshot) {
  if (
    snapshot.host === "durable" &&
    durableAgentId &&
    snapshot.sessionId !== durableAgentId
  )
    return;
  // 元数据和旧目标快照不能更改加载态，也不能抢先替换当前会话身份。
  if (pendingConversation) {
    if (
      snapshot.sessionId !== pendingConversation.sessionId ||
      !Array.isArray(snapshot.messages)
    )
      return;
    pendingConversation = undefined;
    conversationSwitching = false;
  }
  if (snapshot.host === "durable" && !durableAgentId) {
    durableAgentId = snapshot.sessionId;
    sessionStorage.setItem(selectionKey, durableAgentId);
  }
  if (state?.sessionId !== snapshot.sessionId) {
    historyOwner = snapshot.sessionId ?? "";
    historyIndex = -1;
    historyDraft = "";
    nativeHistoryLimit = 50;
    if (sessionDrafts.read().owner !== snapshot.sessionId)
      $("#prompt").value = sessionDrafts.select(
        snapshot.sessionId,
        $("#prompt").value,
      ).text;
    resetInteraction();
    closeCommands();
    syncComposerButton();
  }
  const enteringReadOnly =
    !state?.capabilities?.readOnly && snapshot.capabilities?.readOnly;
  const panelPolicyChanged =
    state?.sessionCommands !== snapshot.sessionCommands ||
    ["sessionTree", "tasks", "readOnly", "remote"].some(
      (key) => state?.capabilities?.[key] !== snapshot.capabilities?.[key],
    );
  const enteringSession = state?.sessionId !== snapshot.sessionId;
  if (panelPolicyChanged || enteringSession) {
    actionEpoch++;
    closeActionMenu();
  }
  state = snapshot;
  syncChatViews();
  document.body.classList.toggle(
    "remote-client",
    state?.capabilities?.remote === true,
  );
  state.messages = snapshot.messages?.map(
    (row) => messageDetails.get(messageDetailKey(row))?.value ?? row,
  );
  workspacePanel?.update();
  renderComposerContext();
  if (runtimePrefix && !desktopReady) {
    desktopReady = true;
    desktopMessage("ready");
  }
  const nativeHistory = !!state.capabilities?.nativeHistory;
  $("#composer").hidden = nativeHistory;
  $("#native-history-toolbar").hidden = !nativeHistory && !state.historyMore;
  $("#native-history-label").hidden = !nativeHistory;
  $("#native-history-label").textContent = state.archivePending
    ? "归档待完成 · SQLite 记录"
    : state.archived
      ? "已归档 · SQLite 记录"
      : "Pi 会话记录 · 同步查看";
  $("#native-history-older").hidden = !state.historyMore;
  $("#native-history-resume").hidden =
    !nativeHistory ||
    !!state.archived ||
    !!state.archivePending ||
    !runtimePrefix;
  document.body.classList.toggle(
    "projectless",
    !!state.capabilities?.readOnly && !nativeHistory,
  );
  if (enteringReadOnly) {
    document.body.classList.add("right-collapsed");
    syncRightSidebar();
  }
  composerAttachments.render();
  extensionAdapterRegistry.setSession(state?.sessionId);
  selected = state.model;
  $("#session-title").textContent = state.name;
  $("#selected-model").textContent = selected?.name ?? "选择模型";
  composerModelPicker.update();
  // 定点重启后，待恢复任务在就绪状态旁显式标出；恢复完毕即消失。
  const recoveryNote =
    (state.recovery?.outstanding ?? 0) > 0
      ? ` · 已从检查点恢复 ${state.recovery.outstanding} 项`
      : "";
  $("#run-status").innerHTML =
    `<span class="dot"></span>${esc(state.initializing ? "加载扩展…" : state.operation || state.workingMessage || (state.capabilities?.nativeHistory ? "会话记录" : state.idle ? "就绪" : "运行中"))}${esc(recoveryNote)}`;
  $("#context-usage").textContent =
    state.usage?.tokens == null
      ? "上下文 —"
      : `上下文 ${state.usage.estimated ? "≈" : ""}${Math.round(state.usage.percent ?? 0)}%`;
  $("#context-detail").textContent =
    state.usage?.tokens == null
      ? "—"
      : `${formatTokens(state.usage.tokens)} / ${formatTokens(state.usage.contextWindow)}`;
  $("#context-usage").title =
    state.usage?.tokens == null
      ? "暂无上下文用量"
      : `上下文 ${state.usage.tokens} / ${state.usage.contextWindow} Token`;
  $("#extension-status").textContent = (state.statuses ?? []).join(" · ");
  $("#cost-usage").textContent = state.stats?.cost
    ? `$${state.stats.cost.toFixed(3)}`
    : "";
  if (Array.isArray(state.commands))
    commands = normalizeCommands(state.commands);
  else if (commandListKey !== commandKey()) commands = [];
  resourceSettings.update();
  $("#workspace-name").textContent =
    state.capabilities?.readOnly && !nativeHistory
      ? "无项目对话"
      : state.cwd.split(/[\\/]/).pop() || state.cwd;
  $("#workspace-path").textContent =
    state.capabilities?.readOnly && !nativeHistory
      ? "只读 · 允许文件读取、网页搜索与网页读取"
      : state.cwd;
  $("#runtime-label").textContent =
    `Pi ${state.version} · ${state.host === "durable" ? "Durable " + state.frameworkVersion : state.host === "tui" ? "TUI 共享后端" : state.host === "headless" ? "独立 Web 后端" : state.capabilities?.nativeHistory ? "原生会话记录" : "扩展"}`;
  $("#agent-config-button").hidden = state.host !== "durable";
  $("#agent-config-button").disabled = !state.idle;
  $("#settings-version").textContent = `Pi ${state.version}`;
  activeCalls = new Map(
    (state.activeCalls ?? []).map((call) => [call.id, call]),
  );
  const metrics = state.metrics ?? {
    total: state.stats?.tokens?.total,
    cost: state.stats?.cost,
  };
  $("#token-total").textContent =
    `Token ${metrics.total == null ? "—" : formatTokens(metrics.total)}`;
  $("#token-cost").textContent =
    metrics.cost == null ? "$—" : `$${metrics.cost.toFixed(4)}`;
  $("#cache-hit").textContent =
    `缓存 ${metrics.cacheHitRate == null ? "—" : (metrics.cacheHitRate * 100).toFixed(1) + "%"}`;
  renderUsageDetails(metrics);
  $("#git-branch").textContent =
    `⑂ ${state.git ? state.git.branch + (state.git.detached ? " · detached" : "") : "查看改动"}`;
  $("#git-branch").title = state.git?.branch ?? "当前工作区没有 Git 分支";
  $("#thinking-level").value = state.thinkingLevel ?? "medium";
  const deferredConfiguration = !!state.configurationPending;
  $("#selected-model").title = deferredConfiguration
    ? "已选择；当前任务结束后应用"
    : (state.model?.name ?? "选择模型");
  $("#analysis-control").title = deferredConfiguration
    ? "模型或思考强度将在当前任务结束后应用"
    : "选择模型和思考强度";
  renderThinkingPicker();
  gitPane.update();
  $("#stop-button").hidden = state.idle;
  $("#prompt").disabled = !!state.capabilities?.nativeHistory;
  syncComposerButton();
  renderMessages(state.messages, { enter: enteringSession });
  if (chatViewsAreActive())
    void sessionInventories.refresh(snapshot, {
      kinds:
        view === "providers"
          ? ["providers"]
          : ["plugins", "marketplace"].includes(view)
            ? ["plugins"]
            : [],
    });
  syncChatViews();
  if (snapshot.host === "durable") {
    sessions = snapshot.agents.map((agent) => ({
      ...agent,
      id: String(agent.id),
      running: !agent.idle,
    }));
    renderSessions();
    // 两个内置面板只做节流读取；不在这里直接拉取（见各自的刷新实现）。
    void branchTree.refresh();
    void taskPanel.refresh();
  } else void refreshSessions().catch((error) => toast(error.message));
}
function applyRecord(record) {
  if (record.kind === "browser_changed") {
    workspacePanel?.browserChanged();
    return;
  }
  if (record.kind === "remote_changed") {
    if (view === "remote")
    return;
  }
  // 切换未就绪时，state 仍属于旧会话；仅保留不修改会话内容的通知与包进度。
  if (
    pendingConversation &&
    record.kind !== "notification" &&
    record.kind !== "package_progress"
  )
    return;
  const sessionId =
    pendingConversation?.sessionId ??
    (state?.host === "durable"
      ? durableAgentId || state.sessionId
      : state?.sessionId);
  if (record.data?.sessionId && record.data.sessionId !== sessionId) return;
  if (record.kind === "interaction_changed") {
    void pollInteractions();
  } else if (record.kind === "assistant_update") {
    state.streamingMessage = record.data.message;
    state.streamingText = record.data.message.text;
    state.phase = record.data.phase.startsWith("thinking")
      ? "thinking"
      : "output";
    renderLiveConversation();
  } else if (record.kind === "tool_update") {
    activeCalls.set(record.data.id, record.data);
    activeCallsVersion++;
    state.operation =
      record.data.status === "running" ? `执行 ${record.data.name}…` : "";
    renderMessages(messageRows);
  } else if (record.kind === "text_delta") {
    const node = $("#messages");
    const nearBottom =
      node.scrollHeight - node.scrollTop - node.clientHeight < 100;
    $(".empty-conversation")?.remove();
    streaming ??= appendMessage({ role: "assistant", text: "" });
    streaming.textContent += record.data.delta;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  } else if (record.kind === "tool_start")
    $("#run-status").innerHTML =
      `<span class="dot"></span>执行 ${esc(record.data.name)}…`;
  else if (record.kind === "tool_end")
    $("#run-status").innerHTML =
      `<span class="dot"></span>${record.data.isError ? "工具执行失败" : "运行中"}`;
  else if (record.kind === "notification") toast(record.data.message);
  else if (record.kind === "package_progress")
    toast(`${record.data.action} · ${record.data.source}`);
  else if (record.kind === "editor_text") {
    $("#prompt").value = record.data.text;
    mirrorComposer();
    syncComposerButton();
    updateCommands();
  }
}
$("#messages")?.addEventListener("contextmenu", (event) => {
  const row = event.target.closest("[data-entry-id]");
  if (!row || !durableAgentId) return;
  event.preventDefault();
  openMessageMenu(event.clientX, event.clientY, Number(row.dataset.entryId));
});
$("#sessions")?.addEventListener("contextmenu", (event) => {
  const row = event.target.closest("[data-session-id]");
  if (!row || !live) return;
  event.preventDefault();
  openSessionMenu(row, event.clientX, event.clientY);
});
/* 键盘也能打开会话菜单：行获得焦点后按菜单键或 Shift+F10。 */
$("#sessions")?.addEventListener("keydown", (event) => {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
    return;
  const row = event.target.closest("[data-session-id]");
  if (!row || !live) return;
  event.preventDefault();
  const box = row.getBoundingClientRect();
  openSessionMenu(row, box.left + 12, box.bottom - 4);
});
document.addEventListener("pointerdown", (event) => {
  if (
    !event.target.closest(".action-menu") &&
    !actionMenuTrigger?.contains(event.target)
  )
    closeActionMenu();
});
window.addEventListener("resize", () => closeActionMenu());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeActionMenu();
});
document.addEventListener("visibilitychange", () => {
  syncChatViews();
  if (!live) return;
  if (document.hidden || !hostFocused) sessionConnection.pause();
  else sessionConnection.resume();
});
window.addEventListener("offline", () => {
  if (live) {
    sessionConnection.pause();
    connected = false;
    syncChatViews();
    $("#connection-status").dataset.state = "offline";
    $("#connection-status").textContent = "网络离线";
    syncComposerButton();
  }
});
window.addEventListener("online", () => {
  if (live && hostFocused) sessionConnection.resume();
});
window.addEventListener("pagehide", (event) => {
  chatPageActive = false;
  clearInterval(interactionTimer);
  syncChatViews();
  if (!event.persisted) {
    preferencesSettings.dispose();
    providerSettings.dispose();
    packageSettings.dispose();
    resourceSettings.dispose();
    composerAttachments.dispose();
    chatDialog.dispose();
    sessionInventories.dispose();
  }
  branchTree.setActive(false);
  taskPanel.setActive(false);
  if (live) sessionConnection.pause();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  chatPageActive = true;
  if (live) interactionTimer = setInterval(() => pollInteractions(), 1200);
  syncChatViews();
  branchTree.setActive(true);
  taskPanel.setActive(true);
  extensionWorkbench?.update(messageRows, readPanelContext());
  void branchTree.refresh();
  void taskPanel.refresh();
  if (live && hostFocused) sessionConnection.resume();
});
window.addEventListener("focus", () => {
  if (live && hostFocused && !document.hidden) sessionConnection.check();
});
navigator.connection?.addEventListener("change", () => {
  if (live && hostFocused && !document.hidden)
    void sessionConnection.reconnect();
});
function updateViewport() {
  const viewport = window.visualViewport;
  const height =
    viewport && viewport.scale === 1 ? viewport.height : innerHeight;
  document.documentElement.style.setProperty(
    "--viewport-height",
    `${Math.round(height)}px`,
  );
  if (!$("#thinking-menu").hidden) positionThinkingMenu();
}
window.visualViewport?.addEventListener("resize", updateViewport);
window.addEventListener("resize", updateViewport);
updateViewport();
function safeLink(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
}
const interactionHead = $("#interaction-dialog .dialog-head");
function resetInteraction() {
  if ($("#interaction-dialog").open) $("#interaction-dialog").close();
  $("#ask-user").hidden = true;
  $("#composer").hidden = !!state?.capabilities?.nativeHistory;
  $("#interaction-dialog").append(interactionHead, $("#interaction-form"));
  $("#interaction-form").dataset.promptId = "";
  $("#interaction-form").reset();
  $("#interaction-submit").disabled = false;
  activeInteraction = null;
  interactionSignature = "";
  syncComposerButton();
}
function placeInteraction(inline) {
  $("#ask-user").hidden = !inline;
  $("#composer").hidden = inline;
  if (inline) closeCommands();
  syncComposerButton();
  if (inline) {
    if ($("#interaction-dialog").open) $("#interaction-dialog").close();
    $("#ask-user").append(interactionHead, $("#interaction-form"));
  } else
    $("#interaction-dialog").append(interactionHead, $("#interaction-form"));
}
function askMarkup(prompt) {
  const questions = prompt.questions ?? [prompt.ask];
  return questions
    .map((question, index) => {
      if (question.mode === "custom")
        return field(
          question.question + " · Custom option",
          "value",
          "",
          "text",
          'autocomplete="off"',
        );
      const multiple = question.mode === "multi" || question.multiSelect;
      const options = question.options
        .map(
          (option, optionIndex) =>
            `<label class="ask-option"><input type="${multiple ? "checkbox" : "radio"}" name="pick-${index}" value="${optionIndex}"><span><strong>${esc(option.label)}</strong><small>${esc(option.description)}</small>${option.preview ? `<details><summary>预览选项</summary><div class="markdown-body">${renderMarkdown(option.preview)}</div></details>` : ""}</span></label>`,
        )
        .join("");
      const custom = `<label class="ask-option"><input type="${multiple ? "checkbox" : "radio"}" name="pick-${index}" value="custom"><span>Custom option${prompt.type === "questionnaire" || multiple ? `<input name="custom-${index}" type="text" placeholder="输入自定义答案" autocomplete="off">` : ""}</span></label>`;
      return `<fieldset class="ask-question"><legend>${esc(question.header)} · ${esc(question.question)}</legend>${options}${custom}</fieldset>`;
    })
    .join("");
}
function interactionValue(prompt, form) {
  if (prompt.type !== "questionnaire" && !prompt.ask) return form.get("value");
  if (prompt.ask?.mode === "custom") return form.get("value");
  const questions = prompt.questions ?? [prompt.ask];
  const choices = questions.map((_question, index) => {
    const values = form.getAll(`pick-${index}`);
    if (values.includes("custom"))
      return {
        selected: [],
        custom: String(form.get(`custom-${index}`) ?? ""),
      };
    return { selected: values.map(Number) };
  });
  if (prompt.type === "questionnaire") return JSON.stringify(choices);
  if (prompt.ask.mode === "multi") {
    if (choices[0].custom !== undefined) {
      if (/^[\d,\s.]+$/.test(choices[0].custom))
        throw new Error(
          "原生 RPC 多选问卷将纯数字解析为选项；请在自定义答案中加文字说明",
        );
      return choices[0].custom;
    }
    return choices[0].selected.map((index) => index + 1).join(",");
  }
  const selected = form.get("pick-0");
  if (selected === null) throw new Error("请选择一个选项或 Custom option");
  return prompt.options[
    selected === "custom" ? prompt.ask.options.length : Number(selected)
  ].id;
}
$("#interaction-form").addEventListener("change", (event) => {
  const input = event.target;
  if (
    input.type !== "checkbox" ||
    !input.name.startsWith("pick-") ||
    !input.checked
  )
    return;
  for (const sibling of event.currentTarget.elements) {
    if (
      sibling.name === input.name &&
      sibling !== input &&
      (input.value === "custom" || sibling.value === "custom")
    )
      sibling.checked = false;
  }
});
let interactionPoll, interactionTimer;
/* Polling asks for a cheap revision first. A host that cannot answer cheaply
 * reports unsupported and the page keeps its previous behaviour; every third
 * tick still refreshes so a missed bit can only delay, never lose, an update. */
let revisionSupported,
  interactionRevision,
  resourceRevision,
  pollTick = 0;
async function revisionChanged(kind) {
  pollTick++;
  if (revisionSupported === false) return true;
  try {
    const value = await api("/api/revision");
    if (!value?.supported) {
      revisionSupported = false;
      return true;
    }
    revisionSupported = true;
    const bit = value[kind];
    if (bit === undefined) return true;
    const previous =
      kind === "interactions" ? interactionRevision : resourceRevision;
    if (kind === "interactions") interactionRevision = bit;
    else resourceRevision = bit;
    return previous !== bit || pollTick % 3 === 0;
  } catch {
    return true;
  }
}
function pollInteractions() {
  if (!live || !connected || !hostFocused || document.hidden || !chatPageActive)
    return;
  interactionPoll ??= (async () => {
    try {
      if (!(await revisionChanged("interactions"))) return;
      await refreshInteractions();
    } catch (error) {
      // A failed fetch must not be hidden behind an unchanged revision.
      interactionRevision = undefined;
      throw error;
    } finally {
      interactionPoll = undefined;
    }
  })();
  return interactionPoll;
}
async function refreshInteractions() {
  const sessionId = state?.sessionId;
  try {
    const result = await api("/api/interactions");
    if (sessionId !== state?.sessionId) return;
    const job =
      result.rows.find((row) => row.status === "running") ??
      result.rows.find((row) => row.id === activeInteraction?.id);
    if (!job) {
      resetInteraction();
      return;
    }
    activeInteraction = job;
    const signature = JSON.stringify({
      id: job.id,
      prompt: job.prompt?.id,
      status: job.status,
      events: job.events,
    });
    if (signature === interactionSignature) return;
    const changedPrompt =
      job.prompt?.id !== $("#interaction-form").dataset.promptId;
    interactionSignature = signature;
    const inline = job.prompt?.type === "questionnaire" || !!job.prompt?.ask;
    placeInteraction(inline);
    $("#interaction-title").textContent = job.label;
    const events = job.events
      .map((event) =>
        event.type === "auth_url"
          ? `<p><a href="${esc(safeLink(event.url))}" target="_blank" rel="noopener noreferrer">在浏览器中继续登录 ↗</a></p><p class="muted">${esc(event.instructions ?? "")}</p>`
          : event.type === "device_code"
            ? `<p>验证码：<strong>${esc(event.userCode)}</strong></p><a href="${esc(safeLink(event.verificationUri))}" target="_blank" rel="noopener noreferrer">打开验证页面 ↗</a>`
            : `<p class="muted">${esc(event.message ?? "")}</p>`,
      )
      .join("");
    if (job.status !== "running") {
      resetInteraction();
      toast(
        job.status === "complete"
          ? "认证或交互已完成"
          : (job.error ?? "操作已取消"),
      );
      if (job.label.startsWith("MCP ") && events)
        openDialog(
          job.label,
          `<div class="mcp-report">${events}</div>`,
          () => {},
          "关闭",
        );
      await api("/api/interaction-reply", { id: job.id, dismiss: true });
      activeInteraction = null;
      await refresh();
      return;
    }
    if (changedPrompt) {
      $("#interaction-body").innerHTML =
        events +
        (job.prompt
          ? inline
            ? askMarkup(job.prompt)
            : job.prompt.type === "select"
              ? `<label class="field-label">${esc(job.prompt.message)}<select name="value">${job.prompt.options.map((option) => `<option value="${esc(option.id)}">${esc(option.label)}</option>`).join("")}</select></label>`
              : field(
                  job.prompt.message,
                  "value",
                  "",
                  job.prompt.type === "secret" ? "password" : "text",
                  `placeholder="${esc(job.prompt.placeholder ?? "")}" autocomplete="off"`,
                )
          : "<p>等待 Pi 响应…</p>");
      $("#interaction-form").dataset.promptId = job.prompt?.id ?? "";
      $("#interaction-submit").hidden = !job.prompt;
      if (!inline && !$("#interaction-dialog").open)
        $("#interaction-dialog").showModal();
    }
  } catch (error) {
    if (activeInteraction) toast(error.message);
  }
}
$("#interaction-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $("#interaction-submit").disabled = true;
  try {
    await api("/api/interaction-reply", {
      id: activeInteraction.id,
      promptId: activeInteraction.prompt.id,
      value: interactionValue(activeInteraction.prompt, new FormData(form)),
      sessionId: state?.sessionId,
    });
    form.reset();
    await pollInteractions();
    $("#interaction-submit").disabled = false;
  } catch (error) {
    $("#interaction-submit").disabled = false;
    toast(error.message);
  }
});
$("#interaction-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelInteraction();
});
async function cancelInteraction() {
  if (activeInteraction)
    await api("/api/interaction-reply", {
      id: activeInteraction.id,
      promptId: activeInteraction.prompt?.id,
      cancel: true,
    });
  resetInteraction();
}
const THINKING_MENU_GUTTER = 12;
const thinkingLabels = {
  off: "关闭思考",
  minimal: "极少思考",
  low: "低",
  medium: "中等思考",
  high: "高",
  xhigh: "更高",
  max: "最大",
};
const composerModelPicker = createComposerModelPicker({
  trigger: $("#analysis-control"),
  getData: () => ({
    model: selected,
    providers: providerSettings.pickerModels,
    thinkingLevel: state?.thinkingLevel ?? $("#thinking-level").value,
    effortLabel:
      thinkingLabels[state?.thinkingLevel ?? $("#thinking-level").value] ?? "",
    levels: (state?.thinkingLevels ?? Object.keys(thinkingLabels)).map(
      (value) => ({ value, label: thinkingLabels[value] ?? value }),
    ),
    editable: !live || !!state?.idle || !!state?.canDeferConfiguration,
    thinkingEditable:
      state?.thinkingEditable ??
      state?.canDeferConfiguration ??
      state?.idle ??
      !live,
  }),
  selectModel: selectComposerModel,
  selectThinking: async (level) => {
    const result = await api("/api/thinking", {
      level,
      sessionId: state?.sessionId,
    });
    await refresh();
    if (result.deferred) toast("思考强度将在当前任务结束后应用");
  },
  loadModels: () =>
    sessionInventories.refresh(state, { kinds: ["modelChoices"] }),
  reload: () =>
    sessionInventories.refresh(state, { force: true, kinds: ["modelChoices"] }),
  onError: (error) => toast(error.message),
});
function renderThinkingPicker() {
  const button = $("#thinking-level");
  const levels = state?.thinkingLevels ?? Object.keys(thinkingLabels);
  const editable =
    state?.thinkingEditable ??
    state?.canDeferConfiguration ??
    state?.idle ??
    !live;
  button.textContent = `${thinkingLabels[button.value ?? "medium"]} ⌄`;
  button.disabled = !editable || levels.length < 2;
  button.title =
    levels.length < 2
      ? "当前模型没有可切换的思考等级"
      : editable
        ? state?.configurationPending
          ? "已排队；当前任务结束后应用"
          : state?.idle
            ? "调整会话思考等级；不会改变已发出的请求"
            : "调整会话思考等级；当前任务结束后应用"
        : state?.thinkingEditable === undefined && !state?.idle
          ? "旧宿主不支持运行中调整；请等任务结束后更新宿主"
          : "宿主正在初始化或执行配置操作，请稍后重试";
  if (button.disabled) closeThinking();
  $("#thinking-menu").innerHTML = levels
    .map(
      (level) =>
        `<button type="button" role="menuitemradio" aria-checked="${level === button.value}" data-thinking="${level}"><span>${thinkingLabels[level]}</span><span>${level === button.value ? "✓" : ""}</span></button>`,
    )
    .join("");
}
function positionThinkingMenu() {
  const menu = $("#thinking-menu");
  menu.style.left = "0px";
  const overflow =
    menu.getBoundingClientRect().right - (innerWidth - THINKING_MENU_GUTTER);
  if (overflow > 0) menu.style.left = `-${Math.ceil(overflow)}px`;
}
function closeThinking() {
  $("#thinking-menu").hidden = true;
  $("#thinking-level").setAttribute("aria-expanded", "false");
}
$("#thinking-level").value = "medium";
renderThinkingPicker();
$("#thinking-level").addEventListener("click", () => {
  const opening = $("#thinking-menu").hidden;
  renderThinkingPicker();
  $("#thinking-menu").hidden = !opening;
  $("#thinking-level").setAttribute("aria-expanded", String(opening));
  if (opening) {
    positionThinkingMenu();
    (
      $('#thinking-menu [aria-checked="true"]') ?? $("#thinking-menu button")
    )?.focus();
  }
});
$("#thinking-menu").addEventListener("keydown", (event) => {
  const buttons = [...$("#thinking-menu").querySelectorAll("button")];
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeThinking();
    $("#thinking-level").focus();
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    buttons[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
    ]?.focus();
  } else if (event.key === "Tab") closeThinking();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".thinking-picker")) closeThinking();
});
// A link in a message must not navigate this iframe (framed sites often render
// as a blank page). Route it to the workspace browser panel, or a real external
// tab when the right-hand browser is unavailable.
document.addEventListener(
  "click",
  (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const href = link.getAttribute("href") ?? "";
    if (!/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    event.stopPropagation();
    if (workspacePanel?.openWeb && !state?.capabilities?.browserRemoteDisabled)
      void workspacePanel.openWeb(href);
    else window.open(href, "_blank", "noopener,noreferrer");
  },
  true,
);
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (
    !button.dataset.view &&
    !button.dataset.go &&
    [
      preferencesSettings,
      providerSettings,
      resourceSettings,
      packageSettings,
    ].some((module) => module.handleClick(button))
  )
    return;
  try {
    if (button.dataset.thinking) {
      if (live) {
        await api("/api/thinking", { level: button.dataset.thinking });
        await refresh();
      } else {
        $("#thinking-level").value = button.dataset.thinking;
        renderThinkingPicker();
      }
      closeThinking();
      $("#thinking-level").focus();
      return;
    }
    if (button.dataset.commandIndex !== undefined) {
      await acceptCommand(Number(button.dataset.commandIndex), true);
      return;
    }
    if (button.dataset.view || button.dataset.go) {
      if ($("#dialog").open) chatDialog.close();
      await showView(button.dataset.view || button.dataset.go);
      return;
    }
    if (button.dataset.sessionId) {
      chatDialog.close();
      if (live) {
        // 先同步更换草稿／面板身份，再导航；不能让 await 把新输入记进旧会话。
        const switching = switchConversation(button.dataset.sessionId);
        await showView("workspace");
        await switching;
      } else {
        await showView("workspace");
        conversationSwitching = true;
        renderConversationLoading("正在切换会话…");
        const chosen = button.dataset.sessionId;
        window.setTimeout(() => {
          $("#session-title").textContent =
            sessions.find((row) => row.id === chosen)?.name ?? "会话";
          renderMessages(demoMessages);
        }, 260);
      }
      return;
    }
    if (button.dataset.preview !== undefined) {
      event.preventDefault();
      let message = messageRows[Number(button.dataset.preview)];
      if (message?.lazy) {
        const id = message.id;
        await loadMessageDetails([String(id)]);
        message = messageRows.find((row) => row.id === id);
      }
      if (message) {
        $("#preview-title").textContent = message.toolName ?? "工具输出";
        $("#preview-content").textContent = message.text;
        revealRight("tools");
      }
      return;
    }
    switch (button.dataset.action) {
      case "sidebar":
        if (runtimePrefix && state?.capabilities?.remote !== true) {
          desktopMessage("toggle-sidebar");
          break;
        }
        if (matchMedia("(max-width:760px)").matches) {
          document.body.classList.toggle("sidebar-open");
          $(".drawer-backdrop").hidden =
            !document.body.classList.contains("sidebar-open");
        } else document.body.classList.toggle("sidebar-collapsed");
        break;
      case "close-dialog":
        chatDialog.close();
        $("#dialog-form").reset();
        break;
      case "close-preview":
      case "close-right-view":
        revealRight(null);
        break;
      case "hide-right-sidebar":
        setRightSidebar(false);
        break;
      case "workspace-tools":
        setRightSidebar($("#workspace-right").inert);
        break;
      case "cancel-interaction":
        await cancelInteraction();
        break;
      case "new-session":
        if (state?.host === "durable" && state?.capabilities?.remote === true) {
          await api("/api/new-session", {});
          await refresh();
          await showView("workspace");
          $("#prompt").focus();
          break;
        }
        if (state?.host === "durable") {
          await openDurableAgent();
          break;
        }
        if (live) {
          await api("/api/new-session", {});
          await refresh();
        } else {
          $("#session-title").textContent = "新会话";
          renderMessages([]);
        }
        await showView("workspace");
        $("#prompt").focus();
        break;
      case "agent-config":
        await openDurableAgent(true);
        break;
      case "git-review":
        await gitPane.open();
        break;
      case "git-commit":
        await gitPane.open("", "commit");
        break;
      case "refresh-sessions":
        await refreshSessions();
        break;
      case "workspace-info":
        openDialog(
          "当前工作空间",
          `<p>${esc(state?.cwd ?? "设计演示工作空间")}</p><div class="dialog-note">新会话、工具执行和项目配置都使用此工作目录。启动时可用 pi web --cwd 指定项目。</div>`,
          () => {},
          "关闭",
        );
        break;
      case "reload":
        if (live) {
          await api("/api/reload", {});
          await refresh();
        }
        preferencesSettings.reloaded();
        packageSettings.reloaded();
        toast("已重载");
        break;
      case "composer-tools":
        openComposerTools();
        break;
      case "model":
        composerModelPicker.open();
        break;
      case "stop":
        if (live) await api("/api/abort", {});
        else toast("任务已停止 · 演示");
        break;
    }
  } catch (error) {
    toast(error.message);
  }
});
let commandLoad, commandListKey;
const commandKey = () => `${chatViewIdentity()}:${state?.commandsRevision}`;
const normalizeCommands = (rows) =>
  rows.map((row) =>
    row.name === "sessions"
      ? { ...row, source: "builtin", action: "sessions" }
      : row,
  );
async function loadCommands() {
  if (!live || !state || Array.isArray(state.commands)) return;
  const key = commandKey();
  if (commandListKey === key) return;
  if (commandLoad?.key === key) return commandLoad.task;
  const job = { key };
  commandLoad = job;
  job.task = api("/api/commands")
    .then((value) => {
      if (commandKey() !== key) return;
      commands = normalizeCommands(value.rows);
      commandListKey = key;
      resourceSettings.update();
    })
    .finally(() => {
      if (commandLoad === job) commandLoad = undefined;
    });
  return job.task;
}
function closeCommands() {
  $("#command-menu").hidden = true;
  $("#prompt").setAttribute("aria-expanded", "false");
  $("#prompt").removeAttribute("aria-activedescendant");
}
function syncComposerButton() {
  syncComposerTools();
  $("#send-button").disabled =
    composerAttachments.choosing ||
    !readClientPolicy(readPanelContext()).canCompose ||
    (live && (!state || !connected)) ||
    !$("#ask-user").hidden ||
    composerAttachments.rows().some((file) => file.status !== "ready") ||
    (!$("#prompt").value.trim() && !composerAttachments.rows().length);
}
function formatTokens(value) {
  return value >= 1000
    ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
    : String(value ?? 0);
}
/**
 * 把输入框正文镜像给宿主，供扩展的同步 `getEditorText()` 读取。
 * SDK 的 `getEditorText()` 没有异步形态，所以只能由渲染进程主动推送；这里做节流，
 * 并跳过与上次相同的值。失败不提示用户——镜像是辅助能力，不该打扰输入。
 */
let composerMirrorTimer;
let composerMirrorSent = "";
function mirrorComposer() {
  clearTimeout(composerMirrorTimer);
  composerMirrorTimer = setTimeout(() => {
    const text = $("#prompt").value;
    if (text === composerMirrorSent) return;
    composerMirrorSent = text;
    api("/api/composer", { text }, { selectSession: false }).catch(() => {
      // 镜像失效时允许下一次输入重试。
      composerMirrorSent = "";
    });
  }, 220);
}

function updateCommands() {
  const prompt = $("#prompt"),
    token = prompt.value.match(/^\/([^\s]*)$/);
  if (
    !token ||
    view !== "workspace" ||
    prompt.disabled ||
    commandDismissed === prompt.value
  ) {
    closeCommands();
    return;
  }
  if (
    live &&
    !Array.isArray(state?.commands) &&
    commandListKey !== commandKey()
  ) {
    $("#command-menu").hidden = false;
    $("#command-options").textContent = "加载命令…";
    void loadCommands()
      .then(updateCommands)
      .catch((error) => {
        closeCommands();
        toast(error.message);
      });
    return;
  }
  const query = token[1].toLowerCase();
  commandMatches = commands
    .filter((row) => {
      return `${row.name} ${row.label} ${row.description}`
        .toLowerCase()
        .includes(query);
    })
    .slice(0, 100);
  commandIndex = Math.min(commandIndex, Math.max(0, commandMatches.length - 1));
  $("#command-menu").hidden = false;
  prompt.setAttribute("aria-expanded", "true");
  renderCommandOptions();
}
function renderCommandOptions() {
  let lastGroup = "";
  $("#command-options").innerHTML =
    commandMatches
      .map((row, index) => {
        const group =
          {
            builtin: "Pi 命令",
            extension: "扩展命令",
            skill: "技能",
            prompt: "提示模板",
          }[row.source] || "命令";
        const heading =
          group === lastGroup
            ? ""
            : `<div class="command-group">${group}</div>`;
        lastGroup = group;
        return `${heading}<button type="button" role="option" id="command-${index}" aria-selected="${index === commandIndex}" data-command-index="${index}" class="command-option ${index === commandIndex ? "active" : ""}"><span class="command-name">/${esc(row.name)}</span><span class="command-description">${esc(row.description)}</span><span class="command-kind">${esc(row.label)}</span></button>`;
      })
      .join("") ||
    `<div class="empty">${live && !state?.commands ? "后台需更新：停止后重新运行 pi web，以加载命令与技能接口。" : "没有匹配的命令或技能"}</div>`;
  if (commandMatches.length) {
    $("#prompt").setAttribute(
      "aria-activedescendant",
      `command-${commandIndex}`,
    );
    $(`#command-${commandIndex}`)?.scrollIntoView({ block: "nearest" });
  }
}
async function acceptCommand(index, execute) {
  const row = commandMatches[index];
  if (!row) return;
  closeCommands();
  commandDismissed = "";
  $("#prompt").value = `/${row.name} `;
  $("#prompt").focus();
  syncComposerButton();
  if (execute && row.source === "builtin") {
    $("#prompt").value = "";
    syncComposerButton();
    await executeWebCommand(row, "");
  }
}
async function executeWebCommand(row, args) {
  if (row.action === "git") {
    await openGit(args);
    return;
  }
  if (row.name === "login") {
    await showView("providers");
    openProviderCatalog();
    return;
  }
  if (["general", "providers", "skills", "mcp"].includes(row.action)) {
    await showView(row.action);
    return;
  }
  if (row.action === "model") {
    composerModelPicker.open();
    return;
  }
  if (row.action === "new-session") {
    $('[data-action="new-session"]').click();
    return;
  }
  if (row.action === "sessions") {
    if (row.name === "sessions" && args && args !== "list") {
      if (!live) {
        toast("演示模式不执行会话管理操作");
        return;
      }
      if (!state?.sessionCommands)
        throw new Error("当前服务尚未加载新版会话命令，请等任务结束后更新宿主");
      const result = await api("/api/prompt", { message: `/sessions ${args}` });
      if (result.sessionCommand?.text)
        openDialog(
          "会话管理帮助",
          `<pre>${esc(result.sessionCommand.text)}</pre>`,
          () => {},
          "关闭",
        );
      await refresh();
      return;
    }
    await refreshSessions();
    openDialog(
      "管理 pi 会话（切换不停止后台任务）",
      sessions
        .map(
          (item) =>
            `<button type="button" class="session-picker-row" data-session-id="${esc(item.id)}">${esc(item.name)}<small>${item.messageCount ?? 0} 条消息 · ${item.running ? "运行中" : item.waiting ? "等待交互" : item.live ? "空闲" : "历史"} · ${esc(item.id.slice(0, SESSION_ID_DISPLAY_LENGTH))}</small></button>`,
        )
        .join("") || "<p>此工作空间暂无历史会话</p>",
      () => {},
      "关闭",
    );
    return;
  }
  if (row.action === "session-info") {
    const stats = state?.stats;
    openDialog(
      "Pi 会话信息",
      `<div class="session-info"><p>模型：${esc(selected ? `${selected.provider} / ${selected.id}` : "尚未选择")}</p><p>上下文：${esc($("#context-usage").textContent || "暂无用量")}</p><p>消息：${stats?.totalMessages ?? messageRows.length} · 工具调用：${stats?.toolCalls ?? 0}</p><p>累计 Token：${stats?.tokens?.total ?? 0} · 费用：$${Number(stats?.cost ?? 0).toFixed(4)}</p><p class="muted">${esc(stats?.sessionFile ?? "演示会话")}</p></div>`,
      () => {},
      "关闭",
    );
    return;
  }
  if (row.action === "copy") {
    const text = messageRows.findLast(
      (item) => item.role === "assistant",
    )?.text;
    if (!text) {
      toast("暂无助手回复");
      return;
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        toast("已复制最后回复");
        return;
      } catch {}
    }
    // Plain LAN HTTP does not expose the secure-context Clipboard API.
    openDialog(
      "复制助手回复",
      `<p class="muted">长按或选择下面的文字进行复制。</p><textarea class="copy-response" readonly aria-label="助手回复原文">${esc(text)}</textarea>`,
      () => {},
      "关闭",
    );
    $(".copy-response").select();
    return;
  }
  if (row.action === "help") {
    openDialog(
      "Pi Web 命令",
      `<div class="command-help">${commands.map((item) => `<div><code>/${esc(item.name)}</code><span>${esc(item.description)}</span></div>`).join("")}</div><p class="dialog-note">Enter 换行 · Ctrl / ⌘ Enter 发送 · Ctrl / ⌘ N 新建会话 · / 打开命令菜单</p>`,
      () => {},
      "关闭",
    );
    return;
  }
  if (row.name === "name" && !args) {
    openDialog(
      "命名会话",
      field(
        "会话名称",
        "name",
        state?.name || "",
        "text",
        "required maxlength=200",
      ),
      async (form) => {
        if (live)
          await api("/api/prompt", { message: `/name ${form.get("name")}` });
        else $("#session-title").textContent = form.get("name");
      },
    );
    return;
  }
  if (live)
    await api("/api/prompt", {
      message: `/${row.name}${args ? ` ${args}` : ""}`,
    });
  else toast(`${row.label} · 演示，实际运行请使用 pi web`);
}
function completeSubmission(submission) {
  sessionDrafts.edit($("#prompt").value);
  const current = sessionDrafts.complete(submission);
  if (
    current.owner === submission.owner &&
    $("#prompt").value === submission.text
  )
    $("#prompt").value = current.text;
  composerAttachments.render();
}
function composerHistory(owner) {
  const persisted = messageRows
    .filter(
      (row) =>
        row.role === "user" &&
        row.presentation?.source !== "automatic" &&
        typeof row.text === "string",
    )
    .map((row) =>
      row.presentation?.source === "user"
        ? (row.presentation.original ?? row.text)
        : row.text,
    );
  const pending = sentHistory.get(owner) ?? [];
  let overlap = Math.min(persisted.length, pending.length);
  while (
    overlap > 0 &&
    persisted.slice(-overlap).some((text, index) => text !== pending[index])
  )
    overlap--;
  return [...persisted, ...pending.slice(overlap)];
}
function rememberComposerMessage(owner, message) {
  if (!message) return;
  const rows = sentHistory.get(owner) ?? [];
  rows.push(message);
  if (rows.length > 50) rows.splice(0, rows.length - 50);
  sentHistory.set(owner, rows);
  if (sentHistory.size > 100)
    sentHistory.delete(sentHistory.keys().next().value);
  if (owner === (state?.sessionId ?? "preview")) {
    historyIndex = -1;
    historyDraft = "";
  }
}
function showComposerHistory(value) {
  const prompt = $("#prompt");
  prompt.value = value;
  prompt.setSelectionRange(value.length, value.length);
  composerAttachments.resize();
  syncComposerButton();
  updateCommands();
}
function renderBtwManager(rows = []) {
  btwThread = null;
  $("#btw-title").textContent = "侧问答";
  $("#btw-back").hidden = true;
  $("#btw-new").hidden = false;
  $("#btw-composer").hidden = true;
  $("#btw-content").innerHTML = rows.length
    ? `<div class="btw-list">${rows.map((row) => `<button type="button" class="btw-list-row" data-btw-open="${esc(row.id)}"><span><strong>${esc(row.title)}</strong><small>${row.questionCount} 个问题 · ${esc(row.model)}</small></span><span aria-hidden="true">›</span></button>`).join("")}</div>`
    : '<div class="btw-empty">还没有侧问答。新建一个问题，Pi 会参考当前会话，但不会把问答写进主会话。</div>';
}
function renderBtwThread(thread, { error = "", thinking = false } = {}) {
  btwThread = thread;
  $("#btw-title").textContent = thread.title || "新侧问答";
  $("#btw-back").hidden = false;
  $("#btw-new").hidden = false;
  $("#btw-composer").hidden = false;
  $("#btw-model-label").textContent =
    `${thread.model || "Pi 当前模型"} · ${thread.thinkingLevel || "off"}`;
  const turns = thread.turns
    .map(
      (turn, index) =>
        `<article class="btw-turn btw-turn-question"><p class="btw-turn-label">你问</p><div class="btw-turn-card">${esc(turn.question)}</div></article><article class="btw-turn"><p class="btw-turn-label">Pi BTW</p><div class="btw-turn-card">${esc(turn.answer)}</div><button type="button" class="outline-button btw-bring" data-btw-bring="${index}">带回主输入框</button></article>`,
    )
    .join("");
  $("#btw-content").innerHTML =
    `${turns || '<div class="btw-empty">这个侧线程还没有问题。</div>'}${thinking ? '<div class="btw-turn"><div class="btw-turn-card btw-thinking">正在思考…</div></div>' : ""}${error ? `<div class="btw-turn"><p class="btw-turn-label">请求失败</p><div class="btw-turn-card" style="color:var(--danger)">${esc(error)}</div></div>` : ""}`;
  $("#btw-content").scrollTop = $("#btw-content").scrollHeight;
}
async function openBtw(question = "") {
  const dialog = $("#btw-dialog");
  if (!dialog.open) dialog.showModal();
  $("#btw-content").innerHTML = '<div class="btw-empty">正在打开侧问答…</div>';
  if (!question) {
    const result = await api("/api/btw", { action: "list" });
    renderBtwManager(result.rows);
    return;
  }
  const { thread } = await api("/api/btw", { action: "open" });
  renderBtwThread(thread);
  void submitBtwQuestion(question);
}
async function openBtwThread(id) {
  const { thread } = await api("/api/btw", { action: "open", threadId: id });
  renderBtwThread(thread);
  $("#btw-question").focus();
}
async function submitBtwQuestion(value) {
  const question = String(value ?? "").trim();
  if (!question || !btwThread || btwBusy) return;
  btwBusy = true;
  $("#btw-send").disabled = true;
  $("#btw-cancel").hidden = false;
  $("#btw-question").value = "";
  renderBtwThread(btwThread, { thinking: true });
  try {
    const result = await api("/api/btw", {
      action: "ask",
      threadId: btwThread.id,
      question,
    });
    if (result.thread) btwThread = result.thread;
    renderBtwThread(btwThread, { error: result.error ?? "" });
    if (result.error) $("#btw-question").value = question;
  } catch (error) {
    renderBtwThread(btwThread, { error: error.message });
    $("#btw-question").value = question;
  } finally {
    btwBusy = false;
    $("#btw-send").disabled = false;
    $("#btw-cancel").hidden = true;
    if (!$("#btw-dialog").open) return;
    $("#btw-question").focus();
  }
}
$("#btw-content").addEventListener("click", (event) => {
  const bring = event.target.closest("[data-btw-bring]");
  if (bring && btwThread) {
    const answer = btwThread.turns[Number(bring.dataset.btwBring)]?.answer;
    if (answer) {
      const prompt = $("#prompt");
      prompt.value = prompt.value.trim()
        ? `${prompt.value.trim()}\n\n${answer}`
        : answer;
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      $("#btw-dialog").close();
      prompt.focus();
    }
    return;
  }
  const button = event.target.closest("[data-btw-open]");
  if (button)
    openBtwThread(button.dataset.btwOpen).catch((error) =>
      toast(error.message),
    );
});
$("#btw-new").addEventListener("click", async () => {
  try {
    const { thread } = await api("/api/btw", { action: "open" });
    renderBtwThread(thread);
    $("#btw-question").focus();
  } catch (error) {
    toast(error.message);
  }
});
$("#btw-back").addEventListener("click", () =>
  openBtw().catch((error) => toast(error.message)),
);
$("#btw-close").addEventListener("click", () => $("#btw-dialog").close());
$("#btw-dialog").addEventListener("close", () => {
  btwThread = null;
  btwBusy = false;
});
$("#btw-composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void submitBtwQuestion($("#btw-question").value);
});
$("#btw-cancel").addEventListener("click", async () => {
  if (!btwThread || !btwBusy) return;
  try {
    await api("/api/btw", { action: "cancel", threadId: btwThread.id });
  } catch (error) {
    toast(error.message);
  }
});
$("#btw-question").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $("#btw-composer").requestSubmit();
  }
});
$("#prompt").addEventListener("input", () => {
  historyIndex = -1;
  historyDraft = "";
  sessionDrafts.edit($("#prompt").value);
  mirrorComposer();
  composerAttachments.resize();
  syncComposerButton();
  commandIndex = 0;
  commandDismissed = "";
  updateCommands();
});
$("#prompt").addEventListener("focus", updateCommands);
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#composer")) closeCommands();
});
$("#native-history-older").addEventListener("click", async () => {
  nativeHistoryLimit = Math.min(10000, nativeHistoryLimit + 300);
  $("#native-history-older").disabled = true;
  try {
    await refreshOnce(await api("/api/state"));
  } catch (error) {
    toast(error.message);
  } finally {
    $("#native-history-older").disabled = false;
  }
});
$("#native-history-resume").addEventListener("click", () =>
  desktopMessage("resume"),
);
$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (composerAttachments.choosing) {
    toast("请先完成文件选择");
    return;
  }
  if (!readClientPolicy(readPanelContext()).canCompose) {
    if (!state?.capabilities?.nativeHistory)
      toast("请等待 Agent 切换完成；草稿已保留");
    return;
  }
  if (live && !connected) {
    toast("连接恢复后再发送；草稿和附件已保留");
    return;
  }
  const submission = sessionDrafts.capture({
    text: $("#prompt").value,
    mode: $("#send-mode").value,
    durable: live && state?.host === "durable",
  });
  const { message, files } = submission;
  if (!message && !files.length) return;
  if (files.some((file) => file.status !== "ready")) {
    toast("请等待附件读取完成，或移除失败的附件");
    return;
  }
  if (files.length && message.startsWith("/")) {
    toast("附件只能随普通消息提交；请先执行命令");
    return;
  }
  if (files.length && live && !state?.capabilities?.attachments) {
    toast("当前服务尚未支持附件；请等任务结束后更新宿主");
    return;
  }
  try {
    closeCommands();
    const match = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (match) await loadCommands();
    const command = match && commands.find((row) => row.name === match[1]);
    if (command?.name === "btw" && command.source === "extension") {
      if (!state.capabilities?.btw)
        throw new Error(
          "当前 Desktop 后端尚未加载 pi-btw 适配，请更新并重启 Pi Desktop 后重试",
        );
      await openBtw(match[2]?.trim() || "");
      completeSubmission(submission);
      return;
    }
    if (command?.source === "builtin") {
      await executeWebCommand(command, match[2]?.trim() || "");
      completeSubmission(submission);
      return;
    }
    if (match && !command)
      throw new Error("未知命令；输入 / 查看 pi 当前可用的命令与技能");
    if (live) {
      await api("/api/prompt", {
        message,
        ...(submission.text === message ? {} : { original: submission.text }),
        mode: submission.mode,
        sessionId: submission.owner,
        ...(submission.retry ? { requestId: submission.retry.requestId } : {}),
        ...(files.length
          ? {
              attachments: files.map((file) =>
                file.kind === "reference"
                  ? { kind: "reference", name: file.name, path: file.path }
                  : { name: file.name, type: file.type, data: file.data },
              ),
            }
          : {}),
      });
      rememberComposerMessage(submission.owner, submission.text);
    } else {
      messageRows.push({ role: "user", text: message });
      rememberComposerMessage(submission.owner, message);
      renderMessages(messageRows);
      setTimeout(() => {
        messageRows.push({
          role: "assistant",
          text: "这是界面演示。通过 pi web 启动后，消息会由真实 pi 会话处理。",
        });
        renderMessages(messageRows);
      }, 800);
    }
    completeSubmission(submission);
  } catch (error) {
    toast(error.message);
  }
});
$("#prompt").addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (
    event.key === "Enter" &&
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey
  ) {
    event.preventDefault();
    $("#composer").requestSubmit();
    return;
  }
  if (!$("#command-menu").hidden) {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      commandIndex =
        (commandIndex +
          (event.key === "ArrowDown" ? 1 : -1) +
          commandMatches.length) %
        Math.max(1, commandMatches.length);
      renderCommandOptions();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      commandDismissed = $("#prompt").value;
      closeCommands();
      return;
    }
    if (
      ["Enter", "Tab"].includes(event.key) &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      commandMatches.length
    ) {
      event.preventDefault();
      acceptCommand(commandIndex, false).catch((error) => toast(error.message));
      return;
    }
  }
  if (["ArrowUp", "ArrowDown"].includes(event.key)) {
    const prompt = event.currentTarget;
    const owner = state?.sessionId ?? "preview";
    if (historyOwner !== owner) {
      historyOwner = owner;
      historyIndex = -1;
      historyDraft = "";
    }
    const atBoundary =
      event.key === "ArrowUp"
        ? !prompt.value.slice(0, prompt.selectionStart).includes("\n")
        : !prompt.value.slice(prompt.selectionEnd).includes("\n");
    if (event.key === "ArrowUp" && historyIndex >= 0) {
      const rows = composerHistory(owner);
      event.preventDefault();
      historyIndex = Math.max(0, historyIndex - 1);
      showComposerHistory(rows[historyIndex]);
      return;
    }
    if (event.key === "ArrowDown" && historyIndex >= 0) {
      const rows = composerHistory(owner);
      event.preventDefault();
      if (historyIndex >= rows.length - 1) {
        historyIndex = -1;
        showComposerHistory(historyDraft);
      } else showComposerHistory(rows[++historyIndex]);
      return;
    }
    if (event.key === "ArrowUp" && atBoundary) {
      const rows = composerHistory(owner);
      if (rows.length) {
        event.preventDefault();
        if (historyIndex < 0) {
          historyDraft = prompt.value;
          historyIndex = rows.length - 1;
        } else historyIndex = Math.max(0, historyIndex - 1);
        showComposerHistory(rows[historyIndex]);
      }
    }
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (event.key === "0" || event.code === "Digit0") {
      event.preventDefault();
      localStorage.setItem("pi-web-font-size", "14");
      preferencesSettings.applyAppearance();
      return;
    }
    if (event.key === "=" || event.key === "+" || event.code === "Equal") {
      event.preventDefault();
      preferencesSettings.adjustFontSize(1);
      return;
    }
    if (event.key === "-" || event.key === "_" || event.code === "Minus") {
      event.preventDefault();
      preferencesSettings.adjustFontSize(-1);
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "n") {
    event.preventDefault();
    $('[data-action="new-session"]').click();
  }
  if (event.key === "Escape" && !$("#ask-user").hidden) {
    event.preventDefault();
    void cancelInteraction().catch((error) => toast(error.message));
    return;
  }
  if (
    event.key === "Escape" &&
    !$("#dialog").open &&
    !$("#interaction-dialog").open
  ) {
    if (
      $("#workspace-right").classList.contains("expanded") ||
      document.body.classList.contains("right-open")
    )
      revealRight(null);
    else if (live && state && !state.idle)
      api("/api/abort", {}).catch((error) => toast(error.message));
    else closeSidebar();
  }
});
// Kept in the existing served browser module so older hosts can still load the page.
// This logical module owns Git view state; callers provide transport and shared UI.
// Limits and permitted actions come from the server's read() result, so this
// module never restates the prepare() confirmation rules.
function createGitPane({ request, snapshot, confirm, reveal }) {
  let owner,
    data,
    generation = 0,
    loading,
    pending = false,
    expanded,
    diffCache,
    analyzing = false,
    attempted = false,
    historyData,
    historySelection,
    historyLoading = false,
    diagnostics;
  const drafts = new Map();
  const panel = $("#workspace-right");
  const source = () => $("#git-source").value;
  const validOwner = () => owner === snapshot().sessionId;
  const output = (text = "") => {
    $("#git-output").textContent = text;
    $("#git-output").hidden = !text;
    $("#git-manage-output").textContent = text;
    $("#git-manage-output").hidden = !text;
  };
  function reset() {
    generation++;
    data =
      expanded =
      diffCache =
      diagnostics =
      historyData =
      historySelection =
        undefined;
    historyLoading = false;
    $("#git-history-list").replaceChildren();
    $("#git-history-scope").value = "current";
    $("#git-history-detail").textContent = "";
    $("#git-history-detail").hidden = true;
    $("#git-ref").value = "HEAD";
    $("#git-new-name").value = $("#git-tag-message").value = "";
    $("#git-files").innerHTML =
      '<div class="git-review-empty"><strong>尚未读取变更</strong><p>刷新状态后开始审查</p></div>';
    $("#git-branch-select").replaceChildren();
    $("#git-remote-select").replaceChildren();
    $("#git-diagnostics").hidden = true;
    $("#git-status").textContent = "";
    $("#git-card-count").textContent = "";
    $("#git-card-stats").innerHTML =
      '<span class="git-added">+—</span><span class="git-removed">−—</span>';
    output();
  }
  function bulkStagePaths(action) {
    const unstage = action === "unstage";
    const paths = [];
    let skipped = 0;
    const limits = data?.limits;
    const maxPaths = Number.isSafeInteger(limits?.stagePaths)
      ? limits.stagePaths
      : 0;
    const maxBytes = Number.isSafeInteger(limits?.stageBytes)
      ? limits.stageBytes
      : 0;
    let budget = maxBytes;
    for (const file of data?.files ?? []) {
      if (unstage ? !file.staged : !file.unstaged) continue;
      if (paths.length >= maxPaths) {
        skipped++;
        continue;
      }
      // Only selected untracked inputs consume the confirmation byte budget.
      if (!unstage && file.index === "?" && file.size != null) {
        if (file.size > budget) {
          skipped++;
          continue;
        }
        budget -= file.size;
      }
      paths.push(file.path);
    }
    return { paths, skipped };
  }
  function controls() {
    const state = snapshot();
    const supported = state.live && state.gitManagement;
    const readable =
      supported &&
      state.connected &&
      state.projectTrusted === true &&
      validOwner() &&
      !!data &&
      !loading &&
      !historyLoading &&
      !pending;
    const permitted = new Set(data?.permittedActions ?? []);
    const allowed = (action) => permitted.has(action);
    const writable =
      readable && !data.busy && (state.gitWritable ?? state.idle);
    // Bulk staging mirrors the single-file actions; the limits come from the
    // server's read() result and prepare() remains the authority.
    const bulk = {
      "stage-all": { action: "stage", ...bulkStagePaths("stage") },
      "unstage-all": { action: "unstage", ...bulkStagePaths("unstage") },
    };
    const notice = !state.sessionId
      ? "请先连接 Pi"
      : !supported
        ? "当前宿主尚未加载 Git 管理；仅显示现有分支。请等任务结束后确认更新原宿主。"
        : !state.connected
          ? "连接恢复后再操作 Git"
          : state.projectTrusted !== true
            ? "请先在设置中信任项目，再读取 Git；仓库过滤器可能执行程序。"
            : loading
              ? ""
              : !data
                ? "尚未读取到仓库信息，请刷新重试。"
                : data.operations?.length
                  ? "仓库有未完成的合并／变基，请先在终端处理。"
                  : !writable
                    ? "所有会话任务和配置操作结束后才可写入；仍可审查差异。"
                    : "";
    $("#git-notice").textContent = notice;
    $("#git-notice").hidden = !notice;
    $("#git-review-notice").textContent = notice;
    $("#git-review-notice").hidden = !notice;
    // The bulk action follows the reviewed side, so the toolbar stays one row
    // even in a narrow docked panel.
    const stagedView = source() === "staged";
    for (const button of panel.querySelectorAll("[data-git-action]")) {
      const action = button.dataset.gitAction;
      if (bulk[action])
        button.hidden = action !== (stagedView ? "unstage-all" : "stage-all");
      button.disabled =
        action === "refresh"
          ? pending || !!loading
          : action === "analyze"
            ? !readable ||
              !expanded ||
              analyzing ||
              !state.gitAnalysis ||
              !/\.(?:[cm]?[jt]sx?|jsonc?)$/i.test(expanded.path)
            : bulk[action]
              ? !writable ||
                !allowed(bulk[action].action) ||
                !bulk[action].paths.length
              : [
                    "diff",
                    "log",
                    "show",
                    "pick-tag",
                    "history-prev",
                    "history-next",
                  ].includes(action)
                ? !readable ||
                  (action === "show" && !state.gitExtended) ||
                  (action === "history-prev" &&
                    (!historyData || historyData.page <= 1)) ||
                  (action === "history-next" && !historyData?.nextPage)
                : !writable ||
                  (action !== "manage" && !allowed(action)) ||
                  (action === "manage" && !state.gitExtended) ||
                  (action === "commit" &&
                    (!data.files.some((file) => file.staged) ||
                      !$("#git-message").value.trim())) ||
                  (action === "switch" &&
                    (!data.branches.length || data.files.length > 0)) ||
                  (["fetch", "pull", "push"].includes(action) &&
                    (!data.remotes.length ||
                      (action !== "fetch" &&
                        (!data.head || !data.branches.includes(data.branch))) ||
                      (action === "pull" && data.files.length > 0)));
      button.title = button.disabled
        ? notice ||
          (action === "analyze"
            ? "仅 JS/TS 与 JSON；宿主须支持 LSP，分析当前工作树，不分析已暂存快照"
            : "当前没有可执行的文件／分支／远端或提交说明")
        : bulk[action]
          ? `对 ${bulk[action].paths.length} 个文件执行 git ${bulk[action].action}${bulk[action].skipped ? `；另有 ${bulk[action].skipped} 个超出单次额度` : ""}`
          : "";
    }
    $("#git-manage-notice").textContent = state.gitExtended
      ? "目标解析成真实提交 SHA 后确认；不执行任意 shell 或修订表达式。" +
        (notice ? " " + notice : "")
      : "当前宿主尚未加载 merge/checkout/reset/tag 管理；任务结束后确认更新宿主。";
    const selectedAction = $("#git-manage-action").value;
    for (const field of panel.querySelectorAll("[data-git-field]"))
      field.hidden = field.dataset.gitField !== selectedAction;
    $("#git-name-field").hidden = !(
      selectedAction === "tag" ||
      (selectedAction === "checkout" &&
        $("#git-checkout-mode").value === "create")
    );
    $("#git-history-scope").disabled = !state.gitGraph || !readable;
    $("#git-message").disabled = !supported || !validOwner() || pending;
    $("#git-branch-select").disabled = !writable || !data.branches.length;
    $("#git-remote-select").disabled = !writable || !data.remotes.length;
  }
  function showDiagnostics() {
    $("#git-diagnostics").hidden = !expanded;
    if (!expanded) return;
    const state = snapshot();
    $("#git-diagnostics-note").textContent = analyzing
      ? "正在运行本地语言服务器…"
      : !state.gitAnalysis
        ? "当前宿主尚未接入 LSP；不会显示模拟诊断。"
        : !diagnostics
          ? "手动分析当前工作树文件，不自动改写、安装或下载。已暂存 diff 可能与工作树不同。"
          : "本次 LSP 诊断仅针对当前工作树；不是完整审查或编译通过证明。";
    $("#git-diagnostics-list").innerHTML = !diagnostics
      ? ""
      : diagnostics.error
        ? `<p>${esc(diagnostics.error)}</p>`
        : `<p class="muted">${esc(diagnostics.executable)} · ${diagnostics.diagnostics.length} 条诊断${diagnostics.truncated ? "（已截取前 200 条）" : ""}</p>` +
          diagnostics.diagnostics
            .map(
              (item) =>
                `<div class="diagnostic-row"><span class="diagnostic-severity severity-${item.severity}">${{ 1: "错误", 2: "警告", 3: "信息", 4: "提示" }[item.severity]}</span><span class="diagnostic-location">${item.line}:${item.column}${item.code == null ? "" : " · " + esc(item.code)}</span><p>${esc(item.message)}</p></div>`,
            )
            .join("");
  }
  function render() {
    if (!data) {
      controls();
      return;
    }
    const state = snapshot(),
      staged = source() === "staged";
    $("#git-root").textContent = data.root;
    $("#git-branch").textContent = data.branch;
    $("#git-branch").title = data.branch;
    $("#git-status").textContent = data.busy
      ? "Git 操作运行中"
      : data.files.length
        ? ""
        : "工作区干净";
    const oldBranch = $("#git-branch-select").value,
      oldRemote = $("#git-remote-select").value;
    const branch = data.branches.includes(oldBranch) ? oldBranch : data.branch;
    const remote = data.remotes.includes(oldRemote)
      ? oldRemote
      : (data.upstream?.remote ??
        (data.remotes.includes("origin") ? "origin" : data.remotes[0]));
    $("#git-branch-select").innerHTML = data.branches
      .map(
        (name) =>
          `<option ${name === branch ? "selected" : ""} value="${esc(name)}">${esc(name)}</option>`,
      )
      .join("");
    $("#git-remote-select").innerHTML = data.remotes
      .map(
        (name) =>
          `<option ${name === remote ? "selected" : ""} value="${esc(name)}">${esc(name)}</option>`,
      )
      .join("");
    let added = 0,
      removed = 0,
      unknown = 0;
    for (const file of data.files) {
      for (const key of ["staged", "unstaged"]) {
        if (!file[key]) continue;
        const stats = file.stats?.[key];
        if (stats?.added == null || stats?.removed == null) unknown++;
        else {
          added += stats.added;
          removed += stats.removed;
        }
      }
    }
    $("#git-card-count").textContent = data.files.length
      ? String(data.files.length)
      : "";
    $("#git-card-stats").innerHTML =
      `<span class="git-added">+${added}</span><span class="git-removed">−${removed}</span>${unknown ? '<span class="git-unknown">*</span>' : ""}`;
    $("#git-card-stats").title = unknown
      ? "部分二进制／大文件或旧宿主未提供行统计；不是零变更"
      : "已暂存和未暂存行统计（分层计算）";
    const files = data.files.filter(
      (file) => file[staged ? "staged" : "unstaged"],
    );
    if (
      expanded &&
      !files.some(
        (file) => file.path === expanded.path && expanded.staged === staged,
      )
    ) {
      expanded = diagnostics = undefined;
    }
    $("#git-files").innerHTML = files.length
      ? files
          .map((file) => {
            const isOpen =
              expanded?.path === file.path && expanded.staged === staged;
            const stats = file.stats?.[staged ? "staged" : "unstaged"];
            const name = file.path.split("/").pop(),
              directory = file.path.slice(0, -(name.length + 1));
            const kind = /\.(?:tsx?|jsx?|[mc][jt]s)$/i.test(name)
              ? "code"
              : /\.jsonc?$/i.test(name)
                ? "json"
                : /\.(?:md|txt)$/i.test(name)
                  ? "text"
                  : "file";
            return `<article class="git-change-card"><div class="git-file-head"><button class="git-file-name" type="button" data-git-action="diff" data-git-path="${esc(file.path)}" data-git-staged="${staged}" aria-expanded="${isOpen}"><span class="git-file-icon kind-${kind}">${kind === "code" ? "⌘" : kind === "json" ? "{}" : kind === "text" ? "▤" : "◇"}</span><span class="git-file-path"><strong>${esc(name)}</strong>${directory ? `<span class="git-file-directory">${esc(directory)}</span>` : ""}</span><span class="git-file-stats"><span class="git-added">${stats?.added == null ? "+—" : "+" + stats.added}</span><span class="git-removed">${stats?.removed == null ? "−—" : "−" + stats.removed}</span></span><span class="git-chevron">${isOpen ? "⌃" : "⌄"}</span></button><button class="git-file-stage" type="button" data-git-action="${staged ? "unstage" : "stage"}" data-git-path="${esc(file.path)}" title="${staged ? "git restore --staged" : "git add"} -- ${esc(file.path)}" aria-label="${staged ? "取消暂存" : "暂存"} ${esc(file.path)}">${staged ? "−" : "+"}</button></div>${isOpen ? `<div class="git-file-actions"><span>${esc(staged ? "已暂存差异" : "工作树差异")}</span></div><pre class="git-file-diff" tabindex="0" aria-label="${esc(file.path)} 差异"></pre>` : ""}</article>`;
          })
          .join("")
      : `<div class="git-review-empty"><strong>${staged ? "没有已暂存变更" : "没有未暂存变更"}</strong><p>${staged ? "从未暂存审查中选择文件暂存" : "工作树与索引一致"}</p></div>`;
    const diff = $("#git-files .git-file-diff");
    if (diff)
      diff.textContent =
        diffCache?.path === expanded.path &&
        diffCache.staged === expanded.staged &&
        diffCache.revision === data.revision
          ? diffCache.output
          : "正在读取差异…";
    $("#git-tag-list").innerHTML =
      (data.tags ?? [])
        .map(
          (name) =>
            `<button type="button" class="text-button" data-git-action="pick-tag" data-git-tag="${esc(name)}">${esc(name)}</button>`,
        )
        .join("") ||
      '<p class="muted">没有本地 tag（旧宿主可能未提供列表）</p>';
    $("#git-commit-summary").textContent =
      `仅包含 ${data.files.filter((file) => file.staged).length} 个已暂存文件；未暂存文件不会自动加入。`;
    showDiagnostics();
    controls();
  }
  async function read(action = "status", path, staged = false, extra = {}) {
    const target = owner,
      serial = ++generation;
    const query = new URLSearchParams({
      sessionId: target,
      action,
      staged: String(staged),
      ...extra,
    });
    if (path) query.set("path", path);
    const result = await request("/api/git?" + query);
    if (target !== owner || !validOwner() || serial !== generation)
      throw new Error("Git 读取已过期，请刷新重试");
    return result;
  }
  async function refresh() {
    const state = snapshot();
    if (
      !state.live ||
      !state.gitManagement ||
      !state.connected ||
      state.projectTrusted !== true
    ) {
      controls();
      return;
    }
    if (loading) return loading;
    const target = owner;
    const operation = (async () => {
      try {
        const result = await read();
        if (target !== owner || !validOwner()) return;
        if (data && data.root !== result.root) {
          $("#git-branch-select").replaceChildren();
          $("#git-remote-select").replaceChildren();
        }
        if (data && data.revision !== result.revision)
          expanded = diagnostics = undefined;
        if (diffCache?.revision !== result.revision) diffCache = undefined;
        data = result;
        render();
      } catch (error) {
        if (target === owner && validOwner()) {
          $("#git-status").textContent = error.message;
          if (error.message.includes("16 MiB") && !state.gitReview)
            $("#git-status").textContent +=
              " · 旧宿主读取规则尚未更新；任务结束后确认更新宿主。";
        }
      } finally {
        if (loading === operation) loading = undefined;
        controls();
      }
    })();
    loading = operation;
    controls();
    return operation;
  }
  async function toggle(path, staged) {
    output();
    if (expanded?.path === path && expanded.staged === staged) {
      expanded = diagnostics = undefined;
      render();
      return;
    }
    const selection = { path, staged },
      target = owner;
    expanded = selection;
    diagnostics = undefined;
    render();
    if (
      diffCache?.path === path &&
      diffCache.staged === staged &&
      diffCache.revision === data.revision
    )
      return;
    try {
      const result = await read("diff", path, staged);
      if (selection !== expanded || target !== owner) return;
      diffCache = {
        path,
        staged,
        revision: result.revision,
        output: result.output,
      };
      data = result;
      render();
    } catch (error) {
      if (selection === expanded && target === owner) {
        const node = $("#git-files .git-file-diff");
        if (node) node.textContent = error.message;
      }
    }
  }
  async function mutation(input, note = "") {
    if (pending) throw new Error("Git 操作正在运行");
    const target = owner;
    if (!validOwner()) throw new Error("当前会话已变化，请重新预览");
    const plan = await request("/api/git", input);
    if (target !== owner || !validOwner())
      throw new Error("当前会话已变化，请重新预览");
    confirm(
      plan,
      async () => {
        if (target !== owner || !validOwner())
          throw new Error("当前会话已变化，请重新预览");
        pending = true;
        controls();
        $("#git-status").textContent = "Git 操作执行中…";
        try {
          const result = await request("/api/git", { token: plan.token });
          if (target !== owner || !validOwner()) return;
          await refresh();
          output(result.output || "Git 操作已完成");
          if (result.conflict) $("#git-status").textContent = result.output;
        } finally {
          pending = false;
          controls();
        }
      },
      note,
    );
  }
  async function analyze() {
    if (!expanded || analyzing || !snapshot().gitAnalysis) return;
    const selection = expanded,
      target = owner;
    analyzing = true;
    diagnostics = undefined;
    showDiagnostics();
    controls();
    try {
      const result = await request("/api/git-analysis", {
        path: selection.path,
      });
      if (target === owner && selection === expanded && validOwner())
        diagnostics = result;
    } catch (error) {
      if (target === owner && selection === expanded)
        diagnostics = { error: error.message };
    } finally {
      analyzing = false;
      showDiagnostics();
      controls();
    }
  }
  function historyMarkup(result) {
    const graph = result.graph;
    $("#git-history-list").style.setProperty(
      "--git-graph-width",
      (graph?.width ?? 24) + "px",
    );
    return result.commits
      .map((commit, index) => {
        const row = graph?.rows[index];
        const drawing = row
          ? `<svg class="git-graph" aria-hidden="true" viewBox="0 0 ${graph.width} ${graph.height}" width="${graph.width}" height="${graph.height}">${row.edges.map((edge) => `<path class="graph-color-${edge.color}" data-edge="${edge.kind}" d="${esc(edge.path)}"/>`).join("")}<circle class="graph-node graph-color-${row.node.color}" data-kind="${row.kind}" cx="${row.node.x}" cy="${row.node.y}" r="${row.kind === "commit" ? 3 : 5}"/>${row.kind === "merge" ? `<circle class="graph-merge-dot graph-color-${row.node.color}" cx="${row.node.x}" cy="${row.node.y}" r="2"/>` : ""}</svg>`
          : "";
        const refs = commit.references ?? [];
        const title = [
          commit.subject,
          commit.id,
          commit.author,
          commit.date,
          ...refs.map((ref) => ref.id),
        ]
          .filter(Boolean)
          .join(" · ");
        return `<button type="button" class="git-history-row ${row ? "git-graph-row" : ""}" data-git-action="show" data-git-ref="${esc(commit.id)}" title="${esc(title)}" aria-label="${esc(title)}${row?.kind === "head" ? " · 当前 HEAD" : ""}${commit.parentIds?.length > 1 ? " · 合并提交" : ""}">${drawing}<span class="git-history-subject">${esc(commit.subject)}</span><span class="git-history-author">${esc(commit.author || commit.shortId)}</span><span class="git-history-refs">${refs
          .slice(0, 3)
          .map(
            (ref) =>
              `<span class="git-ref git-ref-${esc(ref.type)}" title="${esc(ref.id)}">${ref.current ? "◎ " : ref.type === "tag" ? "◇ " : ref.type === "remote" ? "↗ " : "⑂ "}${esc(ref.name)}</span>`,
          )
          .join(
            "",
          )}${refs.length > 3 ? `<span class="git-ref">+${refs.length - 3}</span>` : ""}</span></button>`;
      })
      .join("");
  }
  async function showHistory(page = 1) {
    const target = owner;
    reveal("history");
    const operation = {};
    historyLoading = operation;
    historySelection = undefined;
    controls();
    $("#git-history-list").textContent = "正在读取历史…";
    $("#git-history-detail").hidden = true;
    try {
      const result = await read("log", undefined, false, {
        page: String(page),
        ...(snapshot().gitGraph
          ? { scope: $("#git-history-scope").value }
          : {}),
      });
      if (target !== owner || !validOwner()) return;
      historyData = { page: result.page ?? 1, nextPage: result.nextPage };
      data = result;
      render();
      $("#git-history-list").innerHTML = Array.isArray(result.commits)
        ? result.commits.length
          ? historyMarkup(result)
          : '<p class="muted">尚无提交</p>'
        : `<pre>${esc(result.output || "旧宿主未返回历史")}</pre>`;
      $("#git-history-page").textContent = "第 " + historyData.page + " 页";
    } catch (error) {
      if (target === owner && historyLoading === operation)
        $("#git-history-list").textContent = error.message;
    } finally {
      if (historyLoading === operation) historyLoading = false;
      controls();
    }
  }
  async function showCommit(ref) {
    const target = owner,
      selection = { ref };
    historySelection = selection;
    reveal("history");
    if (!snapshot().gitExtended)
      throw new Error("当前宿主尚未加载提交详情，请在任务结束后更新");
    for (const row of panel.querySelectorAll(".git-history-row")) {
      const selected = row.dataset.gitRef === ref;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-pressed", String(selected));
    }
    $("#git-history-detail").hidden = false;
    $("#git-history-detail").textContent = "正在读取提交…";
    try {
      const result = await read("show", undefined, false, { ref });
      if (target !== owner || !validOwner() || selection !== historySelection)
        return;
      $("#git-history-detail").textContent = result.output;
      $("#git-history-detail").scrollIntoView({ block: "nearest" });
    } catch (error) {
      if (target === owner && selection === historySelection)
        $("#git-history-detail").textContent = error.message;
    }
  }
  function managementInput() {
    const action = $("#git-manage-action").value,
      ref = $("#git-ref").value.trim();
    if (action === "checkout")
      return {
        action,
        mode: $("#git-checkout-mode").value,
        ref,
        branch:
          $("#git-checkout-mode").value === "create"
            ? $("#git-new-name").value.trim()
            : undefined,
      };
    if (action === "reset")
      return { action, mode: $("#git-reset-mode").value, ref };
    if (action === "tag")
      return {
        action,
        operation: $("#git-tag-operation").value,
        name: $("#git-new-name").value.trim(),
        ref,
        message: $("#git-tag-message").value,
      };
    return { action, ref };
  }
  async function open(args = "", mode = "review") {
    const target = owner;
    reveal(mode);
    await refresh();
    if (target !== owner || !data || !validOwner()) return;
    const { parseGitCommand, gitActions, gitExtendedActions, gitHelp } =
      await import("./git-command.mjs");
    if (target !== owner || !validOwner()) return;
    const input = parseGitCommand(args);
    if (
      (gitExtendedActions.includes(input.action) ||
        ["show", "tags"].includes(input.action)) &&
      !snapshot().gitExtended
    )
      throw new Error("当前宿主尚未加载扩展 Git 管理；任务结束后确认更新宿主");
    if (input.action === "log") {
      await showHistory(input.page);
      return;
    }
    if (input.action === "show") {
      await showCommit(input.ref);
      return;
    }
    if (input.action === "tags") {
      reveal("manage");
      const result = await read("tags");
      $("#git-manage-notice").textContent =
        result.output || "当前宿主未提供 tag 列表；任务结束后确认更新宿主";
      return;
    }
    if (input.action === "help") output(gitHelp);
    else if (gitActions.includes(input.action)) await mutation(input);
    else if (input.action === "diff" && input.path) {
      $("#git-source").value = input.staged ? "staged" : "unstaged";
      await toggle(input.path, Boolean(input.staged));
    } else if (input.action === "branches") {
      output(data.branches.join("\n") || "没有本地分支");
    } else if (["log", "diff"].includes(input.action)) {
      const result = await read(input.action, undefined, Boolean(input.staged));
      if (data && data.revision !== result.revision)
        expanded = diagnostics = diffCache = undefined;
      data = result;
      render();
      output(result.output);
    }
  }
  function update() {
    const state = snapshot();
    if (state.sessionId !== owner) {
      if (owner) drafts.set(owner, $("#git-message").value);
      owner = state.sessionId;
      loading = undefined;
      attempted = false;
      reset();
      $("#git-message").value = drafts.get(owner) ?? "";
    }
    if (!state.gitManagement) {
      attempted = false;
      if (data) reset();
    }
    if (!data) {
      $("#git-branch").textContent = state.git?.branch ?? "分支 —";
      $("#git-branch").title = state.git?.branch ?? "";
    }
    controls();
    if (
      owner &&
      !data &&
      !loading &&
      !attempted &&
      state.live &&
      state.gitManagement &&
      state.connected &&
      state.projectTrusted === true
    ) {
      attempted = true;
      void refresh();
    }
  }
  $("#git-source").addEventListener("change", () => {
    expanded = diagnostics = undefined;
    render();
  });
  $("#git-message").addEventListener("input", controls);
  $("#git-history-scope").addEventListener("change", () => void showHistory());
  for (const id of [
    "git-manage-action",
    "git-checkout-mode",
    "git-tag-operation",
  ])
    $("#" + id).addEventListener("change", controls);
  panel.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-git-action]");
    if (!button || button.disabled) return;
    try {
      const action = button.dataset.gitAction;
      if (action === "refresh") {
        expanded = diagnostics = diffCache = undefined;
        await refresh();
        return;
      }
      if (!validOwner()) throw new Error("当前会话已变化，请刷新");
      if (action === "diff") {
        await toggle(
          button.dataset.gitPath,
          button.dataset.gitStaged === "true",
        );
        return;
      }
      if (action === "analyze") {
        await analyze();
        return;
      }
      if (action === "stage-all" || action === "unstage-all") {
        const unstage = action === "unstage-all";
        const { paths, skipped } = bulkStagePaths(
          unstage ? "unstage" : "stage",
        );
        if (!paths.length) return;
        await mutation(
          { action: unstage ? "unstage" : "stage", paths },
          skipped
            ? `另有 ${skipped} 个文件未包含：一次最多 ${data?.limits?.stagePaths ?? 0} 个，且所选未跟踪文件须在 ${Math.round((data?.limits?.stageBytes ?? 0) / 1024 / 1024)} MiB 内；可分批暂存。`
            : "",
        );
        return;
      }
      const menu = button.closest("details");
      if (menu) menu.open = false;
      if (action === "log") {
        await showHistory();
        return;
      }
      if (action === "show") {
        await showCommit(button.dataset.gitRef);
        return;
      }
      if (action === "history-prev" || action === "history-next") {
        await showHistory(
          action === "history-prev"
            ? historyData.page - 1
            : historyData.nextPage,
        );
        return;
      }
      if (action === "pick-tag") {
        $("#git-new-name").value = button.dataset.gitTag;
        $("#git-ref").value = button.dataset.gitTag;
        return;
      }
      if (action === "manage") {
        await mutation(managementInput());
        return;
      }
      await mutation({
        action,
        paths: button.dataset.gitPath ? [button.dataset.gitPath] : undefined,
        message: $("#git-message").value,
        branch: $("#git-branch-select").value,
        remote: $("#git-remote-select").value || undefined,
      });
    } catch (error) {
      $("#git-status").textContent = error.message;
    }
  });
  return { update, open, history: showHistory };
}
function syncRightSidebar() {
  const pane = $("#workspace-right");
  const visible =
    !document.body.classList.contains("right-collapsed") &&
    (!matchMedia("(max-width:760px)").matches ||
      document.body.classList.contains("right-open"));
  pane.inert = !visible;
  pane.setAttribute("aria-hidden", String(!visible));
  const trigger = $('[data-action="workspace-tools"]');
  trigger.setAttribute("aria-expanded", String(visible));
  trigger.setAttribute("aria-label", visible ? "隐藏右侧栏" : "显示右侧栏");
  trigger.title = visible ? "隐藏整个右侧栏" : "恢复右侧栏";
}
function setRightSidebar(visible) {
  const pane = $("#workspace-right");
  const hadFocus = pane.contains(document.activeElement);
  document.body.classList.toggle("right-collapsed", !visible);
  document.body.classList.toggle("right-open", visible);
  localStorage.setItem("pi-web-right-hidden", String(!visible));
  syncRightSidebar();
  if (!visible && hadFocus) $('[data-action="workspace-tools"]').focus();
}
function revealRight(mode) {
  if (workspacePanel && !workspacePanel.rendering) {
    if (!mode && !["changes", "tools"].includes(workspacePanel.activeKind))
      return;
    workspacePanel.openBuiltin(mode ?? "home");
    return;
  }
  const pane = $("#workspace-right");
  pane.classList.toggle("expanded", Boolean(mode));
  pane.dataset.view = mode ?? "";
  $(".right-tabs").hidden = false;
  $('[data-action="close-right-view"]').hidden = !mode;
  $(".right-placeholder").hidden = Boolean(mode);
  for (const [key, id] of [
    ["review", "git-review-pane"],
    ["tools", "preview-panel"],
    ["commit", "git-commit-pane"],
    ["history", "git-history-pane"],
    ["manage", "git-manage-pane"],
  ]) {
    $("#" + id).hidden = mode !== key;
    $(`[data-right-view="${key}"]`).setAttribute(
      "aria-selected",
      String(mode === key),
    );
  }
  if (mode) setRightSidebar(true);
  else {
    if (!workspacePanel?.rendering)
      document.body.classList.remove("right-open");
    syncRightSidebar();
  }
}
const gitPane = createGitPane({
  request: api,
  snapshot: () => ({ ...state, live, connected }),
  reveal: revealRight,
  confirm: (plan, execute, note = "") => {
    const gitRequest = plan.request ?? {};
    const staging =
      gitRequest.action === "stage" || gitRequest.action === "unstage";
    // Staging only names the selected paths; the full change list belongs to
    // operations that can touch the whole worktree.
    const body = staging
      ? `<p>${esc(plan.root)}</p><p>${gitRequest.action === "stage" ? "将暂存" : "将取消暂存"} ${gitRequest.paths.length} 个文件：</p><pre>${esc(gitRequest.paths.join("\n"))}</pre>${note ? `<p class="dialog-note">${esc(note)}</p>` : ""}<p class="dialog-note">${esc(plan.warning)}</p>`
      : `<p>${esc(plan.root)}</p><pre>${esc(JSON.stringify(gitRequest, null, 2))}</pre>${note ? `<p class="dialog-note">${esc(note)}</p>` : ""}<p>当前已暂存（提交时全部包含）：</p><pre>${esc(plan.staged.join("\n") || "无")}</pre><p>当前工作区变更：</p><pre>${esc((plan.affected ?? []).join("\n") || "无")}</pre><p class="dialog-note">${esc(plan.warning)}</p>`;
    openDialog(
      staging
        ? gitRequest.action === "stage"
          ? "确认暂存（git add）"
          : "确认取消暂存"
        : "确认 Git 操作",
      body,
      execute,
      "确认执行",
    );
  },
});
const openGit = (args = "") => gitPane.open(args);
if (runtimePrefix) {
  workspacePanel = createWorkspacePanels({
    pane: $("#workspace-right"),
    request: api,
    snapshot: () => state,
    reveal: revealRight,
    show: setRightSidebar,
    storageKey: `pi-desktop-recent-pages${runtimePrefix}`,
  });
  workspacePanel.configure(desktopConfiguration);
  document.addEventListener("pi-desktop:open-git", (event) => {
    void (event.detail === "history" ? gitPane.history() : gitPane.open());
  });
}

$(".right-tabs").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-right-view]");
  if (tab) {
    if (tab.dataset.rightView === "review") void gitPane.open();
    else if (tab.dataset.rightView === "history") void gitPane.history();
    else revealRight(tab.dataset.rightView);
  }
});
// Both edges share pointer capture, keyboard bounds and cancellation semantics.
const MIN_CHAT_WIDTH = 320,
  MIN_LEFT_WIDTH = 180,
  MIN_RIGHT_WIDTH = 240;
const MAX_LEFT_WIDTH = 480,
  RESIZE_STEP = 16,
  LAYOUT_GUTTER = 20;
function bindSidebarResize(handle, side) {
  let origin;
  const pane = side === "left" ? $(".sidebar") : $("#workspace-right");
  const property = side === "left" ? "--sidebar-width" : "--right-width";
  const apply = (requested) => {
    const root = document.documentElement;
    const mobile = matchMedia("(max-width:760px)").matches;
    if (mobile) return;
    const total = $(".app").getBoundingClientRect().width;
    const left =
      document.body.classList.contains("sidebar-collapsed") ||
      document.body.classList.contains("settings-open")
        ? 0
        : $(".sidebar").getBoundingClientRect().width;
    const right = $("#view-workspace").hidden
      ? 0
      : $("#workspace-right").getBoundingClientRect().width;
    const minimum = side === "left" ? MIN_LEFT_WIDTH : MIN_RIGHT_WIDTH;
    const maximum = Math.max(
      minimum,
      side === "left"
        ? Math.min(
            MAX_LEFT_WIDTH,
            total - right - MIN_CHAT_WIDTH - LAYOUT_GUTTER,
          )
        : Math.min(
            (total - left) * 0.65,
            total - left - MIN_CHAT_WIDTH - LAYOUT_GUTTER,
          ),
    );
    const width = Math.min(maximum, Math.max(minimum, requested));
    root.style.setProperty(property, width + "px");
    handle.setAttribute("aria-valuemin", String(minimum));
    handle.setAttribute("aria-valuemax", String(Math.round(maximum)));
    handle.setAttribute("aria-valuenow", String(Math.round(width)));
  };
  const finish = () => {
    origin = undefined;
    document.body.classList.remove("resizing-sidebar");
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || matchMedia("(max-width:760px)").matches) return;
    event.preventDefault();
    origin = { x: event.clientX, width: pane.getBoundingClientRect().width };
    document.body.classList.add("resizing-sidebar");
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (origin)
      apply(
        origin.width + (side === "left" ? 1 : -1) * (event.clientX - origin.x),
      );
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    handle.addEventListener(name, finish);
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    // Keyboard steps land instantly; only pointer drags and pane toggles use
    // the shell transition.
    document.body.classList.add("resizing-sidebar");
    apply(
      pane.getBoundingClientRect().width +
        (event.key === "ArrowRight" ? 1 : -1) *
          (side === "left" ? 1 : -1) *
          RESIZE_STEP,
    );
    requestAnimationFrame(() =>
      document.body.classList.remove("resizing-sidebar"),
    );
  });
  window.addEventListener("resize", () => {
    if (document.documentElement.style.getPropertyValue(property))
      apply(
        parseFloat(document.documentElement.style.getPropertyValue(property)),
      );
  });
}
bindSidebarResize($(".sidebar-resize"), "left");
bindSidebarResize($(".preview-resize"), "right");
document.body.classList.toggle(
  "right-collapsed",
  localStorage.getItem("pi-web-right-hidden") !== "false",
);
syncRightSidebar();
window.addEventListener("resize", syncRightSidebar);
async function prefillGoalPrompt(value) {
  await showView("workspace");
  if (/^\/goal-tweak\b/.test(value) && !value.endsWith(" ")) value += " ";
  const prompt = $("#prompt");
  prompt.value = value;
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  prompt.focus();
  toast("已填入输入框，按 Enter 发送");
}
async function handleGoalPanelAction({ kind, value }) {
  if (kind === "refresh") {
    await refresh();
    return;
  }
  if (kind === "focus-composer") {
    await showView("workspace");
    $("#prompt").focus();
    return;
  }
  if (kind === "prefill") {
    await prefillGoalPrompt(value);
    return;
  }
  if (kind === "command") {
    // The adapter's declared command set already validated this intent; the
    // page only sends the exact command, never re-parses free text.
    try {
      await api("/api/prompt", { message: value });
      await refresh();
      toast(value === "/goal-pause" ? "已暂停目标" : "已恢复目标");
    } catch (error) {
      toast(error.message);
    }
  }
}
function readPanelContext() {
  const selected = String(
    state?.host === "durable"
      ? durableAgentId || state.sessionId || ""
      : (state?.sessionId ?? ""),
  );
  return {
    sessionId: selected,
    ready:
      !!state &&
      String(state.sessionId ?? "") === selected &&
      !pendingConversation,
    capabilities: state?.capabilities ?? {},
    sessionCommands: state?.sessionCommands === true,
    // 既有远程网关裁剪 /api/command；策略必须保留此 adapter 的显式收窄。
    taskCommands:
      state?.sessionCommands === true && state?.capabilities?.remote !== true,
  };
}
function canManageBranches() {
  return readClientPolicy(readPanelContext()).canManageBranches;
}
/* 内置「分支树」页：数据来自 /api/tree，动作复用消息菜单与会话栏的同一条命令路径。 */
const branchTree = createBranchTreePanel({
  fetchHistory: (id, before, options) =>
    api(
      `/api/subagent-history?sessionId=${encodeURIComponent(id)}${before === undefined ? "" : `&before=${before}`}`,
      undefined,
      options,
    ),
  fetchDetail: (id, taskId, options) =>
    api(
      `/api/task-detail?sessionId=${encodeURIComponent(id)}&taskId=${taskId}`,
      undefined,
      options,
    ),
  fetchTree: (id, options) =>
    api(`/api/tree?id=${encodeURIComponent(id)}`, undefined, options),
  command: (name, input) =>
    api("/api/command", { command: name, ...input }, { selectSession: false }),
  toast: (message) => toast(message),
  openCreatedSession,
  switchSession: (id) =>
    switchConversation(id).catch((error) => toast(error.message)),
});
/* 内置「任务与子代理」页：读取 /api/tasks，操作复用同一命令路径（取消需要两步确认）。 */
const taskPanel = createTaskPanel({
  fetchDetail: (id, taskId, options) =>
    api(
      `/api/task-detail?sessionId=${encodeURIComponent(id)}&taskId=${taskId}`,
      undefined,
      options,
    ),
  fetchTasks: (id, options) =>
    api(`/api/tasks?id=${encodeURIComponent(id)}`, undefined, options),
  command: (input, options) => api("/api/command", input, options),
  toast: (message) => toast(message),
  currentSession: () => readPanelContext().sessionId,
});
extensionWorkbench = createExtensionWorkbench({
  root: $("#view-extensions"),
  registry: extensionAdapterRegistry,
  builtinPages: [branchTree, taskPanel],
  sanitize: (html) => DOMPurify.sanitize(html),
  loadDetails: loadMessageDetails,
  onError: toast,
  onPanelAction: handleGoalPanelAction,
  onCount(count) {
    syncComposerTools();
    const badge = $("#extension-page-count");
    badge.hidden = !count;
    badge.textContent = count;
    badge.parentElement.setAttribute(
      "aria-label",
      `扩展工作台，${count} 个页面`,
    );
  },
});
/* 静态 HTML 先于延迟模块上屏；首个可展示的界面就绪后再露出外壳。 */
function revealShell() {
  delete document.documentElement.dataset.booting;
}
async function boot() {
  if (!live) {
    commands = (await import("./pi-commands.mjs")).webCommands;
    state = {
      cwd: "~/Projects/pi-desktop",
      sessionId: "demo-1",
      idle: true,
      defaults: {},
    };
    const demoPlugins = [
      {
        id: "rtk",
        name: "RTK Optimizer",
        source: "npm:pi-rtk-optimizer",
        type: "package",
        description: "工具输出优化；保留已有过滤策略。",
        enabled: true,
        adapted: true,
        config: { guardWhenRtkMissing: true, showRewriteNotifications: true },
      },
      {
        id: "local",
        name: "本地扩展 · 演示",
        source: "extensions/example.ts",
        type: "file",
        description: "当前工作空间的 pi 扩展。",
        enabled: true,
        adapted: false,
      },
    ];
    const demoProviders = [
      {
        id: "example",
        name: "兼容服务 · 演示",
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        custom: true,
        keyConfigured: false,
        models: [{ id: "example-model", name: "示例模型" }],
        auth: {},
      },
    ];
    sessions = [
      {
        id: "demo-1",
        name: "搭建 pi 工作空间",
        messageCount: demoMessages.length,
      },
      {
        id: "demo-2",
        name: "检查模型与扩展",
        messageCount: demoMessages.length,
      },
    ];
    renderMessages(demoMessages);
    renderSessions();
    state.model = selected;
    syncChatViews();
    packageSettings.applyInventory({ rows: demoPlugins });
    providerSettings.applyInventory("providers", { rows: demoProviders });
    providerSettings.applyInventory("modelChoices", { rows: demoProviders });
    syncComposerButton();
    revealShell();
    await showView(
      titles[location.hash.slice(1)] ? location.hash.slice(1) : "workspace",
    );
    return;
  }
  $("#prompt").disabled = true;
  $("#send-button").disabled = true;
  $("#connection-status").textContent = "连接 Pi…";
  // 首份快照尚未返回时，只展示真实的加载状态，不能沿用 HTML 里的示例身份。
  $("#session-title").textContent = "正在载入会话…";
  $("#runtime-label").textContent = "连接 Pi…";
  $("#workspace-name").textContent = "工作空间";
  $("#workspace-path").textContent = "正在载入…";
  // 停止会话由 pi-history 提供，不经过 Durable 的切换消息；首次读取同样显示骨架。
  renderConversationLoading("正在载入会话…");
  // 骨架已经是可展示的加载面：此时再显示外壳，避免静态占位内容闪现。
  revealShell();
  await refresh();
  await showView(
    titles[location.hash.slice(1)] ? location.hash.slice(1) : "workspace",
  );
  interactionTimer = setInterval(() => pollInteractions(), 1200);
}
boot().catch((error) => {
  revealShell();
  $("#connection-status").textContent = "未连接";
  $("#prompt").disabled = true;
  $("#send-button").disabled = true;
  toast(`${error.message}。正在自动重试连接。`);
});
