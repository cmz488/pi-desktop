/**
 * Pi 扩展 UI 的唯一适配对象。
 *
 * 接口：`createExtensionUiContext(options)` 返回 `{ ui, report, state, reset }`；
 *   `ui` 实现 `ExtensionUIContext`，`report()` 给出每个成员的实际实现层级与本次会话的使用情况。
 * 不变量：每个 SDK UI 成员都必须落在三态之一，不允许静默 no-op：
 *   - `native`：GUI 真实实现；
 *   - `degraded`：语义降级但仍可用（例如 TUI 组件被投影成有界文本），并带原因；
 *   - `refused`：明确拒绝并带原因，调用方拿到失败而不是假数据。
 * 为什么：SDK 的 ExtensionUIContext 是 TUI 契约（终端按键、ANSI 组件、主题切换）。GUI 宿主
 *   无法全部满足，但静默 no-op 会让扩展以为操作成功、假返回值会让扩展基于错误数据决策。
 *   把差异显式记录，扩展作者与用户都能看到实际能力。
 * 错误：`refused` 成员按 SDK 形状返回失败（`setTheme`）或抛 `HostUiUnsupported`；其余成员按
 *   各自说明降级，不吞掉交互错误。
 */

/** capability 层级；顺序即强弱，用于聚合报告。 */
export const UI_CAPABILITY_LEVELS = /** @type {const} */ (["native", "degraded", "refused"]);

/** 明确拒绝时抛出；调用方可据此区分"不支持"与"执行失败"。 */
export class HostUiUnsupported extends Error {
  constructor(member, reason) {
    super(reason);
    this.name = "HostUiUnsupported";
    this.member = member;
    this.code = "HOST_UI_UNSUPPORTED";
  }
}

/**
 * 每个 `ExtensionUIContext` 成员的声明实现层级。
 *
 * 这份表是契约：新增 SDK 成员必须在此登记，`test/extension-ui-conformance.test.mjs` 会比对
 * SDK 类型面的成员集合，漏登记即失败。
 */
export const UI_CAPABILITY_DECLARATION = Object.freeze({
  // GUI 真实实现。
  select: { level: "native" },
  confirm: { level: "native" },
  input: { level: "native" },
  editor: { level: "native" },
  notify: { level: "native" },
  setStatus: { level: "native" },
  setWorkingMessage: { level: "native" },
  setWorkingVisible: { level: "native" },
  setHiddenThinkingLabel: { level: "native" },
  setWidget: { level: "native" },
  setTitle: { level: "native" },
  setEditorText: { level: "native" },
  getEditorText: { level: "native" },
  pasteToEditor: { level: "native" },
  theme: { level: "native" },
  getAllThemes: { level: "native" },
  getTheme: { level: "native" },
  getToolsExpanded: { level: "native" },
  setToolsExpanded: { level: "native" },
  // 语义降级：能工作，但不是终端语义。
  onTerminalInput: {
    level: "degraded",
    reason: "GUI 没有原始终端输入流；返回的退订函数可用，但 handler 不会被调用",
  },
  setWorkingIndicator: {
    level: "degraded",
    reason: "GUI 使用自己的工作动画；仅保留帧配置用于状态行文案",
  },
  setFooter: {
    level: "degraded",
    reason: "页脚组件被投影成有界文本，不渲染终端布局",
  },
  setHeader: {
    level: "degraded",
    reason: "头部组件被投影成有界文本，不渲染终端布局",
  },
  custom: {
    level: "degraded",
    reason: "TUI 组件被投影成有界文本并以 undefined 结束；不支持键盘交互",
  },
  addAutocompleteProvider: {
    level: "degraded",
    reason: "补全由渲染进程实现；扩展提供者已登记但未接入",
  },
  setEditorComponent: {
    level: "degraded",
    reason: "GUI 使用自研输入框；已保存工厂但不应用",
  },
  getEditorComponent: {
    level: "degraded",
    reason: "回读已保存的工厂；该工厂不会被 GUI 应用",
  },
  // 明确拒绝。
  setTheme: {
    level: "refused",
    reason: "GUI 主题由宿主外观设置管理",
  },
});

