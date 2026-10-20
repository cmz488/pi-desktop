/**
 * 扩展工作台：注册 adapter 与内置读模型的第二展示面，不加载插件脚本或拥有业务状态。
 *
 * 接口：projectExtensionPages／projectExtensionPanels、createExtensionWorkbench；
 *   update(rows, context)／select(key) 与内置页上下文见
 *   docs/architecture/interfaces/read-panels.md。
 * 不变量：页面按会话与稳定键隔离；所有内置页先更新身份再过滤；相同页面重画保留
 *   披露状态、焦点与滚动；动作只转交注册 adapter 已验证的意图。
 * 错误：当前懒加载失败走 onError；过期结果不重画，renderer 输出沿用清理与安全回退。
 */
const MAX_PAGES = 80;
const MAX_RETAINED_ENTRIES = 500;

/** Reuse the registry's scoped identities and latest-state policy, not plugin IDs. */
export function projectExtensionPages(registry, rows, { sessionId } = {}) {
  const { messages, states } = registry.layout(rows, { sessionId });
  const seen = new Set();
  return [...states.reverse(), ...messages.reverse()]
    .filter((row) => {
      const key = row.extensionView?.disclosureKey;
      if (row.display === false || !key || seen.has(key)) return false;
      // Adapters that own an operations panel are rendered there instead of
      // becoming a pile of per-card pages.
      if (registry.panelForView?.(row.extensionView)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_PAGES)
    .map((row) => ({
      key: row.extensionView.disclosureKey,
      state: !!row.extensionState,
      view: row.extensionView,
    }));
}

export function projectExtensionPanels(registry, rows, { sessionId } = {}) {
  return (registry.panels?.(rows, { sessionId }) ?? []).map((panel) => ({
    key: panel.key,
    panel,
    view: {
      label: panel.panel.label ?? "面板",
      title: panel.panel.title ?? "操作面板",
      status: "",
    },
  }));
}

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** A second presentation surface for the existing adapter contract.
 * It never loads extension scripts, dispatches commands, or owns plugin state. */
export function createExtensionWorkbench({
  root,
  registry,
  builtinPages = [],
  sanitize,
  loadDetails,
  onError,
  onCount,
  onPanelAction,
}) {
  const list = root.querySelector(".extension-page-list");
  const detail = root.querySelector(".extension-page-detail");
  const empty = root.querySelector(".extension-workbench-empty");
  const layout = root.querySelector(".extension-workbench-layout");
  const disclosures = new Map();
  const loadAttempts = new Map();
  let latestRows = [],
    latestContext = {};
  let pages = [],
    owner,
    renderedOwner,
    selected,
    signature = "",
    loading,
    generation = 0;

  function renderList() {
    const focused = list.contains(document.activeElement)
      ? document.activeElement.dataset.extensionKey
      : undefined;
    list.replaceChildren();
    for (const page of pages) {
      const button = element("button", "extension-page-choice");
      button.type = "button";
      button.classList.toggle("is-builtin", !!page.builtin);
      button.dataset.extensionKey = page.key;
      if (page.key === selected) button.setAttribute("aria-current", "page");
      button.append(
        element("small", "", page.view.label || "扩展"),
        element("strong", "", page.view.title || "扩展页面"),
        element(
          "span",
          "",
          [
            page.builtin
              ? "内置页"
              : page.panel
                ? "操作面板"
                : page.state
                  ? "实时状态"
                  : "会话记录",
            page.view.status,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      button.onclick = () => {
        selected = page.key;
        renderList();
        renderDetail();
      };
      list.append(button);
    }
    if (focused)
      [...list.children]
        .find((node) => node.dataset.extensionKey === focused)
        ?.focus({ preventScroll: true });
  }

  async function hydrate(page, trigger) {
    const identity = ++generation;
    const session = owner;
    loading = page.key;
    // Repainting an open lazy fold must never become an automatic retry loop.
    // The explicit button remains a retry path, including after loader failure.
    loadAttempts.set(page.key, page.view.lazyMessageId);
    while (loadAttempts.size > MAX_RETAINED_ENTRIES)
      loadAttempts.delete(loadAttempts.keys().next().value);
    trigger.disabled = true;
    trigger.textContent = "正在加载…";
    try {
      await loadDetails([page.view.lazyMessageId]);
    } catch (error) {
      if (session === owner && identity === generation) onError(error.message);
    } finally {
      if (session === owner && identity === generation) {
        loading = undefined;
        renderDetail();
      }
    }
  }

  let active = true;
  function syncBuiltinVisibility() {
    for (const page of builtinPages)
      page.builtin.setVisible?.(
        active && !root.hidden && page.key === selected,
      );
  }
  function renderDetail() {
    syncBuiltinVisibility();
    const page = pages.find((row) => row.key === selected);
    const previousScroll = detail.scrollTop;
    const active = document.activeElement;
    const focusedBuiltin = detail.contains(active)
      ? active.dataset.workbenchFocus
      : undefined;
    const focusedDetail =
      detail.contains(active) && active.tagName === "SUMMARY"
        ? active.parentElement.dataset.disclosure
        : undefined;
    const focusedLoad =
      detail.contains(active) && active.dataset.loadExtension === "true";
    for (const node of detail.querySelectorAll("details[data-disclosure]"))
      disclosures.set(node.dataset.disclosure, node.open);
    while (disclosures.size > MAX_RETAINED_ENTRIES)
      disclosures.delete(disclosures.keys().next().value);
    const changed = detail.dataset.page !== page?.key;
    detail.replaceChildren();
    detail.dataset.page = page?.key ?? "";
    detail.classList.toggle("is-builtin", !!page?.builtin);
    if (!page) return;
    const meta = element("div", "extension-page-meta");
    meta.append(
      element(
        "span",
        "extension-page-kind",
        page.panel ? "操作面板" : page.state ? "实时状态" : "会话记录",
      ),
      element(
        "span",
        "",
        page.panel
          ? "目标、任务与验收集中在这里"
          : page.state
            ? "跟随当前会话更新"
            : "保留在原会话中",
      ),
    );
    if (!page.builtin) detail.append(meta);
    if (page.builtin) {
      const content = element(
        "div",
        "extension-page-content branch-tree-content",
      );
      detail.append(content);
      page.builtin.render(content, {
        ...latestContext,
        sessionId: owner,
        rerender: repaintBuiltin,
      });
      detail.scrollTop = changed ? 0 : previousScroll;
      if (
        !changed &&
        focusedBuiltin &&
        document.activeElement === document.body
      )
        [...content.querySelectorAll("[data-workbench-focus]")]
          .find((node) => node.dataset.workbenchFocus === focusedBuiltin)
          ?.focus({ preventScroll: true });
      return;
    }
    if (page.panel) {
      const content = element(
        "div",
        "extension-page-content goal-panel-content",
      );
      content.innerHTML = sanitize(
        registry.renderPanel(page.panel, { disclosures }),
      );
      if (!content.innerHTML.trim())
        content.textContent = "目标面板暂时无法渲染。";
      detail.append(content);
      detail.scrollTop = changed ? 0 : previousScroll;
      return;
    }
    if (page.view.lazyMessageId) {
      const load = element("button", "outline-button", "加载完整内容");
      load.type = "button";
      load.dataset.loadExtension = "true";
      load.disabled = loading === page.key;
      if (load.disabled) load.textContent = "正在加载…";
      load.onclick = () => void hydrate(page, load);
      detail.append(load);
    }
    const content = element("div", "extension-page-content");
    if (!disclosures.has(page.key))
      disclosures.set(page.key, !page.view.lazyMessageId);
    // Renderers are locally registered, but this boundary still sanitizes HTML.
    // Plain details.piDesktop text is already escaped by the shared renderer.
    content.innerHTML = sanitize(
      registry.render(page.view, { placement: "page", disclosures }),
    );
    if (!content.innerHTML.trim())
      content.textContent = "此扩展暂时无法渲染。可返回会话查看原始消息。";
    detail.append(content);
    if (!changed && focusedDetail)
      [...detail.querySelectorAll("details[data-disclosure]")]
        .find((node) => node.dataset.disclosure === focusedDetail)
        ?.querySelector("summary")
        ?.focus({ preventScroll: true });
    if (!changed && focusedLoad)
      (detail.querySelector("[data-load-extension]") ?? detail).focus({
        preventScroll: true,
      });
    detail.scrollTop = changed ? 0 : previousScroll;
  }

  // Panel actions are declarative data attributes rendered by the adapter; the
  // adapter's declared action contract validates them once at the seam. The
  // workbench forwards a typed intent and never executes extension code.
  detail.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-panel-action]");
    if (!button || !detail.contains(button)) return;
    const page = pages.find((row) => row.key === selected);
    if (!page?.panel) return;
    const kind = String(button.dataset.panelAction ?? "");
    const value = String(button.dataset.panelValue ?? "");
    if (!page.panel.panel.acceptsAction?.(kind, value)) return;
    event.preventDefault();
    try {
      void Promise.resolve(
        onPanelAction?.({
          adapterId: page.panel.adapterId,
          panelId: page.panel.panelId,
          kind,
          value,
        }),
      ).catch((error) => onError(error.message));
    } catch (error) {
      onError(error.message);
    }
  });

  // Native disclosures remain keyboard accessible, and lazy details use the
  // same message-detail endpoint as the transcript. No parallel data protocol.
  detail.addEventListener(
    "toggle",
    (event) => {
      const node = event.target;
      if (!node.matches?.("details[data-disclosure]") || !detail.contains(node))
        return;
      disclosures.set(node.dataset.disclosure, node.open);
      if (!node.open || !node.dataset.lazyMessages) return;
      const page = pages.find((row) => row.key === selected);
      // Lazy folds start closed; opening one or using the retry button calls
      // the transcript's existing loader, with its session ownership checks.
      if (
        page?.view.lazyMessageId &&
        loading !== page.key &&
        !root.hidden &&
        loadAttempts.get(page.key) !== page.view.lazyMessageId
      )
        void hydrate(page, detail.querySelector("[data-load-extension]"));
    },
    true,
  );

  function repaintBuiltin() {
    if (!controller.update(latestRows, latestContext)) renderDetail();
  }
  const controller = {
    setActive(value) {
      active = value;
      syncBuiltinVisibility();
    },
    /* 会话栏「打开分支树」需要直接选中内置页；找不到 key 时保持当前选择。 */
    select(key) {
      if (!pages.some((row) => row.key === key)) return false;
      selected = key;
      renderList();
      renderDetail();
      return true;
    },
    update(rows, context = {}) {
      const { sessionId } = context;
      latestRows = rows;
      latestContext = context;
      if (owner !== sessionId) {
        owner = sessionId;
        selected = undefined;
        loading = undefined;
        generation++;
        signature = "";
        disclosures.clear();
        loadAttempts.clear();
        detail.replaceChildren();
      }
      // 未选中的内置页也必须立即失效，不能等用户重新打开才清掉旧确认和请求。
      const changedBuiltins = new Set();
      for (const page of builtinPages)
        if (page.builtin.update?.(context)) changedBuiltins.add(page.key);
      const next = [
        ...builtinPages.filter((page) => page.available !== false),
        ...projectExtensionPanels(registry, rows, { sessionId }),
        ...projectExtensionPages(registry, rows, { sessionId }),
      ];
      const nextSignature = JSON.stringify(next);
      // 会话切换时页面清单可能完全一样，但内置页要看的是新会话，必须重画。
      const ownerChanged = renderedOwner !== owner;
      if (nextSignature === signature && !ownerChanged) {
        if (!changedBuiltins.has(selected)) return false;
        renderDetail();
        return true;
      }
      signature = nextSignature;
      renderedOwner = owner;
      pages = next;
      if (!pages.some((row) => row.key === selected)) selected = pages[0]?.key;
      empty.hidden = pages.length > 0;
      layout.hidden = !pages.length;
      onCount(pages.length);
      renderList();
      renderDetail();
      return true;
    },
  };
  return controller;
}
