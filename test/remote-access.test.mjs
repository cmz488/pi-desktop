import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, createServer } from "node:http";
import { createGunzip, gunzipSync, brotliDecompressSync } from "node:zlib";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { EventEmitter } from "node:events";
import { createDeskBridge } from "../src/server/bridge.mjs";
import { createRemoteAccess } from "../src/remote/remote-access.mjs";
import { createTailscaleFunnel } from "../src/remote/tailscale-funnel.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
test("public DNS propagation can outlast three probes without publishing early; retry waits remain cancellable", async (t) => {
  const server = createServer((_req, res) =>
    res.end(JSON.stringify({ instance: "desktop" })),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let calls = 0;
  const verifier = createTailscaleFunnel({
    verificationTimeout: 3000,
    verificationRetryDelay: 5,
    requestPublic(url, options, callback) {
      if (++calls <= 4) {
        const req = new EventEmitter();
        req.end = () =>
          queueMicrotask(() => {
            req.emit(
              "error",
              Object.assign(new Error("DNS not propagated"), {
                code: "ENOTFOUND",
              }),
            );
            req.emit("close");
          });
        return req;
      }
      return request(
        `http://127.0.0.1:${server.address().port}${url.pathname}`,
        options,
        callback,
      );
    },
  });
  await verifier.verify("https://pi-phone.test.ts.net/", {
    expected: "desktop",
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(calls, 5);
  const waiting = createTailscaleFunnel({
    verificationTimeout: 3000,
    verificationRetryDelay: 2000,
    requestPublic() {
      const req = new EventEmitter();
      req.end = () =>
        queueMicrotask(() => {
          req.emit(
            "error",
            Object.assign(new Error("DNS not propagated"), {
              code: "EAI_AGAIN",
            }),
          );
          req.emit("close");
        });
      return req;
    },
  });
  const controller = new AbortController();
  const pending = waiting.verify("https://pi-phone.test.ts.net/", {
    expected: "desktop",
    signal: controller.signal,
  });
  await pause(20);
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});
test("public DNS failures explain the direct-network checks without suggesting a proxy", async () => {
  const verifier = createTailscaleFunnel({
    verificationTimeout: 50,
    verificationRetryDelay: 5,
    requestPublic() {
      const req = new EventEmitter();
      req.end = () =>
        queueMicrotask(() => {
          req.emit(
            "error",
            Object.assign(new Error("DNS lookup failed"), {
              code: "ENOTFOUND",
            }),
          );
          req.emit("close");
        });
      return req;
    },
  });
  await assert.rejects(
    verifier.verify("https://pi-phone.test.ts.net/", {
      expected: "desktop",
      signal: AbortSignal.timeout(1000),
    }),
    (error) => {
      assert.match(error.message, /DNS/);
      assert.match(error.message, /直连/);
      assert.doesNotMatch(error.message, /代理/);
      return true;
    },
  );
});
test("a running tunnel is revoked when its daemon develops intercepted TLS health", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-funnel-monitor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "tailscale-fixture"),
    record = join(root, "target.json"),
    blocked = join(root, "blocked");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='status') console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'pi-phone.test.ts.net.'},Health:fs.existsSync(${JSON.stringify(blocked)})?['likely intercepted connection; certificate is self-signed']:[]}));
