import { test } from "node:test";
import assert from "node:assert/strict";
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

test("真实 Host 完整 system override 与两阶段 context 作用于实际请求，不泄漏到下一次输入", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "PROMPT_OVERRIDE_PROBE" });
  await f.settled();
  assert.equal(
    f.requests.at(-1).messages[0].content,
    "FORCED_NATIVE_SYSTEM_PROMPT",
  );
  await f.api("prompt", { sessionId: f.id, message: "SYSTEM_CONTEXT_PROBE" });
  await f.settled();
  assert(
    f.requests.at(-1).messages[0].content.includes("CONTEXT_SYSTEM_SENTINEL"),
  );
  assert(
    !f.requests
      .at(-1)
      .messages[0].content.includes("FORCED_NATIVE_SYSTEM_PROMPT"),
  );
  await f.api("prompt", {
    sessionId: f.id,
    message: "STRUCTURED_PROMPT_PROBE",
  });
  await f.settled();
  assert(
    f.requests.at(-1).messages[0].content.includes("STRUCTURED_PROMPT_SECTION"),
  );
  await f.api("prompt", { sessionId: f.id, message: "CONTEXT_MESSAGE_PROBE" });
  const state = await f.settled();
  assert(
    f.requests
      .at(-1)
      .messages.some(
        (message) =>
          message.role === "user" && text(message) === "CONTEXT_CHAIN_MARKER",
      ),
  );
  assert(
    !state.messages.some(
      (message) =>
        message.role === "user" && message.text === "CONTEXT_CHAIN_MARKER",
    ),
  );
  const trace = await readExtensionTrace(f.cwd);
  assert(
    trace
      .filter((row) => row.type === "context_with_system")
      .every((row) => row.leadingSystem),
  );
});

test("before_agent_start 的标准 custom 进入首次模型请求与转录，且只追加一次", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "BEFORE_MESSAGE_PROBE" });
  const state = await f.settled();
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.requests[0].messages.filter(
      (message) =>
        message.role === "user" && text(message) === "BEFORE_MESSAGE_CONTEXT",
    ).length,
    1,
  );
  assert.equal(
    state.messages.filter(
      (message) =>
        message.role === "custom" && message.text === "BEFORE_MESSAGE_CONTEXT",
    ).length,
    1,
  );
});

test("assistant message_end 的同 role 替换进入 Durable 提交和后续模型上下文", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", {
    sessionId: f.id,
    message: "MESSAGE_REPLACEMENT_PROBE",
  });
  const state = await f.settled();
  assert(
    state.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.text === "REPLACED_NATIVE_ANSWER",
    ),
  );
  assert(
    !state.messages.some(
      (message) =>
        message.role === "assistant" && message.text === "REPLACE_THIS_ANSWER",
    ),
  );
  await f.api("prompt", { sessionId: f.id, message: "next" });
  await f.settled();
  assert(
    f.requests
      .at(-1)
      .messages.some(
        (message) =>
          message.role === "assistant" &&
          text(message) === "REPLACED_NATIVE_ANSWER",
      ),
  );
});
