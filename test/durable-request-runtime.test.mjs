import { test } from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  hook,
  GenerationTask,
  CompactionTask,
  AssistantEntry,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ensureDurableRequests } from "../src/agent/durable-boundaries.mjs";

const provider = "request-runtime-test";
function collection() {
  const models = createModels();
  const faux = fauxProvider({
    provider,
    models: [{ id: "local" }, { id: "alternate" }],
    tokensPerSecond: 100000,
  });
  models.setProvider(faux.provider);
  const calls = [];
  const observed = new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple")
        return (model, input, options) => {
          calls.push({ model, input, options });
          return target.streamSimple(model, input, options);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { models: observed, faux, calls };
}
async function fixture(t, models, extensions, settings) {
  const support = await ensureDurableRequests();
  assert.equal(support.apiVersion, 1);
  assert.equal(GenerationTask.definition.capabilities.requestRuntime, 1);
  assert.equal(CompactionTask.definition.capabilities.requestRuntime, 1);
  const registry = createRegistry();
  for (const extension of extensions)
    registry.install(defineExtension(extension));
  const reports = [];
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings,
      onReport: (error) => reports.push(error.message),
    },
    context,
  );
  t.after(() => harness.close(context));
  return { harness, reports, registry };
}
const entry = (root, id) =>
  root.commit((tx) => tx.entry(AssistantEntry, id), context);

test("请求运行时按会话选择 Models，同名 provider 不串用且仍是原生 generation", async (t) => {
  const a = collection(),
    b = collection();
  const f = await fixture(t, createModels(), [
    {
      name: "model-a",
      hooks: [hook(GenerationTask, { modelRuntime: () => a.models })],
    },
    {
      name: "model-b",
      hooks: [hook(GenerationTask, { modelRuntime: () => b.models })],
    },
  ]);
  const root = await f.harness.root(context, {
    agent: {
      model: { provider, modelId: "local" },
      extensions: [f.registry.snapshot().extension("model-a")],
    },
  });
  const sibling = await f.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: {
        model: { provider, modelId: "local" },
        extensions: [f.registry.snapshot().extension("model-b")],
      },
    },
    context,
  );
  a.faux.setResponses([fauxAssistantMessage("A")]);
  b.faux.setResponses([fauxAssistantMessage("B")]);
  const [first, second] = await Promise.all([
    root.submit({ type: "input", content: "a" }, context),
    sibling.submit({ type: "input", content: "b" }, context),
  ]);
  const [answerA, answerB] = await Promise.all([
    first.wait(context),
    second.wait(context),
  ]);
  assert.equal(answerA.status, "done");
  assert.equal(answerB.status, "done");
  assert.equal(
    (await entry(root, answerA.answer)).model[0].content[0].text,
    "A",
  );
  assert.equal(
    (await entry(sibling, answerB.answer)).model[0].content[0].text,
    "B",
  );
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.deepEqual(f.reports, []);
});

test("beforeRequest 消费请求级 model 与 options，Durable signal 和回执身份仍受保护", async (t) => {
  const native = collection(),
    foreign = new AbortController();
  const f = await fixture(t, native.models, [
    {
      name: "request-options",
      hooks: [
        hook(GenerationTask, {
          beforeRequest: (request) => ({
            messages: request.messages,
            model: native.models.getModel(provider, "alternate"),
            options: {
              ...request.options,
              headers: { "x-pi-fixture": "native" },
              signal: foreign.signal,
              sessionId: "foreign-session",
              onPayload: (payload) => payload,
            },
          }),
        }),
      ],
    },
  ]);
  const root = await f.harness.root(context, {
    agent: { model: { provider, modelId: "local" } },
  });
  native.faux.setResponses([fauxAssistantMessage("REQUEST_OPTIONS")]);
  const submission = await root.submit(
    { type: "input", content: "start" },
    context,
  );
  const result = await submission.wait(context);
  assert.equal(result.status, "done");
  assert.equal((await entry(root, result.answer)).model[0].model, "alternate");
  assert.equal(native.calls[0].model.id, "alternate");
  assert.equal(native.calls[0].options.headers["x-pi-fixture"], "native");
  assert.notEqual(native.calls[0].options.signal, foreign.signal);
  assert.equal(typeof native.calls[0].options.sessionId, "string");
  assert.notEqual(native.calls[0].options.sessionId, "foreign-session");
  assert.equal(typeof native.calls[0].options.onPayload, "function");
  const usage = await f.harness.snapshot(UsageDoc, root.id, context);
  assert.deepEqual(
    usage.models[`${provider}/alternate`],
    (await entry(root, result.answer)).model[0].usage,
  );
  assert.deepEqual(f.reports, []);
});

