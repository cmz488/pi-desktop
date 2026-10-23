import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
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
  hook,
  GenerationTask,
  CompactionTask,
  InboxDoc,
  defineTool,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ensureDurableInputs } from "../src/agent/durable-boundaries.mjs";

const nativeInput = (content) => ({
  kind: "desk.native-message",
  model: [{ role: "user", content, timestamp: 1 }],
  data: {
    nativeMessage: {
      role: "custom",
      customType: "plain-fixture",
      content,
      display: true,
      timestamp: 1,
    },
  },
});
const definitions = [
  GenerationTask.definition,
  CompactionTask.definition,
  InboxDoc.definition,
];
const harnessToken = Harness;
const sourceDigests = async () =>
  Promise.all(
    ["generation", "compaction", "harness", "submissions", "inbox"].map(
      async (name) =>
        createHash("sha256")
          .update(
            await readFile(
              new URL(
                `./harness/${name}.js`,
                import.meta.resolve("@earendil-works/pi-durable"),
              ),
            ),
          )
          .digest("hex"),
    ),
  );
const beforeSources = sourceDigests();
async function fixture(t, hooks = {}, tools = []) {
  await ensureDurableInputs();
  assert.equal(GenerationTask.definition, definitions[0]);
  assert.equal(CompactionTask.definition, definitions[1]);
  assert.equal(InboxDoc.definition, definitions[2]);
  assert.equal(Harness, harnessToken);
  const models = createModels(),
    faux = fauxProvider({
      provider: "entry-inputs",
      models: [{ id: "local" }],
      tokensPerSecond: 100000,
    });
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "entry-inputs",
      tools,
      hooks: [hook(GenerationTask, hooks)],
    }),
  );
  const reports = [];
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, onReport: (error) => reports.push(error.message) },
    context,
  );
  t.after(async () => {
    await harness.close(context);
    assert.deepEqual(reports, []);
  });
  const root = await harness.root(context, {
    agent: { model: { provider: "entry-inputs", modelId: "local" } },
  });
  return { harness, root, faux };
}
const entries = async (root) =>
  (await root.entries({}, 100, undefined, context)).items;

test("entry input 空闲启动原生 run，不生成伪 pi.user，首次回执不被后续输入改写", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage("CUSTOM_OK"),
    fauxAssistantMessage("LATER"),
  ]);
  const first = await f.root.submit(
    {
      type: "input",
      entry: nativeInput("CUSTOM_CONTEXT"),
      requestId: "custom-once",
    },
    context,
  );
  const result = await first.wait(context);
  assert.equal(result.status, "done");
  const before = await entries(f.root);
  assert.equal(before.filter((row) => row.kind === "pi.user").length, 0);
  const original = before.find((row) => row.id === result.entry);
  assert.equal(original.kind, "desk.native-message");
  assert.equal(original.data.nativeMessage.customType, "plain-fixture");
  assert.equal(
    before.find((row) => row.id === result.answer).model[0].content[0].text,
    "CUSTOM_OK",
  );
  const duplicate = await f.root.submit(
    {
      type: "input",
      entry: nativeInput("DIFFERENT_RETRY"),
      requestId: "custom-once",
    },
    context,
  );
  assert.equal(duplicate.id, first.id);
  await (
    await f.root.submit({ type: "input", content: "later" }, context)
  ).wait(context);
  assert.equal((await first.wait(context)).answer, result.answer);
  assert.equal(
    (await entries(f.root)).filter((row) => row.kind === "desk.native-message")
      .length,
    1,
  );
});

test(
  "entry input 的 steer 沿原生工具边界进入同一个 run",
  { timeout: 10000 },
  async (t) => {
    let reached, release;
    const started = new Promise((resolve) => {
      reached = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tool = defineTool({
      name: "entry_gate",
      description: "gate",
      parameters: Type.Object({}),
      execute: async (_args, _api, ctx) => {
        reached();
        await Promise.race([
          gate,
          new Promise((resolve) =>
            ctx.abortSignal.addEventListener("abort", resolve, { once: true }),
          ),
        ]);
        return { content: [{ type: "text", text: "TOOL_RESULT" }] };
      },
    });
    const f = await fixture(t, {}, [tool]);
    f.faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "entry-tool",
            name: "entry_gate",
            arguments: {},
          },
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("AFTER_STEER"),
    ]);
    const first = await f.root.submit(
      { type: "input", content: "start" },
      context,
    );
    await started;
    const next = await f.root.submit(
      { type: "input", entry: nativeInput("STEER_CONTEXT"), whenBusy: "steer" },
      context,
    );
    assert.equal((await next.status(context)).status, "queued");
    release();
    const [a, b] = await Promise.all([first.wait(context), next.wait(context)]);
    assert.equal(a.answer, b.answer);
    const rows = await entries(f.root);
    assert.equal(
      rows.find((row) => row.id === a.answer).model[0].content[0].text,
      "AFTER_STEER",
    );
    assert.equal(rows.filter((row) => row.kind === "pi.user").length, 1);
    assert.equal(
      rows.find((row) => row.id === b.entry).kind,
      "desk.native-message",
    );
  },
);

