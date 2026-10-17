import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostInterface } from "../src/server/host-interface.mjs";

const base = {
  agentDir: "/agent",
  snapshot: () => ({ sessionId: "A", cwd: "/project" }),
  capabilities: {},
};

test("Host interface declares capabilities once instead of probing option keys", () => {
  const host = createHostInterface({
    ...base,
    packageAction: async () => ({}),
    listSessions: async () => [],
    capabilities: { packageManagement: true, sessions: true },
  });
  assert.equal(host.capabilities.packageManagement, true);
  assert.equal(host.capabilities.sessions, true);
  assert.equal(host.supports("packageManagement"), true);
  assert.equal(host.supports("mcp"), false);
  assert.deepEqual(host.transport, {
    agentDir: "/agent",
    modelsPath: undefined,
    host: undefined,
    port: undefined,
    certPath: undefined,
    keyPath: undefined,
    autoPort: undefined,
    embeddedUI: undefined,
    funnel: undefined,
    filePicker: undefined,
    catalogFetch: undefined,
    lanAddresses: undefined,
  });
});

test("Host interface exposes one target-token helper and explicit unsupported errors", () => {
  const host = createHostInterface(base);
  const target = host.target({ sessionId: "A" });
  assert.equal(target.sessionId, "A");
  assert.throws(
    () => host.require("packageAction", "没有包管理"),
    (error) => error.status === 501 && /包管理/.test(error.message),
  );
  assert.throws(
    () => host.require("listSessions", "x"),
    (error) => error.status === 501,
  );
});

test("Host interface rejects an adapter without a snapshot", () => {
  assert.throws(() => createHostInterface({ agentDir: "/agent" }), /snapshot/);
});

test("callbacks alone do not advertise capabilities", () => {
  const host = createHostInterface({
    ...base,
    packageAction: async () => ({}),
    listSessions: async () => [],
  });
  assert.equal(host.capabilities.packageManagement, false);
  assert.equal(host.capabilities.sessions, false);
});
