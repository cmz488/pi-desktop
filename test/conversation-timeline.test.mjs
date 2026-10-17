import { test } from "node:test";
import assert from "node:assert/strict";
import { projectConversationTimeline } from "../src/shared/lazy-data.mjs";

const thinking = (text) => ({ type: "thinking", text });
const text = (value) => ({ type: "text", text: value });
const tool = (id) => ({ type: "toolCall", id, name: "read", arguments: "{}" });
const assistant = (id, blocks, extra = {}) => ({
  role: "assistant",
  id,
  blocks,
  ...extra,
});
const entries = (row) => row.blocks[0].entries;

test("Durable partial messages retain their streaming identity in activity folds", () => {
  const live = assistant("partial", [thinking("live thought")]);
  const original = structuredClone(live);
  const timeline = projectConversationTimeline(
    [{ role: "user", id: "u", text: "question" }],
    { streamingMessage: live },
  );
  assert.equal(entries(timeline[1])[0].sources[0].streaming, true);
  assert.deepEqual(live, original);
});

test("adjacent thinking merges across blocks, messages and the live stream without mutating source messages", () => {
  const rows = [
    assistant("a", [thinking("one"), thinking("two")], { lazy: true }),
    assistant("b", [thinking("three")]),
  ];
  const original = structuredClone(rows);
  const timeline = projectConversationTimeline(rows, {
    streamingMessage: assistant("streaming", [thinking("four")]),
  });
  assert.equal(timeline.length, 1);
  assert.equal(entries(timeline[0]).length, 1);
  assert.equal(
    entries(timeline[0])[0].block.text,
    "one\n\ntwo\n\nthree\n\nfour",
  );
  assert.deepEqual(
    entries(timeline[0])[0].sources.map((source) => source.id),
    ["a", "a", "b", "streaming"],
  );
  assert.equal(entries(timeline[0])[0].sources.at(-1).streaming, true);
  assert.deepEqual(rows, original);
});

test("tools and thinking form one folded activity between visible intermediate and final output", () => {
  const timeline = projectConversationTimeline([
    { role: "user", id: "u", text: "question" },
    assistant("a", [
      thinking("plan"),
      text("intermediate"),
      tool("call"),
      thinking("check"),
      thinking("again"),
    ]),
    { role: "toolResult", id: "result", toolCallId: "call", text: "result" },
    assistant("b", [text("final")]),
  ]);
  assert.deepEqual(
    timeline.map((row) => (row.role === "user" ? "user" : row.blocks[0].type)),
    ["user", "activity", "text", "activity", "text"],
  );
  assert.equal(timeline[2].blocks[0].text, "intermediate");
  assert.deepEqual(
    entries(timeline[3]).map((entry) => entry.block.type),
    ["toolCall", "thinking"],
  );
  assert.equal(entries(timeline[3])[1].block.text, "check\n\nagain");
  assert.equal(timeline[4].blocks[0].text, "final");
});

test("thoughts never merge across tool calls, model output or user-turn boundaries", () => {
  const timeline = projectConversationTimeline([
    assistant("a", [
      thinking("before"),
      tool("call"),
      thinking("after"),
      text("output"),
      thinking("next"),
    ]),
    { role: "user", id: "u", text: "new question" },
    assistant("b", [thinking("new turn")]),
  ]);
  assert.deepEqual(
    entries(timeline[0]).map((entry) => entry.block.type),
    ["thinking", "toolCall", "thinking"],
  );
  assert.equal(entries(timeline[2])[0].block.text, "next");
  assert.equal(entries(timeline[4])[0].block.text, "new turn");
});

test("streamed calls and orphan results are shown exactly once, while active nested tools retain their order", () => {
  const timeline = projectConversationTimeline(
    [
      {
        role: "toolResult",
        id: "r",
        toolCallId: "orphan",
        toolName: "bash",
        lazy: true,
        text: "done",
      },
    ],
    {
      streamingMessage: assistant("streaming", [
        text("progress"),
        tool("streamed"),
      ]),
      activeCalls: [
        { id: "streamed", name: "read" },
        { id: "nested", name: "bash", parentId: "streamed" },
        { id: "orphan", name: "bash" },
      ],
    },
  );
  assert.equal(timeline.length, 3);
  assert.equal(entries(timeline[0])[0].block.id, "orphan");
  assert.equal(entries(timeline[0])[0].sources[0].lazy, true);
  assert.deepEqual(
    entries(timeline[2]).map((entry) => entry.block.id),
    ["streamed", "nested"],
  );
  assert.equal(entries(timeline[2])[1].block.parentId, "streamed");
});

test("activity keys survive lazy detail loading and live thought completion", () => {
  const before = projectConversationTimeline(
    [assistant("a", [thinking("preview")], { lazy: true, eventKey: 1 })],
    { streamingMessage: assistant("streaming", [thinking("live")]) },
  );
  const after = projectConversationTimeline([
    assistant("a", [thinking("full detail")], { eventKey: 1 }),
    assistant("b", [thinking("completed")]),
  ]);
  assert.equal(before[0].id, after[0].id);
  assert.equal(entries(after[0])[0].block.text, "full detail\n\ncompleted");
});

test("blank thinking is retained, whitespace-only model output is skipped, errors remain visible", () => {
  const timeline = projectConversationTimeline([
    assistant("a", [thinking(""), text("  "), thinking("actual")]),
    assistant("b", [], { stopReason: "error", error: "provider unavailable" }),
  ]);
  assert.equal(entries(timeline[0]).length, 1);
  assert.equal(entries(timeline[0])[0].block.text, "actual");
  assert.equal(timeline[1].error, "provider unavailable");
  assert.equal(timeline[1].stopReason, "error");
});
