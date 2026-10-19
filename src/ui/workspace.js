import {
  normalizeSidebarView,
  orderSessions,
  workspaceParents,
} from "./sidebar-view.mjs";
import { dshIcon } from "./dsh-icons.mjs";
import { createIndexedFetch } from "./lazy-data.mjs";
import { createHostTaskPanel } from "./host-task-panel.js";

/**
 * 工作区入口：Desktop Agent 导航、原生历史分支选择与全 Host 任务窗口。
 *
 * 接口：生命周期命令与导航字段见 docs/architecture/interfaces/lifecycle.md；
 *   同源 iframe 通过 select-conversation／session-changed 同步客户端选择。
 * 不变量：分支请求固定 Agent／generation／会话；选择不停止后台工作，晚到回执
 *   不导航另一会话；停止的历史分支先启动原 worker，远程能力不由 UI 扩大。
 * 错误：当前 HTTP 失败显示 notice；超时不宣称工作已取消，旧窗口消息忽略。
 */
const indexedFetch = createIndexedFetch();
const $ = (selector) => document.querySelector(selector);
const statuses = {
  running: "运行中",
  stopped: "已停止",
  failed: "启动失败",
  starting: "启动中",
  stopping: "停止中",
  history: "Pi TUI · 记录",
  missing: "记录已移除",
};
let state,
  selected =
    new URL(location.href).searchParams.get("agent") ??
    sessionStorage.getItem("pi-desktop-selected-agent") ??
    "",
  tab = "workspace",
  frameKey = "",
  editing,
  pending = false,
  pendingOperation,
  removeTarget;
const scanUrl = new URL(location.href);
if (scanUrl.searchParams.has("agent")) {
  scanUrl.searchParams.delete("agent");
  history.replaceState(
    null,
    "",
    scanUrl.pathname + scanUrl.search + scanUrl.hash,
  );
}
let timer;
const frames = new Map();
const collapsedProjects = {};
const expandedSessions = new Set();
const pendingDrafts = new Map();
const selectedConversations = new Map();
let navigationEpoch = 0;
const conversationKey = (agent) =>
  `pi-desktop:conversation:${agent.id}:${agent.generation ?? 0}`;
function rememberConversation(agent, id) {
  selectedConversations.set(agent.id, {
    generation: agent.generation ?? 0,
    id,
  });
  sessionStorage.setItem(conversationKey(agent), String(id));
}
let storedView;
try {
  storedView = JSON.parse(
    localStorage.getItem("pi-desktop-sidebar-view") ?? "{}",
  );
} catch {}
let sidebarView = normalizeSidebarView(storedView);
let manualCollapsed =
  localStorage.getItem("pi-desktop-sidebar-collapsed") === "true";
let search = "",
  renameTarget;
