import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  Type,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  GenerationTask,
  AssistantEntry,
  LiveDoc,
  InboxDoc,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ensureDurableBoundaries } from "../src/agent/durable-boundaries.mjs";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const text = (message) =>
  message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
async function fixture(t, hooks, options = {}) {
  const source = new URL(
    "./harness/generation.js",
    import.meta.resolve("@earendil-works/pi-durable"),
  );
  const digest = () =>
    readFile(source).then((data) =>
      createHash("sha256").update(data).digest("hex"),
    );
  const before = await digest();
  const definition = GenerationTask.definition;
  const support = await ensureDurableBoundaries();
  assert.equal(
    GenerationTask.definition,
    definition,
    "保留原生 definition 身份",
  );
  assert.equal(support.apiVersion, 1);
  assert.equal(
    GenerationTask.definition.capabilities.committedBoundary,
    support.apiVersion,
  );
  assert.equal(await digest(), before, "补丁不修改 node_modules");
  assert.equal(await ensureDurableBoundaries(), support, "进程内只安装一次");
  const models = createModels();
  const faux = fauxProvider({
    provider: "native-boundary-test",
    models: [{ id: "local" }],
    tokensPerSecond: options.tokensPerSecond ?? 100000,
  });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  assert.equal(registry.snapshot().task("pi.generation"), GenerationTask);
  assert.equal(
    registry
      .snapshot()
      .tasks()
      .filter((task) => task.definition.name === "pi.generation").length,
    1,
  );
  registry.install(
    defineExtension({
      name: "boundary-test",
      tools: options.tools ?? [],
      hooks: [hook(GenerationTask, hooks)],
    }),
  );
  const reports = [];
  const harness = await Harness.open(
    options.storage ?? new MemoryStorage(),
    {
      models,
      registry,
      settings: options.settings,
      onReport: (error) => reports.push(error.message),
    },
    context,
  );
  const root = await harness.root(context, {
    agent: { model: { provider: "native-boundary-test", modelId: "local" } },
  });
  t.after(async () => {
    await harness.close(context);
    assert.deepEqual(reports, []);
  });
  const entry = (id) =>
    root.commit((tx) => tx.entry(AssistantEntry, id), context);
  return { harness, root, faux, entry, models, registry };
}

test("提交后 afterTurn 读取真实 entry，在原 submission 内继续且不伪造用户输入", async (t) => {
  let f;
  const observed = [];
  f = await fixture(t, {
    afterTurn: async (event) => {
      const value = await f.entry(event.assistant);
      observed.push({ id: value.id, text: text(value.model[0]) });
      if (observed.length === 1)
        return {
          entries: [
            {
              kind: "test.native-boundary",
              model: [
                {
                  role: "user",
                  content: "NATIVE_BOUNDARY_CONTEXT",
                  timestamp: 1,
                },
              ],
            },
          ],
          continue: true,
        };
    },
  });
  f.faux.setResponses([
    fauxAssistantMessage("FIRST_BOUNDARY_RESPONSE"),
    fauxAssistantMessage("FINAL_BOUNDARY_RESPONSE"),
  ]);
  const submission = await f.root.submit(
    { type: "input", content: "start", requestId: "native-turn" },
    context,
  );
  const settled = await submission.wait(context);
  assert.equal(settled.status, "done");
  assert.equal(
    text((await f.entry(settled.answer)).model[0]),
    "FINAL_BOUNDARY_RESPONSE",
  );
  assert.deepEqual(
    observed.map((row) => row.text),
    ["FIRST_BOUNDARY_RESPONSE", "FINAL_BOUNDARY_RESPONSE"],
  );
  assert.notEqual(observed[0].id, observed[1].id);
  const entries = (await f.root.entries({}, 100, undefined, context)).items;
  assert.equal(entries.filter((row) => row.kind === "pi.user").length, 1);
  assert.equal(
    entries.filter((row) => row.kind === "test.native-boundary").length,
    1,
  );
  assert.equal(
    (await submission.wait(context)).answer,
    settled.answer,
    "已结束的首次答案仍不可变",
  );
});

