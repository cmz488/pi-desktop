import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionInventories } from "../src/shared/session-inventories.mjs";
test("cached listings reconcile external changes on later activity without reading per token", async () => {
  let time = 0,
    version = "old",
    calls = 0;
  const values = [];
  const inventories = createSessionInventories({
    now: () => time,
    load: async () => {
      calls++;
      return { version };
    },
    apply: (_kind, value) => values.push(value.version),
  });
  const snapshot = { sessionId: "a" };
  await inventories.refresh(snapshot);
  version = "external update";
  for (let i = 0; i < 100; i++) await inventories.refresh(snapshot);
  assert.equal(calls, 2);
  time = 30001;
  await inventories.refresh(snapshot);
  assert.deepEqual(values, [
    "old",
    "old",
    "external update",
    "external update",
  ]);
});
test("resource refreshes coalesce, retain unchanged listings and discard old Agent results", async () => {
  const pending = [],
    applied = [];
  const inventories = createSessionInventories({
    load: (kind, owner) =>
      new Promise((resolve) => pending.push({ kind, owner, resolve })),
    apply: (...args) => applied.push(args),
  });
  const a = { sessionId: "a", cwd: "/a" };
  const first = inventories.refresh(a);
  inventories.refresh(a);
  await Promise.resolve();
  assert.equal(pending.length, 2);
  const second = inventories.refresh({ sessionId: "b", cwd: "/b" });
  await Promise.resolve();
  pending.forEach((item) => item.resolve({ rows: [item.owner] }));
  await Promise.all([first, second]);
  assert.equal(applied.length, 2);
  assert(applied.every((item) => item[2] === "b"));
  await inventories.refresh({ sessionId: "b", cwd: "/b" });
  assert.equal(pending.length, 4);
});
test("slow or failed listings do not delay other resources or report a chat disconnection", async () => {
  let release;
  const applied = [],
    errors = [];
  const inventories = createSessionInventories({
    load: (kind) =>
      kind === "plugins"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ rows: [] }),
    apply: (kind) => applied.push(kind),
    onError: (kind) => errors.push(kind),
  });
  const job = inventories.refresh({ sessionId: "a" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(applied, ["providers"]);
  release({ rows: [] });
  await job;
  assert.deepEqual(errors, []);
  const failed = createSessionInventories({
    load: (kind) =>
      kind === "plugins"
        ? Promise.reject(new Error("offline listing"))
        : Promise.resolve({ rows: [] }),
    apply: () => {},
    onError: (kind) => errors.push(kind),
  });
  await failed.refresh({ sessionId: "a" });
  assert.deepEqual(errors, ["plugins"]);
});
