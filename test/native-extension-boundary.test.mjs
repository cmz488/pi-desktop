import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { until } from "./desktop-fixture.mjs";
import {
  standardExtensionFixture,
  readExtensionTrace,
} from "./standard-extension-fixture.mjs";

test("turn 事件携带真实已发布的原生 entry 身份、索引和 preview", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "committed turn" });
  await f.settled();
  const trace = await readExtensionTrace(f.cwd);
  const end = trace.find((row) => row.type === "turn_end");
  assert(end?.messageEntryId);
  assert.equal(end.persistedRole, "assistant");
  assert.equal(end.turnIndex, 0);
  assert(end.boundary);
  const start = trace.find((row) => row.type === "turn_start");
  assert.equal(start.turnIndex, 0);
  assert(Number.isFinite(start.timestamp));
  assert(
    trace.indexOf(start) <
      trace.findIndex(
        (row) => row.type === "message_start" && row.role === "user",
      ),
  );
  const metadata = await f.call(
    `/api/workspace/detail?kind=agent&id=${f.actor.id}`,
  );
  const journal = (await readFile(metadata.nativeSessionPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(
    journal.some(
      (row) =>
        row.id === end.messageEntryId && row.message?.role === "assistant",
    ),
  );
  assert(
    trace.findIndex((row) => row.type === "turn_end") <
      trace.findIndex((row) => row.type === "agent_end"),
  );
  assert(
    trace.findIndex((row) => row.type === "agent_end") <
      trace.findIndex((row) => row.type === "agent_before_settle"),
  );
});

test("连续工具提交只保存扩展状态，不把转录检查点回灌为扩展 entry", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  for (let i = 0; i < 2; i++) {
    await f.api("prompt", { sessionId: f.id, message: "RUN_REVIEW_CHECK" });
    await f.settled();
  }
  const metadata = await f.call(
    `/api/workspace/detail?kind=agent&id=${f.actor.id}`,
  );
  const journal = (await readFile(metadata.nativeSessionPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    journal.filter((row) => row.customType === "pi-desktop-config").length,
    1,
  );
  assert.equal(journal.filter((row) => row.message?.role === "user").length, 2);
  const trace = await readExtensionTrace(f.cwd);
  assert(
    trace
      .filter((row) => row.type === "turn_end")
      .every((row) => row.persistedRole === "assistant"),
  );
});

test("边界私有 draft 只提交一次，下一原生边界读取同一个已发布身份", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "PRIVATE_DRAFT_PROBE" });
  await f.settled();
  const trace = await readExtensionTrace(f.cwd);
  const id = trace.find(
    (row) => row.type === "agent_before_settle",
  )?.privateEntryId;
  assert(id);
  const metadata = await f.call(
    `/api/workspace/detail?kind=agent&id=${f.actor.id}`,
  );
  const journal = (await readFile(metadata.nativeSessionPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    journal.filter((row) => row.customType === "notes-boundary-private").length,
    1,
  );
  assert(journal.some((row) => row.id === id && row.data.saved));
  assert.equal(f.requests.length, 1);
});

test("取消等待中的原生决策丢弃迟到 draft 与继续，网页观察不会再次调用 handler", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "WAIT_BOUNDARY_PROBE" });
  await until(
    () => readExtensionTrace(f.cwd),
    (trace) => trace.some((row) => row.type === "turn_end"),
  );
  await f.api("state");
  await f.api("state");
  await f.api("abort", { sessionId: f.id });
  const state = await f.settled();
  assert.equal(f.requests.length, 1);
  assert(
    !state.messages.some((row) =>
      row.text?.includes("FORBIDDEN_CANCEL_CONTINUATION"),
    ),
  );
  const trace = await readExtensionTrace(f.cwd);
  assert.equal(trace.filter((row) => row.type === "turn_end").length, 1);
  assert.equal(trace.filter((row) => row.type === "agent_settled").length, 1);
});

test("后续原生 handler 的 preview 读取此前 handler 已接纳的显式输入，不额外生成第三轮", async (t) => {
  const f = await standardExtensionFixture();
  t.after(() => f.close());
  await f.api("prompt", { sessionId: f.id, message: "QUEUED_BOUNDARY_PROBE" });
  await f.settled();
  assert.equal(f.requests.length, 2);
  const review = await readExtensionTrace(f.cwd, "review");
  assert(
    review.some(
      (row) =>
        row.type === "turn_end" &&
        JSON.stringify(row.pending).includes("EXPLICIT_BOUNDARY_INPUT"),
    ),
  );
});

