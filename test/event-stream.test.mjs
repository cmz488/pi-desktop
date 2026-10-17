import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createGzip, constants } from "node:zlib";
import { openSessionStream } from "../src/shared/connection.mjs";
const until = async (predicate) => {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Event stream condition timed out");
};
const hooks = () => {
  const events = [],
    errors = [];
  let opens = 0,
    activity = 0;
  return {
    events,
    errors,
    get opens() {
      return opens;
    },
    get activity() {
      return activity;
    },
    handlers: {
      open() {
        opens++;
      },
      activity() {
        activity++;
      },
      record(value) {
        events.push(value);
      },
      error(error) {
        errors.push(error);
      },
    },
  };
};
test("SSE transport observes comment heartbeats and parses UTF-8 split across CRLF and JSON frames", async (t) => {
  let source;
  const body = new ReadableStream({
    start(controller) {
      source = controller;
    },
  });
  const h = hooks();
  const stream = openSessionStream("/events", h.handlers, {
    fetcher: async () =>
      new Response(body, {
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      }),
  });
  t.after(() => stream.close());
  await until(() => h.opens === 1);
  const encoder = new TextEncoder();
  const text =
    ': heartbeat\r\n\r\ndata: {"epoch":"a",\r\ndata: "seq":2,"text":"中文"}\r\n\r\n';
  const bytes = encoder.encode(text);
  for (let n = 0; n < bytes.length; n++) source.enqueue(bytes.slice(n, n + 1));
  await until(() => h.events.length === 1);
  assert.deepEqual(h.events[0], { epoch: "a", seq: 2, text: "中文" });
  assert(h.activity > 1);
  assert.equal(h.errors.length, 0);
});
test("HTTP auth failures are exposed immediately and never reported as a successful stream", async () => {
  const h = hooks();
  openSessionStream("/events", h.handlers, {
    fetcher: async () => new Response('{"error":"expired"}', { status: 401 }),
  });
  await until(() => h.errors.length === 1);
  assert.equal(h.errors[0].status, 401);
  assert.equal(h.opens, 0);
});
test("intentional close cancels the reader without a reconnect error", async (t) => {
  let cancelled = 0;
  const h = hooks();
  const stream = openSessionStream("/events", h.handlers, {
    fetcher: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  t.after(() => stream.close());
  await until(() => h.opens === 1);
  stream.close();
  await until(() => cancelled === 1);
  assert.equal(h.errors.length, 0);
});
test("truncated, malformed and oversized frames never advance the client replay cursor", async (t) => {
  for (const text of [
    'data: {"seq":1}',
    "data: broken\n\n",
    `data: ${"x".repeat(300)}\n\n`,
  ]) {
    const h = hooks();
    const stream = openSessionStream("/events", h.handlers, {
      maxFrameChars: 200,
      fetcher: async () =>
        new Response(text, {
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    t.after(() => stream.close());
    await until(() => h.errors.length === 1);
    assert.equal(h.events.length, 0);
  }
});
test("existing gzip SSE flushes deliver heartbeats and events immediately over real HTTP", async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Content-Encoding": "gzip",
    });
    const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
    gzip.pipe(res);
    gzip.write(": connected\n\n");
    const timer = setTimeout(
      () => gzip.write('data: {"epoch":"a","seq":1}\n\n'),
      10,
    );
    res.once("close", () => {
      clearTimeout(timer);
      gzip.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const h = hooks();
  const stream = openSessionStream(
    `http://127.0.0.1:${server.address().port}/events`,
    h.handlers,
  );
  t.after(() => stream.close());
  await until(() => h.events.length === 1);
  assert(h.activity >= 2);
  assert.equal(h.events[0].seq, 1);
});
