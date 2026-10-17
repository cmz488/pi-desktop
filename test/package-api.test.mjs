import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeskBridge } from "../src/server/bridge.mjs";
import { createPackageManagement } from "../src/resources/package-management.mjs";

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-package-api-"));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project"),
    packageRoot = join(root, "installed");
  await Promise.all([mkdir(agentDir), mkdir(cwd), mkdir(packageRoot)]);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:fixture-extensions"] }),
  );
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "fixture-extensions", version: "1.0.0" }),
  );
  let selected = "A",
    directory = cwd,
    idle = true;
  const bridge = createDeskBridge({
    agentDir,
    port: 0,
    host: "127.0.0.1",
    snapshot: () => ({ sessionId: selected, cwd: directory, models: [], idle }),
    canWrite: () => idle,
    projectTrusted: () => true,
    packageRoot: () => packageRoot,
    ...extra,
  });
  const origin = new URL(await bridge.start()).origin;
  t.after(async () => {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  });
  const request = (path, input) =>
    fetch(
      origin + path,
      input === undefined
        ? {}
        : {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify(input),
          },
    );
  return {
    request,
    root,
    agentDir,
    packageRoot,
    cwd,
    select: (id) => {
      selected = id;
    },
    setCwd: (path) => {
      directory = path;
    },
    setIdle: (value) => {
      idle = value;
    },
  };
}

test("package operations exclude concurrent writes from validation through native completion and release failed locks", async (t) => {
  const f = await fixture(t);
  let writes = 0,
    changed = 0,
    release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const management = createPackageManagement({
    agentDir: f.agentDir,
    snapshot: () => ({ sessionId: "A", cwd: f.cwd, host: "durable" }),
    canWrite: () => true,
    hasChanged: () => false,
    pending: () => false,
    onWrite: () => changed++,
    packageAction: async () => {
      writes++;
      await held;
    },
  });
  const input = {
    sessionId: "A",
    scope: "global",
    source: "npm:fixture-extensions",
  };
  const first = management.execute("update", input);
  await assert.rejects(
    management.execute("remove", input),
    (error) => error.status === 409,
  );
  release();
  await first;
  assert.equal(writes, 1);
  assert.equal(changed, 1);
  await assert.rejects(
    management.execute("install", { ...input, source: "bad\nsource" }),
    (error) => error.status === 422,
  );
  await management.execute("update", input);
  assert.equal(writes, 2);
});

test("shared bridge advertises official catalog and forwards only its fixed-origin directory requests", async (t) => {
  const urls = [];
  const f = await fixture(t, {
    catalogFetch: async (url) => {
      urls.push(String(url));
      return new Response(
        '<main><article data-package-card="true"></article></main>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  const state = await (await f.request("/api/state")).json();
  assert.equal(state.marketplaceOfficial, true);
  const result = await f.request(
    "/api/package-catalog?q=fixture&type=skill&sort=recent&page=2&refresh=1",
  );
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.source, "pi.dev");
  assert(body.html.includes("data-package-card"));
  assert.equal(new URL(urls[0]).searchParams.get("name"), "fixture");
  assert.equal(
    (await f.request("/api/package-details?name=https%3A%2F%2Fevil.test"))
      .status,
    422,
  );
  assert.equal(urls.length, 1);
});

test("inventory reads real installed versions; checks are manual, native, scoped and do not promise latest", async (t) => {
  let checks = 0;
  const f = await fixture(t, {
    packageUpdates: async () => {
      checks++;
      return {
        supported: true,
        rows: [
          { source: "npm:fixture-extensions", scope: "global", type: "npm" },
        ],
      };
    },
  });
  let inventory = await (await f.request("/api/plugins")).json();
  assert.equal(inventory.rows[0].installedVersion, "1.0.0");
  assert.equal(inventory.rows[0].updateAvailable, null);
  assert.equal(checks, 0);
  f.setIdle(false);
  assert.equal(
    (await f.request("/api/package-updates", { sessionId: "A" })).status,
    409,
  );
  assert.equal(checks, 0);
  f.setIdle(true);
  const checked = await f.request("/api/package-updates", { sessionId: "A" });
  assert.equal(checked.status, 200);
  inventory = await checked.json();
  assert.equal(checks, 1);
  assert.equal(inventory.rows[0].updateAvailable, true);
  assert(inventory.updatesCheckedAt > 0);
  inventory = await (await f.request("/api/plugins")).json();
  assert.equal(inventory.rows[0].updateAvailable, true);
  assert.equal(checks, 1);
  await writeFile(
    join(f.packageRoot, "package.json"),
    JSON.stringify({ version: "2.0.0" }),
  );
  inventory = await (await f.request("/api/plugins")).json();
  assert.equal(inventory.rows[0].installedVersion, "2.0.0");
  assert.equal(
    inventory.rows[0].updateAvailable,
    null,
    "External reconciliation must invalidate stale update hints",
  );
});

test("late native update results cannot be relabeled for a new session or cwd", async (t) => {
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, {
    packageUpdates: async () => {
      started();
      await new Promise((resolve) => {
        release = resolve;
      });
      return {
        supported: true,
        rows: [{ source: "npm:fixture-extensions", scope: "global" }],
      };
    },
  });
  const pending = f.request("/api/package-updates", { sessionId: "A" });
  await Promise.race([
    ready,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Native check was not invoked")),
        2000,
      );
      timer.unref();
    }),
  ]);
  f.select("B");
  release();
  assert.equal((await pending).status, 409);
  assert.equal(
    (await (await f.request("/api/plugins")).json()).rows[0].updateAvailable,
    null,
  );
});

test("package writes retain native sources and require original target, trust and inventory revision", async (t) => {
  const writes = [];
  const f = await fixture(t, {
    packageAction: async (input) => writes.push(input),
  });
  await writeFile(
    join(f.agentDir, "settings.json"),
    JSON.stringify({ packages: ["git:github.com/fixture/tools@main"] }),
  );
  const row = (await (await f.request("/api/plugins")).json()).rows[0];
  const input = {
    sessionId: "A",
    action: "update",
    scope: "global",
    source: row.source,
    revision: row.revision,
  };
  assert.equal((await f.request("/api/package", input)).status, 200);
  assert.equal(writes.length, 1);
  f.select("B");
  assert.equal((await f.request("/api/package", input)).status, 409);
  assert.equal(writes.length, 1);
  f.select("A");
  await writeFile(
    join(f.agentDir, "settings.json"),
    JSON.stringify({ packages: [] }),
  );
  assert.equal((await f.request("/api/package", input)).status, 409);
  assert.equal(writes.length, 1);
});
