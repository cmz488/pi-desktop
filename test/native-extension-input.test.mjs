import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { until } from "./desktop-fixture.mjs";
import {
  standardExtensionFixture,
  readExtensionTrace,
} from "./standard-extension-fixture.mjs";

const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");

test("真实 Host 在模型准入前消费标准 input transform／handled，程序输入保留 source", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "INPUT_TRANSFORM_PROBE" });
  await f.settled();
  assert(
    f.requests
      .at(-1)
      .messages.some(
        (message) =>
          message.role === "user" && text(message) === "INPUT_REWRITTEN",
      ),
  );
  let trace = await readExtensionTrace(f.cwd);
  assert.equal(
    trace.filter(
      (row) => row.type === "input" && row.text === "INPUT_TRANSFORM_PROBE",
    ).length,
    1,
  );
  assert.equal(trace.find((row) => row.type === "input").source, "rpc");
  const count = f.requests.length;
  await f.api("prompt", { sessionId: f.id, message: "INPUT_HANDLED_PROBE" });
  await until(
    () => f.api("state"),
    (state) =>
      state.messages.some(
        (message) =>
          message.role === "custom" && message.text === "INPUT_WAS_HANDLED",
      ),
  );
  assert.equal(f.requests.length, count);
  await f.api("prompt", {
    sessionId: f.id,
    message: "/notes-status send-user",
  });
  await f.settled();
  assert.equal(f.requests.length, count + 1);
  assert(
    f.requests
      .at(-1)
      .messages.some(
        (message) =>
          message.role === "user" && text(message) === "INPUT_REWRITTEN",
      ),
  );
  trace = await readExtensionTrace(f.cwd);
  assert(
    trace.some(
      (row) =>
        row.type === "input" &&
        row.source === "extension" &&
        row.text === "INPUT_TRANSFORM_PROBE",
    ),
  );
});

test("input 先于模板展开，并消费标准程序消息的 images 变换", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  const path = join(f.agentDir, "settings.json");
  const settings = JSON.parse(await readFile(path, "utf8"));
  await writeFile(
    path,
    JSON.stringify({
      ...settings,
      prompts: [join(f.cwd, "prompts", "fixture-template.md")],
    }),
  );
  await f.api("prompt", { sessionId: f.id, message: "/reload" });
  await f.api("prompt", { sessionId: f.id, message: "TEMPLATE_ORDER_PROBE" });
  await f.settled();
  assert(
    f.requests
      .at(-1)
      .messages.some(
        (message) =>
          message.role === "user" &&
          text(message) === "Template fixture: INPUT_CHAIN",
      ),
  );
  await f.api("prompt", {
    sessionId: f.id,
    message: "/notes-status send-image",
  });
  await f.settled();
  const trace = await readExtensionTrace(f.cwd);
  assert(
    trace.some(
      (row) =>
        row.type === "input" &&
        row.text === "IMAGE_INPUT_PROBE" &&
        row.images === 1 &&
        row.source === "extension",
    ),
  );
  assert(
    f.requests
      .at(-1)
      .messages.some(
        (message) =>
          message.role === "user" && text(message) === "IMAGE_INPUT_REWRITTEN",
      ),
  );
  assert.equal(
    trace.findLast((row) => row.type === "before_agent_start").images,
    0,
  );
});

test("标准 custom triggerTurn 在真实 Host 使用 entry input，不增加伪用户消息", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", {
    sessionId: f.id,
    message: "/notes-status start-custom",
  });
  const state = await f.settled();
  assert.equal(f.requests.length, 1);
  const messages = state.messages.filter(
    (message) => message.text === "CUSTOM_TRIGGER_CONTEXT",
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "custom");
  assert.equal(
    f.requests[0].messages.filter(
      (message) =>
        message.role === "user" && text(message) === "CUSTOM_TRIGGER_CONTEXT",
    ).length,
    1,
  );
  assert(
    !(await readExtensionTrace(f.cwd)).some(
      (row) => row.type === "input" && row.text === "CUSTOM_TRIGGER_CONTEXT",
    ),
  );
});
