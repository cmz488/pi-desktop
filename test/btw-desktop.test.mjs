import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDesktopBtwContext,
  createDesktopBtw,
} from "../src/agent/btw-desktop.mjs";

test("Desktop BTW keeps a resumable side thread outside the main session", async () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "Implement a parser" }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will use a recursive descent parser." },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "hidden tool output" }],
      },
    },
  ];
  const originalEntries = structuredClone(entries);
  const calls = [];
  const registry = {
    streamSimple(model, context, options) {
      calls.push({ model, context, options });
      return {
        result: async () => ({
          role: "assistant",
          content: [{ type: "text", text: `answer ${calls.length}` }],
          stopReason: "stop",
          timestamp: Date.now(),
        }),
      };
    },
  };
  const adapter = createDesktopBtw();
  const runtime = {
    sessionId: "session-a",
    model: {
      provider: "fixture",
      id: "model-a",
      name: "Fixture Model",
      reasoning: true,
    },
    modelRegistry: registry,
    thinkingLevel: "high",
    messages: entries,
  };
  const { thread } = await adapter.handle({ action: "open" }, runtime);
  const first = await adapter.handle(
    { action: "ask", threadId: thread.id, question: "Why recursive descent?" },
    runtime,
  );
  const second = await adapter.handle(
    {
      action: "ask",
      threadId: thread.id,
      question: "What is the alternative?",
    },
    runtime,
  );

  assert.equal(first.thread.turns[0].answer, "answer 1");
  assert.equal(second.thread.turns.length, 2);
  assert.match(
    calls[0].context.messages[0].content[0].text,
    /Implement a parser/,
  );
  assert.doesNotMatch(
    calls[0].context.messages[0].content[0].text,
    /hidden tool output/,
  );
  assert.match(
    calls[1].context.messages.at(-1).content[0].text,
    /What is the alternative\?/,
  );
  assert.equal(calls[1].context.messages.at(-2).content[0].text, "answer 1");
  assert.equal(calls[0].options.reasoning, "high");
  assert.equal(calls[0].options.sessionId, calls[1].options.sessionId);
  assert.notEqual(calls[0].options.sessionId, runtime.sessionId);
  assert.deepEqual(
    entries,
    originalEntries,
    "side questions must not mutate Pi's session branch",
  );

  const list = await adapter.handle({ action: "list" }, runtime);
  assert.equal(list.rows[0].title, "Why recursive descent?");
  await assert.rejects(
    adapter.handle(
      { action: "open", threadId: thread.id },
      { ...runtime, sessionId: "session-b" },
    ),
    /其他会话/,
  );
});

test("conversation context is bounded and keeps only user and assistant entries", () => {
  const context = buildDesktopBtwContext([
    { type: "message", message: { role: "toolResult", content: "ignored" } },
    { type: "message", message: { role: "user", content: "question" } },
    {
      role: "assistant",
      text: "durable answer",
      blocks: [{ type: "text", text: "durable answer" }],
    },
  ]);
  assert.equal(context, "User: question\n\nAssistant: durable answer");
  const clipped = buildDesktopBtwContext([
    { role: "user", content: "x".repeat(45_000) },
  ]);
  assert(clipped.length < 40_100);
  assert.match(clipped, /Earlier context omitted/);
});

test("a Desktop BTW response can be cancelled without aborting the Pi session", async () => {
  let signal;
  const adapter = createDesktopBtw();
  const runtime = {
    sessionId: "session-cancel",
    model: { provider: "fixture", id: "model-a", name: "Fixture Model" },
    thinkingLevel: "off",
    messages: [],
    modelRegistry: {
      streamSimple(_model, _context, options) {
        signal = options.signal;
        return {
          result: () =>
            new Promise((resolve) =>
              signal.addEventListener("abort", () =>
                resolve({
                  role: "assistant",
                  content: [],
                  stopReason: "aborted",
                }),
              ),
            ),
        };
      },
    },
  };
  const { thread } = await adapter.handle({ action: "open" }, runtime);
  const answer = adapter.handle(
    { action: "ask", threadId: thread.id, question: "A long side question" },
    runtime,
  );
  await new Promise((resolve) => setImmediate(resolve));
  await adapter.handle({ action: "cancel", threadId: thread.id }, runtime);
  assert.equal(signal.aborted, true);
  assert.equal((await answer).cancelled, true);
});
