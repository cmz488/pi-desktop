import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createExtensionAdapterRegistry,
  extensionAdapterRegistry,
} from "../src/shared/extension-adapters.mjs";
import { projectMessage } from "../src/shared/conversation.mjs";
import {
  chatSnapshot,
  projectConversationTimeline,
} from "../src/shared/lazy-data.mjs";

const adapter = (options = {}) => ({
  id: "fixture",
  version: 1,
  project: () => ({ title: "fixture" }),
  render: (view) => view.title,
  ...options,
});
const cardMessage = (id, card, extra = {}) =>
  projectMessage(
    {
      role: "custom",
      customType: "fixture",
      content: `fallback:${id}`,
      details: { piDesktop: { version: 1, title: id, ...card } },
      ...extra,
    },
    id,
  );
const goalMessage = (id, goal) =>
  projectMessage(
    {
      role: "toolResult",
      toolName: "get_goal",
      toolCallId: id,
      content: [{ type: "text", text: `goal result ${id}` }],
      details: { version: 3, goal },
    },
    id,
  );
const goal = (objective) => ({
  objective,
  status: "active",
  usage: { activeSeconds: 120, tokensUsed: 456 },
  taskList: {
    tasks: [
      { id: "1", title: "check", status: "complete" },
      { id: "2", title: "ship", status: "pending" },
    ],
  },
});

test("Goal draft entries and native widgets share one scoped state card and escape presentation text", () => {
  const draft = projectMessage(
    {
      role: "custom",
      customType: "pi-goal-draft",
      content: "",
      details: { version: 1, seed: "Plan the feature" },
    },
    "resource:pi-goal-draft",
  );
  assert.equal(draft.extensionView.status, "起草中");
  assert.equal(
    projectMessage(
      {
        role: "custom",
        customType: "pi-goal-draft",
        details: { version: 1, seed: "old", clearedAt: "done" },
      },
      "cleared",
    ).extensionView,
    undefined,
  );
  const widget = projectMessage(
    {
      role: "custom",
      customType: "pi-widget",
      content: "",
      details: {
        key: "goal",
        lines: ["Live goal", "<script>alert(1)</script>", "Paused"],
      },
    },
    "widget:goal",
  );
  const layout = extensionAdapterRegistry.layout(
    [draft, goalMessage("tool", goal("old")), widget],
    { sessionId: "A" },
  );
  assert.equal(layout.states.length, 1);
  assert.equal(layout.states[0].extensionView.title, "Live goal");
  assert.match(
    extensionAdapterRegistry.render(layout.states[0].extensionView),
    /&lt;script&gt;/,
  );
  assert.match(
    extensionAdapterRegistry.render(layout.states[0].extensionView),
    /Paused/,
  );
});

test("old disposers cannot release registrations created after dispose, and cleanup is exactly once", () => {
  const registry = createExtensionAdapterRegistry([]);
  const calls = [];
  const oldDispose = registry.register(
    adapter({
      onRegister: () => () => calls.push("old cleanup"),
      onDispose: () => calls.push("old dispose"),
    }),
  );
  registry.dispose();
  registry.dispose();
  const newDispose = registry.register(
    adapter({
      render: () => "new",
      onRegister: () => () => calls.push("new cleanup"),
      onDispose: () => calls.push("new dispose"),
    }),
  );
  oldDispose();
  oldDispose();
  assert.equal(registry.render({ adapterId: "fixture", version: 1 }), "new");
  assert.deepEqual(calls, ["old cleanup", "old dispose"]);
  newDispose();
  registry.dispose();
  assert.deepEqual(calls, [
    "old cleanup",
    "old dispose",
    "new cleanup",
    "new dispose",
  ]);
});

test("a cleanup can replace its own registration without the old entry deleting the new one", () => {
  const registry = createExtensionAdapterRegistry([]);
  const dispose = registry.register(
    adapter({
      onRegister: () => () =>
        registry.register(adapter({ render: () => "replacement" })),
    }),
  );
  dispose();
  dispose();
  assert.equal(
    registry.render({ adapterId: "fixture", version: 1 }),
    "replacement",
  );
  registry.dispose();
});

