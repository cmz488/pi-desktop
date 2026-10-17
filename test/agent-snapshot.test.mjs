import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activityFor,
  createAgentSnapshot,
} from "../src/server/agent-snapshot.mjs";

test("Agent snapshot owns the common shape and defaults", () => {
  const snapshot = createAgentSnapshot({
    host: "headless",
    sessionId: 42,
    cwd: "/project",
    idle: true,
    messages: [{ id: "m" }],
    extra: { widgets: [] },
  });
  assert.equal(snapshot.sessionId, "42");
  assert.equal(snapshot.name, "新会话");
  assert.equal(snapshot.activity.kind, "idle");
  assert.equal(snapshot.operation, "");
  assert.equal(snapshot.thinkingLevel, "off");
  assert.equal(snapshot.projectTrusted, true);
  assert.deepEqual(snapshot.messages, [{ id: "m" }]);
  assert.deepEqual(snapshot.widgets, []);
  assert.equal(snapshot.metrics.total, 0);
});

test("activity is typed without requiring the client to parse operation prose", () => {
  assert.deepEqual(activityFor({ operation: "pi 正在思考" }), {
    kind: "thinking",
    label: "思考中",
  });
  assert.deepEqual(activityFor({ operation: "waiting for tool" }), {
    kind: "waiting",
    label: "等待中",
  });
  assert.deepEqual(activityFor({ operation: "执行 read…" }), {
    kind: "tool",
    label: "执行 read…",
  });
  assert.deepEqual(activityFor({ idle: false }), {
    kind: "working",
    label: "运行中",
  });
  assert.deepEqual(activityFor({ history: true }), {
    kind: "history",
    label: "会话记录",
  });
});

test("host activity and extra fields survive normalization", () => {
  const snapshot = createAgentSnapshot({
    host: "durable",
    activity: { kind: "compacting", label: "压缩中" },
    extra: { active: { id: 1 }, frameworkVersion: "1.0.2" },
    stats: { tokens: { total: 5 }, cost: 0.1 },
  });
  assert.equal(snapshot.operation, "压缩中");
  assert.deepEqual(snapshot.active, { id: 1 });
  assert.equal(snapshot.frameworkVersion, "1.0.2");
  assert.equal(snapshot.metrics.total, 5);
});
