import { test } from "node:test";
import assert from "node:assert/strict";

// The coding SDK is one large module graph, and a host that never needs its
// namespace must not pay for it. This file is isolated so nothing else loads it
// first; the assertions cover the lazy-binding contract itself.
test("Pi SDK bindings stay lazy, memoized and loud before loading", async () => {
  const sdk = await import("../src/agent/pi-sdk.mjs");

  // Before any load the namespace is a live binding: nested access fails with
  // an actionable message instead of "is not a function".
  assert.throws(
    () => sdk.embeddedPiSdk.SettingsManager.create(),
    /Pi SDK 尚未加载/,
  );
  assert.throws(() => new sdk.embeddedPiSdk.Theme(), /Pi SDK 尚未加载/);

  const loading = sdk.loadEmbeddedPiSdk();
  assert.equal(sdk.loadEmbeddedPiSdk(), loading, "the load is memoized");
  const namespace = await loading;
  assert.equal(typeof namespace.SettingsManager.create, "function");
  assert.equal(typeof sdk.embeddedPiSdk.SettingsManager.create, "function");
  assert.equal(sdk.embeddedPiSdk.VERSION, namespace.VERSION);
});

test("startup-critical submodules load on their own", async () => {
  const sdk = await import("../src/agent/pi-sdk.mjs");
  const settings = await sdk.loadPiSettingsManager();
  const sessions = await sdk.loadPiSessionManager();
  const messages = await sdk.loadPiMessages();
  assert.equal(typeof settings.SettingsManager.create, "function");
  assert.equal(typeof sessions.SessionManager.inMemory, "function");
  assert.equal(typeof sessions.parseSessionEntries, "function");
  assert.equal(typeof messages.convertToLlm, "function");
  assert.equal(sdk.loadPiMessages(), sdk.loadPiMessages());
});
