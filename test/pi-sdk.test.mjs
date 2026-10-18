import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolvePiSdk,
  checkPiSdk,
  piSdk,
  loadEmbeddedPiSdk,
  scopedMcpCredentials,
} from "../src/agent/pi-sdk.mjs";

await loadEmbeddedPiSdk();

test("SDK resolver follows the installed Pi package entry across an upgrade instead of using the local peer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-sdk-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"), { recursive: true });
  const cli = join(root, "dist", "cli.js");
  await writeFile(cli, "// native Pi executable");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.99.2",
      type: "module",
      exports: { ".": { import: "./dist/public-v1.mjs" } },
    }),
  );
  await writeFile(
    join(root, "dist", "public-v1.mjs"),
    "export const VERSION='0.99.2';",
  );
  assert.equal(
    await resolvePiSdk(cli),
    pathToFileURL(join(root, "dist", "public-v1.mjs")).href,
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.100.1",
      type: "module",
      exports: { ".": { import: "./dist/public-v2.mjs" } },
    }),
  );
  await writeFile(
    join(root, "dist", "public-v2.mjs"),
    "export const VERSION='0.100.1';",
  );
  const entry = await resolvePiSdk(cli);
  assert.equal((await import(entry)).VERSION, "0.100.1");
  assert.equal(checkPiSdk(piSdk), piSdk);
  assert.throws(
    () => checkPiSdk({ ...piSdk, createAgentSessionRuntime: undefined }),
    /createAgentSessionRuntime/,
  );
});

test("custom agent directories use the native MCP credential store inside that directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-mcp-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await scopedMcpCredentials(root),
    url = "https://example.invalid/mcp";
  const state = {
    tokens: { access_token: "fixture-only", token_type: "Bearer" },
  };
  // Pi 1.0 keys accounts by server name + URL; older SDKs key by URL alone.
  const args =
    Number(piSdk.VERSION.split(".")[0]) >= 1 ? ["fixture", url] : [url];
  store.forServer(...args).save(state);
  assert.deepEqual(store.tokens(...args), state.tokens);
  assert.deepEqual(store.forServer(...args).load(), state);
  assert.equal(store.remove(...args), true);
  assert.equal(store.tokens(...args), undefined);
});