/** TUI 组件渲染成有界纯文本行：GUI 只消费文本，不执行终端布局。 */
const MAX_COMPONENT_LINES = 40;
const MAX_COMPONENT_LINE_UNITS = 400;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function renderComponentLines(component) {
  if (component === undefined || component === null) return [];
  if (Array.isArray(component)) return component.flatMap((line) => renderComponentLines(line));
  const render = component.render ?? component;
  if (typeof render !== "function") return [];
  const lines = render.call(component, 100);
  if (!Array.isArray(lines)) return [];
  return lines
    .slice(0, MAX_COMPONENT_LINES)
    .map((line) => String(line).replace(ANSI, "").trim().slice(0, MAX_COMPONENT_LINE_UNITS))
    .filter(Boolean);
}

/**
 * 组件工厂可能同步抛错；GUI 端降级成空行而非中断会话。
 *
 * 保持同步：host.snapshot() 是同步 API（bridge 与 SSE 都同步调用），插槽行必须能在其中读出。
 * TUI 组件工厂本来也是同步的；返回 Promise 的工厂在这里降级为空行。
 */
function resolveComponentLines(factory, ...args) {
  if (typeof factory !== "function") return [];
  try {
    const produced = factory(...args);
    if (produced && typeof produced.then === "function") return [];
    return renderComponentLines(produced);
  } catch {
    return [];
  }
}

/** TUI 的最小替身：组件会调用 requestRender/terminal/children，GUI 不需要真实布局。 */
const stubTui = {
  requestRender() {},
  terminal: { columns: 100, rows: 40 },
  children: [],
};
const stubKeybindings = { matches: () => false, getKeys: () => [] };
const stubOverlayHandle = { show() {}, hide() {}, dispose() {} };
/** 页脚数据源的最小替身：只提供组件通常会读的字段。 */
const footerData = {
  getGitBranch: () => undefined,
  getStatuses: () => [],
  getContextUsage: () => undefined,
};

/**
 * 静态能力报告：只含声明层级，`used` 全为 0。
 *
 * 声明是适配器自身的属性，不依赖任何会话；资源 session 尚未就绪时 Host 用它兜底，
 * 客户端仍能知道哪些能力可用、哪些是降级或拒绝。
 */
export function uiDeclarationReport() {
  return {
    members: Object.fromEntries(
      Object.entries(UI_CAPABILITY_DECLARATION).map(([member, declared]) => [
        member,
        { ...declared, used: 0 },
      ]),
    ),
    usedMembers: [],
    counts: UI_CAPABILITY_LEVELS.reduce(
      (acc, level) => ({
        ...acc,
        [level]: Object.values(UI_CAPABILITY_DECLARATION).filter(
          (entry) => entry.level === level,
        ).length,
      }),
      {},
    ),
  };
}

/**
 * 快照里的 `ui` 字段：可见状态 + 能力报告。
 * 与宿主已有会话时返回的形状一致，使客户端不需要分辨来源。
 */
export function uiSnapshot(report = uiDeclarationReport()) {
  return {
    workingVisible: true,
    hiddenThinkingLabel: "",
    toolsExpanded: false,
    title: "",
    autocompleteProviders: 0,
    capabilities: report,
  };
}

/**
 * @param {object} options
 * @param {(label: string, prompt: object) => Promise<any>} options.prompt
 * @param {(event: {message: string, type?: string}) => void} options.notify
 * @param {(text: string) => void} options.setEditorText
 * @param {() => string} options.getEditorText
 * @param {(message?: string) => void} options.setWorkingMessage
 * @param {() => void} options.invalidate
 * @param {object} options.theme  已构造的 SDK `Theme` 实例
 * @param {() => {name: string, path?: string}[]} [options.listThemes]
 * @param {(name: string) => object | undefined} [options.loadTheme]
 */
