import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMobileServer } from "../src/server/mobile.mjs";
import { until } from "./desktop-fixture.mjs";
import { readUntil } from "./sse-reader.mjs";
import { perchoConsumers } from "./percho-fixture.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "pi-mobile-stream-"));
  let entries = [],
    live = { idle: true },
    changed;
  const server = await startMobileServer({
    directory,
    pageHtml: "<html></html>",
    tls: false,
    workspace: {
      read: async () => ({
        agents: [{ id: 1, name: "session", cwd: "/private/path" }],
      }),
      transcript: async () => ({ entries }),
      live: async () => live,
      execute: async () => {},
      subscribe: (listener) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    },
  });
  const controllers = [];
  t.after(async () => {
    controllers.forEach((c) => c.abort());
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    server,
    update(next, running = { idle: true }) {
      entries = next;
      live = running;
      changed?.();
    },
    async connect() {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/stream?t=${server.token}`,
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(8000),
          ]),
        },
      );
      return { response, controller };
    },
  };
}

test(
  "手机保持同一 SSE 连接即可收到外部 partial 与最终回复",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const { response } = await f.connect();
    const reader = response.body.getReader();
    await readUntil(reader, "event: list");
    f.update([], { idle: false, partial: { id: "p", text: "LIVE_PARTIAL" } });
    const partialWire = await readUntil(reader, "LIVE_PARTIAL");
    assert(partialWire.includes("event: snapshot"));
    f.update([
      {
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: "FINAL_REPLY" }],
          },
        ],
      },
    ]);
    const wire = await readUntil(reader, "FINAL_REPLY");
    const frame = wire
      .split("\n\n")
      .find((frame) => frame.includes("FINAL_REPLY"));
    const data = JSON.parse(
      frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        .slice(6),
    );
    const consumer = await perchoConsumers();
    const state = consumer.applyFrame(consumer.initialLanState, {
      event: "snapshot",
      data,
    });
    assert.equal(state.transcripts["1"].agentActive, false);
    assert.doesNotThrow(() =>
      consumer.buildChatRows(state.transcripts["1"], "1"),
    );
    assert.equal(data.list[0].cwd, "");
    assert.equal(data.views[0].cwd, "");
  },
);

test(
  "真实 SSE 连接只释放一次名额，达到上限后拒绝，保持连接也能停机",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      clients = [];
    for (let i = 0; i < 5; i++) {
      const client = await f.connect();
      clients.push(client);
      assert.equal(client.response.status, 200);
      await client.response.body.getReader().read();
    }
    assert.equal(f.server.capacity.clients, 5);
    const rejected = await f.connect();
    assert.equal(rejected.response.status, 503);
    clients[0].controller.abort();
    await until(
      async () => f.server.capacity.clients,
      (count) => count === 4,
      1000,
    );
    assert.equal((await f.connect()).response.status, 200);
    assert.equal((await f.connect()).response.status, 503);
    const stopped = f.server.stop();
    await Promise.race([
      stopped,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("stop 被 SSE 长连接阻塞")),
          1000,
        );
        timer.unref();
      }),
    ]);
    assert.equal(f.server.capacity.clients, 0);
  },
);