const iconButton = (name, action, className = "") => {
  const node = button("", action, className);
  node.innerHTML = dshIcon(name);
  return node;
};
function relativeTime(value) {
  if (!value) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)} 天`;
  return `${Math.floor(seconds / 2592000)} 个月`;
}
function rename(id) {
  renameTarget = id;
  const project = id.startsWith("project:");
  const record = project
    ? state.projects.find((row) => row.id === id.slice(8))
    : state.agents.find((row) => row.id === id);
  $("#rename-dialog h2").textContent = project ? "重命名项目" : "重命名会话";
  $("#rename-form").elements.name.value = record.name;
  $("#rename-error").textContent = "";
  void window.piDesk?.browserCommand?.({ action: "hide" }).catch(() => {});
  $("#rename-dialog").showModal();
}

function visibleAgents(projectId, all = false) {
  return orderSessions(
    state.agents.filter(
      (row) =>
        (all || row.projectId === projectId) &&
        (sidebarView.archived === "show" ||
          !!row.archived === (sidebarView.archived === "only")) &&
        (!search ||
          `${row.name} ${(row.branches ?? []).map((branch) => branch.name).join(" ")} ${state.projects.find((project) => project.id === row.projectId)?.name ?? ""}`
            .toLowerCase()
            .includes(search)),
    ),
    sidebarView,
  );
}
function saveSidebarView() {
  localStorage.setItem("pi-desktop-sidebar-view", JSON.stringify(sidebarView));
  render();
}
function moveSession(id, direction) {
  const row = state.agents.find((row) => row.id === id);
  const rows = visibleAgents(row.projectId),
    index = rows.findIndex((row) => row.id === id);
  const next = index + direction;
  if (next < 0 || next >= rows.length) return;
  [rows[index], rows[next]] = [rows[next], rows[index]];
  const ids = rows.map((row) => row.id);
  sidebarView.manual = [
    ...ids,
    ...sidebarView.manual.filter((id) => !ids.includes(id)),
  ];
  saveSidebarView();
}
function openViewOptions(event) {
  const anchor = $("#filter-toggle"),
    menu = $("#agent-menu");
  menuTarget = "view:options";
  menuAnchor = anchor;
  menu.replaceChildren();
  for (const [key, heading, choices] of [
    [
      "groupBy",
      "分组",
      [
        ["workspace", "按工作区"],
        ["workspace-tree", "工作区目录树"],
        ["flat", "所有会话"],
      ],
    ],
    [
      "orderBy",
      "排序",
      [
        ["manual", "自定义顺序"],
        ["updated", "最近更新"],
      ],
    ],
    [
      "archived",
      "归档",
      [
        ["hide", "隐藏归档"],
        ["show", "显示归档"],
        ["only", "仅显示归档"],
      ],
    ],
  ]) {
    const label = document.createElement("div");
    label.className = "menu-label";
    label.textContent = heading;
    menu.append(label);
    for (const [value, text] of choices) {
      const item = button(
        `${text}${sidebarView[key] === value ? " ✓" : ""}`,
        () => {
          sidebarView[key] = value;
          closeMenu(true);
          saveSidebarView();
        },
      );
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(sidebarView[key] === value));
      item.dataset.viewOption = `${key}:${value}`;
      menu.append(item);
    }
  }
  $("#filter-toggle").setAttribute("aria-expanded", "true");
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector("button").focus();
}

let menuTarget, menuAnchor;
function closeMenu(restore = false) {
  $("#agent-menu").hidden = true;
  $("#filter-toggle").setAttribute("aria-expanded", "false");
  if (restore) menuAnchor?.focus();
  menuAnchor = undefined;
  menuTarget = undefined;
}
function updateMenu() {
  if (!menuTarget || menuTarget.startsWith("view:")) return;
  const projectMenu = menuTarget.startsWith("project:");
  const target = projectMenu
    ? state.projects.find((row) => row.id === menuTarget.slice(8))
    : state.agents.find((row) => row.id === menuTarget);
  if (!target) return closeMenu();
  const active = ["starting", "running", "stopping"].includes(target.status);
  for (const item of $("#agent-menu").querySelectorAll("button")) {
    const command = item.dataset.command;
    let reason = pending ? "正在处理管理操作，请稍候" : "";
    if (!reason && projectMenu && command === "project.remove") {
      if (
        state.agents.some(
          (row) =>
            row.projectId === target.id &&
            ["starting", "running", "stopping"].includes(row.status),
        )
      )
        reason = "请先停止该项目的 Agent 再移除工作区";
    } else if (!reason && !projectMenu) {
      if (["starting", "stopping"].includes(target.status))
        reason = "会话进程正在启动或停止，请稍候";
      else if (
        command === "conversation.fork" &&
        (target.status !== "running" ||
          target.projectId === null ||
          document.body.classList.contains("remote-client"))
      )
        reason =
          target.projectId === null
            ? "只读会话不能创建分支"
            : target.status !== "running"
              ? "请先启动会话"
              : "远程连接不提供创建分支";
      else if (command === "agent.archive" && active)
        reason = "请先停止会话进程再归档";
      else if (command === "agent.archive" && target.archived)
        reason = "此会话已归档";
      else if (
        ["agent.start", "agent.resume"].includes(command) &&
        (active || target.archived || target.archivePending)
      )
        reason = active ? "会话进程已在运行" : "请先恢复会话或完成归档";
      else if (
        ["agent.stop", "agent.restart"].includes(command) &&
        target.status !== "running"
      )
        reason = "会话进程已停止";
      else if (command === "agent.restore" && !target.archived)
        reason = "此会话尚未归档";
    }
    item.disabled = !!reason;
    item.title =
      reason ||
      (command === "conversation.fork"
        ? "创建继承此会话当前上下文的新会话，原会话保持不变"
        : "");
  }
}
function confirmRemoveProject(project) {
  removeTarget = project.id;
  $("#remove-project-name").textContent = project.name;
  $("#remove-project-description").textContent =
    `从 Desktop 移除此工作区及 ${state.agents.filter((row) => row.projectId === project.id).length} 个会话的入口。项目文件、Pi 会话和归档记录会保留；重新添加同一目录即可恢复。`;
  $("#remove-project-error").textContent = "";
  void window.piDesk?.browserCommand?.({ action: "hide" }).catch(() => {});
  $("#remove-project-dialog").showModal();
}
function openProjectMenu(project, event, anchor) {
  menuTarget = `project:${project.id}`;
  menuAnchor = anchor;
  const menu = $("#agent-menu");
  menu.replaceChildren(
    button("新会话", () => {
      closeMenu();
      edit("agent", undefined, project.id);
    }),
    button("重命名项目", () => {
      closeMenu();
      rename(`project:${project.id}`);
    }),
    button(
      "移除工作区",
      () => {
        closeMenu();
        confirmRemoveProject(project);
      },
      "danger",
    ),
  );
  menu.lastChild.dataset.command = "project.remove";
  for (const node of menu.children) node.setAttribute("role", "menuitem");
  updateMenu();
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX || rect.right, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY || rect.bottom, innerHeight - menu.offsetHeight - 8))}px`;
  menu.firstChild.focus();
}
function openMenu(id, event, anchor, conversationId) {
  const agent = state.agents.find((row) => row.id === id);
  if (!agent) return;
  const branch =
    conversationId === undefined
      ? undefined
      : agent.branches?.find((row) => row.id === conversationId);
  if (conversationId !== undefined && !branch) return;
  menuTarget = id;
  menuAnchor = anchor;
  const menu = $("#agent-menu");
  const entries = agent.archived
    ? [["恢复会话", "agent.restore"]]
    : branch
      ? [["创建分支", "conversation.fork"]]
      : agent.source === "pi"
        ? [["在 Desktop 中继续", "agent.resume"]]
        : agent.status === "running"
          ? [
              ["停止进程", "agent.stop"],
              ["重启进程", "agent.restart"],
            ]
          : [
              ["启动会话", "agent.start"],
              ...(agent.nativeSessionAvailable
                ? [["接管 Pi 最新记录", "agent.resume"]]
                : []),
            ];
  if (!branch && !agent.archived && agent.source !== "pi")
    entries.unshift(["创建分支", "conversation.fork"]);
  menu.replaceChildren(
    ...entries.map(([label, command]) => {
      const node = button(label, async () => {
        closeMenu();
        const epoch = navigationEpoch;
        const result = await action(
          command,
          id,
          command === "conversation.fork"
            ? {
                generation: agent.generation ?? 0,
                ...(branch ? { conversationId: branch.id } : {}),
              }
            : {},
        );
        if (
          command === "conversation.fork" &&
          result?.sessionId &&
          epoch === navigationEpoch &&
          state.agents.some(
            (row) =>
              row.id === id &&
              row.status === "running" &&
              !row.archived &&
              (row.generation ?? 0) === (agent.generation ?? 0),
          )
        )
          selectAgent(agent, Number(result.sessionId));
      });
      node.dataset.command = command;
      node.setAttribute("role", "menuitem");
      return node;
    }),
    ...(!branch && !agent.archived
      ? [
          button(agent.pinned ? "取消置顶" : "置顶", () => {
            closeMenu();
            void action("agent.pin", id);
          }),
          button("重命名", () => {
            closeMenu();
            rename(id);
          }),
          button("归档会话", () => {
            closeMenu();
            void action("agent.archive", id);
          }),
        ]
      : []),
    ...(!branch && sidebarView.orderBy === "manual"
      ? [
          button("上移", () => {
            closeMenu();
            moveSession(id, -1);
          }),
          button("下移", () => {
            closeMenu();
            moveSession(id, 1);
          }),
        ]
      : []),
    ...(branch || agent.source === "pi"
      ? []
      : [
          button("人格设置", () => {
            closeMenu();
            selected = id;
            setView("personality");
          }),
        ]),
  );
  const archiveButton = [...menu.children].find(
    (item) => item.textContent === "归档会话",
  );
  if (archiveButton) {
    archiveButton.dataset.command = "agent.archive";
  }
  for (const item of menu.children) {
    item.setAttribute("role", "menuitem");
  }
  updateMenu();
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX || rect.right, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY || rect.bottom, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector("button:not(:disabled)")?.focus();
}
document.addEventListener("pointerdown", (event) => {
  if (!$("#agent-menu").contains(event.target)) closeMenu();
});
window.addEventListener("blur", () => closeMenu());
document.addEventListener("keydown", (event) => {
  if ($("#agent-menu").hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
    return;
  }
  const items = [...$("#agent-menu").querySelectorAll("button:not(:disabled)")];
  if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    items[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
            items.length
    ]?.focus();
  }
  if (event.key === "Tab") closeMenu();
});
function sendView() {
  frames
    .get(frameKey)
    ?.contentWindow?.postMessage(
      { type: "pi-desktop:view", view: tab },
      location.origin,
    );
}
function setView(next) {
  tab = next;
  if (next !== "workspace")
    void window.piDesk?.browserCommand?.({ action: "hide" }).catch(() => {});
  navigation(false);
  render();
  sendView();
}
function sendConfiguration(frame) {
  const agent = state.agents.find((row) => row.id === frame.dataset.owner);
  const project = state.projects.find((row) => row.id === agent?.projectId);
  frame.contentWindow?.postMessage(
    {
      type: "pi-desktop:workspace-config",
      agent,
      project,
      projects: state.projects,
      promptProfiles: state.promptProfiles,
      sidebarCollapsed: manualCollapsed,
      nativeBrowser: !!window.piDesk?.browserCommand,
      focused: frame.dataset.owner === selected,
    },
    location.origin,
  );
}
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  const frame = frames.get(frameKey);
  if (!frame || event.source !== frame.contentWindow) return;
  if (event.data?.type === "pi-desktop:browser-request") {
    const { requestId, input } = event.data;
    if (
      typeof requestId !== "string" ||
      requestId.length > 100 ||
      !input ||
      !window.piDesk?.browserCommand
    )
      return;
    const command = { ...input, owner: frame.dataset.owner };
    if (command.action === "layout") {
      const bounds = frame.getBoundingClientRect();
      if (
        tab !== "workspace" ||
        frame.hidden ||
        document.querySelector("dialog[open]")
      )
        command.action = "hide";
      else if (command.bounds)
        command.bounds = {
          ...command.bounds,
          x: command.bounds.x + bounds.left,
          y: command.bounds.y + bounds.top,
        };
    }
    void window.piDesk.browserCommand(command).then(
      (result) =>
        frame.contentWindow?.postMessage(
          { type: "pi-desktop:browser-response", requestId, result },
          location.origin,
        ),
      (error) =>
        frame.contentWindow?.postMessage(
          {
            type: "pi-desktop:browser-response",
            requestId,
            error: error.message,
          },
          location.origin,
        ),
    );
    return;
  }
  if (event.data?.type === "pi-desktop:ready" && pendingDrafts.has(selected)) {
    frame.contentWindow.postMessage(
      { type: "pi-desktop:restore-draft", draft: pendingDrafts.get(selected) },
      location.origin,
    );
    pendingDrafts.delete(selected);
  }
  if (event.data?.type === "pi-desktop:session-changed") {
    const conversationId = event.data.conversationId;
    const agent = state.agents.find((row) => row.id === frame.dataset.owner);
    if (!agent || !Number.isSafeInteger(conversationId) || conversationId < 0)
      return;
    const prior = selectedConversations.get(agent.id);
    if (
      prior?.id !== conversationId ||
      prior.generation !== (agent.generation ?? 0)
    ) {
      rememberConversation(agent, conversationId);
      navigationEpoch++;
      render();
    }
    void refresh().catch((error) => notice(error.message));
    return;
  }
  if (event.data?.type === "pi-desktop:project")
    void createInProject(event.data.projectId, event.data.draft);
  if (event.data?.type === "pi-desktop:resume")
    void action("agent.resume", selected);
  if (event.data?.type === "pi-desktop:policy")
    void action("agent.policy", selected, { mode: event.data.mode });
  if (event.data?.type === "pi-desktop:prompt")
    void action("agent.prompt", selected, {
      promptProfileId: event.data.promptProfileId,
    });
  if (event.data?.type === "pi-desktop:configure-prompt")
    edit(
      "prompt",
      state.promptProfiles.find((row) => row.id === event.data.id),
    );
  if (event.data?.type === "pi-desktop:toggle-sidebar") toggleSidebar();
  if (event.data?.type === "pi-desktop:view-changed") {
    tab = event.data.view;
    if (tab !== "workspace")
      void window.piDesk?.browserCommand?.({ action: "hide" }).catch(() => {});
    navigation(false);
    $("#settings").setAttribute(
      "aria-pressed",
      String(!["workspace", "extensions"].includes(tab)),
    );
    $("#extensions-entry").setAttribute(
      "aria-pressed",
      String(tab === "extensions"),
    );
  }
});
let refreshGeneration = 0,
  workspaceRequests = 0,
  workspaceRead,
  authorizationExpired = false,
  navigationSignature = "";
