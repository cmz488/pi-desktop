import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readDocument,
  mutateDocument,
  patchProvider,
} from "../src/config/config-store.mjs";

test("provider patch keeps hidden credentials, compatibility flags and model metadata", () => {
  const initial = {
    unrelated: 9,
    providers: {
      demo: {
        apiKey: "fixture-secret",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        compat: { supportsStore: false },
        models: [{ id: "model", contextWindow: 64000 }],
      },
    },
  };
  const next = patchProvider(structuredClone(initial), {
    id: "demo",
    baseUrl: "https://example.net/v1",
    api: "openai-responses",
    apiKey: "",
    modelId: "",
  });
  assert.equal(next.providers.demo.apiKey, "fixture-secret");
  assert.deepEqual(next.providers.demo.models, initial.providers.demo.models);
  assert.deepEqual(next.providers.demo.compat, initial.providers.demo.compat);
  assert.equal(next.unrelated, 9);
});
test("revision conflict refuses a stale editor and leaves the latest configuration intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-desk-config-"));
  try {
    const path = join(dir, "settings.json");
    await writeFile(
      path,
      JSON.stringify({ preference: "original", packages: [] }),
    );
    const first = await readDocument(path);
    await writeFile(
      path,
      JSON.stringify({ preference: "external", packages: [] }),
    );
    await assert.rejects(
      mutateDocument(path, first.revision, (data) => ({
        ...data,
        packages: ["new"],
      })),
      (error) => error.status === 409,
    );
    assert.equal((await readDocument(path)).data.preference, "external");
    const current = await readDocument(path);
    await mutateDocument(path, current.revision, (data) => ({
      ...data,
      packages: ["new"],
    }));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      preference: "external",
      packages: ["new"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("service input cannot introduce credential commands or non-HTTP endpoints", () => {
  const input = {
    id: "demo",
    baseUrl: "https://example.com",
    api: "openai-completions",
    modelId: "model",
  };
  assert.throws(() => patchProvider({}, { ...input, apiKey: "!printenv" }));
  assert.throws(() =>
    patchProvider({}, { ...input, baseUrl: "file:///etc/passwd" }),
  );
  assert.throws(() =>
    patchProvider({}, { ...input, baseUrl: "https://secret@example.com" }),
  );
});