test("beforeSettle 等待决策并在原 run 内继续，顺序与账本保持", async (t) => {
  let f,
    settledCount = 0;
  const order = [];
  f = await fixture(t, {
    afterTurn: async (event) =>
      order.push("turn:" + text((await f.entry(event.assistant)).model[0])),
    beforeSettle: async (event) => {
      order.push("settle:" + text((await f.entry(event.assistant)).model[0]));
      if (++settledCount === 1)
        return {
          entries: [
            {
              kind: "test.pre-settle",
              model: [
                { role: "user", content: "SETTLE_CONTEXT", timestamp: 1 },
              ],
            },
          ],
          continue: true,
        };
    },
  });
  f.faux.setResponses([
    fauxAssistantMessage("FIRST"),
    fauxAssistantMessage("FINAL"),
  ]);
  const result = await (
    await f.root.submit({ type: "input", content: "start" }, context)
  ).wait(context);
  assert.equal(text((await f.entry(result.answer)).model[0]), "FINAL");
  assert.deepEqual(order, [
    "turn:FIRST",
    "settle:FIRST",
    "turn:FINAL",
    "settle:FINAL",
  ]);
  const assistants = (
    await f.root.entries({}, 100, undefined, context)
  ).items.filter((row) => row.kind === "pi.assistant");
  assert.equal(assistants.length, 2);
  const expected = new Map();
  for (const row of assistants) {
    const message = row.model[0],
      key = message.provider + "/" + message.model;
    const total = expected.get(key) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    };
    for (const field of Object.keys(total))
      total[field] += message.usage[field] ?? 0;
    expected.set(key, total);
  }
  const billed = await f.harness.snapshot(UsageDoc, f.root.id, context);
  for (const [key, total] of expected)
    for (const [field, value] of Object.entries(total))
      assert.equal(
        billed.models[key][field],
        value,
        "边界不会重复或漏计模型用量",
      );
});

test(
  "边界等待期间 abort 不会被迟到 continue 重新启动",
  { timeout: 10000 },
  async (t) => {
    let reached;
    const pending = new Promise((resolve) => {
      reached = resolve;
    });
    const f = await fixture(t, {
      afterTurn: async (_event, _api, ctx) => {
        reached();
        await new Promise((resolve) =>
          ctx.abortSignal.addEventListener("abort", resolve, { once: true }),
        );
        return {
          continue: true,
          entries: [
            {
              kind: "test.forbidden-late",
              model: [{ role: "user", content: "LATE", timestamp: 1 }],
            },
          ],
        };
      },
    });
    f.faux.setResponses([
      fauxAssistantMessage("FIRST"),
      fauxAssistantMessage("SHOULD_NOT_RUN"),
    ]);
    const submission = await f.root.submit(
      { type: "input", content: "start" },
      context,
    );
    await pending;
    await f.root.abort(context);
    const result = await submission.wait(context);
    assert.equal(result.status, "unanswered");
    assert.equal(result.reason, "aborted");
    const entries = (await f.root.entries({}, 100, undefined, context)).items;
    assert.equal(
      entries.filter((row) => row.kind === "pi.assistant").length,
      1,
    );
    assert(!entries.some((row) => row.kind === "test.forbidden-late"));
  },
);

test("没有新 hook 的原生 onYield 与队列行为不改写", async (t) => {
  let count = 0;
  const f = await fixture(t, {
    onYield: () =>
      ++count === 1 ? { continue: "legacy continuation" } : undefined,
  });
  f.faux.setResponses([
    fauxAssistantMessage("FIRST"),
    fauxAssistantMessage("FINAL"),
  ]);
  const result = await (
    await f.root.submit({ type: "input", content: "start" }, context)
  ).wait(context);
  assert.equal(text((await f.entry(result.answer)).model[0]), "FINAL");
  assert.equal(count, 2);
  assert.equal(
    (await f.root.entries({}, 100, undefined, context)).items.filter(
      (row) => row.kind === "pi.user",
    ).length,
    2,
  );
});

test("原生 SDK 声明同一接口时优先采用，不二次补丁", () => {
  const code = `import {GenerationTask} from '@earendil-works/pi-durable';
const original=GenerationTask.definition.phases.request;
GenerationTask.definition.capabilities={committedBoundary:1};
GenerationTask.definition.version=2;
GenerationTask.definition.migrate=(input,checkpoint)=>({input,checkpoint});
const {ensureDurableBoundaries}=await import(${JSON.stringify(new URL("../src/agent/durable-boundaries.mjs", import.meta.url).href)});
const result=await ensureDurableBoundaries();
if(result.implementation!=='native'||GenerationTask.definition.phases.request!==original)process.exitCode=1;
console.log(result.implementation);`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "native");
});

