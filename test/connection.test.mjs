import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionConnection } from "../src/shared/connection.mjs";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail("Connection condition timed out");
}
function fixture(readSnapshot, { autoOpen = true, ...options } = {}) {
  const streams = [],
    snapshots = [],
    events = [],
    statuses = [];
  const connection = createSessionConnection({
    readSnapshot,
    applySnapshot: (snapshot) => snapshots.push(snapshot),
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    retryDelays: [5, 10],
    random: () => 0.5,
    ...options,
    openStream(cursor, handlers) {
      const stream = {
        cursor,
        handlers,
        closes: 0,
        close() {
          this.closes++;
        },
      };
      streams.push(stream);
      if (autoOpen) queueMicrotask(() => handlers.open());
      return stream;
    },
  });
  return { connection, streams, snapshots, events, statuses };
}
test("continuous state events refresh the page during streaming instead of postponing it until the turn ends", async (t) => {
  let seq = 0;
  const f = fixture(async () => ({ epoch: "a", seq }));
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  const interval = setInterval(
    () =>
      f.streams[0].handlers.record({
        kind: "state_changed",
        epoch: "a",
        seq: ++seq,
      }),
    20,
  );
  t.after(() => clearInterval(interval));
  await until(() => f.snapshots.length >= 3);
  assert.equal(f.streams.length, 1);
});
test("routine snapshots keep one healthy event stream and failed startup retries until online", async (t) => {
  let attempts = 0;
  const f = fixture(async () => {
    if (++attempts < 3) throw new Error("network");
    return { epoch: "a", seq: 1 };
  });
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  await until(() => f.statuses.includes("connected"));
  assert.equal(attempts, 3);
  await f.connection.refresh();
  assert.equal(f.streams.length, 1);
  assert.equal(f.streams[0].closes, 0);
});
test("deltas newer than an in-flight snapshot survive refresh, and epoch changes rebuild the stream", async (t) => {
  let next = { epoch: "a", seq: 1 },
    resolve;
  const f = fixture(() =>
    resolve
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve(next),
  );
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  resolve = true;
  const pending = f.connection.refresh();
  f.streams[0].handlers.record({
    kind: "assistant_update",
    epoch: "a",
    seq: 3,
    data: { text: "latest" },
  });
  resolve({ epoch: "a", seq: 2 });
  resolve = undefined;
  await pending;
  assert.equal(f.events[0].data.text, "latest");
  assert.equal(f.streams.length, 1);
  next = { epoch: "b", seq: 0 };
  await f.connection.refresh();
  assert.equal(f.streams[0].closes, 1);
  assert.equal(f.streams[1].cursor.epoch, "b");
});
test("disconnect retries failed snapshots, resumes from the cursor and ignores stale stream errors", async (t) => {
  let fail = false;
  const f = fixture(async () => {
    if (fail) throw new Error("offline");
    return { epoch: "a", seq: 1 };
  });
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  fail = true;
  f.streams[0].handlers.error();
  await sleep(25);
  fail = false;
  await until(() => f.streams.length === 2);
  f.streams[0].handlers.error();
  assert.equal(f.streams[1].closes, 0);
  f.connection.pause();
  assert.equal(f.streams[1].closes, 1);
  await f.connection.resume();
  assert.equal(f.streams.length, 3);
});

test("returning to the foreground replaces a stalled snapshot instead of waiting for its old timeout", async (t) => {
  let reads = 0,
    release;
  const f = fixture(() =>
    ++reads === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve({ epoch: "a", seq: 2 }),
  );
  t.after(() => {
    f.connection.stop();
    release?.({ epoch: "old", seq: 0 });
  });
  void f.connection.refresh();
  f.connection.pause();
  void f.connection.resume();
  await sleep(10);
  assert.equal(
    reads,
    2,
    "the foreground reconnect must not be held behind the suspended request",
  );
  await until(() => f.statuses.includes("connected"));
  release({ epoch: "old", seq: 0 });
  await sleep(5);
  assert.equal(
    f.snapshots.length,
    1,
    "late results from the old network must not overwrite the foreground snapshot",
  );
  assert.equal(f.snapshots[0].epoch, "a");
});