export function createExtensionUiContext(options) {
  const {
    prompt,
    notify,
    setEditorText,
    getEditorText,
    setWorkingMessage,
    invalidate,
    theme,
    listThemes = () => [],
    loadTheme = () => undefined,
  } = options;

  /** 本次会话实际触达过的 degraded／refused 成员。 */
  const used = new Map();

  const state = {
    statuses: new Map(),
    widgets: new Map(),
    workingVisible: true,
    workingFrames: undefined,
    hiddenThinkingLabel: "",
    toolsExpanded: false,
    autocompleteProviders: 0,
    editorComponent: undefined,
    title: "",
  };

  const touch = (member) => {
    if (!used.has(member)) used.set(member, (used.get(member) ?? 0) + 1);
  };

  const ui = {
    // ── 交互 ─────────────────────────────────────────────────────────────
    select: (title, values, opts) =>
      prompt(title, {
        type: "select",
        message: title,
        options: values.map((value) => ({ id: value, label: value })),
        signal: opts?.signal,
        timeout: opts?.timeout,
      }),
    confirm: async (title, message, opts) =>
      (await prompt(title, {
        type: "select",
        message,
        options: [
          { id: "yes", label: "确认" },
          { id: "no", label: "取消" },
        ],
        signal: opts?.signal,
        timeout: opts?.timeout,
      })) === "yes",
    input: (title, placeholder, opts) =>
      prompt(title, {
        type: "text",
        message: title,
        placeholder,
        signal: opts?.signal,
        timeout: opts?.timeout,
      }),
    editor: (title, prefill) =>
      prompt(title, { type: "text", message: title, placeholder: prefill }),
    notify: (message, type) => notify({ message, type }),

    // ── 终端输入：GUI 没有原始按键流 ──────────────────────────────────────
    onTerminalInput: (handler) => {
      touch("onTerminalInput");
      // 返回可用的退订函数，使扩展的注册/清理逻辑仍然成立；handler 永不调用。
      return () => {};
    },

    // ── 状态与工作行 ──────────────────────────────────────────────────────
    setStatus: (key, text) => {
      if (text === undefined) state.statuses.delete(key);
      else state.statuses.set(key, String(text).replace(ANSI, "").slice(0, 200));
      invalidate();
    },
    setWorkingMessage: (message) => {
      setWorkingMessage(message === undefined ? "" : String(message).slice(0, 200));
      invalidate();
    },
    setWorkingVisible: (visible) => {
      state.workingVisible = visible !== false;
      invalidate();
    },
    setWorkingIndicator: (indicator) => {
      touch("setWorkingIndicator");
      state.workingFrames = indicator?.frames;
      invalidate();
    },
    setHiddenThinkingLabel: (label) => {
      state.hiddenThinkingLabel = label === undefined ? "" : String(label).slice(0, 80);
      invalidate();
    },

    // ── 组件插槽 ─────────────────────────────────────────────────────────
    setWidget: (key, value, widgetOptions) => {
      state.widgets.get(key)?.dispose?.();
      state.widgets.delete(key);
      if (value !== undefined) {
        state.widgets.set(key, {
          key,
          placement: widgetOptions?.placement ?? "aboveEditor",
          lines: () =>
            typeof value === "function"
              ? resolveComponentLines(value, stubTui, theme)
              : renderComponentLines(value),
        });
      }
      invalidate();
    },
    setFooter: (factory) => {
      if (factory === undefined) {
        state.widgets.delete("footer");
        invalidate();
        return;
      }
      touch("setFooter");
      state.widgets.set("footer", {
        key: "footer",
        placement: "footer",
        lines: () => resolveComponentLines(factory, stubTui, theme, footerData),
      });
      invalidate();
    },
    setHeader: (factory) => {
      if (factory === undefined) {
        state.widgets.delete("header");
        invalidate();
        return;
      }
      touch("setHeader");
      state.widgets.set("header", {
        key: "header",
        placement: "header",
        lines: () => resolveComponentLines(factory, stubTui, theme),
      });
      invalidate();
    },
    setTitle: (title) => {
      state.title = String(title ?? "").slice(0, 200);
      invalidate();
    },

    /**
     * TUI 自定义组件：需要键盘焦点与 ANSI 绘制。
     * GUI 降级为一次有界文本投影，随后以 `undefined` 结束（等同用户取消），使扩展的 `await`
     * 不会永久挂起，也不会误以为用户做了选择。
     */
    custom: async (factory, customOptions) => {
      touch("custom");
      let done;
      const settled = new Promise((resolve) => {
        done = resolve;
      });
      let lines = [];
      try {
        lines = renderComponentLines(
          await factory(stubTui, theme, stubKeybindings, done),
        );
      } catch {
        lines = [];
      }
      if (lines.length) notify({ message: lines.join("\n"), type: "info" });
      customOptions?.onHandle?.(stubOverlayHandle);
      done?.(undefined);
      await settled;
      return undefined;
    },

    // ── 编辑器 ───────────────────────────────────────────────────────────
    setEditorText: (text) => setEditorText(String(text ?? "")),
    getEditorText: () => getEditorText(),
    pasteToEditor: (text) => setEditorText(String(text ?? "")),
    addAutocompleteProvider: (factory) => {
      if (typeof factory !== "function") return;
      touch("addAutocompleteProvider");
      state.autocompleteProviders += 1;
      invalidate();
    },
    setEditorComponent: (factory) => {
      touch("setEditorComponent");
      state.editorComponent = factory;
      invalidate();
    },
    getEditorComponent: () => {
      touch("getEditorComponent");
      return state.editorComponent;
    },

    // ── 主题 ─────────────────────────────────────────────────────────────
    get theme() {
      return theme;
    },
    getAllThemes: () => {
      try {
        const themes = listThemes();
        return Array.isArray(themes) ? themes : [];
      } catch {
        return [];
      }
    },
    getTheme: (name) => {
      try {
        return loadTheme(String(name));
      } catch {
        return undefined;
      }
    },
    setTheme: () => {
      touch("setTheme");
      // 明确拒绝，而不是假装成功。
      return {
        success: false,
        error: "请通过 Desktop 外观设置管理主题",
      };
    },

    // ── 工具卡片 ─────────────────────────────────────────────────────────
    getToolsExpanded: () => state.toolsExpanded,
    setToolsExpanded: (expanded) => {
      state.toolsExpanded = expanded === true;
      invalidate();
    },
  };

  /**
   * 完整报告：声明层级 + 本次会话是否触达。
   * `usedMembers` 只含 degraded／refused 的触达记录，用来回答"这个扩展依赖哪些降级能力"。
   */
  const report = () => ({
    members: Object.fromEntries(
      Object.entries(UI_CAPABILITY_DECLARATION).map(([member, declared]) => [
        member,
        { ...declared, used: used.get(member) ?? 0 },
      ]),
    ),
    usedMembers: [...used.keys()].sort(),
    counts: UI_CAPABILITY_LEVELS.reduce(
      (acc, level) => ({
        ...acc,
        [level]: Object.values(UI_CAPABILITY_DECLARATION).filter((entry) => entry.level === level)
          .length,
      }),
      {},
    ),
  });

  const reset = () => {
    for (const widget of state.widgets.values()) widget?.dispose?.();
    state.widgets.clear();
    state.statuses.clear();
    state.workingVisible = true;
    state.workingFrames = undefined;
    state.hiddenThinkingLabel = "";
    state.toolsExpanded = false;
    state.autocompleteProviders = 0;
    state.editorComponent = undefined;
    state.title = "";
    used.clear();
  };

  /** 首帧也要有声明层级可读，且 `reset` 不应让声明消失（声明是静态契约）。 */
  return { ui, report, state, reset };
}
