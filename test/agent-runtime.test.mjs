import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDurableRuntime,
  defineAgentRuntime,
} from "../src/control-plane/agent-runtime.mjs";

test("Durable is the first Agent runtime adapter behind the worker boundary", async () => {
  let received;
  const runtime = createDurableRuntime({
    start: async (options) => {
      received = options;
      return { url: "http://127.0.0.1:1" };
    },
  });
  assert.equal(runtime.id, "durable");
  const app = await runtime.start({ cwd: "/tmp/project", agentName: "A" });
  assert.equal(app.url, "http://127.0.0.1:1");
  assert.deepEqual(received, {
    cwd: "/tmp/project",
    agentName: "A",
    singleAgent: true,
    host: "127.0.0.1",
    port: 0,
  });
});

test("Agent runtime definitions reject missing identity or start", () => {
  assert.throws(() => defineAgentRuntime({ start: () => {} }), /id/);
  assert.throws(() => defineAgentRuntime({ id: "x" }), /start/);
  assert.deepEqual(Object.keys(defineAgentRuntime({ id: "x", start() {} })), [
    "id",
    "start",
  ]);
});