function toggleSidebar() {
  if (matchMedia("(max-width:720px)").matches)
    navigation(!document.body.classList.contains("navigation-open"));
  else {
    manualCollapsed = !manualCollapsed;
    localStorage.setItem(
      "pi-desktop-sidebar-collapsed",
      String(manualCollapsed),
    );
    navigation(false);
    const frame = frames.get(frameKey);
    if (frame) sendConfiguration(frame);
  }
}
function navigation(open) {
  document.body.classList.toggle("navigation-open", open);
  $("#nav-backdrop").hidden = !open;
  $("#navigation-toggle").setAttribute("aria-expanded", String(open));
  const mobile = matchMedia("(max-width:720px)").matches;
  const collapsed =
    !["workspace", "extensions"].includes(tab) || (!mobile && manualCollapsed);
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  $("#sidebar-collapse").setAttribute("aria-expanded", String(!collapsed));
  const hidden = collapsed || (mobile && !open);
  $("#workspace-nav").inert = hidden;
  $("#workspace-nav").setAttribute("aria-hidden", String(hidden));
}
async function api(path, input, signal) {
  return indexedFetch(
    path,
    input === undefined
      ? { signal }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal,
        },
  );
}

function notice(message) {
  $("#notice").textContent = message;
  $("#notice").hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => {
    $("#notice").hidden = true;
  }, 6000);
}
function button(text, action, className = "") {
  const node = document.createElement("button");
  node.textContent = text;
  node.className = className;
  node.addEventListener("click", action);
  return node;
}
function selectAgent(agent, conversationId) {
  closeMenu();
  navigationEpoch++;
  if (conversationId !== undefined) rememberConversation(agent, conversationId);
  selected = agent.id;
  tab = "workspace";
  localStorage.setItem("pi-desktop-selected", selected);
  navigation(false);
  render();
  sendView();
  if (conversationId !== undefined)
    frames.get(frameKey)?.contentWindow?.postMessage(
      {
        type: "pi-desktop:select-conversation",
        conversationId,
        generation: agent.generation ?? 0,
      },
      location.origin,
    );
}
function agentButton(agent, branch) {
  const conversation = selectedConversations.get(agent.id);
  const current =
    conversation?.generation === (agent.generation ?? 0)
      ? conversation.id
      : undefined;
  const active =
    agent.id === selected &&
    (branch
      ? branch.id === current
      : !(agent.branches ?? []).some((row) => row.id === current));
  const item = button(
    "",
    () => selectAgent(agent, branch?.id ?? agent.rootConversationId),
    "agent" + (active ? " selected" : ""),
  );
  const dot = document.createElement("i");
  dot.className = "dot " + agent.status;
  const label = document.createElement("span");
  label.textContent = branch?.name ?? agent.name;
  if (branch) {
    dot.className = "session-branch-icon";
    dot.innerHTML = dshIcon("branch");
  }
  if (agent.pinned && !branch) {
    dot.className = "session-pin";
    dot.innerHTML = dshIcon("pin");
  }
  const status = document.createElement("small");
  status.textContent = branch
    ? `#${branch.id}`
    : pendingOperation?.id === agent.id
      ? pendingOperation.label
      : ["running", "history"].includes(agent.status)
        ? relativeTime(agent.updatedAt ?? agent.createdAt)
        : statuses[agent.status];
  if (
    !branch &&
    pendingOperation?.id !== agent.id &&
    ["running", "history"].includes(agent.status) &&
    (agent.updatedAt ?? agent.createdAt)
  )
    status.dataset.updatedAt = agent.updatedAt ?? agent.createdAt;
  item.append(dot, label, status);
  item.title = branch
    ? `${branch.name} · 从会话 #${branch.forkOf.conversationId} 创建的分支 · 右键管理`
    : (agent.error ??
      `${agent.name} · ${statuses[agent.status]}${agent.pid ? " · PID " + agent.pid : ""} · 右键管理`);
  item.dataset.agentId = agent.id;
  if (branch) item.dataset.conversationId = String(branch.id);
  item.setAttribute("aria-busy", String(pendingOperation?.id === agent.id));
  const row = document.createElement("div");
  row.className = "agent-row" + (branch ? " native-branch" : "");
  const more = iconButton(
    "more",
    (event) => openMenu(agent.id, event, more, branch?.id),
    "agent-more",
  );
  more.setAttribute("aria-label", `管理 ${branch?.name ?? agent.name}`);
  more.setAttribute("aria-haspopup", "menu");
  row.append(item, more);
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenu(agent.id, event, item, branch?.id);
  });
  row.addEventListener("keydown", (event) => {
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      openMenu(agent.id, event, item, branch?.id);
    }
  });
  if (branch || !agent.branches?.length) return row;
  const family = document.createElement("div");
  family.className = "agent-family";
  family.setAttribute("role", "group");
  family.setAttribute("aria-label", `${agent.name} 的会话`);
  family.append(
    row,
    ...agent.branches.map((member) => agentButton(agent, member)),
  );
  return family;
}
function render() {
  if (selected) sessionStorage.setItem("pi-desktop-selected-agent", selected);
  for (const node of document.querySelectorAll("small[data-updated-at]"))
    node.textContent = relativeTime(node.dataset.updatedAt);
  const signature = JSON.stringify([
    state.projects,
    state.agents,
    selected,
    [...selectedConversations],
    collapsedProjects,
    search,
    sidebarView,
    [...expandedSessions],
    pendingOperation,
  ]);
  if (signature !== navigationSignature) {
    navigationSignature = signature;
    $("#conversations").replaceChildren(
      ...(sidebarView.groupBy === "flat" ? [] : visibleAgents(null)).map(
        (agent) => agentButton(agent),
      ),
    );
    const nodes = state.projects
      .filter(
        (project) =>
          (project.source !== "pi" || visibleAgents(project.id).length) &&
          (sidebarView.archived !== "only" || visibleAgents(project.id).length),
      )
      .filter(
        (project) =>
          !search ||
          project.name.toLowerCase().includes(search) ||
          visibleAgents(project.id).length,
      )
      .map((project) => {
        const section = document.createElement("section");
        section.className = "project";
        section.dataset.projectId = project.id;
        const title = document.createElement("div");
        title.className = "project-title";
        const name = button(
          project.name,
          () => {
            const hidden = section.classList.toggle("collapsed");
            collapsedProjects[project.id] = hidden;
            name.setAttribute("aria-expanded", String(!hidden));
          },
          "project-name",
        );
        section.classList.toggle("collapsed", !!collapsedProjects[project.id]);
        name.setAttribute(
          "aria-expanded",
          String(!collapsedProjects[project.id]),
        );
        name.title = project.cwd;
        const folder = document.createElement("span");
        folder.className = "project-folder";
        folder.innerHTML = dshIcon(
          state.agents.some(
            (row) => row.id === selected && row.projectId === project.id,
          )
            ? "folder-open"
            : "folder",
        );
        const triangle = document.createElement("span");
        triangle.className = "project-chevron";
        triangle.innerHTML = dshIcon("triangle");
        name.prepend(folder, triangle);
        const manage = iconButton(
          "more",
          (event) => openProjectMenu(project, event, manage),
          "project-manage",
        );
        manage.setAttribute("aria-label", `管理项目 ${project.name}`);
        name.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openProjectMenu(project, event, name);
        });
        name.addEventListener("keydown", (event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            openProjectMenu(project, event, name);
          }
        });
        const add = iconButton("plus", () =>
          edit("agent", undefined, project.id),
        );
        add.setAttribute("aria-label", `在 ${project.name} 创建 Agent`);
        title.append(name, manage, add);
        section.append(title);
        const agents = visibleAgents(project.id);
        const count =
          search || expandedSessions.has(project.id) ? agents.length : 5;
        const shown = agents.slice(0, count);
        const current = agents.find((row) => row.id === selected);
        if (current && !shown.includes(current)) shown.push(current);
        for (const agent of shown) section.append(agentButton(agent));
        if (agents.length > shown.length)
          section.append(
            button(
              `展开其余 ${agents.length - shown.length} 个会话`,
              () => {
                expandedSessions.add(project.id);
                render();
              },
              "more-sessions",
            ),
          );
        return section;
      });
    if (sidebarView.groupBy === "flat")
      $("#projects").replaceChildren(
        ...visibleAgents(null, true).map((agent) => agentButton(agent)),
      );
    else {
      $("#projects").replaceChildren(...nodes);
      if (sidebarView.groupBy === "workspace-tree") {
        const parents = workspaceParents(state.projects),
          elements = new Map(
            nodes.map((node) => [node.dataset.projectId, node]),
          );
        for (const [id, parent] of parents)
          if (parent && elements.has(parent) && elements.has(id)) {
            elements.get(parent).append(elements.get(id));
            elements.get(id).classList.add("nested-project");
          }
      }
    }
  }
  $("#process-count").textContent =
    `${state.agents.filter((row) => row.status === "running").length} 个进程`;
  const agent = state.agents.find((row) => row.id === selected);
  const project = state.projects.find((row) => row.id === agent?.projectId);
  const conversation = agent && selectedConversations.get(agent.id);
  const branch =
    conversation?.generation === (agent?.generation ?? 0)
      ? agent?.branches?.find((row) => row.id === conversation.id)
      : undefined;
  const running =
    ["running", "history"].includes(agent?.status) ||
    (!branch &&
      agent?.historyAvailable &&
      ["workspace", "extensions"].includes(tab) &&
      !["starting", "stopping"].includes(agent?.status));
  document.body.classList.toggle("runtime-active", !!running);
  $("#title").textContent = agent
    ? project
      ? `${project.name} / ${agent.name}`
      : agent.name
    : "项目工作空间";
  $("#subtitle").textContent = agent
    ? `${project?.cwd ?? "无项目 · 只读 / 网页搜索"} · ${statuses[agent.status]}${agent.pid ? " · PID " + agent.pid : ""}`
    : "为每个项目启动独立 Agent";
  $("#settings").setAttribute(
    "aria-pressed",
    String(!["workspace", "extensions"].includes(tab)),
  );
  $("#extensions-entry").setAttribute(
    "aria-pressed",
    String(tab === "extensions"),
  );
  $("#offline-settings").hidden = running || tab === "workspace";
  $("#offline-settings h1").textContent =
    tab === "extensions" ? "扩展工作台" : "设置";
  $("#settings-start").disabled =
    !agent || pending || ["starting", "stopping"].includes(agent.status);
  // A selected but inactive Agent shows an intentional boot surface; the
  // project marketing hero belongs only to the no-Agent workspace.
  const booting = !!agent && !running && tab === "workspace";
  $("#empty").hidden = running || !!agent || tab !== "workspace";
  $("#agent-boot").hidden = !booting;
  if (!agent) {
    $("#empty h1").textContent = "Make it yours.";
    $("#empty p").textContent =
      "添加本地项目，创建独立 Agent。会话、任务和配置持久保存，切换项目时后台工作继续。";
    $("#empty-add").hidden = false;
  }
  if (booting) {
    const transitioning = ["starting", "stopping"].includes(agent.status);
    $("#agent-boot").classList.toggle("is-starting", transitioning);
    $("#agent-boot-title").textContent = transitioning
      ? agent.status === "stopping"
        ? `正在停止 ${agent.name}`
        : `正在启动 ${agent.name}`
      : (branch?.name ?? agent.name);
    $("#agent-boot-note").textContent = transitioning
      ? "正在连接 Pi 会话、工具与扩展…"
      : (agent.error ??
        (branch
          ? "此分支由原 Agent 的同一进程承载，启动后继续此分支。"
          : `${statuses[agent.status] ?? "未运行"} · 启动后继续此 Agent 的会话与后台任务`));
    $("#agent-boot-start").hidden =
      transitioning || !["stopped", "failed"].includes(agent.status);
    $("#agent-boot-start").disabled = pending;
  }
  const key = running
    ? `${agent.id}:${agent.generation ?? 0}:${agent.pid ?? "history"}`
    : "";
  for (const [id, frame] of frames) {
    const [owner, generation, pid] = id.split(":");
    if (
      !state.agents.some(
        (row) =>
          row.id === owner &&
          String(row.generation ?? 0) === generation &&
          String(row.pid ?? "history") === pid &&
          (["running", "history"].includes(row.status) ||
            row.historyAvailable) &&
          (row.status === "running" || row.id === selected),
      )
    ) {
      void window.piDesk
        ?.browserCommand?.({ action: "release", owner })
        .catch(() => {});
      frame.remove();
      frames.delete(id);
    } else {
      frame.hidden = id !== key;
      sendConfiguration(frame);
      frame.removeAttribute("id");
    }
  }
  if (frameKey !== key) {
    void window.piDesk?.browserCommand?.({ action: "hide" }).catch(() => {});
    frameKey = key;
    const placeholder = $("#runtime");
    if (placeholder && !placeholder.dataset.owner) placeholder.remove();
    if (running && !frames.has(key)) {
      const frame = document.createElement("iframe");
      frame.title = `${agent.name} · Pi Agent 工作空间`;
      frame.dataset.owner = agent.id;
      const conversation = selectedConversations.get(agent.id);
      frame.src = `/agents/${agent.id}/?embed=1${conversation?.generation === (agent.generation ?? 0) ? `&agent=${conversation.id}` : ""}#${tab}`;
      frame.addEventListener("load", () => {
        sendConfiguration(frame);
        if (frame.dataset.owner === selected) sendView();
      });
      frames.set(key, frame);
      $("main").append(frame);
    }
    if (running)
      frames
        .get(key)
        .contentWindow?.postMessage(
          { type: "pi-desktop:view", view: tab },
          location.origin,
        );
  }
  if (running) {
    frames.get(key).id = "runtime";
    frames.get(key).hidden = false;
  }
  if (running) sendConfiguration(frames.get(key));
  updateMenu();
}
async function refresh() {
  workspaceRead?.abort();
  const controller = new AbortController();
  workspaceRead = controller;
  const deadline = setTimeout(
    () => controller.abort(new Error("连接超时，正在重试")),
    8000,
  );
  const generation = ++refreshGeneration;
  workspaceRequests++;
  try {
    const value = await api(
      "/api/workspace?view=index",
      undefined,
      controller.signal,
    );
    if (generation !== refreshGeneration) return;
    state = value;
    for (const agent of state.agents) {
      if (
        selectedConversations.get(agent.id)?.generation ===
        (agent.generation ?? 0)
      )
        continue;
      selectedConversations.delete(agent.id);
      const stored = sessionStorage.getItem(conversationKey(agent));
      if (/^\d+$/.test(stored ?? "") && Number.isSafeInteger(Number(stored)))
        rememberConversation(agent, Number(stored));
    }
    if (
      !state.agents.some(
        (row) =>
          row.id === selected &&
          (sidebarView.archived !== "hide" || !row.archived),
      )
    )
      selected =
        state.agents.find((row) => row.projectId === null && !row.archived)
          ?.id ?? "";
    authorizationExpired = false;
    render();
  } catch (error) {
    if (generation !== refreshGeneration) return;
    if ([401, 403].includes(error.status)) authorizationExpired = true;
    throw error;
  } finally {
    clearTimeout(deadline);
    if (workspaceRead === controller) workspaceRead = undefined;
    workspaceRequests--;
  }
}
async function edit(kind, record, projectId) {
  if (record) {
    try {
      record = await api(
        `/api/workspace/detail?kind=${kind}&id=${encodeURIComponent(record.id)}`,
      );
    } catch (error) {
      notice(error.message);
      return;
    }
  }
  editing = { kind, record, projectId, revision: state.revision };
  const form = $("#editor-form");
  form.reset();
  $("#editor-title").textContent = record
    ? `编辑${kind === "project" ? "项目" : "Agent"}配置`
    : kind === "prompt"
      ? "添加系统提示词"
      : kind === "project"
        ? "添加项目"
        : "创建 Agent";
  form.elements.name.value = record?.name ?? "";
  form.elements.cwd.value = record?.cwd ?? "";
  form.elements.cwd.required = kind === "project";
  form.elements.cwd.readOnly = !!record;
  $("#directory-field").hidden = kind !== "project";
  $("#pick-directory").hidden = !!record || !window.piDesk?.pickDirectory;
  form.elements.instructions.value = record?.instructions ?? "";
  $("#personality-fields").hidden = kind !== "prompt";
  $("#editor-error").textContent = "";
  void window.piDesk?.browserCommand?.({ action: "hide" }).catch(() => {});
  $("#editor").showModal();
}
async function action(command, id = selected, patch = {}) {
  if (pending) return false;
  pending = true;
  pendingOperation = {
    command,
    id,
    label:
      {
        "agent.archive": "正在归档…",
        "agent.restore": "正在恢复…",
        "agent.stop": "正在停止…",
        "agent.start": "正在启动…",
        "agent.restart": "正在重启…",
        "agent.resume": "正在接管…",
        "conversation.fork": "正在创建分支…",
      }[command] ?? "正在处理…",
  };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 20000);
  let succeeded = false,
    result;
  render();
  try {
    result = await api(
      "/api/workspace/command",
      {
        command,
        ...patch,
        id,
      },
      controller.signal,
    );
    succeeded = true;
  } catch (error) {
    notice(
      controller.signal.aborted
        ? "管理请求超时，正在刷新实际状态；请确认结果后再重试"
        : error.message,
    );
  } finally {
    clearTimeout(deadline);
    pending = false;
    pendingOperation = undefined;
    await refresh().catch((error) => notice(error.message));
    render();
  }
  return command === "conversation.fork" ? result : succeeded;
}
async function newChat(projectId = null, draft) {
  if (pending) return;
  pending = true;
  $("#new-chat").disabled = true;
  $("#new-chat").textContent = "正在启动…";
  try {
    const result = await api("/api/workspace/command", {
      command: "conversation.create",
      projectId,
    });
    if (draft) pendingDrafts.set(result.id, draft);
    selected = result.id;
    tab = "workspace";
    navigation(false);
  } catch (error) {
    notice(error.message);
  } finally {
    pending = false;
    $("#new-chat").disabled = false;
    $("#new-chat").innerHTML = dshIcon("new-chat") + " 新会话";
    await refresh();
  }
}
async function createInProject(projectId, draft) {
  if (projectId !== null && !state.projects.some((row) => row.id === projectId))
    return;
  if (draft?.files?.some((file) => file.status !== "ready")) {
    notice("请等待附件读取完成再切换项目");
    return;
  }
  await newChat(projectId, draft);
}
$("#new-chat").onclick = () => newChat();
$("#skill-center").onclick = () => setView("skills");
$("#extensions-entry").onclick = () => setView("extensions");
const hostTaskPanel = createHostTaskPanel({
  root: $("#host-task-dialog"),
  request: api,
});
$("#tasks-entry").onclick = async () => {
  try {
    await window.piDesk?.browserCommand?.({ action: "hide" });
  } catch {
    notice("未能隐藏浏览器面板，请先手动关闭后再打开任务监控");
    return;
  }
  hostTaskPanel.open();
};
$("#search-toggle").onclick = () => {
  $("#workspace-search").hidden = !$("#workspace-search").hidden;
  if (!$("#workspace-search").hidden) $("#workspace-search").focus();
  else {
    search = "";
    $("#workspace-search").value = "";
    render();
  }
};
$("#workspace-search").oninput = (event) => {
  search = event.target.value.trim().toLowerCase();
  render();
};
$("#filter-toggle").onclick = openViewOptions;
$("#rename-cancel").onclick = () => $("#rename-dialog").close();
$("#rename-form").onsubmit = async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await api("/api/workspace/command", {
      command: renameTarget.startsWith("project:")
        ? "project.rename"
        : "agent.rename",
      id: renameTarget.startsWith("project:")
        ? renameTarget.slice(8)
        : renameTarget,
      name: event.currentTarget.elements.name.value,
    });
    $("#rename-dialog").close();
    await refresh();
  } catch (error) {
    $("#rename-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
for (const node of document.querySelectorAll("[data-dsh-icon]"))
  node.innerHTML = dshIcon(node.dataset.dshIcon);
$("#home").onclick = async () => {
  const agent = state.agents.find(
    (row) => row.projectId === null && !row.archived,
  );
  if (!agent) return newChat();
  selectAgent(agent);
  if (agent.status === "stopped" || agent.status === "failed")
    await action("agent.start");
};
const colorScheme = matchMedia("(prefers-color-scheme: dark)");
function appearance() {
  const preference = localStorage.getItem("pi-web-theme") ?? "light";
  const storedSize = Number(localStorage.getItem("pi-web-font-size") ?? 14);
  const fontSize = Number.isInteger(storedSize)
    ? Math.max(12, Math.min(24, storedSize))
    : 14;
  document.documentElement.dataset.theme =
    preference === "system"
      ? colorScheme.matches
        ? "dark"
        : "light"
      : preference;
  document.documentElement.style.setProperty("--ui-font-size", `${fontSize}px`);
  document.documentElement.style.setProperty(
    "--ui-font-scale",
    String(fontSize / 14),
  );
}
appearance();
window.addEventListener("storage", appearance);
colorScheme.addEventListener("change", appearance);
let pickingDirectory = false;
async function addProject() {
  if (pickingDirectory) return;
  pickingDirectory = true;
  $("#add-project").disabled = $("#empty-add").disabled = true;
  try {
    const cwd = window.piDesk?.pickDirectory
      ? await window.piDesk.pickDirectory()
      : (await api("/api/workspace/directory", {})).path;
    if (!cwd) return;
    await api("/api/workspace/command", { command: "project.save", cwd });
    await refresh();
  } catch (error) {
    notice(error.message);
  } finally {
    pickingDirectory = false;
    $("#add-project").disabled = $("#empty-add").disabled = false;
  }
}
$("#add-project").onclick = $("#empty-add").onclick = addProject;
$("#sidebar-collapse").onclick = toggleSidebar;
$("#navigation-toggle").onclick = toggleSidebar;
$("#nav-backdrop").onclick = () => navigation(false);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") navigation(false);
});
window.addEventListener("resize", () =>
  navigation(document.body.classList.contains("navigation-open")),
);
$("#settings-start").onclick = $("#agent-boot-start").onclick = () =>
  action("agent.start");