test("原生 context edit 修改实际上下文并保留原记录身份", async (t) => {
  const f = await standardExtensionFixture({
    modelReply: (input) => ({
      text: JSON.stringify(input.messages).includes("EDITED_INPUT_CONTEXT")
        ? "EDIT_FINAL"
        : "EDIT_INITIAL",
    }),
  });
  t.after(() => f.close());
  await f.api("prompt", {
    sessionId: f.id,
    message: "CONTEXT_EDIT_BOUNDARY_PROBE",
  });
  const state = await f.settled();
  assert.equal(f.requests.length, 2);
  assert.equal(state.messages.at(-1).text, "EDIT_FINAL");
  assert.equal(
    state.messages.find((row) => row.role === "user").text,
    "CONTEXT_EDIT_BOUNDARY_PROBE",
  );
  assert(
    f.requests[1].messages.some(
      (row) =>
        row.role === "user" &&
        JSON.stringify(row.content).includes("EDITED_INPUT_CONTEXT"),
    ),
  );
  const metadata = await f.call(
    `/api/workspace/detail?kind=agent&id=${f.actor.id}`,
  );
  const journal = (await readFile(metadata.nativeSessionPath, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  const edit = journal.find((row) => row.type === "context_edit");
  assert(
    journal.some(
      (row) =>
        row.id === edit.targetId &&
        row.message?.content === "CONTEXT_EDIT_BOUNDARY_PROBE",
    ),
  );
});

for (const suffix of ["KEEP", "NULL"])
  test(`原生 compaction ${suffix} 通过原模型活动的边界提交`, async (t) => {
    const f = await standardExtensionFixture({
      modelReply: (input) => ({
        text: JSON.stringify(input.messages).includes("BOUNDARY_SUMMARY")
          ? "COMPACTION_FINAL"
          : "COMPACTION_INITIAL",
      }),
    });
    t.after(() => f.close());
    await f.api("prompt", {
      sessionId: f.id,
      message: `COMPACTION_BOUNDARY_${suffix}`,
    });
    const state = await f.settled();
    assert.equal(f.requests.length, 2);
    assert.equal(state.messages.at(-1).text, "COMPACTION_FINAL");
    assert(JSON.stringify(f.requests[1]).includes("BOUNDARY_SUMMARY"));
    if (suffix === "NULL")
      assert(
        !JSON.stringify(f.requests[1]).includes("COMPACTION_BOUNDARY_NULL"),
      );
    const metadata = await f.call(
      `/api/workspace/detail?kind=agent&id=${f.actor.id}`,
    );
    const journal = (await readFile(metadata.nativeSessionPath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const compaction = journal.find((row) => row.type === "compaction");
    assert.equal(compaction.summary, "BOUNDARY_SUMMARY");
    if (suffix === "NULL")
      assert.equal(compaction.firstKeptEntryId, compaction.id);
    else assert(journal.some((row) => row.id === compaction.firstKeptEntryId));
  });

for (const [prompt, marker] of [
  ["TURN_BOUNDARY_PROBE", "TURN_BOUNDARY_CONTEXT"],
  ["SETTLE_BOUNDARY_PROBE", "SETTLE_BOUNDARY_CONTEXT"],
])
  test(`${prompt} 的原生 draft／继续在原模型活动中作用`, async (t) => {
    const f = await standardExtensionFixture({
      modelReply: (input) => ({
        text: JSON.stringify(input.messages).includes(marker)
          ? "BOUNDARY_FINAL_ANSWER"
          : "BOUNDARY_INITIAL_ANSWER",
      }),
    });
    t.after(() => f.close());
    await f.api("prompt", { sessionId: f.id, message: prompt });
    const state = await f.settled();
    assert.equal(f.requests.length, 2);
    assert.equal(state.messages.filter((row) => row.role === "user").length, 1);
    assert.equal(state.messages.at(-1).text, "BOUNDARY_FINAL_ANSWER");
    const trace = await readExtensionTrace(f.cwd);
    assert(
      trace
        .filter((row) => row.type === "turn_end")
        .every(
          (row) =>
            row.messageEntryId &&
            row.persistedRole === "assistant" &&
            row.boundary,
        ),
    );
    assert.equal(
      trace.filter((row) => row.type === "before_agent_start").length,
      1,
    );
    assert.equal(trace.filter((row) => row.type === "agent_settled").length, 1);
    assert.equal(
      trace.filter((row) => row.type === "agent_start").length,
      prompt.startsWith("SETTLE") ? 2 : 1,
    );
    assert.equal(new Set(trace.map((row) => row.sessionId)).size, 1);
  });
