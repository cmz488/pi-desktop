import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtensionAdapterRegistry } from "../src/shared/extension-adapters.mjs";
import { projectExtensionPages } from "../src/ui/shared/extension-workbench.js";

const registry = createExtensionAdapterRegistry();
const card = (id, properties = {}, extra = {}) => {
  const row = {
    role: "custom",
    id,
    customType: "fixture",
    display: true,
    details: { piDesktop: { version: 1, title: id, ...properties } },
    ...extra,
  };
  return { ...row, extensionView: registry.project(row) };
};
const state = (key) => ({ mode: "state", key });
const pages = (rows, sessionId = "A") =>
  projectExtensionPages(registry, rows, { sessionId });

test("extension pages reuse latest-state policy and never duplicate a tool's state card", () => {
  const rows = [
    card("old", { presentation: state("build") }),
    card("ordinary"),
    card(
      "latest",
      { presentation: state("build") },
      { role: "toolResult", toolCallId: "call" },
    ),
    card("other", { presentation: state("review") }),
  ];
  const before = structuredClone(rows);
  const result = pages(rows);
  assert.deepEqual(
    result.map((page) => page.view.title),
    ["other", "latest", "ordinary"],
  );
  assert.deepEqual(
    result.map((page) => page.state),
    [true, true, false],
  );
  assert.equal(new Set(result.map((page) => page.key)).size, result.length);
  assert.deepEqual(rows, before);
});

test("page identity survives updates and lazy detail hydration, but is isolated by session", () => {
  const first = pages([
    card("first", { presentation: state("build") }, { lazy: true }),
  ])[0];
  const next = pages([card("next", { presentation: state("build") })])[0];
  assert.equal(first.key, next.key);
  assert.equal(first.view.lazyMessageId, "first");
  assert.equal(next.view.lazyMessageId, undefined);
  assert.notEqual(
    first.key,
    pages([card("first", { presentation: state("build") })], "B")[0].key,
  );
});

test("hidden, ordinary and unsupported messages do not create phantom pages", () => {
  assert.deepEqual(
    pages([
      { role: "user", id: "u", text: "ordinary" },
      card("hidden", {}, { display: false }),
      {
        role: "custom",
        id: "unsupported",
        extensionView: { adapterId: "unknown", version: 1 },
      },
    ]),
    [],
  );
  const future = card("future");
  future.extensionView.version = 99;
  assert.deepEqual(pages([future]), []);
});

test("ordinary extension records stay separate and pages are bounded newest-first", () => {
  const rows = Array.from({ length: 100 }, (_, index) => card(String(index)));
  const result = pages(rows);
  assert.equal(result.length, 80);
  assert.equal(result[0].view.title, "99");
  assert.equal(result.at(-1).view.title, "20");
});

test("registered renderers receive page placement through the existing interface", () => {
  const custom = createExtensionAdapterRegistry([]);
  const contexts = [];
  const release = custom.register({
    id: "fixture",
    version: 1,
    project: () => ({ title: "Custom detail" }),
    render: (view, context) => {
      contexts.push(context.placement);
      return view.title;
    },
  });
  const row = {
    id: "custom",
    role: "custom",
    extensionView: custom.project({}),
  };
  const [page] = projectExtensionPages(custom, [row], { sessionId: "A" });
  assert.equal(
    custom.render(page.view, { placement: "page" }),
    "Custom detail",
  );
  assert.deepEqual(contexts, ["page"]);
  release();
  assert.deepEqual(
    projectExtensionPages(custom, [row], { sessionId: "A" }),
    [],
  );
});