$("#settings").onclick = () => setView("general");
$("#settings-back").onclick = () => setView("workspace");
$("#close-editor").onclick = $("#cancel-editor").onclick = () =>
  $("#editor").close();
$("#remove-project-cancel").onclick = () => $("#remove-project-dialog").close();
$("#remove-project-dialog").addEventListener("cancel", (event) => {
  if (pendingOperation?.command === "project.remove") event.preventDefault();
});
$("#remove-project-form").onsubmit = async (event) => {
  event.preventDefault();
  if (pending || !removeTarget) return;
  const id = removeTarget;
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  $("#remove-project-cancel").disabled = true;
  submit.textContent = "正在移除…";
  $("#remove-project-error").textContent = "";
  try {
    const succeeded = await action("project.remove", id);
    if (succeeded || !state.projects.some((row) => row.id === id)) {
      $("#remove-project-dialog").close();
      removeTarget = undefined;
    } else {
      $("#remove-project-error").textContent = $("#notice").textContent;
    }
  } finally {
    submit.disabled = false;
    $("#remove-project-cancel").disabled = false;
    submit.textContent = "移除工作区";
  }
};
$("#pick-directory").onclick = async () => {
  try {
    const path = await window.piDesk.pickDirectory();
    if (path) $("#editor-form").elements.cwd.value = path;
  } catch (error) {
    $("#editor-error").textContent = error.message;
  }
};
$("#editor-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    const result = await api("/api/workspace/command", {
      command:
        editing.kind === "agent" && !editing.record
          ? "conversation.create"
          : `${editing.kind}.save`,
      id: editing.record?.id,
      projectId: editing.projectId,
      revision: editing.revision,
      name: form.elements.name.value,
      cwd: form.elements.cwd.value,
      ...(editing.kind === "prompt"
        ? {
            instructions: form.elements.instructions.value,
            fileRevision: editing.record?.fileRevision,
          }
        : {}),
    });
    if (editing.kind === "agent") {
      selected = result.id;
      if (!editing.record) tab = "workspace";
    }
    $("#editor").close();
    await refresh();
    if (editing.kind === "prompt" && selected)
      await action("agent.prompt", selected, { promptProfileId: result.id });
  } catch (error) {
    $("#editor-error").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
};
window.piDesk?.onBrowserState?.((value) => {
  for (const frame of frames.values())
    if (frame.dataset.owner === value.owner)
      frame.contentWindow?.postMessage(
        { type: "pi-desktop:browser-state", state: value },
        location.origin,
      );
});
for (const id of ["editor", "rename-dialog", "remove-project-dialog"])
  $("#" + id).addEventListener("close", () =>
    frames
      .get(frameKey)
      ?.contentWindow?.postMessage(
        { type: "pi-desktop:panel-visibility" },
        location.origin,
      ),
  );