test(
  "entry input 保留 busy reject 和排队取消，不留下模型贡献",
  { timeout: 10000 },
  async (t) => {
    let reached, release;
    const started = new Promise((resolve) => {
      reached = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture(t, {
      afterResponse: async (_message, _api, ctx) => {
        reached();
        await Promise.race([
          gate,
          new Promise((resolve) =>
            ctx.abortSignal.addEventListener("abort", resolve, { once: true }),
          ),
        ]);
      },
    });
    f.faux.setResponses([fauxAssistantMessage("ONLY_FIRST")]);
    const first = await f.root.submit(
      { type: "input", content: "first" },
      context,
    );
    await started;
    await assert.rejects(
      f.root.submit(
        { type: "input", entry: nativeInput("REJECT"), whenBusy: "reject" },
        context,
      ),
      { name: "ConversationBusy" },
    );
    const queued = await f.root.submit(
      { type: "input", entry: nativeInput("CANCEL"), whenBusy: "followUp" },
      context,
    );
    assert.equal(await queued.abort(context), "aborted");
    assert.equal((await queued.wait(context)).reason, "aborted");
    release();
    await first.wait(context);
    assert.equal(
      (await entries(f.root)).filter(
        (row) => row.kind === "desk.native-message",
      ).length,
      0,
    );
  },
);

test("entry input 仅追加新贡献，拒绝改写已有上下文或混合两种正文", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.root.submit(
      { type: "input", entry: { ...nativeInput("bad"), head: "self" } },
      context,
    ),
    /已有上下文/,
  );
  await assert.rejects(
    f.root.submit(
      { type: "input", entry: nativeInput("bad"), content: "also bad" },
      context,
    ),
    /同时指定/,
  );
  await assert.rejects(
    f.root.submit(
      { type: "input", entry: { kind: "empty", model: [] } },
      context,
    ),
    /模型消息/,
  );
  assert.equal((await entries(f.root)).length, 0);
});

test(
  "真实 SQLite 的 v1 inbox 迁移及排队 entry input 二次恢复不制造用户输入",
  { timeout: 15000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-entry-input-recovery-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const installer = new URL(
      "../src/agent/durable-boundaries.mjs",
      import.meta.url,
    ).href;
    const code = `import assert from 'node:assert/strict';
import {createModels,fauxProvider,fauxAssistantMessage}from '@earendil-works/pi-ai';
import {Harness,createRegistry,defineExtension,hook,GenerationTask,InboxDoc}from '@earendil-works/pi-durable';
import {openNodeSqliteStorage}from '@earendil-works/pi-durable/storage/sqlite/node';
import {BACKGROUND_CONTEXT as ctx}from '@earendil-works/chord/context';
const models=createModels(),faux=fauxProvider({provider:'recovery',models:[{id:'local'}],tokensPerSecond:100000});models.setProvider(faux.provider);
let stage=1,reached;let paused=new Promise(resolve=>{reached=resolve;});
const registry=createRegistry();registry.install(defineExtension({name:'recovery',hooks:[hook(GenerationTask,{afterResponse:async(_message,_api,context)=>{if(stage<3){reached();await new Promise(resolve=>context.abortSignal.addEventListener('abort',resolve,{once:true}));}}})]}));
const open=async()=>Harness.open(await openNodeSqliteStorage(process.argv[1]),{models,registry,settings:{followUpMode:'one'}},ctx);
let h=await open(),root=await h.root(ctx,{agent:{model:{provider:'recovery',modelId:'local'}}});
assert.equal(InboxDoc.definition.version,1);faux.setResponses([fauxAssistantMessage('INTERRUPTED_V1')]);
const first=await root.submit({type:'input',content:'first'},ctx);await paused;
const legacy=await root.submit({type:'input',content:'legacy followup',whenBusy:'followUp'},ctx);await h.close(ctx);
const {ensureDurableInputs}=await import(${JSON.stringify(installer)});await ensureDurableInputs();assert.equal(InboxDoc.definition.version,2);
stage=2;paused=new Promise(resolve=>{reached=resolve;});h=await open();root=await h.root(ctx);faux.setResponses([fauxAssistantMessage('INTERRUPTED_V2')]);h.resume();await paused;
const native=await root.submit({type:'input',requestId:'raw-recovery',whenBusy:'followUp',entry:{kind:'desk.native-message',model:[{role:'user',content:'CUSTOM_RESTART',timestamp:1}],data:{nativeMessage:{role:'custom',customType:'recovery',content:'CUSTOM_RESTART',display:true,timestamp:1}}}},ctx);
const queued=await h.snapshot(InboxDoc,root.id,ctx);assert.equal(queued.items.length,2);await h.close(ctx);
stage=3;h=await open();faux.setResponses([fauxAssistantMessage('RESTORED_FIRST'),fauxAssistantMessage('RESTORED_LEGACY'),fauxAssistantMessage('RESTORED_CUSTOM')]);h.resume();
const a=await(await h.submission(first.id)).wait(ctx),b=await(await h.submission(legacy.id)).wait(ctx),c=await(await h.submission(native.id)).wait(ctx);
for(const result of [a,b,c])assert.equal(result.status,'done');
root=await h.root(ctx);const rows=(await root.entries({},100,undefined,ctx)).items;
assert.equal(rows.find(row=>row.id===a.answer).model[0].content[0].text,'RESTORED_FIRST');assert.equal(rows.find(row=>row.id===b.answer).model[0].content[0].text,'RESTORED_LEGACY');assert.equal(rows.find(row=>row.id===c.answer).model[0].content[0].text,'RESTORED_CUSTOM');
assert.equal(rows.filter(row=>row.kind==='pi.user').length,2);assert.equal(rows.filter(row=>row.kind==='desk.native-message').length,1);assert.equal(rows.find(row=>row.id===c.entry).kind,'desk.native-message');
await h.close(ctx);console.log('restored');`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", code, join(directory, "state.sqlite")],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "restored");
  },
);