test("registration rollback and failing cleanup do not prevent releasing the remaining adapters", (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const registry = createExtensionAdapterRegistry([]);
  const calls = [];
  registry.setSession("A");
  assert.throws(
    () =>
      registry.register(
        adapter({
          onRegister: () => () => calls.push("rollback"),
          onSessionChanged: () => {
            throw new Error("registration failed");
          },
          onDispose: () => calls.push("failed disposed"),
        }),
      ),
    /registration failed/,
  );
  registry.register(
    adapter({ onDispose: () => calls.push("replacement disposed") }),
  );
  registry.register(
    adapter({
      id: "throws",
      onRegister: () => () => {
        throw new Error("cleanup failed");
      },
      onDispose: () => calls.push("throws disposed"),
    }),
  );
  registry.dispose();
  assert.deepEqual(calls, [
    "rollback",
    "failed disposed",
    "throws disposed",
    "replacement disposed",
  ]);
  assert.equal(errors.length, 1);
});

test("legacy project/render registrations and session notifications remain compatible", () => {
  const registry = createExtensionAdapterRegistry([]);
  const sessions = [];
  registry.setSession("A");
  const unregister = registry.register(
    adapter({
      onSessionChanged: (next, previous) => sessions.push([next, previous]),
    }),
  );
  registry.setSession("A");
  registry.setSession("B");
  assert.deepEqual(sessions, [
    ["A", undefined],
    ["B", "A"],
  ]);
  const view = registry.project({});
  assert.equal(registry.render(view), "fixture");
  assert.equal(registry.render({ ...view, version: 2 }), "");
  unregister();
  registry.setSession("C");
  assert.equal(sessions.length, 2);
  assert.equal(registry.render(view), "");
});

test("registration identity is stable, and failed initial registrations release earlier resources", () => {
  const registry = createExtensionAdapterRegistry([]);
  const definition = adapter();
  const dispose = registry.register(definition);
  definition.id = "mutated";
  definition.version = 9;
  assert.equal(registry.project({}).adapterId, "fixture");
  assert.equal(
    registry.render({ adapterId: "fixture", version: 1, title: "stable" }),
    "stable",
  );
  dispose();
  assert.equal(
    registry.render({ adapterId: "fixture", version: 1, title: "gone" }),
    "",
  );
  const calls = [];
  assert.throws(
    () =>
      createExtensionAdapterRegistry([
        adapter({ onRegister: () => () => calls.push("released") }),
        adapter({
          id: "failure",
          onRegister: () => {
            throw new Error("startup failed");
          },
        }),
      ]),
    /startup failed/,
  );
  assert.deepEqual(calls, ["released"]);
});

test("Goal only claims its declared tool results; generic cards retain precedence", () => {
  for (const details of [
    { version: 3 },
    { version: 3, goal: goal("foreign") },
    { version: 3, goal: null },
  ]) {
    assert.equal(
      extensionAdapterRegistry.project({
        role: "toolResult",
        toolName: "other",
        details,
      }),
      undefined,
    );
  }
  assert.equal(
    extensionAdapterRegistry.project({
      role: "custom",
      details: { version: 3, goal: goal("foreign") },
    }),
    undefined,
  );
  assert.equal(
    goalMessage("empty", null).extensionView.title,
    "当前没有活动目标",
  );
  assert.equal(
    goalMessage("goal", goal("real")).extensionView.adapterId,
    "pi-goal-x",
  );
  const declared = cardMessage(
    "declared",
    {},
    {
      role: "toolResult",
      toolName: "get_goal",
      details: {
        version: 3,
        goal: goal("goal"),
        piDesktop: { version: 1, title: "declared" },
      },
    },
  );
  assert.equal(declared.extensionView.adapterId, "pi-desktop-card");
});

test("Goal and declared cards use the same safe schema, summary, rendering and state layout", () => {
  const native = goalMessage("goal", goal("<img src=x onerror=alert(1)>"));
  const declared = cardMessage("build", {
    label: "构建",
    status: "运行中",
    progress: { value: 1, total: 2 },
    items: [{ label: "<script>unsafe()</script>", status: "done" }],
    metrics: ["2 分钟"],
    presentation: { mode: "state", key: "fixture/build" },
  });
  for (const message of [native, declared]) {
    assert.equal(message.extensionView.kind, "card");
    assert.equal(
      extensionAdapterRegistry.summary(message.extensionView).includes("1/2"),
      true,
    );
    const html = extensionAdapterRegistry.render(message.extensionView);
    assert.match(html, /extension-generic/);
    assert.match(html, /role="progressbar"/);
    assert(!/<script>|<img/.test(html));
    assert.equal(
      extensionAdapterRegistry.render(message.extensionView, {
        placement: "tool",
      }),
      "",
    );
  }
  const layout = extensionAdapterRegistry.layout([native, declared], {
    sessionId: "A",
  });
  assert.equal(layout.states.length, 2);
  assert.equal(
    layout.messages.length,
    1,
    "native tool result remains available",
  );
  assert.equal(
    layout.states.every((row) => row.extensionState),
    true,
  );
});

