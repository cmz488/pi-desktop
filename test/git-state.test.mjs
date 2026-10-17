import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeskBridge } from "../src/server/bridge.mjs";

test("Git write hints keep snapshots readable during native context handoff", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let bound = false,
    trustCalls = 0;
  const bridge = createDeskBridge({
    agentDir: root,
    port: 0,
    host: "127.0.0.1",
    snapshot: () => ({
      sessionId: "native",
      cwd: root,
      backend: { id: "stable" },
    }),
    canWrite: () => bound,
    capabilities: { canWrite: true, projectTrusted: true },
    projectTrusted: () => {
      trustCalls++;
      if (!bound) throw new Error("Native context unavailable during handoff");
      return true;
    },
  });
  t.after(() => bridge.stop());
  const url = new URL("/api/state", await bridge.start());
  let response = await fetch(url);
  assert.equal(
    response.status,
    200,
    "Read-only snapshots must not access unavailable mutation context",
  );
  let state = await response.json();
  assert.equal(state.backend.id, "stable");
  assert.equal(state.gitWritable, false);
  assert.equal(trustCalls, 0);
  bound = true;
  response = await fetch(url);
  state = await response.json();
  assert.equal(response.status, 200);
  assert.equal(state.gitWritable, true);
  assert.equal(trustCalls, 1);
});
