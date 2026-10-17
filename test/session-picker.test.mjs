import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionHost } from "../src/tui/session-manager.mjs";
import { SessionsView } from "../src/tui/sessions.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { until } from "./concurrent-fixture.mjs";
test("searchable picker preserves drafts, uses exact IDs and fits narrow terminals", async (t) => {
  const manager = new SessionHost();
  const options = (id) => ({
    snapshot: () => ({
      sessionId: id,
      name: id === "aaaaaaaa-1111" ? "Alpha" : "Beta",
      idle: true,
      messages: [],
    }),
    prompt: async () => {},
    abort: async () => {},
  });
  manager.transport(options("aaaaaaaa-1111"), { native: true });
  manager.transport(options("bbbbbbbb-1111"), { native: false });
  manager.focus("aaaaaaaa-1111");
  const view = new SessionsView(
    { terminal: { rows: 14 }, requestRender() {} },
    { fg: (_, s) => s },
    manager,
    () => {},
  );
  t.after(async () => {
    view.dispose();
    await manager.dispose();
  });
  view.handleInput("original draft");
  view.present(await manager.command());
  view.handleInput("Beta");
  assert(view.render(48).join("\n").includes("Beta"));
  assert(!view.render(48).join("\n").includes("Alpha"));
  for (const width of [20, 48, 110])
    assert(view.render(width).every((line) => visibleWidth(line) <= width));
  view.handleInput("\r");
  await until(() => manager.focusId === "bbbbbbbb-1111");
  assert.equal(manager.tuiDrafts.get("aaaaaaaa-1111"), "original draft");
  assert(![...manager.tuiDrafts.values()].includes("Beta"));
});
