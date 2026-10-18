import { dshIcon } from "./dsh-icons.mjs";
import { createAgentBrowserView } from "./agent-browser-view.js";

const node = (tag, className, text) => {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
};
const button = (label, action, icon) => {
  const value = node("button", "panel-button");
  value.type = "button";
  value.setAttribute("aria-label", label);
  value.title = label;
  if (icon) value.innerHTML = dshIcon(icon);
  else value.textContent = label;
  value.onclick = action;
  return value;
};
export function panelAddress(text) {
  const value = text.trim();
  if (!value) throw new Error("请输入网址或搜索内容");
  const host =
    /^(localhost|127\.0\.0\.1|\[[\da-f:]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i.test(
      value,
    );
  const candidate = host
    ? `${/^(localhost|127\.|\[)/.test(value) ? "http" : "https"}://${value}`
    : /^[a-z][a-z\d+.-]*:/i.test(value)
      ? value
      : `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
  const url = new URL(candidate);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("只支持不含凭据的 HTTP / HTTPS 网址");
  return url.href;
}

export function createWorkspacePanels({
  pane,
  request,
  snapshot,
  reveal,
  show,
  storageKey,
}) {
  const tabs = new Map(),
    calls = new Map();
  let intent = 0;
  let selected,
    native = false,
    agentBrowser = false,
    browserRemoteDisabled = false,
    rendering = false,
    browserRevision = -1,
    frame,
    lastBounds,
    lastCwd,
    tree = { cache: new Map(), open: new Set(), filter: "", generation: 0 },
    recent = [];
  try {
    recent = JSON.parse(localStorage.getItem(storageKey) ?? "[]")
      .filter(
        (row) =>
          row &&
          typeof row.url === "string" &&
          /^https?:\/\//.test(row.url) &&
          typeof row.title === "string",
      )
      .slice(0, 10);
  } catch {}
  pane.classList.add("workspace-panels");
  pane.setAttribute("aria-label", "网页、文件与改动浏览器");
  const legacy = node("div", "panel-legacy");
  for (const child of [...pane.children])
    if (!child.matches(".preview-resize, .right-tabs")) legacy.append(child);
  pane.append(legacy);
  const chrome = node("header", "panel-chrome"),
    strip = node("div", "panel-tab-strip");
  strip.id = "panel-tab-strip";
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", "工作区标签页");
  const plus = button("新标签页", () => openHome(), "plus");
  plus.id = "panel-new-tab";
  const collapse = button("收起右侧边栏", () => show(false), "sidebar");
  chrome.append(strip, plus, collapse);
  pane.prepend(chrome);
  const address = node("form", "panel-address"),
    input = node("input");
  input.id = "panel-address-input";
  input.setAttribute("aria-label", "搜索或输入网址");
  input.placeholder = "搜索或输入网址";
  const back = button("后退", () => navigateHistory("back")),
    forward = button("前进", () => navigateHistory("forward")),
    reload = button("刷新网页", () => navigateHistory("reload"));
  back.textContent = "←";
  forward.textContent = "→";
  reload.textContent = "↻";
  const go = button("打开网页", () => address.requestSubmit(), "send");
  const resolution = node("output", "panel-browser-resolution", "— × —");
  resolution.setAttribute("aria-label", "Chromium 画面分辨率");
  resolution.title = "Chromium 画面分辨率正在读取";
  resolution.hidden = true;
  address.append(back, forward, reload, input, go, resolution);
  const status = node("p", "panel-status");
  status.id = "panel-status";
  status.setAttribute("role", "status");
  status.hidden = true;
  const content = node("section", "panel-content"),
    viewport = node("div", "panel-web-viewport");
  viewport.id = "panel-web-viewport";
  const controls = node("div", "panel-document-controls");
  controls.hidden = true;
  pane.append(address, controls, status, content, viewport);
  function active() {
    return tabs.get(selected);
  }
  const browserView = createAgentBrowserView({
    viewport,
    request,
    onError: (error) => report(error.message),
    onResolution({ width, height, scale }) {
      resolution.textContent = `${width} × ${height}`;
      resolution.title = `Chromium · ${width} × ${height} 像素 · ${scale}× 高清画面`;
      resolution.hidden = false;
    },
    onState(value) {
      if (!agentBrowser) return;
      if (value.revision < browserRevision) return;
      browserRevision = value.revision;
      const currentKind = active()?.kind;
      const browserTabs = (value.tabs ?? []).filter((row) =>
        /^https?:/.test(row.url),
      );
      const ids = new Set(browserTabs.map((row) => row.id));
      let changed = false;
      for (const [id, tab] of tabs)
        if (tab.kind === "web" && !ids.has(id)) {
          tabs.delete(id);
          changed = true;
        }
      for (const row of browserTabs) {
        const previous = tabs.get(row.id);
        if (
          !previous ||
          previous.url !== row.url ||
          previous.title !== row.title
        )
          changed = true;
        tabs.set(row.id, {
          ...previous,
          ...row,
          kind: "web",
          back: true,
          forward: true,
        });
      }
      const browserTab =
        browserTabs.find((row) => row.active) ?? browserTabs.at(-1);
      if (
        browserTab &&
        (recent[0]?.url !== browserTab.url ||
          recent[0]?.title !== browserTab.title)
      )
        record(browserTab.url, browserTab.title);
      if (browserTab && ["home", "web"].includes(currentKind)) {
        changed ||= selected !== browserTab.id;
        selected = browserTab.id;
      }
      if (!tabs.has(selected)) {
        selected = [...tabs.keys()].at(-1);
        changed = true;
      }
      if (changed) {
        render();
        if (browserTab && currentKind === "home") show(true);
      }
    },
  });
  function report(message) {
    status.textContent = message ?? "";
    status.hidden = !message;
  }
  function record(url, title) {
    if (!url || !/^https?:/.test(url)) return;
    recent = [
      { url, title: title || url },
      ...recent.filter((row) => row.url !== url),
    ].slice(0, 10);
    localStorage.setItem(storageKey, JSON.stringify(recent));
  }
  function nativeCommand(action, extra = {}) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(requestId);
        reject(new Error("桌面网页服务未响应"));
      }, 8000);
      calls.set(requestId, { resolve, reject, timer });
      window.parent.postMessage(
        {
          type: "pi-desktop:browser-request",
          requestId,
          input: { action, id: active()?.id, ...extra },
        },
        location.origin,
      );
    });
  }
  function layout(force = false) {
    const tab = active();
    const visible =
      tab?.kind === "web" &&
      !pane.inert &&
      !document.querySelector("dialog[open]") &&
      !document.body.classList.contains("settings-open") &&
      viewport.getBoundingClientRect().width > 0;
    if (agentBrowser) {
      browserView.attach(visible);
      return;
    }
    if (!native) return;
    const box = viewport.getBoundingClientRect();
    const bounds = visible
      ? { x: box.x, y: box.y, width: box.width, height: box.height }
      : undefined;
    const signature = JSON.stringify([tab?.id, bounds]);
    if (!force && lastBounds === signature) return;
    lastBounds = signature;
    void nativeCommand(
      visible ? "layout" : "hide",
      bounds ? { bounds } : {},
    ).catch((error) => {
      if (visible) report(error.message);
    });
  }
  const resize = new ResizeObserver(() => layout());
  resize.observe(viewport);
  let queued = false;
  const observe = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      layout();
    });
  });
  observe.observe(document.body, {
    attributes: true,
    subtree: true,
    attributeFilter: ["class", "hidden", "open"],
  });
  window.addEventListener("resize", () => layout(true));
  function add(tab) {
    intent++;
    if (tabs.size >= 12) {
      report("最多保留 12 个标签页，请先关闭部分标签");
      return;
    }
    tabs.set(tab.id, tab);
    selected = tab.id;
    render();
    show(true);
    layout(true);
    return true;
  }
  function close(id) {
    intent++;
    const tab = tabs.get(id);
    if (agentBrowser && tab?.kind === "web") {
      void browserView
        .execute("close-tab", { id })
        .catch((error) => report(error.message));
      return;
    }
    if (native && tab?.kind === "web")
      void nativeCommand("close", { id }).catch(() => {});
    tabs.delete(id);
    if (selected === id) selected = [...tabs.keys()].at(-1);
    if (!tabs.size) openHome();
    else render();
  }
  function openHome() {
    return add({ id: crypto.randomUUID(), kind: "home", title: "新标签页" });
  }
  function openBuiltin(mode) {
    intent++;
    const kind =
      mode === "tools"
        ? "tools"
        : mode === "home" || !mode
          ? "home"
          : "changes";
    if (kind === "home") {
      const existing = [...tabs.values()].find((tab) => tab.kind === "home");
      if (existing) {
        selected = existing.id;
        render();
      } else openHome();
      return;
    }
    const id = kind;
    if (!tabs.has(id))
      tabs.set(id, {
        id,
        kind,
        title: kind === "changes" ? "改动" : "工具输出",
      });
    tabs.get(id).mode = mode;
    selected = id;
    render();
    show(true);
  }
  async function openWeb(value) {
    try {
      if (browserRemoteDisabled) {
        report("浏览器仅在电脑本地运行，手机远程不传输浏览器画面。");
        return;
      }
      const url = panelAddress(value);
      if (agentBrowser) {
        const current = active();
        const state = await browserView.execute(
          current?.kind === "web" ? "navigate" : "new",
          { url, ...(current?.kind === "web" ? { id: current.id } : {}) },
        );
        // The shared Chromium tab list is authoritative: when the panel was on a
        // file/home tab, bring the freshly opened page into view instead of
        // leaving an empty viewport behind.
        const opened =
          (state?.tabs ?? []).find((tab) => tab.active) ??
          (state?.tabs ?? []).at(-1);
        if (opened && current?.kind !== "web") {
          tabs.set(opened.id, {
            ...tabs.get(opened.id),
            ...opened,
            kind: "web",
            back: true,
            forward: true,
          });
          selected = opened.id;
          render();
        }
        show(true);
        layout(true);
        return;
      }
      let tab = active();
      if (!["web", "home"].includes(tab?.kind)) {
        if (!openHome()) return;
        tab = active();
      }
      const generation = ++intent;
      tab.kind = "web";
      tab.title = new URL(url).hostname;
      tab.url = url;
      tab.error = undefined;
      if (native) await nativeCommand("navigate", { url });
      else {
        tab.history ??= [];
        tab.history = [...tab.history.slice(0, (tab.index ?? -1) + 1), url];
        tab.index = tab.history.length - 1;
      }
      record(url, tab.title);
      if (generation !== intent || !tabs.has(tab.id)) return;
      render();
      show(true);
      layout(true);
    } catch (error) {
      report(error.message);
    }
  }
  function navigateHistory(action) {
    const tab = active();
    if (tab?.kind !== "web") return;
    if (agentBrowser) {
      void browserView
        .execute(action, { id: tab.id })
        .catch((error) => report(error.message));
      return;
    }
    if (native)
      void nativeCommand(action).catch((error) => report(error.message));
    else {
      if (action === "back" && tab.index > 0) tab.index--;
      if (action === "forward" && tab.index < tab.history.length - 1)
        tab.index++;
      tab.url = tab.history[tab.index];
      render();
    }
  }
  address.onsubmit = (event) => {
    event.preventDefault();
    void openWeb(input.value);
  };
  function appendShortcut(label, action, icon) {
    const row = button(label, action, icon);
    row.className = "panel-shortcut";
    row.append(node("span", "", label));
    return row;
  }
  function renderHome() {
    const heading = node(
        "h2",
        "",
        browserRemoteDisabled ? "本机浏览器" : "工作区浏览器",
      ),
      tools = node("div", "panel-shortcuts");
    tools.append(
      appendShortcut(
        "改动",
        () => {
          openBuiltin("review");
          document.dispatchEvent(new CustomEvent("pi-desktop:open-git"));
        },
        "edit",
      ),
      appendShortcut(
        "文件",
        () => {
          void openDirectory("");
        },
        "folder",
      ),
    );
    if (!browserRemoteDisabled)
      tools.append(appendShortcut("网页", () => input.focus(), "search"));
    tools.append(
      appendShortcut("工具输出", () => openBuiltin("tools"), "branch"),
    );
    content.append(
      heading,
      node(
        "p",
        "muted",
        browserRemoteDisabled
          ? "浏览器仅在电脑本地运行，手机远程不会接收网页画面。"
          : agentBrowser
            ? "与 Agent 共享 Chromium 页面，可以查看和接管网页操作。"
            : "网页、项目文件与会话输出在这里打开，聊天继续保留在左侧。",
      ),
      tools,
    );
    if (browserRemoteDisabled) return;
    content.append(node("h3", "", "最近网页"));
    if (!recent.length)
      content.append(node("p", "muted", "打开的网页会显示在这里。"));
    for (const row of recent)
      content.append(
        button(row.title, () => {
          void openWeb(row.url);
        }),
      );
  }
  function renderFile(value, host = content) {
    if (!value) {
      host.append(node("p", "muted", "无法预览此文件"));
      return;
    }
    if (value.path) host.append(node("p", "panel-file-path", value.path));
    host.append(node("h3", "", value.name ?? "文件"));
    if (value.kind === "text") {
      const pre = node("pre", "panel-file-text", value.text);
      pre.tabIndex = 0;
      host.append(pre);
    } else if (value.kind === "image") {
      const image = node("img", "panel-file-image");
      image.src = value.url;
      image.alt = value.name;
      host.append(image);
    } else host.append(node("p", "muted", value.message ?? "无法预览此文件"));
  }
  // A second pane in the file document for switching paths. It only reuses
  // the existing bounded /api/files read; no new server route or cache owner.
  const treeActivePath = () => {
    const tab = active();
    return tab?.kind === "file" ? (tab.file?.path ?? "") : "";
  };
  async function readTreeDirectory(path) {
    if (tree.cache.has(path)) return tree.cache.get(path);
    const value = await request(`/api/files?path=${encodeURIComponent(path)}`);
    const entries = value?.kind === "directory" ? (value.entries ?? []) : [];
    tree.cache.set(path, entries);
    return entries;
  }
  function createFileTree(activePath) {
    const aside = node("aside", "panel-file-tree");
    aside.setAttribute("aria-label", "项目文件树");
    const head = node("div", "panel-file-tree-head"),
      title = node("strong", "", "文件"),
      refresh = node("button", "", "↻");
    refresh.type = "button";
    refresh.title = "刷新文件树";
    refresh.setAttribute("aria-label", "刷新文件树");
    head.append(title, refresh);
    const filter = node("label", "panel-file-tree-filter"),
      search = node("span", "", "⌕"),
      filterInput = node("input");
    search.setAttribute("aria-hidden", "true");
    filterInput.type = "search";
    filterInput.placeholder = "筛选文件…";
    filterInput.setAttribute("aria-label", "筛选文件");
    filterInput.value = tree.filter;
    filter.append(search, filterInput);
    const list = node("div", "panel-file-tree-list");
    list.setAttribute("role", "tree");
    list.setAttribute("aria-label", "项目文件");
    aside.append(head, filter, list);
    const matches = (name) =>
      !tree.filter || name.toLowerCase().includes(tree.filter.toLowerCase());
    function appendLevel(host, path, depth) {
      for (const entry of (tree.cache.get(path) ?? []).filter(
        (row) => row.directory || matches(row.name),
      )) {
        const childPath = [path, entry.name].filter(Boolean).join("/"),
          row = node("button", "panel-file-tree-row"),
          chevron = node("span", "panel-file-tree-chevron");
        row.type = "button";
        row.style.setProperty("--tree-depth", String(depth));
        row.setAttribute("role", "treeitem");
        chevron.setAttribute("aria-hidden", "true");
        if (entry.directory) {
          chevron.textContent = "▸";
          row.dataset.treePath = childPath;
          row.setAttribute("aria-expanded", String(tree.open.has(childPath)));
          row.append(chevron, node("span", "panel-file-tree-name", entry.name));
          row.onclick = () => void toggleDirectory(childPath);
          host.append(row);
          if (!tree.open.has(childPath)) continue;
          const group = node("div", "panel-file-tree-children");
          group.setAttribute("role", "group");
          host.append(group);
          appendLevel(group, childPath, depth + 1);
          continue;
        }
        row.dataset.treePath = childPath;
        row.setAttribute("aria-selected", String(childPath === activePath));
        row.append(chevron, node("span", "panel-file-tree-name", entry.name));
        if (entry.link) row.append(node("span", "panel-file-tree-mark", "↗"));
        row.onclick = () => void openFile(childPath);
        host.append(row);
      }
    }
    async function renderTree() {
      const generation = ++tree.generation;
      list.setAttribute("aria-busy", "true");
      try {
        await readTreeDirectory("");
        if (generation !== tree.generation) return;
        list.replaceChildren();
        appendLevel(list, "", 0);
        if (!list.children.length)
          list.append(
            node(
              "p",
              "panel-file-tree-empty",
              tree.filter ? "没有匹配的文件" : "项目中没有可预览的文件",
            ),
          );
      } catch (error) {
        if (generation !== tree.generation) return;
        list.replaceChildren(node("p", "panel-file-tree-empty", error.message));
      } finally {
        if (generation === tree.generation) list.removeAttribute("aria-busy");
      }
    }
    async function toggleDirectory(path) {
      if (tree.open.has(path)) tree.open.delete(path);
      else {
        tree.open.add(path);
        try {
          await readTreeDirectory(path);
        } catch (error) {
          tree.open.delete(path);
          report(error.message);
        }
      }
      await renderTree();
    }
    refresh.onclick = () => {
      tree.cache.clear();
      void renderTree();
    };
    filterInput.oninput = () => {
      tree.filter = filterInput.value.trim();
      void renderTree();
    };
    void renderTree();
    return aside;
  }
  function render() {
    const tab = active();
    if (!tab) return;
    browserView.select(tab.id);
    strip.replaceChildren();
    content.replaceChildren();
    controls.replaceChildren();
    report(tab.error);
    for (const value of tabs.values()) {
      const row = node("div", "panel-tab"),
        select = button(value.title, () => {
          intent++;
          selected = value.id;
          if (agentBrowser && value.kind === "web")
            void browserView
              .execute("select", { id: value.id })
              .catch((error) => report(error.message));
          render();
          show(true);
          layout(true);
        });
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(value.id === selected));
      select.dataset.panelTab = value.id;
      const remove = button(`关闭 ${value.title}`, () => close(value.id));
      remove.textContent = "×";
      remove.className = "panel-tab-close";
      row.append(select, remove);
      strip.append(row);
    }
    const builtin = ["changes", "tools"].includes(tab.kind);
    legacy.hidden = !builtin;
    content.hidden = builtin || tab.kind === "web";
    content.classList.toggle("is-file-view", tab.kind === "file");
    viewport.hidden = browserRemoteDisabled || tab.kind !== "web";
    browserView.attach(
      agentBrowser &&
        tab.kind === "web" &&
        !pane.inert &&
        !document.body.classList.contains("settings-open"),
    );
    address.hidden =
      browserRemoteDisabled || !["home", "web"].includes(tab.kind);
    plus.hidden = browserRemoteDisabled;
    controls.hidden = tab.kind !== "changes";
    input.value = tab.url ?? "";
    back.disabled =
      tab.kind !== "web" ||
      !(native || agentBrowser ? tab.back : tab.index > 0);
    forward.disabled =
      tab.kind !== "web" ||
      !(native || agentBrowser
        ? tab.forward
        : tab.index < tab.history.length - 1);
    reload.disabled = tab.kind !== "web";
    rendering = true;
    try {
      reveal(
        builtin
          ? tab.kind === "tools"
            ? "tools"
            : (tab.mode ?? "review")
          : null,
      );
    } finally {
      rendering = false;
    }
    pane.classList.add("expanded");
    pane.dataset.panelKind = tab.kind;
    if (tab.kind === "changes")
      for (const [mode, title] of [
        ["review", "工作树"],
        ["history", "历史"],
        ["commit", "提交"],
        ["manage", "管理"],
      ]) {
        const choice = button(title, () => {
          tab.mode = mode;
          render();
          if (mode === "review" || mode === "history")
            document.dispatchEvent(
              new CustomEvent("pi-desktop:open-git", { detail: mode }),
            );
        });
        choice.setAttribute("aria-pressed", String(tab.mode === mode));
        controls.append(choice);
      }
    if (tab.kind === "home") renderHome();
    if (tab.kind === "file") {
      const layout = node("div", "panel-file-layout"),
        body = node("div", "panel-file-body");
      renderFile(tab.file, body);
      layout.append(body);
      if (snapshot()?.capabilities?.files !== false)
        layout.append(createFileTree(tab.file?.path ?? treeActivePath()));
      content.append(layout);
    }
    if (tab.kind === "files") {
      const data = tab.directory;
      content.append(node("h3", "", "文件"));
      const toolbar = node("div", "panel-file-toolbar");
      toolbar.append(
        button("上级目录", () => {
          void openDirectory(tab.path.split("/").slice(0, -1).join("/"));
        }),
        button("刷新文件", () => {
          void openDirectory(tab.path);
        }),
      );
      toolbar.firstChild.disabled = !tab.path;
      toolbar.append(button("打开本地文件…", () => filePicker.click()));
      content.append(
        toolbar,
        node("p", "panel-file-path", tab.path || data?.name || "当前项目"),
      );
      if (!data)
        content.append(
          node("p", "muted", "无项目会话可选择本地文件进行预览。"),
        );
      for (const entry of data?.entries ?? []) {
        const path = [tab.path, entry.name].filter(Boolean).join("/");
        const row = button(
          `${entry.name}${entry.directory ? "/" : ""}`,
          () => {
            void (entry.directory ? openDirectory(path) : openFile(path));
          },
          entry.directory ? "folder" : "skill",
        );
        row.className = "panel-file-row";
        row.dataset.panelPath = path;
        row.append(node("span", "", entry.name + (entry.link ? " ↗" : "")));
        content.append(row);
      }
      if (data?.truncated)
        content.append(node("p", "muted", "仅显示前 500 项"));
    }
    if (tab.kind === "web") {
      if (agentBrowser) {
        frame?.remove();
        frame = undefined;
      } else if (native) {
        frame?.remove();
        frame = undefined;
      } else {
        viewport.replaceChildren();
        const external = node("a", "panel-external", "在浏览器中打开");
        external.href = tab.url;
        external.target = "_blank";
        external.rel = "noopener noreferrer";
        frame = node("iframe", "panel-web-frame");
        frame.title = tab.title;
        frame.setAttribute("sandbox", "allow-scripts allow-forms");
        frame.referrerPolicy = "no-referrer";
        frame.src = tab.url;
        viewport.append(external, frame);
      }
    }
    requestAnimationFrame(() => layout());
  }
  async function openDirectory(path) {
    const generation = ++intent;
    try {
      const value =
        snapshot()?.capabilities?.readOnly && !snapshot()?.capabilities?.files
          ? undefined
          : await request(`/api/files?path=${encodeURIComponent(path)}`);
      if (generation !== intent) return;
      if (value && value.kind !== "directory")
        throw new Error("此路径不是目录");
      // The file document and its tree share the same bounded directory read;
      // reuse it instead of issuing a second remote request for the root.
      if (value) tree.cache.set(path, value.entries ?? []);
      const tab = {
        id: "files",
        kind: "files",
        title: "文件",
        path,
        directory: value,
      };
      tabs.set(tab.id, tab);
      selected = tab.id;
      render();
      show(true);
    } catch (error) {
      report(error.message);
    }
  }
  async function openFile(path) {
    const existing = [...tabs.values()].find(
      (tab) => tab.kind === "file" && tab.file?.path === path,
    );
    if (existing) {
      selected = existing.id;
      render();
      show(true);
      layout(true);
      return;
    }
    const generation = ++intent;
    try {
      const file = await request(`/api/files?path=${encodeURIComponent(path)}`);
      if (generation !== intent) return;
      add({ id: crypto.randomUUID(), kind: "file", title: file.name, file });
    } catch (error) {
      report(error.message);
    }
  }
  const filePicker = node("input");
  filePicker.type = "file";
  filePicker.hidden = true;
  filePicker.id = "panel-file-picker";
  pane.append(filePicker);
  filePicker.onchange = async () => {
    const file = filePicker.files[0];
    if (!file) return;
    try {
      const image = [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/bmp",
      ].includes(file.type);
      if (file.size > (image ? 2 * 1024 * 1024 : 512 * 1024))
        throw new Error("文件超过预览上限");
      const data = await file.arrayBuffer();
      const value = image
        ? { kind: "image", name: file.name, url: "" }
        : {
            kind: "text",
            name: file.name,
            text: new TextDecoder("utf-8", { fatal: true }).decode(data),
          };
      if (image)
        value.url = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      if (value.text?.includes("\0")) throw new Error("此文件不是可预览的文本");
      add({
        id: crypto.randomUUID(),
        kind: "file",
        title: file.name,
        file: value,
      });
    } catch (error) {
      report(error.message);
    } finally {
      filePicker.value = "";
    }
  };
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== window.parent)
      return;
    if (event.data?.type === "pi-desktop:browser-response") {
      const call = calls.get(event.data.requestId);
      if (!call) return;
      clearTimeout(call.timer);
      calls.delete(event.data.requestId);
      event.data.error
        ? call.reject(new Error(event.data.error))
        : call.resolve(event.data.result);
    }
    if (event.data?.type === "pi-desktop:browser-state") {
      const data = event.data.state,
        tab = tabs.get(data.id);
      if (!tab || tab.kind !== "web") return;
      Object.assign(tab, {
        ...data,
        url: data.url || tab.url,
        title: data.title || tab.title,
      });
      record(tab.url, tab.title);
      const label = strip.querySelector(`[data-panel-tab="${tab.id}"]`);
      if (label) {
        label.textContent = tab.title || new URL(tab.url).hostname;
        label.title = tab.title;
      }
      if (tab.id === selected) {
        input.value = tab.url || input.value;
        back.disabled = !tab.back;
        forward.disabled = !tab.forward;
        report(tab.error || (tab.loading ? "正在加载…" : ""));
      }
    }
    if (event.data?.type === "pi-desktop:panel-visibility") layout(true);
  });
  document.addEventListener("keydown", (event) => {
    if (
      !(event.ctrlKey || event.metaKey) ||
      document.body.classList.contains("settings-open")
    )
      return;
    if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      void openDirectory("");
    }
    if (event.shiftKey && event.key.toLowerCase() === "g") {
      event.preventDefault();
      openBuiltin("review");
      document.dispatchEvent(new CustomEvent("pi-desktop:open-git"));
    }
  });
  const initial = { id: crypto.randomUUID(), kind: "home", title: "新标签页" };
  tabs.set(initial.id, initial);
  selected = initial.id;
  render();
  return {
    get rendering() {
      return rendering;
    },
    get activeKind() {
      return active()?.kind;
    },
    openBuiltin,
    openWeb,
    layout,
    configure(value) {
      native =
        !browserRemoteDisabled && !agentBrowser && !!value?.nativeBrowser;
      layout(true);
    },
    update() {
      const current = snapshot();
      const remoteDisabled = !!current?.capabilities?.browserRemoteDisabled;
      if (browserRemoteDisabled !== remoteDisabled) {
        browserRemoteDisabled = remoteDisabled;
        native = false;
        if (browserRemoteDisabled) {
          for (const [id, tab] of tabs) if (tab.kind === "web") tabs.delete(id);
          if (active()?.kind === "web") {
            let home = [...tabs.values()].find((tab) => tab.kind === "home");
            if (!home) {
              home = {
                id: crypto.randomUUID(),
                kind: "home",
                title: "新标签页",
              };
              tabs.set(home.id, home);
            }
            selected = home.id;
          }
        }
        plus.hidden = browserRemoteDisabled;
        render();
      }
      const useBrowser = !!current?.capabilities?.agentBrowser;
      if (agentBrowser !== useBrowser) {
        agentBrowser = useBrowser;
        if (agentBrowser) native = false;
        if (!agentBrowser) resolution.hidden = true;
        browserView.configure(agentBrowser);
        render();
      }
      const cwd = current?.cwd;
      if (lastCwd && cwd !== lastCwd) {
        intent++;
        tree.cache.clear();
        tree.open.clear();
        tree.filter = "";
        tree.generation++;
        for (const [id, tab] of tabs)
          if (["file", "files", "changes"].includes(tab.kind)) tabs.delete(id);
        if (!tabs.has(selected)) openHome();
      }
      lastCwd = cwd;
    },
    browserChanged() {
      void browserView.refresh();
    },
    openAttachment(file) {
      add({
        id: crypto.randomUUID(),
        kind: "file",
        title: file.name,
        file: file.image
          ? { kind: "image", name: file.name, url: file.url }
          : { kind: "text", name: file.name, text: file.preview },
      });
    },
  };
}