test("工具回合只分发一次，afterTurn 拿到已提交的助手和工具结果", async (t) => {
  let f;
  const order = [];
  const echo = defineTool({
    name: "boundary_echo",
    description: "echo",
    parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: "text", text: "TOOL_RESULT" }] }),
  });
  f = await fixture(
    t,
    {
      afterTools: () => {
        order.push("tools");
      },
      afterTurn: async (event) => {
        const row = await f.entry(event.assistant);
        order.push(
          row.model[0].stopReason === "toolUse" ? "turn-tools" : "turn-answer",
        );
        if (event.results.length) {
          assert.equal(event.automatic, true);
          assert.equal(event.results.length, 1);
          const result = await f.root.commit(
            (tx) => tx.entry(event.results[0]),
            context,
          );
          assert.equal(result.model[0].toolName, "boundary_echo");
          assert.equal(text(result.model[0]), "TOOL_RESULT");
        }
      },
      beforeSettle: () => {
        order.push("settle");
      },
    },
    { tools: [echo] },
  );
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "boundary-call",
          name: "boundary_echo",
          arguments: {},
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("FINAL"),
  ]);
  const result = await (
    await f.root.submit({ type: "input", content: "start" }, context)
  ).wait(context);
  assert.equal(text((await f.entry(result.answer)).model[0]), "FINAL");
  assert.deepEqual(order, ["tools", "turn-tools", "turn-answer", "settle"]);
});

test("原生错误重试不提前 settle，afterResponse 不重复运行", async (t) => {
  let f,
    responses = 0;
  const order = [];
  f = await fixture(
    t,
    {
      afterResponse: () => {
        responses++;
      },
      afterTurn: (event) => {
        order.push("turn:" + event.outcome);
      },
      beforeSettle: () => {
        order.push("settle");
      },
    },
    { settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } },
  );
  f.faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "429 rate limit",
    }),
    fauxAssistantMessage("FINAL"),
  ]);
  const result = await (
    await f.root.submit({ type: "input", content: "start" }, context)
  ).wait(context);
  assert.equal(result.status, "done");
  assert.equal(text((await f.entry(result.answer)).model[0]), "FINAL");
  assert.equal(responses, 2);
  assert.deepEqual(order, ["turn:error", "turn:completed", "settle"]);
});

test("afterResponse 的原生修改在分类前生效，错误改写不再次发出回调", async (t) => {
  let f,
    responses = 0;
  f = await fixture(
    t,
    {
      afterResponse: (message) => {
        responses++;
        message.stopReason = "stop";
        message.content = [{ type: "text", text: "REPAIRED" }];
      },
      afterTurn: () => {},
    },
    { settings: { retry: { enabled: false } } },
  );
  f.faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "429 rate limit",
    }),
  ]);
  const result = await (
    await f.root.submit({ type: "input", content: "start" }, context)
  ).wait(context);
  assert.equal(result.status, "done");
  assert.equal(text((await f.entry(result.answer)).model[0]), "REPAIRED");
  assert.equal(responses, 1);
});