const flush = async () => {
  for (let n = 0; n < 6; n++) await Promise.resolve();
};
test("stream interruption reconnects the replay cursor without waiting for another snapshot", async (t) => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    return { epoch: "a", seq: 1 };
  });
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  f.streams[0].handlers.record({
    epoch: "a",
    seq: 3,
    kind: "text_delta",
    data: "before",
  });
  f.streams[0].handlers.error(new Error("connection reset"));
  await until(() => f.streams.length === 2);
  assert.equal(reads, 1);
  assert.equal(f.streams[1].cursor.after, 3);
  f.streams[1].handlers.record({
    epoch: "a",
    seq: 4,
    kind: "text_delta",
    data: "after",
  });
  assert.deepEqual(
    f.events.map((row) => row.data),
    ["before", "after"],
  );
});
test("foreground recovery aborts the old fetch and ignores its late failure", async (t) => {
  let reads = 0,
    oldSignal,
    rejectOld;
  const f = fixture(({ signal }) => {
    if (++reads > 1) return Promise.resolve({ epoch: "a", seq: 2 });
    oldSignal = signal;
    return new Promise((_, reject) => {
      rejectOld = reject;
    });
  });
  t.after(() => f.connection.stop());
  const old = f.connection.refresh();
  f.connection.pause();
  await f.connection.resume();
  assert(oldSignal.aborted);
  rejectOld(new Error("old mobile network"));
  await old;
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.streams.at(-1).closes, 0);
});
test("snapshot timeout is bounded even when a transport ignores cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0,
    signal;
  const f = fixture(
    ({ signal: next }) => {
      signal = next;
      return ++reads === 1
        ? new Promise(() => {})
        : Promise.resolve({ epoch: "a", seq: 1 });
    },
    { snapshotTimeoutMs: 20 },
  );
  t.after(() => f.connection.stop());
  const stalled = f.connection.refresh();
  t.mock.timers.tick(20);
  await stalled;
  assert(signal.aborted);
  t.mock.timers.tick(5);
  await flush();
  assert.equal(reads, 2);
  assert.equal(f.statuses.at(-1), "connected");
});
test("stalled handshakes and silent streams recover while heartbeat activity keeps healthy streams alive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(async () => ({ epoch: "a", seq: 1 }), {
    autoOpen: false,
    connectTimeoutMs: 20,
    heartbeatTimeoutMs: 30,
  });
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  t.mock.timers.tick(20);
  assert.equal(f.streams[0].closes, 1);
  t.mock.timers.tick(5);
  assert.equal(f.streams.length, 2);
  f.streams[1].handlers.open();
  t.mock.timers.tick(25);
  f.streams[1].handlers.activity();
  t.mock.timers.tick(25);
  assert.equal(f.streams[1].closes, 0);
  t.mock.timers.tick(5);
  assert.equal(f.streams[1].closes, 1);
  t.mock.timers.tick(10);
  assert.equal(f.streams.length, 3);
});
test("mobile transport loss uses a short first reconnect delay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(async () => ({ epoch: "a", seq: 1 }), {
    autoOpen: false,
    retryDelays: undefined,
    random: () => 0,
  });
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  f.streams[0].handlers.error(new Error("mobile network changed"));
  t.mock.timers.tick(152);
  assert.equal(f.streams.length, 1);
  t.mock.timers.tick(1);
  assert.equal(f.streams.length, 2);
  assert.equal(f.streams[1].cursor.after, 1);
});
test("a failed snapshot keeps a healthy stream and delivers deltas buffered during that request", async (t) => {
  let reject;
  const f = fixture(() =>
    reject
      ? new Promise((_, no) => {
          reject = no;
        })
      : Promise.resolve({ epoch: "a", seq: 1 }),
  );
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  reject = true;
  const pending = f.connection.refresh();
  f.streams[0].handlers.record({
    epoch: "a",
    seq: 2,
    kind: "text_delta",
    data: "live",
  });
  reject(new Error("snapshot network reset"));
  await pending;
  assert.equal(f.streams[0].closes, 0);
  assert.equal(f.events[0].data, "live");
  assert.equal(f.statuses.at(-1), "connected");
});
test("expired authorization stops automatic retries instead of endlessly displaying reconnecting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    throw Object.assign(new Error("expired"), { status: 401 });
  });
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(reads, 1);
  assert.equal(f.statuses.at(-1), "unauthorized");
});
test("snapshot failure cannot rewind an already rendered replay cursor", async (t) => {
  let seq = 1;
  const f = fixture(async () => ({ epoch: "a", seq }));
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  f.streams[0].handlers.record({
    epoch: "a",
    seq: 3,
    kind: "text_delta",
    data: "newest",
  });
  assert.equal(await f.connection.refresh(), false);
  assert.equal(f.snapshots.length, 1);
  seq = 4;
  await f.connection.refresh();
  assert.equal(f.snapshots.at(-1).seq, 4);
});
test("buffer gaps and host epoch changes use a full resync and then resume replay", async (t) => {
  let epoch = "a";
  const f = fixture(async () => ({ epoch, seq: 0 }));
  t.after(() => f.connection.stop());
  await f.connection.refresh();
  epoch = "b";
  f.streams[0].handlers.record({ kind: "resync_required", epoch: "b", seq: 0 });
  await until(() => f.snapshots.length === 2);
  assert.equal(f.streams[1].cursor.epoch, "b");
  assert.equal(f.streams[0].closes, 1);
});
