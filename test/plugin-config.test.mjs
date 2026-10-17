import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverPluginConfig,
  pluginConfigDocument,
  savePluginConfig,
} from "../src/resources/plugin-config.mjs";
import { readDocument } from "../src/config/config-store.mjs";
test("declared plugin config forms redact secrets and preserve unknown nested fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const row = { name: "sample", type: "file", source: join(root, "index.ts") };
  await writeFile(
    join(root, "pi-web.config.json"),
    JSON.stringify({
      file: "config.json",
      fields: [
        { key: "notifications.enabled", type: "boolean", default: true },
        { key: "token", type: "string", secret: true },
      ],
    }),
  );
  await writeFile(
    join(root, "config.json"),
    JSON.stringify({
      notifications: { enabled: true, style: "preserve" },
      token: "private-fixture",
      unknown: { keep: true },
    }),
  );
  const adapter = await discoverPluginConfig(row, root);
  const doc = await pluginConfigDocument(adapter);
  assert.equal(doc.data.token.configured, true);
  assert(!JSON.stringify(doc).includes("private-fixture"));
  await savePluginConfig(adapter, {
    revision: doc.revision,
    patch: { "notifications.enabled": false, token: "" },
  });
  const data = (await readDocument(join(root, "config.json"))).data;
  assert.equal(data.notifications.enabled, false);
  assert.equal(data.notifications.style, "preserve");
  assert.equal(data.token, "private-fixture");
  assert.deepEqual(data.unknown, { keep: true });
  await assert.rejects(
    savePluginConfig(adapter, {
      revision: doc.revision,
      patch: { token: "new" },
    }),
    /配置已被/,
  );
});
test("plugin schema cannot traverse paths or follow symlinks into another directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-schema-")),
    outside = await mkdtemp(join(tmpdir(), "pi-web-private-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(
    join(outside, "auth.json"),
    JSON.stringify({ key: "outside-fixture" }),
  );
  const row = { name: "sample", type: "file", source: join(root, "index.ts") };
  for (const file of ["../auth.json", "config.json"]) {
    if (file === "config.json")
      await symlink(join(outside, "auth.json"), join(root, "config.json"));
    await writeFile(
      join(root, "pi-web.config.json"),
      JSON.stringify({ file, fields: [{ key: "key", type: "string" }] }),
    );
    assert.equal(await discoverPluginConfig(row, root), null);
  }
});