test("原生 entry input 完整能力与迁移契约优先采用，缺少迁移则拒绝", () => {
  const installer = new URL(
    "../src/agent/durable-boundaries.mjs",
    import.meta.url,
  ).href;
  for (const migration of [true, false]) {
    const code = `import {Harness,InboxDoc,GenerationTask,CompactionTask}from '@earendil-works/pi-durable';GenerationTask.definition.version=2;GenerationTask.definition.migrate=(input,checkpoint)=>({input,checkpoint});GenerationTask.definition.capabilities={committedBoundary:1,requestRuntime:1};CompactionTask.definition.capabilities={requestRuntime:1};Harness.capabilities={entryInput:1};InboxDoc.definition.version=2;${migration ? "InboxDoc.definition.migrate=value=>value;" : ""}const open=Harness.open;const {ensureDurableInputs}=await import(${JSON.stringify(installer)});try{const support=await ensureDurableInputs();if(!${migration}||support.implementation!=='native'||Harness.open!==open)throw new Error('unexpected patch');console.log('native');}catch(error){if(${migration}||error.status!==501)throw error;console.log('refused');}`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", code],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), migration ? "native" : "refused");
  }
});

test("SDK token 与依赖文件保持，新的输入能力不写回 node_modules", async () => {
  await ensureDurableInputs();
  assert.equal(Harness.capabilities.entryInput, 1);
  assert.equal(InboxDoc.definition.version, 2);
  assert.deepEqual(await sourceDigests(), await beforeSources);
});

test(
  "排队 entry input 复用原生 followUp 边界，不重复正文或吞掉首次答案",
  { timeout: 10000 },
  async (t) => {
    let reached, release;
    const atResponse = new Promise((resolve) => {
      reached = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture(t, {
      afterResponse: async (message, _api, ctx) => {
        if (message.content[0]?.text === "FIRST") {
          reached();
          await Promise.race([
            gate,
            new Promise((resolve) =>
              ctx.abortSignal.addEventListener("abort", resolve, {
                once: true,
              }),
            ),
          ]);
        }
      },
    });
    f.faux.setResponses([
      fauxAssistantMessage("FIRST"),
      fauxAssistantMessage("CUSTOM_FOLLOWUP"),
    ]);
    const first = await f.root.submit(
      { type: "input", content: "first" },
      context,
    );
    await atResponse;
    const next = await f.root.submit(
      {
        type: "input",
        entry: nativeInput("QUEUED_CUSTOM"),
        whenBusy: "followUp",
        requestId: "queued-custom",
      },
      context,
    );
    assert.equal((await next.status(context)).status, "queued");
    release();
    const [a, b] = await Promise.all([first.wait(context), next.wait(context)]);
    const rows = await entries(f.root);
    assert.equal(
      rows.find((row) => row.id === a.answer).model[0].content[0].text,
      "FIRST",
    );
    assert.equal(
      rows.find((row) => row.id === b.answer).model[0].content[0].text,
      "CUSTOM_FOLLOWUP",
    );
    assert.equal(
      rows.find((row) => row.id === b.entry).kind,
      "desk.native-message",
    );
    assert.equal(rows.filter((row) => row.kind === "pi.user").length, 1);
    assert.equal(
      rows.filter((row) => row.kind === "desk.native-message").length,
      1,
    );
  },
);