test(
  "排队输入仍优先于扩展 continuation，原 submission 不被后续答案改写",
  { timeout: 10000 },
  async (t) => {
    let reached, release;
    const atBoundary = new Promise((resolve) => {
      reached = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let f;
    const order = [];
    f = await fixture(t, {
      afterTurn: async (event) => {
        const value = text((await f.entry(event.assistant)).model[0]);
        order.push("turn:" + value);
        if (value === "FIRST") {
          reached();
          await gate;
          return { continue: true };
        }
      },
      beforeSettle: async (event) => {
        order.push("settle:" + text((await f.entry(event.assistant)).model[0]));
      },
    });
    f.faux.setResponses([
      fauxAssistantMessage("FIRST"),
      fauxAssistantMessage("FOLLOWUP"),
    ]);
    const first = await f.root.submit(
      { type: "input", content: "start" },
      context,
    );
    await atBoundary;
    const next = await f.root.submit(
      { type: "input", content: "next", whenBusy: "followUp" },
      context,
    );
    release();
    const original = await first.wait(context),
      followup = await next.wait(context);
    assert.equal(text((await f.entry(original.answer)).model[0]), "FIRST");
    assert.equal(text((await f.entry(followup.answer)).model[0]), "FOLLOWUP");
    assert.equal((await first.wait(context)).answer, original.answer);
    assert.deepEqual(order, ["turn:FIRST", "turn:FOLLOWUP", "settle:FOLLOWUP"]);
  },
);

test("不匹配的 SDK 内容明确失败，不猜测或写入依赖目录", () => {
  const installer = new URL(
    "../src/agent/durable-boundaries.mjs",
    import.meta.url,
  ).href;
  const fake =
    "import {readFile as original} from 'node:fs/promises';export async function readFile(path,...args){const data=await original(path,...args);return String(path).endsWith('/harness/generation.js')?data+'\\n/* mismatch */':data;}";
  const fakeUrl =
    "data:text/javascript;base64," + Buffer.from(fake).toString("base64");
  const code = `import {registerHooks} from 'node:module';const handle=registerHooks({resolve(specifier,context,next){if(specifier==='node:fs/promises'&&context.parentURL===${JSON.stringify(installer)})return {url:${JSON.stringify(fakeUrl)},shortCircuit:true};return next(specifier,context);}});try{const {ensureDurableBoundaries}=await import(${JSON.stringify(installer)});await ensureDurableBoundaries();process.exitCode=1;}catch(error){if(error.status!==501||!error.message.includes('源码'))throw error;console.log('refused');}finally{handle.deregister();}`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "refused");
});

test("normal message_end 改成错误时仍进入已提交错误边界", async (t) => {
  let responses = 0;
  const seen = [];
  const f = await fixture(
    t,
    {
      afterResponse: (message) => {
        responses++;
        message.stopReason = "error";
        message.errorMessage = "replaced failure";
      },
      afterTurn: (event) => {
        seen.push(event.outcome);
      },
      beforeSettle: (event) => {
        seen.push("settle:" + event.outcome);
      },
    },
    { settings: { retry: { enabled: false } } },
  );
  f.faux.setResponses([fauxAssistantMessage("ORIGINAL")]);
  const result = await (
    await f.root.submit({ type: "input", content: "start" }, context)
  ).wait(context);
  assert.equal(result.status, "unanswered");
  assert.equal(result.reason, "model_error");
  assert.equal(responses, 1);
  assert.deepEqual(seen, ["error", "settle:error"]);
});

test("工具终止候选也等待 beforeSettle，显式继续仍属于原 run", async (t) => {
  let f,
    count = 0;
  const stop = defineTool({
    name: "boundary_stop",
    description: "stop",
    parameters: Type.Object({}),
    execute: async () => ({
      output: [{ type: "text", text: "STOP_RESULT" }],
      control: { terminate: true },
    }),
  });
  f = await fixture(
    t,
    {
      beforeSettle: (event) => {
        if (++count === 1) {
          assert.equal(event.results.length, 1);
          return {
            entries: [
              {
                kind: "test.after-stop",
                model: [{ role: "user", content: "AFTER_STOP", timestamp: 1 }],
              },
            ],
            continue: true,
          };
        }
      },
    },
    { tools: [stop] },
  );
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "stop-call",
          name: "boundary_stop",
          arguments: {},
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("AFTER_STOP_ANSWER"),
  ]);
  const result = await (
    await f.root.submit({ type: "input", content: "start" }, context)
  ).wait(context);
  assert.equal(result.status, "done");
  assert.equal(
    text((await f.entry(result.answer)).model[0]),
    "AFTER_STOP_ANSWER",
  );
  assert.equal(count, 2);
});

test("afterTurn 不能绕过工具 terminate，终止候选仍交给 beforeSettle", async (t) => {
  let turns = 0,
    settles = 0;
  const stop = defineTool({
    name: "boundary_stop",
    description: "stop",
    parameters: Type.Object({}),
    execute: async () => ({
      output: [{ type: "text", text: "STOP_RESULT" }],
      control: { terminate: true },
    }),
  });
  const f = await fixture(
    t,
    {
      afterTurn: () => {
        if (++turns === 1)
          return {
            entries: [
              {
                kind: "test.turn-context",
                model: [
                  { role: "user", content: "TURN_CONTEXT", timestamp: 1 },
                ],
              },
            ],
            continue: true,
          };
      },
      beforeSettle: (event) => {
        settles++;
        assert.equal(event.results.length, 1);
      },
    },
    { tools: [stop] },
  );
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "stop-once",
          name: "boundary_stop",
          arguments: {},
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("MUST_NOT_RUN"),
  ]);
  const result = await (
    await f.root.submit({ type: "input", content: "stop" }, context)
  ).wait(context);
  assert.equal(result.status, "done");
  assert.equal((await f.entry(result.answer)).model[0].stopReason, "toolUse");
  assert.equal(turns, 1);
  assert.equal(settles, 1);
  assert.equal(
    (await f.root.entries({}, 100, undefined, context)).items.filter(
      (row) => row.kind === "pi.assistant",
    ).length,
    1,
  );
});

