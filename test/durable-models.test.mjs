import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { createProvider, lazyApi } from "@earendil-works/pi-ai";

test("catalog credential views expire before delayed descendant authentication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-view-lifetime-"));
  const release = Promise.withResolvers();
  t.after(async () => {
    release.resolve();
    await rm(root, { recursive: true, force: true });
  });
  const agentDir = join(root, "agent"),
    directory = join(root, "desk");
  await mkdir(agentDir);
  await mkdir(directory);
  const id = "fixture-descendant",
    authPath = join(directory, "auth.json");
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [id]: {
          api: "openai-completions",
          baseUrl: "https://fixture.invalid/v1",
          models: [{ id: "model" }],
        },
      },
    }),
  );
  await writeFile(
    authPath,
    JSON.stringify({ [id]: { type: "api_key", key: "fixture-old" } }),
  );
  const app = await openDurableModels({ agentDir, directory });
  let delayed;
  app.models.setProvider(
    createProvider({
      id,
      name: id,
      models: app.models.getProvider(id).getModels(),
      api: lazyApi(
        () => import("@earendil-works/pi-ai/api/openai-completions"),
      ),
      auth: {
        apiKey: {
          resolve: async ({ credential }) => {
            // 真实 SDK auth resolver 内创建回调，保留枚举的异步上下文，再在枚举结束后执行。
            delayed ??= release.promise.then(() => app.models.getAuth(id));
            return credential
              ? { auth: { apiKey: credential.key }, source: "fixture" }
              : undefined;
          },
        },
      },
    }),
  );
  await app.availableModels();
  assert.ok(delayed, "必须在真实目录枚举中建立延迟读取");
  await writeFile(
    authPath,
    JSON.stringify({ [id]: { type: "api_key", key: "fixture-new" } }),
  );
  release.resolve();
  assert.equal(
    (await delayed).auth.apiKey,
    "fixture-new",
    "目录操作完成后，继承其异步上下文的实际认证也必须重新读取凭据",
  );
});

test("model catalogs read one credential view per operation but request auth stays fresh", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"),
    directory = join(root, "desk");
  await mkdir(agentDir);
  await mkdir(directory);
  const provider = "fixture-catalog";
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [provider]: {
          api: "openai-completions",
          baseUrl: "https://fixture.invalid/v1",
          models: [{ id: "fixture-model" }],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      [provider]: { type: "api_key", key: "fixture-inherited" },
    }),
  );
  const authPath = join(directory, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({ [provider]: { type: "api_key", key: "fixture-first" } }),
  );
  const app = await openDurableModels({ agentDir, directory });
  const original = fs.readFile;
  let reads = 0;
  fs.readFile = (path, ...options) => {
    if (String(path).startsWith(root) && String(path).endsWith("/auth.json"))
      reads++;
    return original(path, ...options);
  };
  syncBuiltinESMExports();
  try {
    const view = await app.desktopInventory();
    assert.equal(
      view.rows.find((row) => row.id === provider)?.models[0].available,
      true,
    );
    assert.equal(reads, 2, "每次目录枚举只读一次宿主和继承认证文件");
    await writeFile(
      authPath,
      JSON.stringify({
        [provider]: { type: "api_key", key: "fixture-replaced" },
      }),
    );
    assert.equal(
      (await app.models.getAuth(provider)).auth.apiKey,
      "fixture-replaced",
      "模型请求不能沿用目录枚举的认证快照",
    );
    await writeFile(authPath, JSON.stringify({ [provider]: null }));
    reads = 0;
    const revoked = await app.desktopInventory();
    assert.equal(
      revoked.rows.find((row) => row.id === provider)?.models[0].available,
      false,
      "下一次枚举立即读取注销覆盖，不能退回继承凭据",
    );
    assert.equal(reads, 2);
    assert.equal(await app.models.getAuth(provider), undefined);

    await writeFile(
      authPath,
      JSON.stringify({
        [provider]: { type: "api_key", key: "fixture-scoped" },
      }),
    );
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    let hold = true;
    app.models.setProvider(
      createProvider({
        id: provider,
        name: provider,
        baseUrl: "https://fixture.invalid/v1",
        models: app.models.getProvider(provider).getModels(),
        api: lazyApi(
          () => import("@earendil-works/pi-ai/api/openai-completions"),
        ),
        auth: {
          apiKey: {
            resolve: async ({ credential }) => {
              if (hold) {
                hold = false;
                entered.resolve();
                await release.promise;
                await app
                  .resourceOptions()
                  .credentials.modify(provider, (current) => {
                    assert.equal(
                      current.key,
                      "fixture-modified",
                      "目录回调内的凭据写操作也不能采用旧视图",
                    );
                    return current;
                  });
              }
              return credential
                ? { auth: { apiKey: credential.key }, source: "fixture" }
                : undefined;
            },
          },
        },
      }),
    );
    const listing = app.availableModels();
    await entered.promise;
    try {
      await writeFile(
        authPath,
        JSON.stringify({
          [provider]: { type: "api_key", key: "fixture-concurrent" },
        }),
      );
      assert.equal(
        (await app.models.getAuth(provider)).auth.apiKey,
        "fixture-concurrent",
        "目录读取未结束时，并发请求也不能借用它的凭据视图",
      );
      await app.resourceOptions().credentials.modify(provider, (old) => {
        assert.equal(old.key, "fixture-concurrent", "凭据修改必须读取当前值");
        return { ...old, key: "fixture-modified" };
      });
      assert.equal(
        (await app.models.getAuth(provider)).auth.apiKey,
        "fixture-modified",
      );
    } finally {
      release.resolve();
      await listing;
    }
  } finally {
    fs.readFile = original;
    syncBuiltinESMExports();
  }
});

test("embedded models reuse Pi custom providers without exposing secrets or writing inherited configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-durable-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"),
    directory = join(root, "desk");
  await mkdir(agentDir);
  const inherited = JSON.stringify({
    providers: {
      local: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8/v1",
        apiKey: "never-return-this",
        models: [{ id: "model", reasoning: true }],
      },
    },
  });
  await writeFile(join(agentDir, "models.json"), inherited);
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      openai: { type: "api_key", key: "private-inherited-key" },
    }),
  );
  const app = await openDurableModels({ agentDir, directory });
  const list = await app.inventory();
  assert(!JSON.stringify(list).includes("never-return-this"));
  assert(
    (await app.models.getAvailable()).some(
      (row) => row.provider === "local" && row.id === "model",
    ),
  );
  assert(
    (await app.models.getAuth("openai")).auth.apiKey ===
      "private-inherited-key",
  );
  await app.save({
    id: "local",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    modelId: "new-model",
    apiKey: "new-private-key",
    revision: list.revision,
  });
  assert.equal(
    await readFile(join(agentDir, "models.json"), "utf8"),
    inherited,
  );
  assert.equal(
    (await app.models.getAuth("local")).auth.apiKey,
    "new-private-key",
  );
  assert(!JSON.stringify(await app.inventory()).includes("new-private-key"));
  await assert.rejects(app.save({ id: "x", revision: list.revision }), /变化/);
  await assert.rejects(
    app.save({
      id: "x",
      api: "openai-completions",
      baseUrl: "http://user:password@example.invalid",
      modelId: "x",
      revision: (await app.inventory()).revision,
    }),
    /端点/,
  );
});