test("原生 compaction 也使用当前会话的 Models，不借用全局 provider", async (t) => {
  const native = collection();
  let selections = 0;
  const f = await fixture(
    t,
    createModels(),
    [
      {
        name: "compaction-runtime",
        hooks: [
          hook(CompactionTask, {
            modelRuntime: () => {
              selections++;
              return native.models;
            },
          }),
        ],
      },
    ],
    { compaction: { keepRecentTokens: 1 } },
  );
  const root = await f.harness.root(context, {
    agent: { model: { provider, modelId: "local" } },
  });
  await root.commit(async (tx) => {
    for (let i = 0; i < 4; i++) {
      await tx.appendEntry(root.id, {
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: `history ${i} ` + "context ".repeat(100),
            timestamp: i,
          },
        ],
      });
      await tx.appendEntry(root.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage(`answer ${i}`)],
      });
    }
  }, context);
  native.faux.setResponses([fauxAssistantMessage("NATIVE_COMPACTION_SUMMARY")]);
  const id = await root.compact(undefined, context);
  const task = await f.harness.waitForTask(id, context);
  assert.equal(task.state.outcome.status, "completed");
  assert(task.state.outcome.result.submissionId);
  const placed = await (
    await f.harness.submission(task.state.outcome.result.submissionId)
  ).wait(context);
  assert.equal(placed.status, "done");
  assert(placed.entry);
  assert(selections >= 2);
  const entries = (await root.entries({}, 100, undefined, context)).items;
  assert(
    entries.some(
      (row) =>
        row.kind === "pi.compaction" &&
        JSON.stringify(row.model).includes("NATIVE_COMPACTION_SUMMARY"),
    ),
  );
  assert.deepEqual(f.reports, []);
});

test("未来原生请求运行时声明完整契约时不再替换 phase", () => {
  const installer = new URL(
    "../src/agent/durable-boundaries.mjs",
    import.meta.url,
  ).href;
  const code = `import {GenerationTask,CompactionTask}from '@earendil-works/pi-durable';GenerationTask.definition.version=2;GenerationTask.definition.migrate=(input,checkpoint)=>({input,checkpoint});GenerationTask.definition.capabilities={committedBoundary:1,requestRuntime:1};CompactionTask.definition.capabilities={requestRuntime:1};const generation=GenerationTask.definition.phases.request,compaction=CompactionTask.definition.phases.summarize;const {ensureDurableRequests}=await import(${JSON.stringify(installer)});const support=await ensureDurableRequests();if(support.implementation!=='native'||generation!==GenerationTask.definition.phases.request||compaction!==CompactionTask.definition.phases.summarize)throw new Error('unexpected patch');console.log('native');`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "native");
});

test("原生 SDK 只有边界或 generation 声明时不冒充完整请求适配", () => {
  const installer = new URL(
    "../src/agent/durable-boundaries.mjs",
    import.meta.url,
  ).href;
  const code = `import {GenerationTask}from '@earendil-works/pi-durable';GenerationTask.definition.version=2;GenerationTask.definition.migrate=(input,checkpoint)=>({input,checkpoint});GenerationTask.definition.capabilities={committedBoundary:1,requestRuntime:1};const {ensureDurableRequests}=await import(${JSON.stringify(installer)});try{await ensureDurableRequests();process.exitCode=1;}catch(error){if(error.status!==501)throw error;console.log('refused');}`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "refused");
});

test("modelRuntime 解析失败不得静默退回另一模型集合继续请求", async (t) => {
  const base = collection();
  const f = await fixture(t, base.models, [
    {
      name: "broken-runtime",
      hooks: [
        hook(GenerationTask, {
          modelRuntime: () => {
            throw new Error("MODEL_SCOPE_FAILURE");
          },
        }),
      ],
    },
  ]);
  const root = await f.harness.root(context, {
    agent: { model: { provider, modelId: "local" } },
  });
  base.faux.setResponses([fauxAssistantMessage("FORBIDDEN_FALLBACK")]);
  const result = await (
    await root.submit({ type: "input", content: "start" }, context)
  ).wait(context);
  assert.equal(result.status, "unanswered");
  assert.equal(base.calls.length, 0);
});
