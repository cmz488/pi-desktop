import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { embeddedSdkEntry } from "../src/agent/pi-sdk.mjs";
import {
  createExtensionUiContext,
  UI_CAPABILITY_DECLARATION,
  UI_CAPABILITY_LEVELS,
} from "../src/agent/ui-context.mjs";

/**
 * 扩展 UI 一致性契约。
 *
 * 目的：`ExtensionUIContext` 是 TUI 契约，GUI 宿主必然有差异。这些差异必须是**显式**的三态
 * （native／degraded／refused），不能是静默 no-op 或假返回值。本套件守住三条：
 *   1. 覆盖面：SDK 的每个成员都在声明表里（SDK 升级新增成员时立刻失败）；
 *   2. 诚实性：每个成员的实际行为与声明层级一致；
 *   3. 无静默 no-op：degraded／refused 必须可观测（报告里留下记录或返回失败）。
 */

/** 解析 SDK `.d.ts` 里 `ExtensionUIContext` 的成员名，作为类型面的权威来源。 */
async function sdkUiMembers() {
  const url = new URL("./core/extensions/types.d.ts", embeddedSdkEntry);
  const source = await readFile(url, "utf8");
  const start = source.indexOf("export interface ExtensionUIContext");
  assert(start >= 0, "SDK 中找不到 ExtensionUIContext");
  let depth = 0;
  let from = source.indexOf("{", start);
  let to = -1;
  for (let at = from; at < source.length; at += 1) {
    if (source[at] === "{") depth += 1;
    else if (source[at] === "}") {
      depth -= 1;
      if (depth === 0) {
        to = at;
        break;
      }
    }
  }
  assert(to > from, "ExtensionUIContext 花括号不匹配");
  const body = source.slice(from, to + 1);
  // 成员形如 `name(...)`、`name<T>(...)` 或 `readonly name: T`；泛型参数必须允许，否则
  // 像 `custom<T>(factory)` 这样的重载会被漏掉。
  const members = [
    ...body.matchAll(
      /^ {4}(?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\??\s*(?:<[^>]*>)?\s*[:(]/gm,
    ),
  ].map((match) => match[1]);
  return [...new Set(members)].sort();
}

/** 建一个可观测的替身宿主，记录 GUI 侧收到的每一次回调。 */
function fixture(overrides = {}) {
  const seen = {
    prompts: [],
    notifications: [],
    editorTexts: [],
    editor: "mirror-text",
    workingMessages: [],
    invalidations: 0,
  };
  const created = createExtensionUiContext({
    prompt: async (label, prompt) => {
      seen.prompts.push({ label, ...prompt });
      return prompt.type === "select" ? "yes" : "typed";
    },
    notify: (event) => seen.notifications.push(event),
    setEditorText: (text) => seen.editorTexts.push(text),
    getEditorText: () => seen.editor,
    setWorkingMessage: (message) => seen.workingMessages.push(message),
    invalidate: () => {
      seen.invalidations += 1;
    },
    theme: { name: "fixture-theme" },
    listThemes: () => [{ name: "dark", path: "/themes/dark.json" }],
    loadTheme: (name) => (name === "dark" ? { name } : undefined),
    ...overrides,
  });
  return { ...created, seen };
}

test("声明表覆盖 SDK ExtensionUIContext 的每一个成员", async () => {
  const members = await sdkUiMembers();
  assert(members.length > 0, "SDK 成员解析为空，契约无法成立");
  const declared = Object.keys(UI_CAPABILITY_DECLARATION).sort();
  assert.deepEqual(
    declared,
    members,
    "声明表与 SDK 类型面不一致：新增成员必须在 ui-context.mjs 登记实现层级",
  );
});

test("每个成员都落在三态之一，且没有未声明的实现", () => {
  for (const [member, entry] of Object.entries(UI_CAPABILITY_DECLARATION)) {
    assert.ok(
      UI_CAPABILITY_LEVELS.includes(entry.level),
      `${member} 的实现层级 ${entry.level} 无效`,
    );
    if (entry.level !== "native")
      assert.ok(
        typeof entry.reason === "string" && entry.reason.length > 0,
        `${member} 声明为 ${entry.level} 时必须给出原因`,
      );
  }
});

test("native 成员真实可用，不是空实现", async () => {
  const { ui, state } = fixture();

  assert.equal(await ui.select("标题", ["a", "b"]), "yes");
  assert.equal(await ui.confirm("标题", "内容"), true);
  assert.equal(await ui.input("标题", "占位"), "typed");
  assert.equal(await ui.editor("标题", "预填"), "typed");

  ui.notify("提示", "info");

  ui.setStatus("k", "值");
  ui.setWorkingMessage("生成中");
  ui.setWorkingVisible(false);
  ui.setHiddenThinkingLabel("思考中");
  ui.setTitle("窗口标题");
  ui.setWidget("w", ["行一", "行二"]);
  assert.deepEqual(state.widgets.get("w").lines(), ["行一", "行二"]);
  ui.setEditorText("草稿");
  ui.pasteToEditor("粘贴");
  ui.setToolsExpanded(true);

  assert.equal(ui.getEditorText(), "mirror-text");
  assert.equal(ui.getToolsExpanded(), true);
  assert.equal(ui.theme.name, "fixture-theme");
  assert.deepEqual(ui.getAllThemes(), [
    { name: "dark", path: "/themes/dark.json" },
  ]);
  assert.equal(ui.getTheme("dark").name, "dark");
  assert.equal(ui.getTheme("missing"), undefined);
});

test("setStatus 的 cleared 与 setTitle／setWorkingVisible 进入宿主状态", () => {
  const { ui, state } = fixture();
  ui.setStatus("a", "一");
  assert.equal(state.statuses.get("a"), "一");
  ui.setStatus("a", undefined);
  assert.equal(state.statuses.has("a"), false);

  ui.setTitle("标题");
  assert.equal(state.title, "标题");

  ui.setWorkingVisible(false);
  assert.equal(state.workingVisible, false);
  ui.setWorkingVisible(true);
  assert.equal(state.workingVisible, true);

  ui.setHiddenThinkingLabel("隐");
  assert.equal(state.hiddenThinkingLabel, "隐");
  ui.setHiddenThinkingLabel();
  assert.equal(state.hiddenThinkingLabel, "");
});

test("degraded 成员可用且留下使用记录，不是静默 no-op", async () => {
  const { ui, report, state } = fixture();

  // 终端输入：返回可用退订函数，handler 不调用（GUI 没有原始按键流）。
  let terminalHandlerCalls = 0;
  const unsubscribe = ui.onTerminalInput(() => {
    terminalHandlerCalls += 1;
  });
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  assert.equal(terminalHandlerCalls, 0);

  // TUI 组件：投影成文本并立即结束，await 不会挂起。
  const custom = await ui.custom(() => ({ render: () => ["组件行"] }));
  assert.equal(custom, undefined);

  // 头部／页脚：组件被投影成有界文本。
  ui.setHeader(() => ({ render: () => ["头部"] }));
  ui.setFooter(() => ({ render: () => ["页脚"] }));
  assert.deepEqual(state.widgets.get("header").lines(), ["头部"]);
  assert.deepEqual(state.widgets.get("footer").lines(), ["页脚"]);

  // 编辑器组件：保存但不应用，回读诚实。
  const factory = () => ({ render: () => [] });
  ui.setEditorComponent(factory);
  assert.equal(ui.getEditorComponent(), factory);

  ui.addAutocompleteProvider(() => ({}));
  ui.setWorkingIndicator({ frames: ["*"] });

  const used = report().usedMembers;
  for (const member of [
    "onTerminalInput",
    "custom",
    "setHeader",
    "setFooter",
    "setEditorComponent",
    "addAutocompleteProvider",
    "setWorkingIndicator",
  ])
    assert.ok(used.includes(member), `${member} 使用后必须出现在报告里`);
});

test("refused 成员返回明确失败，不回显假成功", () => {
  const { ui, report } = fixture();
  const result = ui.setTheme("dark");
  assert.equal(result.success, false);
  assert.match(result.error, /主题/);
  assert.ok(report().usedMembers.includes("setTheme"));
});

test("报告统计与声明表一致，reset 清空使用记录但保留声明", async () => {
  const { ui, report, state, reset } = fixture();
  ui.onTerminalInput(() => {});
  ui.setWidget("w", ["x"]);
  ui.setStatus("k", "v");

  const counts = report().counts;
  for (const level of UI_CAPABILITY_LEVELS)
    assert.equal(
      counts[level],
      Object.values(UI_CAPABILITY_DECLARATION).filter(
        (entry) => entry.level === level,
      ).length,
      `${level} 计数与声明表不一致`,
    );
  assert.equal(
    Object.values(counts).reduce((sum, value) => sum + value, 0),
    Object.keys(UI_CAPABILITY_DECLARATION).length,
  );

  reset();
  assert.deepEqual(report().usedMembers, []);
  assert.equal(state.widgets.size, 0);
  assert.equal(state.statuses.size, 0);
  // 声明是静态契约，不随 reset 消失。
  assert.equal(
    Object.keys(report().members).length,
    Object.keys(UI_CAPABILITY_DECLARATION).length,
  );
});

test("交互超时与取消信号透传到宿主交互队列", async () => {
  const { ui, seen } = fixture();
  const controller = new AbortController();
  await ui.select("标题", ["a"], { signal: controller.signal, timeout: 2500 });
  const prompt = seen.prompts.at(-1);
  assert.equal(prompt.signal, controller.signal);
  assert.equal(prompt.timeout, 2500);
  await ui.confirm("标题", "内容", { timeout: 1000 });
  assert.equal(seen.prompts.at(-1).timeout, 1000);
});
