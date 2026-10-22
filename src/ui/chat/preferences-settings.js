/**
 * 配置与外观：拥有人格／Pi 设置表单、草稿、读取和页面外观监听。
 *
 * 接口：setContext／update／handleClick／reloaded／dispose 与外观操作；
 *   见 docs/architecture/interfaces/chat-views.md。
 * 不变量：离页只撤读取并保留同身份草稿；换目标清旧表单，写入仍由原生配置拥有。
 * 错误：当前读取／保存失败提示使用者并保留草稿；过期回复不发布。
 */
export function createPreferencesSettings({
  live,
  embedded,
  api,
  esc,
  toast,
  openDialog,
  getState,
  getDesktopConfiguration,
  desktopMessage,
  showView,
  refresh,
}) {
  const $ = (selector) => document.querySelector(selector);
  const lifetime = new AbortController();
  const systemTheme = matchMedia("(prefers-color-scheme:dark)");
  const DEFAULT_FONT_SIZE = 14;
  const MIN_FONT_SIZE = 12;
  const MAX_FONT_SIZE = 24;
  const optionLabels = {
    off: "关闭",
    on: "开启",
    only: "仅使用 Codemode",
    minimal: "极少",
    low: "低",
    medium: "中等",
    high: "高",
    xhigh: "更高",
    max: "最大",
    "one-at-a-time": "逐条处理",
    all: "全部",
    ask: "询问",
    always: "总是",
    never: "从不",
    auto: "自动",
    streaming: "请求期间预热",
    idle: "空闲时预热",
    regular: "常规",
    fullscreen: "全屏",
    system: "跟随系统",
    transcript: "会话记录",
    "resume-hint": "恢复提示",
    hidden: "隐藏",
    tree: "会话树",
    fork: "分叉会话",
    none: "无",
    default: "默认",
    "no-tools": "隐藏工具消息",
    "user-only": "仅用户消息",
    "labeled-only": "仅标记消息",
    "user-and-assistant": "用户与助手",
  };
  const actions = new Set([
    "resource-settings",
    "display-settings",
    "theme",
    "trust-project",
    "discard-settings",
    "add-personality",
    "refresh-personality",
  ]);
  let identity,
    hasContext = false,
    view = "workspace",
    active = false,
    targetGeneration = 0,
    disposed = false;
  let settingsDocument,
    groups = [],
    settingsCategory = "agent",
    settingsGeneration = 0,
    settingsRead,
    settingsSaving = false,
    settingsNeedsReload = false,
    pending = false;
  const draft = new Map();
  const demoSettings = { global: {}, project: {} };
  let personalityDocument,
    personalitySaving = false,
    personalityGeneration = 0,
    personalityRead,
    personalityEdits = 0,
    personalityDirty = false,
    profileMarkup;

  function listen(target, type, handler) {
    target.addEventListener(type, handler, { signal: lifetime.signal });
  }

  function captureTarget() {
    const state = getState();
    return {
      generation: targetGeneration,
      sessionId: state?.sessionId,
      cwd: state?.cwd,
    };
  }

  function isCurrent(target) {
    if (disposed || target.generation !== targetGeneration) return false;
    const state = getState();
    return target.sessionId === state?.sessionId && target.cwd === state?.cwd;
  }

  function canRead(page) {
    return (
      !disposed && hasContext && active && !document.hidden && view === page
    );
  }

  // 执行从当前事件立即开始；未命中的点击不会经过 Promise/await。
  function run(action) {
    const target = captureTarget();
    const report = (error) => {
      if (isCurrent(target)) toast(error.message);
    };
    try {
      void Promise.resolve(action()).catch(report);
    } catch (error) {
      report(error);
    }
  }

  function cancelSettingsRead() {
    ++settingsGeneration;
    settingsRead?.abort();
    settingsRead = undefined;
  }

  function cancelPersonalityRead() {
    ++personalityGeneration;
    personalityRead?.abort();
    personalityRead = undefined;
  }

  function cancelReads() {
    cancelSettingsRead();
    cancelPersonalityRead();
  }

  function clearSettingsForm() {
    settingsDocument = undefined;
    groups = [];
    draft.clear();
    settingsNeedsReload = false;
    $("#settings-categories").replaceChildren();
    $("#settings-groups").replaceChildren();
    $("#config-location").textContent = "";
  }

  function resetIdentity() {
    clearSettingsForm();
    settingsSaving = false;
    settingsCategory = "agent";
    pending = false;
    $("#settings-search").value = "";
    $("#settings-scope").value = "global";
    personalityDocument = undefined;
    personalitySaving = false;
    personalityDirty = false;
    personalityEdits = 0;
    profileMarkup = undefined;
    $("#personality-file").textContent = "";
    $("#personality-content").value = "";
    $("#personality-status").textContent = "";
    $("#personality-profiles").replaceChildren();
    $("#save-personality").disabled = true;
    updateDraft();
  }

  function ensureLoaded() {
    if (
      canRead("general") &&
      !settingsRead &&
      !settingsSaving &&
      (!settingsDocument || settingsNeedsReload)
    )
      run(() => loadSettings({ preserveDraft: true }));
    if (
      canRead("personality") &&
      !personalityDocument &&
      !personalityRead &&
      !personalitySaving
    )
      run(() => loadPersonality({ preserveDraft: true }));
  }

  function setContext(next) {
    if (disposed) return;
    const changedIdentity = !hasContext || !Object.is(identity, next.identity);
    const changed =
      changedIdentity || view !== next.view || active !== next.active;
    identity = next.identity;
    view = next.view;
    active = next.active;
    hasContext = true;
    if (changed) cancelReads();
    if (changedIdentity) {
      ++targetGeneration;
      resetIdentity();
    }
    ensureLoaded();
  }

  function renderDesktopConfiguration() {
    const html =
      (getDesktopConfiguration()?.promptProfiles ?? [])
        .map(
          (row) =>
            `<article class="settings-card"><h3>${esc(row.name)}</h3><p class="config-location">AGENTS.md</p><button data-edit-personality="${esc(row.id)}">编辑人格</button></article>`,
        )
        .join("") ||
      '<p class="muted">尚未添加人格。可在此添加，也可在输入框上方创建。</p>';
    if (html === profileMarkup) return;
    profileMarkup = html;
    $("#personality-profiles").innerHTML = html;
  }

  function update() {
    if (disposed) return;
    const state = getState();
    if (live) pending = !!state?.pending;
    const desktop = embedded && !!getDesktopConfiguration();
    $(".desktop-personality").hidden = !desktop;
    $("#settings-scope").hidden = desktop;
    if (desktop && $("#settings-scope").value !== "global") {
      cancelSettingsRead();
      $("#settings-scope").value = "global";
      clearSettingsForm();
      ensureLoaded();
    }
    renderDesktopConfiguration();
    if (state)
      $("#settings-pending-note").textContent = state.idle
        ? "保存的 Pi 设置需要重载后应用。"
        : "当前任务继续使用已加载设置；保存的更改将在任务结束后重载应用。";
    updateDraft();
  }

  function effectiveValue(spec) {
    const own = settingsDocument.values[spec.key],
      inherited = settingsDocument.inherited?.[spec.key];
    return own !== null && own !== undefined
      ? own
      : settingsDocument.scope === "project" &&
          inherited !== null &&
          inherited !== undefined
        ? inherited
        : spec.default;
  }

  function renderSetting(spec) {
    const project = settingsDocument.scope === "project";
    if (project && spec.globalOnly) return "";
    const own = settingsDocument.values[spec.key];
    const storedDraft = draft.get(spec.key);
    const raw = storedDraft?.raw ? storedDraft.value : undefined;
    const reset = draft.has(spec.key) && draft.get(spec.key) === null;
    const value =
      draft.has(spec.key) && !reset
        ? raw === undefined
          ? storedDraft
          : spec.type === "enum"
            ? JSON.parse(raw)
            : raw
        : reset
          ? project
            ? (settingsDocument.inherited?.[spec.key] ?? spec.default)
            : spec.default
          : effectiveValue(spec);
    const tag =
      reset || own === null || own === undefined
        ? project
          ? "继承用户"
          : "默认值"
        : project
          ? "项目覆盖"
          : "用户配置";
    let control;
    const name = `data-setting="${esc(spec.key)}"`;
    if (spec.type === "boolean")
      control = `<button type="button" class="switch" role="switch" aria-label="${esc(spec.label)}" aria-checked="${!!value}" ${name}></button>`;
    else if (spec.type === "enum")
      control = `<select ${name} aria-label="${esc(spec.label)}">${spec.options.map((option) => `<option value="${esc(JSON.stringify(option))}" ${option === value ? "selected" : ""}>${esc(option === true ? "开启" : option === false ? "关闭" : (optionLabels[option] ?? option))}</option>`).join("")}</select>`;
    else if (spec.type === "array" || spec.type === "object")
      control = `<textarea ${name} aria-label="${esc(spec.label)}" spellcheck="false">${esc(raw ?? (spec.type === "array" ? value.join("\n") : JSON.stringify(value, null, 2)))}</textarea>`;
    else
      control = `<input ${name} aria-label="${esc(spec.label)}" type="${spec.secret ? "password" : spec.type === "number" ? "number" : "text"}" value="${esc(spec.secret ? (raw ?? storedDraft ?? "") : value)}" ${spec.type === "number" ? `min="${spec.min ?? 0}" ${spec.max === undefined ? "" : `max="${spec.max}"`}` : ""} ${spec.secret ? `autocomplete="new-password" placeholder="${own?.configured ? "已配置 · 留空保持" : "尚未配置"}"` : ""}>`;
    return `<div class="setting-row"><label class="setting-label">${esc(spec.label)}<span class="scope-tag">${tag}</span><small>${esc(spec.key)}${spec.help ? "<br>" + esc(spec.help) : ""}</small></label><div class="setting-control">${control}<button type="button" class="inherit-button" data-reset-setting="${esc(spec.key)}" title="删除此范围的覆盖值">重置</button></div></div>`;
  }

  function filterSettings() {
    const query = $("#settings-search").value.toLowerCase();
    for (const group of $("#settings-groups").querySelectorAll(
      ".settings-group",
    )) {
      for (const row of group.querySelectorAll(".setting-row"))
        row.hidden = !row.textContent.toLowerCase().includes(query);
      group.hidden =
        (!query && group.dataset.group !== settingsCategory) ||
        ![...group.querySelectorAll(".setting-row")].some((row) => !row.hidden);
    }
  }

  function syncSettingsCategories() {
    for (const tab of $("#settings-categories").querySelectorAll(
      "[data-settings-category]",
    ))
      tab.setAttribute(
        "aria-selected",
        String(tab.dataset.settingsCategory === settingsCategory),
      );
  }

  function renderSettings() {
    if (!settingsDocument) return;
    $("#settings-categories").innerHTML = groups
      .map(
        (group) =>
          `<button type="button" role="tab" aria-selected="${settingsCategory === group.id}" data-settings-category="${esc(group.id)}">${esc(group.title)}</button>`,
      )
      .join("");
    $("#settings-groups").innerHTML = groups
      .map(
        (group) =>
          `<section class="settings-group" data-group="${esc(group.id)}"><h2>${esc(group.title)}</h2>${group.fields.map(renderSetting).join("")}</section>`,
      )
      .join("");
    $("#config-location").textContent =
      settingsDocument.scope === "project"
        ? `${getState()?.cwd ?? "当前工作区"}/.pi/settings.json${settingsDocument.trusted === false ? " · 项目未信任，pi 暂不应用项目配置" : ""}`
        : settingsDocument.file || "~/.pi/agent/settings.json";
    updateDraft();
    filterSettings();
  }

  function updateDraft() {
    const state = getState();
    $("#project-trust-notice").hidden =
      state?.capabilities?.readOnly || state?.projectTrusted !== false;
    $("#save-settings").disabled =
      !draft.size ||
      settingsSaving ||
      !!settingsRead ||
      !settingsDocument ||
      settingsDocument.scope !== $("#settings-scope").value;
    $("#draft-label").textContent = draft.size
      ? `${draft.size} 项未保存修改`
      : "没有未保存的修改";
    $("#settings-pending").hidden = !pending;
  }

  async function loadSettings({ preserveDraft = false } = {}) {
    if (!canRead("general")) return;
    cancelSettingsRead();
    const generation = settingsGeneration;
    const controller = (settingsRead = new AbortController());
    const target = captureTarget();
    const scope = $("#settings-scope").value;
    const priorDraft = new Map(draft);
    const current = () =>
      isCurrent(target) &&
      canRead("general") &&
      generation === settingsGeneration &&
      scope === $("#settings-scope").value;
    updateDraft();
    try {
      let value;
      if (live)
        value = await api(
          `/api/settings?scope=${encodeURIComponent(scope)}&sessionId=${encodeURIComponent(target.sessionId ?? "")}`,
          undefined,
          { signal: controller.signal },
        );
      else {
        let schema = groups;
        if (!schema.length) {
          const response = await fetch("/settings-schema.json", {
            signal: controller.signal,
          });
          if (!response.ok)
            throw new Error(`读取 Pi 配置失败：${response.status}`);
          schema = await response.json();
        }
        value = {
          scope,
          groups: schema,
          values: Object.fromEntries(
            schema.flatMap((group) =>
              group.fields.map((spec) => [
                spec.key,
                demoSettings[scope][spec.key] ?? null,
              ]),
            ),
          ),
          inherited: demoSettings.global,
          trusted: true,
        };
      }
      if (!current()) return;
      if (settingsDocument && settingsDocument.scope !== scope) draft.clear();
      else if (!preserveDraft)
        for (const [key, value] of priorDraft)
          if (draft.get(key) === value) draft.delete(key);
      settingsDocument = value;
      groups = value.groups;
      settingsNeedsReload = false;
      renderSettings();
    } catch (error) {
      if (current() && !controller.signal.aborted) throw error;
    } finally {
      if (settingsRead === controller) {
        settingsRead = undefined;
        if (isCurrent(target)) updateDraft();
      }
    }
  }

  function parseSetting(spec, element) {
    if (spec.type === "boolean")
      return element.getAttribute("aria-checked") === "true";
    if (spec.type === "enum") return JSON.parse(element.value);
    if (spec.type === "array")
      return element.value
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
    if (spec.type === "object") return JSON.parse(element.value);
    if (spec.type === "number") return Number(element.value);
    if (spec.type === "auto-number")
      return element.value === "auto" ? "auto" : Number(element.value);
    return element.value;
  }

  function recordSetting(event) {
    const element = event.target.closest("[data-setting]");
    if (
      !element ||
      !settingsDocument ||
      settingsDocument.scope !== $("#settings-scope").value
    )
      return;
    draft.set(element.dataset.setting, { raw: true, value: element.value });
    updateDraft();
  }

  async function saveSettings() {
    if (
      !settingsDocument ||
      settingsSaving ||
      settingsRead ||
      !draft.size ||
      settingsDocument.scope !== $("#settings-scope").value
    )
      return;
    const target = captureTarget();
    const { scope, revision } = settingsDocument;
    const submitted = new Map(draft);
    const patch = {};
    for (const [key, value] of submitted) {
      const spec = groups
        .flatMap((group) => group.fields)
        .find((item) => item.key === key);
      const element = [
        ...$("#settings-form").querySelectorAll("[data-setting]"),
      ].find((item) => item.dataset.setting === key);
      patch[key] = value === null ? null : parseSetting(spec, element);
    }
    settingsSaving = true;
    cancelSettingsRead();
    updateDraft();
    try {
      // 写入不挂读取的 signal；目标、scope 和 revision 在首个 await 前固定。
      if (live)
        await api("/api/settings", {
          sessionId: target.sessionId,
          scope,
          revision,
          patch,
        });
      else
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete demoSettings[scope][key];
          else demoSettings[scope][key] = value;
        }
      if (!isCurrent(target)) return;
      pending = true;
      if (settingsDocument?.scope === scope) {
        for (const [key, value] of submitted)
          if (draft.get(key) === value) draft.delete(key);
        settingsNeedsReload = true;
        if (canRead("general") && $("#settings-scope").value === scope)
          await loadSettings({ preserveDraft: true });
      }
      if (isCurrent(target)) toast("Pi 配置已保存");
    } finally {
      if (isCurrent(target)) {
        settingsSaving = false;
        updateDraft();
      }
    }
  }

  function changeScope() {
    const desired = $("#settings-scope").value;
    const target = captureTarget();
    const source = settingsDocument;
    if (!draft.size || !source) return loadSettings();
    $("#settings-scope").value = source.scope;
    openDialog(
      "切换配置范围",
      "<p>当前表单有未保存的修改。切换后将放弃这些修改。</p>",
      async () => {
        if (
          !isCurrent(target) ||
          !canRead("general") ||
          source !== settingsDocument
        )
          return;
        $("#settings-scope").value = desired;
        await loadSettings();
      },
      "放弃并切换",
    );
  }

  async function loadPersonality({ preserveDraft = false } = {}) {
    if (!live || !embedded || !canRead("personality") || personalitySaving)
      return;
    cancelPersonalityRead();
    const generation = personalityGeneration;
    const controller = (personalityRead = new AbortController());
    const target = captureTarget();
    const edits = personalityEdits;
    const current = () =>
      isCurrent(target) &&
      canRead("personality") &&
      generation === personalityGeneration;
    try {
      const value = await api("/api/personality", undefined, {
        signal: controller.signal,
      });
      if (!current()) return;
      personalityDocument = value;
      $("#personality-file").textContent = value.file;
      if (edits === personalityEdits && !(preserveDraft && personalityDirty)) {
        $("#personality-content").value = value.content;
        personalityDirty = false;
      }
      $("#personality-status").textContent = value.exists
        ? "已加载 AGENTS.md"
        : "尚未配置，保存后创建 AGENTS.md";
      $("#save-personality").disabled = false;
      renderDesktopConfiguration();
    } catch (error) {
      if (current() && !controller.signal.aborted) throw error;
    } finally {
      if (personalityRead === controller) personalityRead = undefined;
    }
  }

  async function savePersonality() {
    if (!personalityDocument || personalitySaving) return;
    const target = captureTarget();
    const content = $("#personality-content").value;
    const revision = personalityDocument.revision;
    const edits = personalityEdits;
    cancelPersonalityRead();
    personalitySaving = true;
    $("#save-personality").disabled = true;
    try {
      const result = await api("/api/personality", {
        sessionId: target.sessionId,
        content,
        revision,
      });
      if (!isCurrent(target)) return;
      personalityDocument = result;
      if (edits === personalityEdits) personalityDirty = false;
      $("#personality-status").textContent =
        result.effectiveFile !== result.file
          ? `已保存；Pi 当前优先加载 ${result.effectiveFile}`
          : result.reloadRequired?.length
            ? "已保存；部分 Agent 需重载后应用"
            : "已保存并应用到运行中的 Agent";
      toast("全局人格已保存");
    } catch (error) {
      if (isCurrent(target))
        $("#personality-status").textContent = error.message;
    } finally {
      if (isCurrent(target)) {
        personalitySaving = false;
        $("#save-personality").disabled = false;
      }
    }
  }

  function trustProject() {
    const target = captureTarget();
    openDialog(
      "信任当前项目",
      `<p>${esc(target.cwd)}</p><p>允许 pi 加载此项目的扩展、技能和配置。扩展会在本机执行。</p>`,
      async () => {
        if (!isCurrent(target)) return;
        await api("/api/project-trust", {
          sessionId: target.sessionId,
          trusted: true,
        });
        if (!isCurrent(target) || !canRead("general")) return;
        await refresh();
        if (isCurrent(target) && canRead("general") && !draft.size)
          await loadSettings();
      },
      "信任并加载",
    );
  }

  function click(button) {
    if (button.dataset.settingsCategory) {
      settingsCategory = button.dataset.settingsCategory;
      $("#settings-search").value = "";
      // 分类只切可见性，不重建表单，保留焦点、滚动和未保存输入。
      syncSettingsCategories();
      filterSettings();
      return;
    }
    if (button.dataset.setting) {
      const spec = groups
        .flatMap((group) => group.fields)
        .find((item) => item.key === button.dataset.setting);
      if (
        spec?.type === "boolean" &&
        settingsDocument?.scope === $("#settings-scope").value
      ) {
        const value = button.getAttribute("aria-checked") !== "true";
        button.setAttribute("aria-checked", String(value));
        draft.set(spec.key, value);
        updateDraft();
      }
      return;
    }
    if (button.dataset.resetSetting) {
      if (
        !settingsDocument ||
        settingsDocument.scope !== $("#settings-scope").value
      )
        return;
      const spec = groups
        .flatMap((group) => group.fields)
        .find((item) => item.key === button.dataset.resetSetting);
      if (!spec) return;
      draft.set(spec.key, null);
      button.closest(".setting-row").outerHTML = renderSetting(spec);
      updateDraft();
      return;
    }
    if (button.dataset.editPersonality) {
      desktopMessage("configure-prompt", {
        id: button.dataset.editPersonality,
      });
      return;
    }
    switch (button.dataset.action) {
      case "resource-settings":
      case "display-settings":
        settingsCategory =
          button.dataset.action === "resource-settings"
            ? "resources"
            : "display";
        syncSettingsCategories();
        filterSettings();
        return showView("general");
      case "theme":
        localStorage.setItem(
          "pi-web-theme",
          document.body.classList.contains("dark") ? "light" : "dark",
        );
        applyAppearance();
        return;
      case "trust-project":
        return trustProject();
      case "discard-settings":
        return loadSettings();
      case "add-personality":
        return desktopMessage("configure-prompt");
      case "refresh-personality":
        return loadPersonality();
    }
  }

  function handleClick(button) {
    if (disposed || !button) return false;
    const data = button.dataset;
    if (
      !(
        data.settingsCategory ||
        data.setting ||
        data.resetSetting ||
        data.editPersonality ||
        actions.has(data.action)
      )
    )
      return false;
    run(() => click(button));
    return true;
  }

  function reloaded() {
    if (disposed) return;
    pending = live ? !!getState()?.pending : false;
    updateDraft();
    if (live && canRead("general") && !draft.size) run(() => loadSettings());
  }

  function applyAppearance() {
    if (disposed) return;
    const theme = localStorage.getItem("pi-web-theme") || "light";
    const savedSize = Number(
      localStorage.getItem("pi-web-font-size") || DEFAULT_FONT_SIZE,
    );
    const size = String(
      Number.isInteger(savedSize)
        ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, savedSize))
        : DEFAULT_FONT_SIZE,
    );
    const dark =
      theme === "dark" || (theme === "system" && systemTheme.matches);
    document.body.classList.toggle("dark", dark);
    // 与 boot.js 首帧的 <html data-theme> 保持一致。
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.setProperty("--ui-font-size", `${size}px`);
    document.documentElement.style.setProperty(
      "--ui-font-scale",
      String(Number(size) / DEFAULT_FONT_SIZE),
    );
    $("#web-theme").value = theme;
    $("#web-font-size").value = size;
  }

  function adjustFontSize(delta) {
    if (disposed) return;
    const current = Number(
      localStorage.getItem("pi-web-font-size") || DEFAULT_FONT_SIZE,
    );
    const next = Math.max(
      MIN_FONT_SIZE,
      Math.min(MAX_FONT_SIZE, current + delta),
    );
    localStorage.setItem("pi-web-font-size", String(next));
    applyAppearance();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    ++targetGeneration;
    cancelReads();
    lifetime.abort();
  }

  for (const page of ["general", "personality", "appearance"])
    listen($("#view-" + page), "click", (event) => {
      const button = event.target.closest("button");
      if (button && !button.dataset.view && handleClick(button))
        event.stopPropagation();
    });
  listen($("#settings-search"), "input", filterSettings);
  listen($("#settings-form"), "input", recordSetting);
  listen($("#settings-form"), "change", recordSetting);
  listen($("#settings-form"), "submit", (event) => {
    event.preventDefault();
    run(saveSettings);
  });
  listen($("#settings-scope"), "change", () => run(changeScope));
  listen($("#personality-content"), "input", () => {
    ++personalityEdits;
    personalityDirty = true;
  });
  listen($("#personality-form"), "submit", (event) => {
    event.preventDefault();
    run(savePersonality);
  });
  listen(document, "visibilitychange", () => {
    cancelReads();
    ensureLoaded();
  });
  listen(systemTheme, "change", applyAppearance);
  listen(window, "storage", applyAppearance);
  listen($("#web-theme"), "change", (event) => {
    localStorage.setItem("pi-web-theme", event.target.value);
    applyAppearance();
  });
  listen($("#web-font-size"), "change", (event) => {
    localStorage.setItem("pi-web-font-size", event.target.value);
    applyAppearance();
  });
  applyAppearance();

  return {
    setContext,
    update,
    handleClick,
    reloaded,
    applyAppearance,
    adjustFontSize,
    dispose,
  };
}
