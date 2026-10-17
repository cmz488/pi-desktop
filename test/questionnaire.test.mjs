import { test } from "node:test";
import assert from "node:assert/strict";
import {
  questionnaireResult,
  rpcQuestion,
} from "../src/agent/questionnaire.mjs";
import { createInteractionStore } from "../src/agent/interaction-store.mjs";
import { until } from "./concurrent-fixture.mjs";
import sessionsExtension from "../src/tui/sessions.ts";
import { getSessionHost } from "../src/tui/session-manager.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const questions = [
  {
    header: "Choice",
    question: "Choose an option?",
    options: [
      { label: "One", description: "First", preview: "**Preview**" },
      { label: "Two", description: "Second" },
    ],
  },
  {
    header: "Multi",
    question: "Which apply?",
    multiSelect: true,
    options: [
      { label: "A", description: "First" },
      { label: "B", description: "Second" },
    ],
  },
];
test("questionnaire adapter preserves preview, multi-select and literal custom answers", () => {
  const result = questionnaireResult(
    questions,
    JSON.stringify([{ selected: [0] }, { selected: [1, 0] }]),
  );
  assert.deepEqual(result.answers[1].selected, ["B", "A"]);
  assert.equal(result.answers[0].preview, "**Preview**");
  const custom = questionnaireResult(
    questions,
    JSON.stringify([{ selected: [], custom: "1" }, { selected: [] }]),
  );
  assert.equal(custom.answers[0].kind, "custom");
  assert.equal(custom.answers[0].answer, "1");
  for (const encoded of [
    "bad",
    "[]",
    '[{"selected":[100]},{"selected":[]}]',
    '[{"selected":[0,0]},{"selected":[]}]',
    '[{"selected":[]},{"selected":[]}]',
  ])
    assert.throws(
      () => questionnaireResult(questions, encoded),
      (error) => error.status === 422,
    );
  assert.equal(
    rpcQuestion(questions, "[Choice] Choose an option?", "select").mode,
    "select",
  );
  assert.equal(rpcQuestion(questions, "Unrelated login", "text"), undefined);
});
test("native and remote answers elect one winner; duplicates and stale cancellation cannot reply twice", async () => {
  let answer,
    changes = 0;
  const store = createInteractionStore(() => changes++);
  const id = store.start("Ask User", async (interaction) => {
    answer = await interaction.prompt({ type: "questionnaire", questions });
  });
  await until(() => store.list()[0].prompt);
  const promptId = store.list()[0].prompt.id;
  assert.throws(
    () => store.reply({ id, cancel: true, promptId: "old" }),
    (error) => error.status === 409,
  );
  const native = { cancelled: true, answers: [] };
  store.settle(id, native);
  assert.throws(
    () => store.reply({ id, promptId, value: "[]" }),
    (error) => error.status === 409,
  );
  await until(() => store.list()[0].status === "cancelled");
  assert.equal(answer, native);
  assert(changes >= 4);
});
test("public TUI custom done callback resolves the real native widget from a remote questionnaire reply", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ask-ui-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  const handlers = new Map();
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    sessionsExtension({
      on: (name, handler) => handlers.set(name, handler),
      registerCommand: () => {},
    });
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
  const manager = getSessionHost(dir);
  t.after(async () => {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  let nativeDone;
  const noop = () => {};
  const ctx = {
    cwd: dir,
    mode: "tui",
    hasUI: true,
    ui: {
      notify: noop,
      select: noop,
      confirm: noop,
      input: noop,
      editor: noop,
      custom: (factory) =>
        new Promise((resolve) => factory({}, {}, {}, resolve)),
    },
  };
  handlers.get("session_start")({}, ctx);
  handlers.get("tool_execution_start")(
    { toolName: "ask_user_question", args: { questions } },
    ctx,
  );
  const value = ctx.ui.custom((_tui, _theme, _keys, done) => {
    nativeDone = done;
    return {};
  });
  await until(() => manager.nativeInteractions.list()[0]?.prompt);
  const job = manager.nativeInteractions.list()[0];
  manager.nativeInteractions.reply({
    id: job.id,
    promptId: job.prompt.id,
    value: JSON.stringify([
      { selected: [1] },
      { selected: [], custom: "Custom" },
    ]),
  });
  const result = await value;
  assert.equal(result.answers[0].answer, "Two");
  nativeDone({ answers: [], cancelled: true });
  assert.equal(result.cancelled, false);
});