test(
  "未注册边界 hook 的检查点中断后正常恢复，不误判副作用",
  { timeout: 10000 },
  async (t) => {
    for (const missing of ["turn", "settle"]) {
      const directory = await mkdtemp(join(tmpdir(), "pi-empty-boundary-"));
      let reopened;
      t.after(async () => {
        await reopened?.close(context);
        await rm(directory, { recursive: true, force: true });
      });
      let reached,
        interrupted = false,
        callbackCalls = 0,
        nextState;
      const atCheckpoint = new Promise((resolve) => {
        reached = resolve;
      });
      const hooks =
        missing === "turn"
          ? {
              beforeSettle: () => {
                callbackCalls++;
              },
            }
          : {
              afterTurn: () => {
                callbackCalls++;
              },
            };
      const f = await fixture(t, hooks, {
        storage: await openNodeSqliteStorage(join(directory, "state.sqlite")),
      });
      const original = GenerationTask.definition.phases.committedBoundary;
      // 在原生 commit 已完成、phase 尚未返回的确定位置中断，不伪造恢复检查点。
      GenerationTask.definition.phases.committedBoundary = async (
        task,
        runtime,
        ctx,
      ) => {
        if (task.state.checkpoint.step !== missing || interrupted)
          return original(task, runtime, ctx);
        const proxy = new Proxy(runtime, {
          get(target, key) {
            if (key === "commit")
              return async (change, commitContext) => {
                let next;
                await target.commit(async (tx, current) => {
                  next = await change(tx, current);
                  return next;
                }, commitContext);
                if (interrupted) return;
                interrupted = true;
                nextState = structuredClone(next);
                reached();
                if (next?.status === "terminal") return;
                await new Promise((resolve) => {
                  if (ctx.abortSignal.aborted) resolve();
                  else
                    ctx.abortSignal.addEventListener("abort", resolve, {
                      once: true,
                    });
                });
                ctx.abortSignal.throwIfAborted();
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return original(task, proxy, ctx);
      };
      try {
        f.faux.setResponses([
          fauxAssistantMessage("ALREADY_COMMITTED"),
          fauxAssistantMessage("MUST_NOT_REPEAT_MODEL"),
        ]);
        const first = await f.root.submit(
          { type: "input", content: missing },
          context,
        );
        await atCheckpoint;
        await f.harness.close(context);
        GenerationTask.definition.phases.committedBoundary = original;
        reopened = await Harness.open(
          await openNodeSqliteStorage(join(directory, "state.sqlite")),
          { models: f.models, registry: f.registry },
          context,
        );
        reopened.resume();
        const result = await (
          await reopened.submission(first.id)
        ).wait(context);
        assert.equal(
          result.status,
          "done",
          JSON.stringify({ missing, nextState, result }),
        );
        assert.equal(callbackCalls, 1);
        const root = await reopened.root(context);
        const assistants = (
          await root.entries({}, 100, undefined, context)
        ).items.filter((row) => row.kind === "pi.assistant");
        assert.equal(assistants.length, 1);
        assert.equal(text(assistants[0].model[0]), "ALREADY_COMMITTED");
        await reopened.close(context);
      } finally {
        GenerationTask.definition.phases.committedBoundary = original;
        await f.harness.close(context);
      }
    }
  },
);

test("v1 原生 generation 检查点通过迁移继续，不新建另一模型任务种类", async (t) => {
  const f = await fixture(t, { afterTurn: () => {} });
  f.faux.setResponses([fauxAssistantMessage("MIGRATED")]);
  const legacy = { definition: { ...GenerationTask.definition, version: 1 } };
  const id = await f.root.commit(async (tx) => {
    await tx.appendEntry(f.root.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "legacy", timestamp: 1 }],
    });
    const task = await tx.createTask(
      legacy,
      {},
      { ownership: { kind: "conversation" }, conversationId: f.root.id },
    );
    (await tx.doc(LiveDoc, f.root.id)).run = { taskId: task, inputs: [] };
    return task;
  }, context);
  f.harness.resume();
  const task = await f.harness.waitForTask(id, context);
  assert.equal(task.version, 2);
  assert.equal(task.kind, "pi.generation");
  assert.equal(task.state.outcome.status, "completed");
  assert.equal(
    text((await f.entry(task.state.outcome.result.entryId)).model[0]),
    "MIGRATED",
  );
});

test(
  "已进入边界的检查点恢复不重放未知副作用，也不重新请求模型",
  { timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "pi-durable-boundary-recovery-"),
    );
    let reopened;
    t.after(async () => {
      await reopened?.close(context);
      await rm(directory, { recursive: true, force: true });
    });
    let reached,
      calls = 0;
    const atBoundary = new Promise((resolve) => {
      reached = resolve;
    });
    const storage = await openNodeSqliteStorage(
      join(directory, "state.sqlite"),
    );
    const f = await fixture(
      t,
      {
        afterTurn: async (_event, _api, ctx) => {
          calls++;
          reached();
          await new Promise((resolve) =>
            ctx.abortSignal.addEventListener("abort", resolve, { once: true }),
          );
          return { continue: true };
        },
      },
      { storage },
    );
    f.faux.setResponses([
      fauxAssistantMessage("COMMITTED_ONCE"),
      fauxAssistantMessage("FORBIDDEN_REPLAY"),
    ]);
    const first = await f.root.submit(
      { type: "input", content: "start" },
      context,
    );
    await atBoundary;
    await f.harness.close(context);
    reopened = await Harness.open(
      await openNodeSqliteStorage(join(directory, "state.sqlite")),
      { models: f.models, registry: f.registry },
      context,
    );
    reopened.resume();
    const result = await (await reopened.submission(first.id)).wait(context);
    assert.equal(result.status, "unanswered");
    assert.equal(result.reason, "model_error");
    assert(result.detail.includes("未重复执行"));
    assert.equal(calls, 1);
    const root = await reopened.root(context);
    const entries = (await root.entries({}, 100, undefined, context)).items;
    assert.equal(
      entries.filter((row) => row.kind === "pi.assistant").length,
      1,
    );
    assert.equal(
      text(entries.find((row) => row.kind === "pi.assistant").model[0]),
      "COMMITTED_ONCE",
    );
  },
);