function cancelWorkspaceRead() {
  refreshGeneration++;
  workspaceRead?.abort();
  workspaceRead = undefined;
}
function wakeWorkspace() {
  if (document.hidden || navigator.onLine === false) return;
  authorizationExpired = false;
  void refresh().catch((error) => notice(error.message));
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cancelWorkspaceRead();
  else wakeWorkspace();
});
window.addEventListener("offline", cancelWorkspaceRead);
window.addEventListener("online", wakeWorkspace);
window.addEventListener("pagehide", cancelWorkspaceRead);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) wakeWorkspace();
});
navigator.connection?.addEventListener("change", wakeWorkspace);
async function detectRemoteClient() {
  try {
    const info = await api("/api/remote");
    if (info?.remoteClient) document.body.classList.add("remote-client");
  } catch {
    /* A local workspace may not expose remote management; keep desktop chrome. */
  }
}
await detectRemoteClient();
navigation(false);
await refresh().catch((error) => notice(error.message));
/* The index poll asks for a cheap revision first; every third tick refreshes
 * anyway so a missed bit can only delay an update, never lose it. */
let revisionSupported,
  workspaceRevision,
  pollTick = 0;
async function catalogChanged() {
  pollTick++;
  if (revisionSupported === false) return true;
  try {
    const value = await api("/api/revision");
    if (!value?.supported) {
      revisionSupported = false;
      return true;
    }
    revisionSupported = true;
    if (value.workspace === undefined) return true;
    const changed = value.workspace !== workspaceRevision;
    workspaceRevision = value.workspace;
    return changed || pollTick % 3 === 0;
  } catch {
    return true;
  }
}
setInterval(() => {
  if (
    document.hidden ||
    navigator.onLine === false ||
    authorizationExpired ||
    workspaceRequests
  )
    return;
  void (async () => {
    if (!(await catalogChanged())) return;
    await refresh();
  })().catch((error) => notice(error.message));
}, 2000);
