import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequestTarget } from "../src/server/target-guard.mjs";

test("request target keeps one identity across awaits", () => {
  let state = { sessionId: "A", cwd: "/project" };
  const target = createRequestTarget(() => state, { sessionId: "A" });
  assert.equal(target.assert().sessionId, "A");
  state = { sessionId: "B", cwd: "/project" };
  assert.throws(
    () => target.assert(),
    (error) => error.status === 409,
  );
});

test("request target can ignore cwd and enforce host handoff readiness", () => {
  let state = { sessionId: "A", cwd: "/one", initializing: true };
  const target = createRequestTarget(() => state, {});
  assert.equal(target.assert({ cwd: false }).sessionId, "A");
  assert.throws(() => target.assert({ ready: true }), /初始化/);
  state = { sessionId: "A", cwd: "/two", initializing: false };
  assert.throws(() => target.assert(), /当前会话/);
  assert.equal(target.assert({ cwd: false }).cwd, "/two");
});

test("request target delegates input validation and then reasserts identity", () => {
  const calls = [];
  const target = createRequestTarget(
    () => ({ sessionId: "A", cwd: "/project" }),
    { sessionId: "A", message: "hello" },
    (input) => calls.push(input.sessionId),
  );
  target.assertInput({ cwd: false });
  assert.deepEqual(calls, ["A"]);
});

test("request target rejects an explicit input session that is not the captured one", () => {
  assert.throws(
    () =>
      createRequestTarget(() => ({ sessionId: "A", cwd: "/project" }), {
        sessionId: "B",
      }),
    (error) => error.status === 409,
  );
});

test("request target can require an explicit session for write confirmations", () => {
  const target = createRequestTarget(
    () => ({ sessionId: "A", cwd: "/project" }),
    {},
  );
  assert.throws(
    () => target.assertInput({ requireSession: true }),
    (error) => error.status === 409,
  );
});