test(
  "最终模型失败不提前消耗原生 inbox 的排队输入",
  { timeout: 10000 },
  async (t) => {
    let reached, release;
    const pending = new Promise((resolve) => {
      reached = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture(
      t,
      {
        afterTurn: async () => {
          reached();
          await gate;
        },
        beforeSettle: () => {},
      },
      { settings: { retry: { enabled: false } } },
    );
    f.faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "terminal failure",
      }),
      fauxAssistantMessage("MUST_STAY_QUEUED"),
    ]);
    const first = await f.root.submit(
      { type: "input", content: "start" },
      context,
    );
    await pending;
    const next = await f.root.submit(
      { type: "input", content: "queued", whenBusy: "followUp" },
      context,
    );
    release();
    const result = await first.wait(context);
    assert.equal(result.status, "unanswered");
    const inbox = await f.harness.snapshot(InboxDoc, f.root.id, context);
    assert(inbox.items.some((item) => item.id === next.id));
    assert.equal(
      (await f.root.entries({}, 100, undefined, context)).items.filter(
        (row) => row.kind === "pi.assistant",
      ).length,
      1,
    );
  },
);

test("afterPartial 只读取已提交快照，所有在途更新先于 afterTurn 结束", async (t) => {
  let f;
  const order = [];
  f = await fixture(
    t,
    {
      afterPartial: async (message) => {
        const live = await f.harness.snapshot(LiveDoc, f.root.id, context);
        assert.equal(text(live.generation.message), text(message));
        order.push("partial");
      },
      afterTurn: () => {
        order.push("turn");
      },
    },
    { tokensPerSecond: 30 },
  );
  f.faux.setResponses([
    fauxAssistantMessage("Streamed partial output with several stable chunks."),
  ]);
  const result = await (
    await f.root.submit({ type: "input", content: "start" }, context)
  ).wait(context);
  assert.equal(result.status, "done");
  assert(order.includes("partial"));
  assert.equal(order.at(-1), "turn");
});
