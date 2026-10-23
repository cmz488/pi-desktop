import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { until } from "./desktop-fixture.mjs";
import {
  standardExtensionFixture,
  readExtensionTrace,
} from "./standard-extension-fixture.mjs";

test("原生工具 start／update／end 的字段、有序等待和最终 tool 消息不重复", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "RUN_NOTES_STREAM" });
  const state = await f.settled();
  const trace = await readExtensionTrace(f.cwd);
  const call = "notes-stream";
  const rows = trace.filter((row) => row.callId === call);
  assert.deepEqual(
    rows
      .filter((row) => row.type.startsWith("tool_execution_"))
      .map((row) => row.type),
    ["tool_execution_start", "tool_execution_update", "tool_execution_end"],
  );
  assert.equal(
    rows.find((row) => row.type === "tool_execution_start").args.op,
    "stream",
  );
  assert.equal(
    rows.find((row) => row.type === "tool_execution_update").partial,
    "NOTES_PARTIAL_OUTPUT",
  );
  const end = rows.find((row) => row.type === "tool_execution_end");
  assert.equal(end.isError, false);
  assert.equal(end.resultHasRole, false);
  assert(end.structuredContent.text.endsWith(":REVIEWED_RESULT"));
  const messageStart = trace.findIndex(
    (row) => row.type === "message_start" && row.role === "toolResult",
  );
  const messageEnd = trace.findIndex(
    (row) => row.type === "message_end" && row.role === "toolResult",
  );
  assert(trace.indexOf(end) < messageStart && messageStart < messageEnd);
  assert.equal(
    trace.filter(
      (row) => row.type === "message_end" && row.role === "toolResult",
    ).length,
    1,
  );
  assert.equal(
    state.messages.filter((row) => row.role === "toolResult").length,
    1,
  );
});

for (const op of ["BLOCK", "THROW"])
  test(`原生 ${op} 保留门禁／错误结果与一次生命周期`, async (t) => {
    const f = await standardExtensionFixture();
    t.after(() => f.close());
    await f.api("prompt", { sessionId: f.id, message: `RUN_NOTES_${op}` });
    const state = await f.settled();
    const trace = await readExtensionTrace(f.cwd);
    assert.equal(
      trace.filter((row) => row.type === "tool_execution_start").length,
      1,
    );
    const ends = trace.filter((row) => row.type === "tool_execution_end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].isError, true);
    if (op === "BLOCK") assert(!trace.some((row) => row.type === "execute"));
    assert(
      state.messages.some((row) => row.role === "toolResult" && row.isError),
    );
  });

test("工具消息 message_end 的同 role 替换进入原生 Durable 提交与实际模型上下文", async (t) => {
  const f = await standardExtensionFixture({
    modelReply: (input) =>
      input.messages.at(-1)?.role === "user"
        ? {
            toolCalls: [
              {
                id: "replace-tool",
                type: "function",
                function: {
                  name: "compat_notes",
                  arguments: JSON.stringify({
                    op: "echo",
                    text: "TOOL_MESSAGE_REPLACEMENT_PROBE",
                  }),
                },
              },
            ],
          }
        : { text: "TOOL_REPLACEMENT_DONE" },
  });
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "replace tool message" });
  const state = await f.settled();
  assert.equal(
    state.messages.find((row) => row.toolCallId === "replace-tool").text,
    "TOOL_MESSAGE_REPLACED",
  );
  assert(
    f.requests[1].messages.some(
      (row) => row.role === "tool" && row.content === "TOOL_MESSAGE_REPLACED",
    ),
  );
});

test("原生工具 usage 进入持久化的同一结果记录", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "RUN_NOTES_USAGE" });
  await f.settled();
  const metadata = await f.call(
    `/api/workspace/detail?kind=agent&id=${f.actor.id}`,
  );
  const journal = (await readFile(metadata.nativeSessionPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    journal.find((row) => row.message?.toolCallId === "notes-usage").message
      .usage.input,
    7,
  );
});

test("SDK 工具结束后的迟到 update 不回流到下一活动", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "RUN_NOTES_LATE" });
  await until(
    () => f.api("state"),
    (state) =>
      state.idle &&
      state.messages.some((row) => row.toolCallId === "notes-late"),
  );
  await until(
    () => readExtensionTrace(f.cwd),
    (trace) => trace.some((row) => row.type === "agent_settled"),
  );
  await f.api("prompt", { sessionId: f.id, message: "another activity" });
  await until(
    () => f.api("state"),
    (state) =>
      state.idle &&
      state.messages.some(
        (row) => row.role === "user" && row.text === "another activity",
      ),
  );
  await until(
    () => readExtensionTrace(f.cwd),
    (trace) => trace.filter((row) => row.type === "agent_settled").length === 2,
  );
  const trace = await until(
    () => readExtensionTrace(f.cwd),
    (rows) => rows.some((row) => row.type === "late-update-attempt"),
  );
  assert(
    !trace.some(
      (row) =>
        row.type === "tool_execution_update" &&
        row.partial === "FORBIDDEN_LATE_UPDATE",
    ),
  );
  assert.equal(f.requests.length, 3);
});

test("标准嵌套工具由原 SDK 执行并保留父调用身份，不产生第二个模型任务", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "RUN_NOTES_NESTED" });
  const state = await f.settled();
  assert(
    state.messages.some(
      (row) =>
        row.role === "toolResult" &&
        row.text.includes("CHECK_RESULT:fixture-note:REVIEWED_INPUT"),
    ),
  );
  const trace = await readExtensionTrace(f.cwd);
  const start = trace.find(
    (row) =>
      row.type === "tool_execution_start" && row.toolName === "compat_check",
  );
  assert(start);
  assert.equal(start.parent, "notes-nested");
  assert(
    trace.some(
      (row) =>
        row.type === "tool_execution_end" &&
        row.callId === start.callId &&
        row.parent === "notes-nested",
    ),
  );
  assert.equal(f.requests.length, 2);
});
