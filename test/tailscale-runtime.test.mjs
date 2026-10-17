import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTailscaleRuntime } from "../src/remote/tailscale-runtime.mjs";
async function fixture(t, { system = false, env = process.env } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-tail-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "tailscale"),
    daemonBinary = join(root, "tailscaled"),
    record = join(root, "daemon.json"),
    logged = join(root, "logged"),
    cliEnvironment = join(root, "cli-environment.json");
  await writeFile(
    binary,
    `#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(cliEnvironment)},JSON.stringify({HTTP_PROXY:process.env.HTTP_PROXY,HTTPS_PROXY:process.env.HTTPS_PROXY,ALL_PROXY:process.env.ALL_PROXY,http_proxy:process.env.http_proxy,https_proxy:process.env.https_proxy,all_proxy:process.env.all_proxy,NO_PROXY:process.env.NO_PROXY,KEEP:process.env.KEEP}));const args=process.argv.slice(2),own=args.some(a=>a.startsWith('--socket='));if(args.includes('status')){if(!own&&!${system}){console.error("failed to connect to local tailscaled; it doesn't appear to be running");process.exit(1);}if(own&&!fs.existsSync(${JSON.stringify(record)})){console.error('failed to connect to local tailscaled');process.exit(1);}console.log(JSON.stringify({BackendState:${system}?'Running':fs.existsSync(${JSON.stringify(logged)})?'Running':'NeedsLogin'}));}else if(args.includes('up')){console.log(JSON.stringify({AuthURL:'https://login.tailscale.com/a/fixture'}));fs.writeFileSync(${JSON.stringify(logged)},'ready');}else process.exit(1);\n`,
    { mode: 0o700 },
  );
  await writeFile(
    daemonBinary,
    `#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,args:process.argv.slice(2),HTTP_PROXY:process.env.HTTP_PROXY,HTTPS_PROXY:process.env.HTTPS_PROXY,ALL_PROXY:process.env.ALL_PROXY,http_proxy:process.env.http_proxy,https_proxy:process.env.https_proxy,all_proxy:process.env.all_proxy,NO_PROXY:process.env.NO_PROXY,KEEP:process.env.KEEP}));process.on('SIGTERM',()=>{fs.rmSync(${JSON.stringify(record)},{force:true});process.exit();});setInterval(()=>{},1000);\n`,
    { mode: 0o700 },
  );
  const runtime = createTailscaleRuntime({
    directory: join(root, "state"),
    binary,
    daemonBinary,
    env,
    retryDelay: 50,
  });
  t.after(() => runtime.close());
  return { runtime, root, record };
}
const until = async (read) => {
  for (let i = 0; i < 100; i++) {
    try {
      const v = await read();
      if (v) return v;
    } catch {}
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("runtime timeout");
};
test("automatic rootless Tailscale owns private state, emits native login URL, restarts a crashed daemon and cleans up", async (t) => {
  const f = await fixture(t);
  await Promise.all([f.runtime.prepare(), f.runtime.prepare()]);
  const initial = JSON.parse(await readFile(f.record, "utf8"));
  assert(initial.args.includes("--tun=userspace-networking"));
  assert.equal((await stat(join(f.root, "state"))).mode & 0o777, 0o700);
  assert.equal(f.runtime.read().backendState, "NeedsLogin");
  const urls = [];
  const prefix = await f.runtime.connect(new AbortController().signal, (url) =>
    urls.push(url),
  );
  assert(prefix[0].startsWith("--socket="));
  assert.deepEqual(urls, ["https://login.tailscale.com/a/fixture"]);
  process.kill(initial.pid, "SIGKILL");
  const replacement = await until(async () => {
    const v = JSON.parse(await readFile(f.record, "utf8"));
    return v.pid !== initial.pid && f.runtime.read().phase === "running"
      ? v
      : undefined;
  });
  await f.runtime.close();
  assert.throws(() => process.kill(replacement.pid, 0), /ESRCH/);
});
test("Tailscale commands and managed daemon bypass inherited proxy variables", async (t) => {
  const f = await fixture(t, {
    env: {
      PATH: process.env.PATH,
      HTTP_PROXY: "http://proxy.invalid:8080",
      HTTPS_PROXY: "http://proxy.invalid:8080",
      ALL_PROXY: "socks5://proxy.invalid:1080",
      http_proxy: "http://proxy.invalid:8080",
      https_proxy: "http://proxy.invalid:8080",
      all_proxy: "socks5://proxy.invalid:1080",
      NO_PROXY: "localhost",
      KEEP: "preserved",
    },
  });
  await f.runtime.prepare();
  const daemon = JSON.parse(await readFile(f.record, "utf8"));
  const cli = JSON.parse(
    await readFile(join(f.root, "cli-environment.json"), "utf8"),
  );
  for (const environment of [daemon, cli]) {
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ])
      assert.equal(environment[key], undefined, `${key} must be unset`);
    assert.equal(environment.NO_PROXY, "localhost");
    assert.equal(environment.KEEP, "preserved");
  }
});
test("available system Tailscale is reused and never owned or shut down by Desktop", async (t) => {
  const f = await fixture(t, { system: true });
  const prefix = await f.runtime.connect(new AbortController().signal);
  assert.deepEqual(prefix, []);
  assert.equal(f.runtime.read().managed, false);
  assert.equal(f.runtime.read().phase, "running");
  await f.runtime.close();
  await assert.rejects(readFile(f.record));
});
test("closing during daemon startup does not leave a process or retry loop", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = f.runtime.prepare(controller.signal).catch(() => {});
  controller.abort();
  await f.runtime.close();
  await pending;
  await assert.rejects(readFile(f.record));
});

