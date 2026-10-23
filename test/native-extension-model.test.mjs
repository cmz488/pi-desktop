import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebSlot } from "../src/server/web.mjs";
import { until } from "./desktop-fixture.mjs";
import { createNativeModelRuntime } from "../src/agent/native-model-runtime.mjs";
import {
  standardExtensionFixture,
  readExtensionTrace,
} from "./standard-extension-fixture.mjs";

test("请求准备异常构成符合 Pi Usage interface 的错误消息", async () => {
  const models = createNativeModelRuntime(
    { modelRuntime: {}, agent: {} },
    { scope: (_signal, run) => run(), event: async () => {}, abort: () => {} },
    () => {
      throw new Error("EXPECTED_TRANSPORT_SETUP_FAILURE");
    },
  );
  const stream = models.streamSimple(
    { api: "fixture", provider: "fixture", id: "error" },
    { messages: [] },
    {},
  );
  const events = [];
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.usage.totalTokens, 0);
  assert.equal(events.at(-1).type, "error");
});

test("标准 provider 请求／响应／原始流 hooks 经过实际 Durable 模型请求", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "PROVIDER_PAYLOAD_PROBE" });
  await f.settled();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].temperature, 0.123);
  assert.equal(f.requestHeaders[0]["x-standard-fixture"], "enabled");
  const trace = await readExtensionTrace(f.cwd);
  for (const type of [
    "before_provider_headers",
    "before_provider_request",
    "after_provider_response",
    "provider_stream_event",
  ])
    assert(
      trace.some((row) => row.type === type),
      type,
    );
  assert(
    trace.some(
      (row) => row.type === "after_provider_response" && row.status === 200,
    ),
  );
  assert(
    trace
      .filter((row) => row.type === "provider_stream_event")
      .every(
        (row) => row.provider === "desktop-fixture" && row.model === "local",
      ),
  );
});

test("资源 Agent 的模型循环守卫保持，只有绑定的 transport 给 Durable 使用", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-stream-"));
  const cwd = join(root, "cwd"),
    agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  let current, stream, app;
  t.after(async () => {
    await app?.stop();
    await rm(root, { recursive: true, force: true });
  });
  app = await startWebSlot({
    cwd,
    agentDir,
    host: "127.0.0.1",
    port: 0,
    resourcesOnly: true,
    noExtensions: true,
    nativeResources: { skills: [], prompts: [], extensions: [] },
    bindResourceSession: (session, transport) => {
      current = session;
      stream = transport.stream;
    },
  });
  await app.ready;
  assert.equal(typeof stream, "function");
  assert.notEqual(stream, current.agent.streamFunction);
  assert.throws(
    () => current.agent.streamFunction(),
    (error) => error.status === 409 && error.message.includes("Durable"),
  );
});

test("取消中的标准 stream 停止，扩展结束事件看到原生取消信号", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await standardExtensionFixture({
    modelReply: () => ({
      stream: (async function* () {
        yield "CANCEL_PARTIAL";
        await gate;
        yield "FORBIDDEN_LATE";
      })(),
    }),
  });
  t.after(async () => {
    release();
    await f.close();
  });
  await f.api("prompt", { sessionId: f.id, message: "cancel stream" });
  await until(
    () => readExtensionTrace(f.cwd),
    (rows) => rows.some((row) => row.type === "message_update"),
  );
  await f.api("abort", { sessionId: f.id });
  release();
  await f.settled();
  const trace = await until(
    () => readExtensionTrace(f.cwd),
    (rows) => rows.some((row) => row.type === "agent_end"),
  );
  assert(trace.findLast((row) => row.type === "agent_end").signalAborted);
  assert.equal(f.requests.length, 1);
  assert(
    !trace.some(
      (row) =>
        row.type === "message_end" && row.text?.includes("FORBIDDEN_LATE"),
    ),
  );
});

test("重载后 provider 与流 handler 不重复注册", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  for (let i = 0; i < 2; i++) {
    await f.api("prompt", {
      sessionId: f.id,
      message: "PROVIDER_PAYLOAD_PROBE",
    });
    await f.settled();
    if (i === 0) await f.api("prompt", { sessionId: f.id, message: "/reload" });
  }
  const trace = await readExtensionTrace(f.cwd);
  assert.equal(f.requests.length, 2);
  assert.equal(
    trace.filter((row) => row.type === "before_provider_request").length,
    2,
  );
  assert.equal(
    trace.filter(
      (row) => row.type === "message_start" && row.role === "assistant",
    ).length,
    2,
  );
});

test("标准 assistant 流事件有序且不重复开始，最终消息仍只提交一次", async (t) => {
  const f = await standardExtensionFixture({
    modelReply: () => ({
      stream: (async function* () {
        yield "STREAM_FIRST ";
        await new Promise((resolve) => setTimeout(resolve, 30));
        yield "STREAM_LAST";
      })(),
    }),
  });
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "stream" });
  const state = await f.settled();
  const trace = await readExtensionTrace(f.cwd);
  const begin = trace.findIndex(
    (row) => row.type === "message_start" && row.role === "assistant",
  );
  const update = trace.findIndex(
    (row) => row.type === "message_update" && row.update === "text_delta",
  );
  const end = trace.findIndex(
    (row) => row.type === "message_end" && row.role === "assistant",
  );
  assert(begin >= 0 && update > begin && end > update);
  assert.equal(
    trace.filter(
      (row) => row.type === "message_start" && row.role === "assistant",
    ).length,
    1,
  );
  assert.equal(
    state.messages.filter(
      (row) =>
        row.role === "assistant" && row.text === "STREAM_FIRST STREAM_LAST",
    ).length,
    1,
  );
  assert.equal(f.requests.length, 1);
});
