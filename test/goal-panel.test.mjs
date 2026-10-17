import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtensionAdapterRegistry } from "../src/shared/extension-adapters.mjs";
import {
  projectExtensionPages,
  projectExtensionPanels,
} from "../src/ui/shared/extension-workbench.js";

const registry = createExtensionAdapterRegistry();
const project = (message) => ({
  ...message,
  extensionView: registry.project(message),
});
const goalRow = (goal, id = "goal-1") =>
  project({
    id,
    role: "toolResult",
    toolName: "update_goal",
    details: { version: 3, goal },
  });
const activeGoal = {
  id: "goal-1",
  objective: "统一 pi-goal-x 操作",
  status: "active",
  sisyphus: false,
  autoContinue: true,
  revision: 7,
  usage: { activeSeconds: 754, tokensUsed: 12345 },
  taskList: {
    tasks: [
      { id: "t1", title: "汇总工具", status: "pending" },
      { id: "t2", title: "实现面板", status: "complete" },
      { id: "t3", title: "补充回归", status: "in_progress", subtasks: [] },
    ],
  },
};

test("goal tool results collapse into one operations panel", () => {
  const row = goalRow(activeGoal);
  const panels = registry.panels([row], { sessionId: "A" });
  assert.equal(panels.length, 1);
  assert.equal(panels[0].panelId, "goal");
  const html = registry.renderPanel(panels[0]);
  assert.match(html, /goal-panel/);
  assert.match(html, /统一 pi-goal-x 操作/);
  assert.match(html, /data-panel-action="command"/);
  assert.match(html, /data-panel-value="\/goal-pause"/);
  assert.match(html, /data-panel-action="prefill"/);
  assert.match(html, /汇总工具/);
  assert.match(html, /1 \/ 3 项任务/);
  assert.match(html, /自动续跑/);
  // The goal adapter no longer produces a second, per-card workbench page.
  assert.equal(
    projectExtensionPages(registry, [row], { sessionId: "A" }).length,
    0,
  );
  assert.equal(
    projectExtensionPanels(registry, [row], { sessionId: "A" }).length,
    1,
  );
});

test("panel coverage and view lookup are adapter-declared, not plugin-id branching", () => {
  const row = goalRow(activeGoal);
  assert.equal(registry.panelForTool("update_goal")?.panelId, "goal");
  assert.equal(registry.panelForTool("set_goal_tasks")?.panelId, "goal");
  assert.equal(registry.panelForTool("bash"), undefined);
  assert.equal(registry.panelForView(row.extensionView)?.panelId, "goal");
  assert.equal(
    registry.panelForView({ adapterId: "unknown", version: 1 }),
    undefined,
  );
  const card = project({
    id: "card-1",
    role: "custom",
    details: { piDesktop: { version: 1, title: "普通扩展" } },
  });
  assert.deepEqual(registry.panels([card], { sessionId: "A" }), []);
});

test("audit, draft and completed states share the same panel", () => {
  const goal = goalRow(activeGoal);
  const audit = project({
    id: "audit-1",
    role: "custom",
    customType: "pi-goal-audit-event",
    content: "I approve this completion claim.",
    details: { phase: "approved", auditor: "deepseek/deepseek-flash" },
  });
  const approved = registry.renderPanel(
    registry.panels([goal, audit], { sessionId: "A" })[0],
  );
  assert.match(approved, /验收通过/);
  assert.match(approved, /I approve this completion claim/);
  assert.match(approved, /deepseek\/deepseek-flash/);

  const draft = project({
    id: "draft-1",
    role: "custom",
    customType: "pi-goal-draft",
    details: { version: 1, seed: "起草新目标", clearedAt: undefined },
  });
  const drafting = registry.renderPanel(
    registry.panels([draft], { sessionId: "A" })[0],
  );
  assert.match(drafting, /起草中/);
  assert.match(drafting, /data-panel-action="focus-composer"/);

  const completed = registry.renderPanel(
    registry.panels([goalRow({ ...activeGoal, status: "complete" })], {
      sessionId: "A",
    })[0],
  );
  assert.match(completed, /已完成/);
  assert.match(completed, /新建目标/);
  assert.doesNotMatch(completed, /data-panel-value="\/goal-pause"/);
});

test("goal panel declares its executable commands at registration", () => {
  const page = registry.panels([goalRow(activeGoal)], { sessionId: "A" })[0];
  assert.equal(page.panel.acceptsAction("command", "/goal-pause"), true);
  assert.equal(page.panel.acceptsAction("command", "/goal-resume"), true);
  assert.equal(page.panel.acceptsAction("command", "/goal-tweak"), false);
  assert.equal(page.panel.acceptsAction("command", "/goal-pause "), false);
  assert.equal(page.panel.acceptsAction("prefill", "/goal-tweak"), true);
  assert.equal(page.panel.acceptsAction("refresh", ""), true);
  assert.equal(page.panel.acceptsAction("refresh", "x"), false);
  assert.equal(page.panel.acceptsAction("focus-composer", ""), true);
});
