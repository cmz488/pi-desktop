import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchService } from "../src/control-plane/process.mjs";

async function fixture(t, prelude = "") {
  const root = await mkdtemp(join(tmpdir(), "pi-service-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const entry = join(root, "worker.mjs");
  await writeFile(
    entry,
    `import { serviceMain } from ${JSON.stringify(new URL("../src/control-plane/process.mjs", import.meta.url).href)};
${prelude}
serviceMain(async () => ({ url: process.cwd(), stop: async () => {} }));
`,
  );
  return { root, cwd, entry };
}

function cleanupService(t, service) {
  t.after(async () => {
    service.child.kill("SIGKILL");
    await service.stop();
  });
  return service;
}

test("fork never resolves a project cwd in the Host process", async (t) => {
  const f = await fixture(t);
  const fork = childProcess.fork;
  t.mock.method(childProcess, "fork", (entry, args, options) => {
    assert.equal(
      options.cwd,
      undefined,
      "a stalled network mount must not block the Host inside fork/chdir",
    );
    return fork(entry, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const parentCwd = process.cwd();
  const service = cleanupService(t, launchService(f.entry, { cwd: f.cwd }));
  assert.equal((await service.ready).url, f.cwd);
  assert.equal(process.cwd(), parentCwd);
});

test("worker keeps inherited cwd when none is requested and reports invalid cwd through readiness", async (t) => {
  const f = await fixture(t);
  const inherited = cleanupService(t, launchService(f.entry, {}));
  assert.equal((await inherited.ready).url, process.cwd());
  const missing = cleanupService(
    t,
    launchService(f.entry, { cwd: join(f.root, "missing") }),
  );
  await assert.rejects(missing.ready, /ENOENT/);
});

test(
  "a worker blocked changing directory times out without blocking HTTP or sibling workers",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      `
process.chdir = () => {
  process.send({ type: "test:blocked-directory" });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};`,
    );
    const server = createServer((_request, response) =>
      response.end("workspace"),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const blocked = cleanupService(
      t,
      launchService(f.entry, { cwd: f.cwd }, { timeout: 1000 }),
    );
    const timedOut = assert.rejects(blocked.ready, /Agent 启动超时/);
    const [message] = await once(blocked.child, "message");
    assert.equal(message.type, "test:blocked-directory");
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(await response.text(), "workspace");
    const siblingFixture = await fixture(t);
    const sibling = cleanupService(
      t,
      launchService(siblingFixture.entry, { cwd: siblingFixture.cwd }),
    );
    assert.equal((await sibling.ready).url, siblingFixture.cwd);
    await timedOut;
  },
);
