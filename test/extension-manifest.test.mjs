import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { piSdk, loadEmbeddedPiSdk } from "../src/agent/pi-sdk.mjs";

await loadEmbeddedPiSdk();

test("extension manifest delegates host packages to Pi while retaining standalone development SDKs", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.scripts.start, "node launch-desktop.mjs");
  assert.equal(manifest.bin["pi-desktop"], "./launch-desktop.mjs");
  assert.equal(manifest.bin["pi-desk"], "./launch-desktop.mjs");
  assert.equal(manifest.bin["pi-web"], "./pi-command.mjs");
  assert(manifest.files.includes("src/**"));
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
  ]) {
    assert.equal(
      manifest.dependencies?.[name],
      undefined,
      `${name} must not install a second extension runtime`,
    );
    assert.equal(manifest.peerDependencies?.[name], "*");
    assert(
      manifest.devDependencies?.[name],
      "standalone Desktop development must retain its SDK",
    );
  }
});

test("installed extension loads in the native Pi resource loader without duplicate-runtime warnings", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-peer-check-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const resources = new piSdk.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: piSdk.SettingsManager.inMemory({
      packages: [fileURLToPath(new URL("../", import.meta.url))],
    }),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resources.reload();
  const loaded = resources.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert(loaded.extensions.some((extension) => extension.commands.has("desk")));
  assert(
    !(loaded.warnings ?? []).some((warning) =>
      warning.warning.includes("Host-provided extension packages"),
    ),
  );
});
