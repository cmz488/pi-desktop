import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  Type,
} from "@earendil-works/pi-ai";
import {
  MemoryStorage,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";

async function fixture(t, backend) {
  const directory = await mkdtemp(join(tmpdir(), "pi-live-projection-"));
  const storage =
    backend === "sqlite"
      ? await openNodeSqliteStorage(join(directory, "agents.sqlite"))
      : new MemoryStorage();
  const scans = [];
  const scan = storage.scanEntries.bind(storage);
  storage.scanEntries = async (...args) => {
    const page = await scan(...args);
    scans.push({ query: args[0], count: page.items.length });
    return page;
  };
  const models = createModels();
  const faux = fauxProvider({
    provider: "live-test",
    models: [
      { id: "small", contextWindow: 32000 },
      { id: "large", contextWindow: 128000 },
    ],
  });
  models.setProvider(faux.provider);
  const workspace = await openAgentWorkspace({ storage, models });
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const create = () =>
    workspace.execute("create", {
      cwd: directory,
      name: "Live projection",
      model: { provider: "live-test", modelId: "small" },
    });
  const append = (id, content) =>
    workspace.persistNative(
      id,
      [],
      [
        {
          message: { role: "user", content, timestamp: 1 },
          triggerTurn: false,
        },
      ],
    );
  return { workspace, storage, scans, create, append, faux, directory };
}

for (const backend of ["memory", "sqlite"]) {
  test(`${backend}: repeated live reads do not rescan unchanged history`, async (t) => {
    const f = await fixture(t, backend);
    const { id } = await f.create();
    await f.workspace.persistNative(
      id,
      [],
      Array.from({ length: 450 }, (_, index) => ({
        message: {
          role: "user",
          content: `history ${index}`,
          timestamp: index,
        },
        triggerTurn: false,
      })),
    );
    const before = await f.workspace.live(id);
    f.scans.length = 0;
    for (let index = 0; index < 5; index++) {
      const live = await f.workspace.live(id);
      assert.deepEqual(live, before);
      assert.equal(live.messages, undefined);
    }
    assert.equal(
      f.scans.length,
      0,
      "unchanged live reads must use native documents and numeric context summaries, not history pages",
    );
    await f.append(id, "new input");
    const next = await f.workspace.live(id);
    assert.equal(next.entryCount, before.entryCount + 1);
    assert.notEqual(next.lastEntryId, before.lastEntryId);
    assert(next.contextUsage.tokens > before.contextUsage.tokens);
    f.scans.length = 0;
    await f.workspace.live(id);
    assert.equal(f.scans.length, 0);
  });

  test(`${backend}: full reads hydrate context once and keep live summaries current`, async (t) => {
    const f = await fixture(t, backend);
    const { id } = await f.create();
    await f.append(id, "initial");
    f.scans.length = 0;
    const active = (await f.workspace.read(id)).active;
    const returned = f.scans.reduce((sum, scan) => sum + scan.count, 0);
    assert.equal(
      returned,
      active.entryCount + 1,
      "one context read: one tail probe plus the active entries, not viewState plus context",
    );
    f.scans.length = 0;
    const live = await f.workspace.live(id);
    const { messages, ...withoutMessages } = active;
    assert(messages.length > 0);
    assert.deepEqual(live, withoutMessages);
    assert.equal(f.scans.length, 0);
    live.contextUsage.tokens = -1;
    assert((await f.workspace.live(id)).contextUsage.tokens >= 0);
  });

  test(`${backend}: native tool and inbox documents stay live without rereading history`, async (t) => {
    const f = await fixture(t, backend);
    const started = Promise.withResolvers();
    const resume = Promise.withResolvers();
    f.workspace.install(
      defineExtension({
        name: "live-pause",
        tools: [
          defineTool({
            name: "live_pause",
            description: "Pause a fixture tool until the test continues it",
            parameters: Type.Object({}),
            execute: async () => {
              started.resolve();
              await resume.promise;
              return { output: [{ type: "text", text: "released" }] };
            },
          }),
        ],
      }),
    );
    const { id } = await f.create();
    f.faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "pause-call",
            name: "live_pause",
            arguments: {},
          },
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("first answer"),
      fauxAssistantMessage("queued answer"),
    ]);
    await f.workspace.execute("send", {
      id,
      message: "pause",
      requestId: "pause",
    });
    try {
      await started.promise;
      const busy = await f.workspace.live(id);
      assert.equal(busy.idle, false);
      assert(busy.liveTools.some((call) => call.callId === "pause-call"));
      f.scans.length = 0;
      await f.workspace.execute("send", {
        id,
        message: "follow up",
        requestId: "follow-up",
      });
      const queued = await f.workspace.live(id);
      assert.equal(queued.queued.length, 1);
      assert.equal(queued.entryCount, busy.entryCount);
      assert.equal(
        f.scans.length,
        0,
        "inbox-only commits must not invalidate context facts",
      );
    } finally {
      resume.resolve();
      await f.workspace.execute("wait", { id });
    }
    const idle = await f.workspace.live(id);
    assert.equal(idle.idle, true);
    assert.equal(idle.queued.length, 0);
    assert(idle.usage.tokens > 0);
  });

  test(`${backend}: an in-flight context read cannot restore an invalidated summary`, async (t) => {
    const f = await fixture(t, backend);
    const { id } = await f.create();
    await f.append(id, "before");
    const started = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const scan = f.storage.scanEntries.bind(f.storage);
    let pause = true;
    f.storage.scanEntries = async (...args) => {
      const page = await scan(...args);
      // 原生 context 已固定 tail，范围读取在提交队列外；此时允许新条目提交。
      if (pause && args[0].maxEntryId !== undefined) {
        pause = false;
        started.resolve();
        await resume.promise;
      }
      return page;
    };
    const pending = f.workspace.live(id);
    try {
      await started.promise;
      await f.append(id, "during context read");
    } finally {
      resume.resolve();
    }
    const previous = await pending;
    const current = await f.workspace.live(id);
    assert.equal(current.entryCount, previous.entryCount + 1);
    assert.notEqual(current.lastEntryId, previous.lastEntryId);
    f.scans.length = 0;
    await f.workspace.live(id);
    assert.equal(f.scans.length, 0, "only the up-to-date summary is reusable");
  });

  test(`${backend}: model windows and conversation ownership stay isolated`, async (t) => {
    const f = await fixture(t, backend);
    const { id } = await f.create();
    const other = await f.create();
    await f.append(id, "first");
    await f.append(other.id, "other");
    const before = await f.workspace.live(id);
    await f.workspace.execute("configure", {
      id,
      model: { provider: "live-test", modelId: "large" },
    });
    const changed = await f.workspace.live(id);
    assert.equal(changed.contextUsage.contextWindow, 128000);
    assert.equal(changed.contextUsage.tokens, before.contextUsage.tokens);
    assert.equal(changed.contextUsage.percent, before.contextUsage.percent / 4);
    f.scans.length = 0;
    await f.append(other.id, "unrelated history");
    await f.workspace.live(id);
    assert.equal(
      f.scans.length,
      0,
      "another conversation must not invalidate this one",
    );
    await f.workspace.close();
    await assert.rejects(f.workspace.live(id), (error) => error.status === 409);
  });
}