else if(process.argv[2]==='serve') console.log('{}');
else {fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(process.argv.at(-1)));console.log('Available on the internet: https://pi-phone.test.ts.net:8443/');setInterval(()=>{},1000);}
`,
    { mode: 0o700 },
  );
  let gateway;
  const funnel = createTailscaleFunnel({
    binary,
    healthInterval: 20,
    requestPublic(url, options, callback) {
      return request(
        gateway,
        { ...options, headers: { Host: url.host }, path: url.pathname },
        callback,
      );
    },
  });
  const verify = funnel.verify;
  funnel.verify = async (...args) => {
    gateway = JSON.parse(await readFile(record, "utf8"));
    return verify(...args);
  };
  const remote = createRemoteAccess({
    targetUrl: () => "http://127.0.0.1:1/",
    funnel,
  });
  t.after(() => remote.close());
  await remote.execute("start");
  await until(
    remote.read,
    (value) => value.phase === "ready" || value.phase === "error",
  );
  assert.equal(remote.read().phase, "ready", remote.read().error);
  await writeFile(blocked, "blocked");
  await until(remote.read, (value) => value.phase === "error");
  assert.match(remote.read().error, /TLS|证书|拦截/);
  assert.equal(remote.read().scanUrl, undefined);
  await remote.close();
  await assert.rejects(call(gateway));
});
test("public verification requires the exact gateway and cancellation aborts stalled verification", async (t) => {
  let body = { instance: "another-desktop" };
  const server = createServer((_req, res) => {
    if (body) res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const verifier = createTailscaleFunnel({
    requestPublic: (url, options, callback) =>
      request(
        {
          hostname: "127.0.0.1",
          port: server.address().port,
          path: url.pathname,
          signal: options.signal,
        },
        callback,
      ),
  });
  const controller = new AbortController();
  await assert.rejects(
    verifier.verify("https://pi-phone.test.ts.net/", {
      signal: controller.signal,
      expected: "this-desktop",
    }),
    /公网扫码入口验证失败/,
  );
  body = { instance: "this-desktop" };
  await verifier.verify("https://pi-phone.test.ts.net/", {
    signal: controller.signal,
    expected: "this-desktop",
  });
  body = null;
  const pending = verifier.verify("https://pi-phone.test.ts.net/", {
    signal: controller.signal,
    expected: "this-desktop",
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});
test("a CLI-announced tunnel cannot publish a QR before its public gateway responds", async () => {
  let release,
    target,
    closes = 0;
  const remote = createRemoteAccess({
    targetUrl: () => "http://127.0.0.1:1/",
    funnel: {
      async start(input) {
        target = input.target;
        return {
          url: "https://pi-phone.test.ts.net:8443/",
          close: async () => {
            closes++;
          },
        };
      },
      async verify() {
        await new Promise((resolve) => {
          release = resolve;
        });
        throw new Error("ECONNRESET");
      },
    },
  });
  try {
    await remote.execute("start");
    await until(remote.read, (value) => value.phase !== "starting");
    assert.equal(remote.read().phase, "checking");
    assert.equal(remote.read().scanUrl, undefined);
    release();
    await until(remote.read, (value) => value.phase === "error");
    assert.equal(remote.read().url, undefined);
    assert.match(remote.read().error, /公网|网络/);
    assert.equal(closes, 1);
    await assert.rejects(call(target));
  } finally {
    release?.();
    await remote.close();
  }
});

test("intercepted Tailscale TLS health prevents false ready and never launches Funnel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-funnel-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "tailscale-fixture");
  await writeFile(
    binary,
    `#!/usr/bin/env node
if(process.argv[2]==='status') console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'pi-phone.test.ts.net.'},Health:['Tailscale could not establish an encrypted connection: likely intercepted connection; certificate is self-signed by CN=Web secure CA']}));
else if(process.argv[2]==='serve') console.log('{}');
else {console.log('Available on the internet: https://pi-phone.test.ts.net:8443/');setInterval(()=>{},1000);}
`,
    { mode: 0o700 },
  );
  const controller = new AbortController();
  let running;
  try {
    await assert.rejects(async () => {
      running = await createTailscaleFunnel({ binary }).start({
        target: "http://127.0.0.1:1/",
        signal: controller.signal,
      });
    }, /证书|TLS|拦截/);
  } finally {
    await running?.close();
  }
});

test("a preferred DERP warning lets the verified Funnel route decide readiness", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-funnel-derp-health-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "tailscale-fixture");
  const launched = join(root, "funnel-launched");
  const publicServer = createServer((_req, res) =>
    res.end(JSON.stringify({ instance: expectedInstance })),
  );
  await new Promise((resolve) => publicServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => publicServer.close(resolve)));
  let expectedInstance = "";
  await writeFile(
    binary,
    `#!/usr/bin/env node