test("ordinary cards keep history; state cards replace only the same scoped identity without mutating messages", () => {
  const rows = [
    cardMessage("ordinary-old", {}),
    cardMessage("state-old", { presentation: { mode: "state", key: "build" } }),
    cardMessage("ordinary-new", {}),
    cardMessage("state-new", { presentation: { mode: "state", key: "build" } }),
    cardMessage("independent", {
      presentation: { mode: "state", key: "deploy" },
    }),
    cardMessage(
      "hidden",
      { presentation: { mode: "state", key: "build" } },
      { display: false },
    ),
  ];
  const original = structuredClone(rows);
  const layout = extensionAdapterRegistry.layout(rows, { sessionId: "A" });
  assert.deepEqual(
    layout.messages.filter((row) => row.display !== false).map((row) => row.id),
    ["ordinary-old", "ordinary-new"],
  );
  assert.deepEqual(
    layout.states.map((row) => row.extensionView.title),
    ["state-new", "independent"],
  );
  const other = extensionAdapterRegistry.layout(rows, { sessionId: "B" });
  assert.notEqual(layout.states[0].id, other.states[0].id);
  assert.deepEqual(rows, original);
});

test("lazy Goal detail rehydration preserves state identity and its disclosure through the presentation interface", () => {
  const full = goalMessage("goal", goal("Ship safely"));
  const lazy = chatSnapshot({ messages: [full] }).messages[0];
  const before = projectConversationTimeline([lazy], { sessionId: "A" }).at(-1);
  const after = projectConversationTimeline([full], { sessionId: "A" }).at(-1);
  assert.equal(before.id, after.id);
  assert.equal(
    before.extensionView.disclosureKey,
    after.extensionView.disclosureKey,
  );
  assert.equal(before.extensionView.lazyMessageId, "goal");
  assert(!after.extensionView.lazyMessageId);
  const disclosures = new Map([[before.extensionView.disclosureKey, true]]);
  assert.match(
    extensionAdapterRegistry.render(before.extensionView, { disclosures }),
    /data-lazy-messages/,
  );
  const html = extensionAdapterRegistry.render(after.extensionView, {
    disclosures,
  });
  assert.match(html, /<details[^>]*open/);
  assert.match(html, /ship/);
});

test("unsupported and failed adapters retain ordinary message fallback and isolate failures", (t) => {
  t.mock.method(console, "error", () => {});
  const registry = createExtensionAdapterRegistry([
    adapter({
      id: "bad",
      project: () => {
        throw new Error("bad projection");
      },
      render: () => {
        throw new Error("bad rendering");
      },
    }),
    adapter({ id: "good" }),
  ]);
  assert.equal(registry.project({}).adapterId, "good");
  assert.equal(registry.render({ adapterId: "bad", version: 1 }), "");
  const row = {
    role: "custom",
    id: "unknown",
    text: "fallback",
    extensionView: { adapterId: "missing", version: 2 },
  };
  assert.deepEqual(registry.layout([row]).messages, [row]);
  const timeline = projectConversationTimeline([row]);
  assert.equal(timeline[0].blocks[0].text, "fallback");
});

test("previous Goal views from a running Host are normalized inside the module", () => {
  const legacy = {
    adapterId: "pi-goal-x",
    version: 1,
    kind: "goal",
    title: "old Host",
    status: "进行中",
    mode: "目标",
    done: 1,
    total: 2,
    tasks: [{ title: "legacy task", status: "待办", depth: 0 }],
  };
  const result = extensionAdapterRegistry.layout([
    { role: "toolResult", id: "old", extensionView: legacy },
  ]);
  assert.equal(result.states.length, 1);
  assert.equal(result.states[0].extensionView.kind, "card");
  assert.match(
    extensionAdapterRegistry.render(result.states[0].extensionView),
    /legacy task/,
  );
});