test("daemon interruption removes a published QR and recovery returns to a fresh scan entry", async (t) => {
  const { createRemoteAccess } = await import(
    "../src/remote/remote-access.mjs"
  );
  let listener,
    closes = 0;
  let state = { phase: "running", backendState: "Running" };
  const access = createRemoteAccess({
    targetUrl: () => "http://127.0.0.1:1/",
    funnel: {
      runtimeState: () => state,
      onRuntimeChange: (fn) => {
        listener = fn;
        return () => {};
      },
      async start() {
        return {
          url: "https://pi-phone.test.ts.net:8443/",
          close: async () => closes++,
        };
      },
    },
  });
  t.after(() => access.close());
  await access.execute("start");
  await until(() => access.read().phase === "ready");
  assert(access.read().scanUrl);
  state = { phase: "restarting" };
  listener();
  assert.equal(access.read().scanUrl, undefined);
  assert.equal(access.read().phase, "error");
  await until(() => closes === 1);
  state = { phase: "running", backendState: "Running" };
  listener();
  assert.equal(access.read().phase, "off");
  await access.close();
});

test("a system daemon without login permission falls back to an independently authorized userspace daemon", async (t) => {
  const f = await fixture(t, { system: true });
  const logged = join(f.root, "permission-login");
  await writeFile(
    join(f.root, "tailscale"),
    `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2),owned=args.some(x=>x.startsWith('--socket='));if(args.includes('status'))console.log(JSON.stringify({BackendState:owned&&fs.existsSync(${JSON.stringify(logged)})?'Running':'NeedsLogin'}));else if(args.includes('up')){if(!owned){console.error('Access denied: requires operator');process.exit(1);}console.log('https://login.tailscale.com/a/owned');fs.writeFileSync(${JSON.stringify(logged)},'ready');}\n`,
    { mode: 0o700 },
  );
  const urls = [];
  const prefix = await f.runtime.connect(new AbortController().signal, (url) =>
    urls.push(url),
  );
  assert(prefix[0].startsWith("--socket="));
  assert.equal(f.runtime.read().managed, true);
  assert.deepEqual(urls, ["https://login.tailscale.com/a/owned"]);
  await f.runtime.close();
});