if(process.argv[2]==='status') console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'pi-phone.test.ts.net.'},Health:["Tailscale could not connect to the 'Singapore' relay server."]}));
else if(process.argv[2]==='serve') console.log('{}');
else {require('node:fs').writeFileSync(${JSON.stringify(launched)},'started');console.log('Available on the internet: https://pi-phone.test.ts.net:8443/');setInterval(()=>{},1000);}
`,
    { mode: 0o700 },
  );
  const funnel = createTailscaleFunnel({
    binary,
    startupTimeout: 1000,
    verificationTimeout: 1000,
    verificationRetryDelay: 5,
    healthInterval: 10000,
    runtime: {
      connect: async () => [],
      read: () => ({ phase: "running", backendState: "Running" }),
      subscribe: () => () => {},
      close: async () => {},
    },
    requestPublic(url, options, callback) {
      return request(
        `http://127.0.0.1:${publicServer.address().port}${url.pathname}`,
        { ...options, headers: { host: url.host } },
        callback,
      );
    },
  });
  const verify = funnel.verify.bind(funnel);
  funnel.verify = async (url, options) => {
    expectedInstance = options.expected;
    return verify(url, options);
  };
  const remote = createRemoteAccess({
    targetUrl: () => "http://127.0.0.1:1/",
    funnel,
  });
  t.after(() => remote.close());
  await remote.execute("start");
  await until(remote.read, (value) => ["ready", "error"].includes(value.phase));
  assert.equal(remote.read().phase, "ready", remote.read().error);
  assert.ok(remote.read().scanUrl);
  assert.equal(await readFile(launched, "utf8"), "started");
});
async function until(read, predicate) {
  for (let index = 0; index < 150; index++) {
    const result = await read();
    if (predicate(result)) return result;
    await pause(10);
  }
  assert.fail("remote condition timed out");
}
function call(url, { host, cookie, origin, input, encoding } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: input === undefined ? "GET" : "POST",
        headers: {
          ...(encoding ? { "Accept-Encoding": encoding } : {}),
          ...(host ? { Host: host } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(origin ? { Origin: origin } : {}),
          ...(input !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("error", reject);
        res.on("data", (v) => chunks.push(v));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          const text = (
            res.headers["content-encoding"] === "gzip"
              ? gunzipSync(bytes)
              : res.headers["content-encoding"] === "br"
                ? brotliDecompressSync(bytes)
                : bytes
          ).toString();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            /* html */
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data,
            text,
            bytes,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-"));
  const messages = [],
    starts = [];
  const funnel = {
    async start({ target, signal, onExit }) {
      const result = { target, signal, onExit, closes: 0 };
      starts.push(result);
      return {
        url: "https://pi-phone.test.ts.net:8443/",
        close: async () => {
          result.closes++;
        },
      };
    },
  };
  await writeFile(join(dir, "settings.json"), "{}");
  const bridge = createDeskBridge({
    host: "127.0.0.1",
    port: 0,
    agentDir: dir,
    funnel,
    snapshot: () => ({
      host: "durable",
      sessionId: "7",
      cwd: dir,
      models: [],
      messages,
    }),
    canWrite: () => true,
    prompt: async (text) => {
      messages.push({ role: "user", text });
    },
    async requestContext(req, res, run) {
      if (req.headers.origin)
        assert.equal(req.headers.origin, `http://${req.headers.host}`);
      return run();
    },
  });
  const local = await bridge.start();
  t.after(async () => {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const control = (action) =>
    call(local + "api/remote", {
      origin: new URL(local).origin,
      input: { action },
    });
  await control("start");
  const remote = await until(
    async () => (await call(local + "api/remote")).data,
    (v) => v.tunnel.phase === "ready",
  );
  const publicUrl = new URL(remote.tunnel.url);
  const gate = (path, opts = {}) =>
    call(starts.at(-1).target + path.replace(/^\//, ""), {
      host: publicUrl.host,
      ...opts,
    });
  const pair = (url = remote.url) =>
    gate("/_pi/connect", {
      origin: publicUrl.origin,
      input: {
        key: new URLSearchParams(new URL(url).hash.slice(1)).get("connect"),
      },
    });
  return {
    bridge,
    local,
    remote,
    gate,
    pair,
    control,
    starts,
    publicUrl,
    messages,
  };
}
test("authenticated phone snapshots and event streams remain compressed through the gateway", async (t) => {
  const f = await fixture(t);
  const paired = await f.pair();
  const cookie = paired.headers["set-cookie"][0].split(";")[0];
  assert.equal(
    (
      await f.gate("/api/workspace/directory", {
        cookie,
        origin: f.publicUrl.origin,
        input: {},
      })
    ).status,
    403,
  );
  f.messages.push({
    role: "assistant",
    text: "Project context and tool results from a long run.\n".repeat(4000),
  });
  const plain = await f.gate("/api/state", { cookie });
  const packed = await f.gate("/api/state", { cookie, encoding: "gzip" });
  assert.equal(packed.headers["content-encoding"], "gzip");
  assert.equal(packed.headers["cache-control"], "no-store");
  assert.deepEqual(packed.data, plain.data);
  assert(packed.bytes.length < plain.bytes.length / 10);
  const brotli = await f.gate("/api/state", { cookie, encoding: "br, gzip" });
  assert.equal(brotli.headers["content-encoding"], "br");
  assert.deepEqual(brotli.data, plain.data);
  assert(brotli.bytes.length < packed.bytes.length);
  t.diagnostic(
    `Authenticated transfer: ${plain.bytes.length} identity / ${packed.bytes.length} gzip / ${brotli.bytes.length} Brotli bytes`,
  );
  for (const encoding of ["gzip;q=0", "gzip;q=0.2, identity;q=1"]) {
    assert.equal(
      (await f.gate("/api/state", { cookie, encoding })).headers[
        "content-encoding"
      ],
      undefined,
    );
  }
  assert.equal(
    (await f.gate("/api/state", { cookie, encoding: "*;q=0" })).status,
    406,
  );
  const stream = await new Promise((resolve, reject) => {
    const req = request(
      f.starts[0].target +
        `api/events?epoch=${plain.data.epoch}&after=${plain.data.seq}`,
      {
        headers: {
          Host: f.publicUrl.host,
          Cookie: cookie,
          "Accept-Encoding": "gzip",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
  t.after(() => stream.destroy());
  assert.equal(stream.headers["content-encoding"], "gzip");
  const decoder = createGunzip();
  t.after(() => decoder.destroy());
  stream.pipe(decoder);
  let wire = "";
  decoder.on("data", (chunk) => (wire += chunk));
  decoder.on("error", () => {}); // Revocation may intentionally interrupt a gzip member.
  await until(
    () => wire,
    (text) => text.includes(": connected"),
  );
  for (const text of ["first streamed reply", "second streamed reply"]) {
    f.bridge.publish("assistant_update", { text });
    await until(
      () => wire,
      (value) => value.includes(text),
    );
  }
  assert(
    wire.indexOf("first streamed reply") <
      wire.indexOf("second streamed reply"),
  );
  const ended = new Promise((resolve) => stream.once("close", resolve));
  await f.control("rotate");
  await ended;
  assert.equal(
    (await f.gate("/api/state", { cookie, encoding: "gzip" })).status,
    401,
  );
  t.diagnostic(
    `Phone session transfer through gateway: ${plain.bytes.length} -> ${packed.bytes.length} bytes`,
  );
});

test("rescanning and switching browser preview after pairing retain authorization and the selected agent", async (t) => {
  const f = await fixture(t);
  const paired = await f.pair();
  const cookie = paired.headers["set-cookie"][0].split(";")[0];
  const scan = await f.gate("/_pi/scan?agent=7", { cookie });
  assert.equal(
    scan.status,
    303,
    "a reloaded scan page must use its existing phone authorization",
  );
  assert.equal(scan.headers.location, "/?agent=7");
  assert.equal((await f.gate("/api/state", { cookie })).status, 200);
  const pairedAgain = await f.gate("/_pi/connect", {
    cookie,
    origin: f.publicUrl.origin,
    input: {
      key: new URLSearchParams(new URL(f.remote.url).hash.slice(1)).get(
        "connect",
      ),
    },
  });
  assert.equal(pairedAgain.status, 200);
  assert.equal(pairedAgain.headers["set-cookie"], undefined);
  assert.equal(
    (await f.control("prepare")).data.tunnel.scanUrl,
    f.remote.tunnel.scanUrl,
  );
  assert.equal(
    (await f.control("start")).data.tunnel.scanUrl,
    f.remote.tunnel.scanUrl,
  );
  assert.equal(
    (await f.pair()).status,
    200,
    "scanning does not consume or rotate the host QR",
  );
  await f.control("rotate");
  assert.equal((await f.gate("/api/state", { cookie })).status, 401);
  assert.equal(
    (await f.pair()).status,
    401,
    "explicit rotation still invalidates the previous QR",
  );
});
test("Funnel QR authorizes a browser automatically; private reads and writes require its cookie and same origin", async (t) => {
  const f = await fixture(t);
  const png = PNG.sync.read(Buffer.from(f.remote.qr.split(",")[1], "base64"));
  const scan = jsQR(
    new Uint8ClampedArray(png.data),
    png.width,
    png.height,
  ).data;
  assert.equal(scan, f.remote.url);
  assert.equal(new URL(scan).searchParams.get("agent"), "7");
  assert.equal((await f.gate("/api/state")).status, 401);
  assert.equal((await f.gate("/prototype.js")).status, 401);
  assert((await f.gate("/_pi/scan")).text.includes("/_pi/connect.js"));
  assert(!(await f.gate("/")).text.includes("pi-desk-mode"));
  assert.equal(
    (await f.gate("/api/state", { host: "evil.example" })).status,
    403,
  );
  assert.equal(
    (await f.pair("https://pi-phone.test.ts.net:8443/#connect=bad")).status,
    401,
  );
  assert.equal(
    (
      await f.gate("/_pi/connect", {
        origin: f.publicUrl.origin,
        input: { key: "中".repeat(43) },
      })
    ).status,
    401,
  );
  const paired = await f.pair();
  assert.equal(paired.status, 200);
  const cookie = paired.headers["set-cookie"][0].split(";")[0];
  assert.match(
    paired.headers["set-cookie"][0],
    /HttpOnly; Secure; SameSite=Strict; Path=\//,
  );
  assert.equal((await f.gate("/api/state", { cookie })).data.sessionId, "7");
  assert.equal(
    (await f.gate("/api/prompt", { cookie, input: { message: "phone" } }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.gate("/api/prompt", {
        cookie,
        origin: "https://evil.example",
        input: { message: "phone" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.gate("/api/prompt", {
        cookie,
        origin: f.publicUrl.origin,
        input: { message: "phone", sessionId: "7" },
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(f.local + "api/state")).data.messages[0].text,
    "phone",
  );
  const remoteView = await f.gate("/api/remote", { cookie });
  assert.equal(remoteView.data.remoteClient, true);
  assert(!JSON.stringify(remoteView.data).includes("connect="));
  assert.equal(
    (
      await f.gate("/api/remote", {
        cookie,
        origin: f.publicUrl.origin,
        input: { action: "rotate" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(f.local + "api/remote", {
        origin: "https://evil.example",
        input: { action: "stop" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(f.local + "api/remote", {
        host: "192.168.0.1",
        input: { action: "stop" },
      })
    ).status,
    403,
  );
});
test("authenticated SSE retains ordered updates; rotation and stop revoke credentials and live streams", async (t) => {
  const f = await fixture(t);
  const paired = await f.pair(),
    cookie = paired.headers["set-cookie"][0].split(";")[0];
  const state = (await f.gate("/api/state", { cookie })).data;
  const stream = await new Promise((resolve, reject) => {
    const req = request(
      f.starts[0].target + `api/events?epoch=${state.epoch}&after=${state.seq}`,
      { headers: { Host: f.publicUrl.host, Cookie: cookie } },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
  let wire = "";
  stream.on("data", (chunk) => (wire += chunk));
  const ended = new Promise((resolve) => {
    stream.once("close", resolve);
    stream.on("error", () => {});
  });
  f.bridge.publish("assistant_update", { text: "live phone update" });
  await until(
    () => wire,
    (v) => v.includes("live phone update"),
  );
  assert(wire.includes(`id: ${state.seq + 1}`));
  const oldScan = f.remote.url;
  await f.control("rotate");
  await ended;
  assert.equal((await f.gate("/api/state", { cookie })).status, 401);
  assert.equal((await f.pair(oldScan)).status, 401);
  const updated = (await call(f.local + "api/remote")).data;
  assert.notEqual(updated.url, oldScan);
  assert.equal((await f.pair(updated.url)).status, 200);
  const target = f.starts[0].target;
  await f.control("stop");
  assert.equal(f.starts[0].closes, 1);
  await assert.rejects(call(target + "api/state", { host: f.publicUrl.host }));
  assert.equal((await call(f.local + "api/state")).status, 200);
  await f.control("start");
  await until(
    async () => (await call(f.local + "api/remote")).data,
    (v) => v.tunnel.phase === "ready",
  );
  assert.equal((await f.gate("/api/state", { cookie })).status, 401);
});
test("cancelling Funnel approval and unexpected process exit leave no published gateway", async () => {
  let mode = "wait",
    last,
    closes = 0;
  const remote = createRemoteAccess({
    targetUrl: () => "http://127.0.0.1:1/",
    funnel: {
      async start(options) {
        last = options;
        if (mode === "wait") {
          options.onApproval("https://login.tailscale.com/f/serve");
          await new Promise((resolve, reject) =>
            options.signal.addEventListener(
              "abort",
              () => reject(options.signal.reason),
              { once: true },
            ),
          );
        }
        return {
          url: "https://pi-phone.test.ts.net:8443/",
          close: async () => {
            closes++;
          },
        };
      },
    },
  });
  try {
    await remote.execute("start");
    await until(remote.read, (v) => !!v.approvalUrl);
    const abandoned = last;
    await remote.execute("stop");
    abandoned.onApproval("https://login.tailscale.com/stale");
    assert.equal(remote.read().phase, "off");
    assert.equal(remote.read().approvalUrl, "");
    mode = "ready";
    await remote.execute("start");
    await until(remote.read, (v) => v.phase === "ready");
    const oldTarget = last.target;
    last.onExit();
    await until(remote.read, (v) => v.phase === "error");
    await remote.execute("start");
    await until(remote.read, (v) => v.phase === "ready");
    await assert.rejects(call(oldTarget));
    assert.equal(closes, 1);
  } finally {
    await remote.close();
  }
  let release, gatewayUrl;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  const retiring = createRemoteAccess({
    targetUrl: () => "http://127.0.0.1:1/",
    funnel: {
      async start({ target }) {
        gatewayUrl = target;
        return {
          url: "https://pi-phone.test.ts.net:8443/",
          close: () => delayed,
        };
      },
    },
  });
  await retiring.execute("start");
  await until(retiring.read, (v) => v.phase === "ready");
  const stop = retiring.execute("stop");
  const restart = assert.rejects(retiring.execute("start"), /远程宿主已关闭/);
  const close = retiring.close();
  release();
  await Promise.all([stop, restart, close]);
  await assert.rejects(call(gatewayUrl));
});
test("foreground CLI preserves occupied ports, surfaces approval and owns only its child", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-funnel-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "tailscale-fixture"),
    record = join(root, "args.json");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='status') console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'pi-phone.test.ts.net.'}}));
else if(args[0]==='serve') console.log(JSON.stringify({TCP:{8443:{HTTPS:true}}}));
else {
 require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({args,pid:process.pid}));
 console.log('https://login.tailscale.com/f/serve');
 console.log('Available on the internet:');
 console.log('https://pi-phone.test.ts.net:10000/');
 setInterval(()=>{},1000);
}
`,
    { mode: 0o700 },
  );
  const approvals = [],
    exits = [],
    controller = new AbortController();
  const running = await createTailscaleFunnel({ binary }).start({
    target: "http://127.0.0.1:32123/",
    signal: controller.signal,
    onApproval: (v) => approvals.push(v),
    onExit: () => exits.push(true),
  });
  assert.equal(running.url, "https://pi-phone.test.ts.net:10000/");
  assert(approvals[0].startsWith("https://login.tailscale.com/"));
  const { readFile } = await import("node:fs/promises");
  const args = JSON.parse(await readFile(record, "utf8"));
  assert.deepEqual(args.args, [
    "funnel",
    "--yes",
    "--https=10000",
    "http://127.0.0.1:32123/",
  ]);
  await running.close();
  assert.throws(() => process.kill(args.pid, 0));
  assert.equal(exits.length, 0);
  await writeFile(
    binary,
    `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='status') console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'pi-phone.test.ts.net.'}}));
else if(args[0]==='serve') console.log('{}');
else { console.error('Access denied: serve config denied. Use sudo tailscale set --operator.'); process.exit(1); }
`,
  );
  await assert.rejects(
    createTailscaleFunnel({ binary }).start({
      target: "http://127.0.0.1:1/",
      signal: new AbortController().signal,
    }),
    /权限不足.*--operator/,
  );
  const missing = createTailscaleFunnel({
    binary: join(root, "not-installed"),
  });
  await assert.rejects(
    missing.start({
      target: "http://127.0.0.1:1/",
      signal: new AbortController().signal,
    }),
    /安装并登录/,
  );
});
