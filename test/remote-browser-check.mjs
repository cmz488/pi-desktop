import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpsRequest } from "node:https";
import { request } from "node:http";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";
import { createTailscaleFunnel } from "../src/remote/tailscale-funnel.mjs";

const root = await mkdtemp(join(tmpdir(), "pi-remote-browser-"));
let app,
  browser,
  browserExit,
  driver,
  edge,
  target,
  releaseVerify,
  failVerification = true,
  closes = 0;
const sockets = new Set();
try {
  const cert = join(root, "cert.pem"),
    key = join(root, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=pi-phone.test.ts.net",
      "-addext",
      "subjectAltName=DNS:pi-phone.test.ts.net",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  );
  edge = createServer(
    { cert: await readFile(cert), key: await readFile(key) },
    (req, res) => {
      if (!target) {
        res.writeHead(503);
        res.end();
        return;
      }
      const upstream = request(
        new URL(req.url, target),
        { method: req.method, headers: req.headers },
        (reply) => {
          res.writeHead(reply.statusCode, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.once("close", () => upstream.destroy());
      req.pipe(upstream);
    },
  );
  edge.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    edge.once("error", reject);
    edge.listen(8443, "127.0.0.1", resolve);
  });
  const publicUrl = "https://pi-phone.test.ts.net:8443/";
  const certificate = await readFile(cert);
  const verifier = createTailscaleFunnel({
    requestPublic: (url, options, callback) =>
      httpsRequest(
        url,
        {
          ...options,
          ca: certificate,
          lookup: (_host, options, done) =>
            options.all
              ? done(null, [{ address: "127.0.0.1", family: 4 }])
              : done(null, "127.0.0.1", 4),
        },
        callback,
      ),
  });
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 60 });
  models.setProvider(faux.provider);
  const workspace = await openAgentWorkspace({
    storage: new MemoryStorage(),
    models,
  });
  const selected = (await workspace.read()).models[0];
  const model = { provider: selected.provider, modelId: selected.modelId };
  const first = await workspace.execute("create", {
    cwd: root,
    name: "Desktop agent",
    model,
  });
  const second = await workspace.execute("create", {
    cwd: root,
    name: "Phone agent",
    model,
  });
  app = await startDurableDesk({
    workspace,
    port: 0,
    funnel: {
      async verify(url, options) {
        if (failVerification) {
          failVerification = false;
          throw new Error("fixture public TLS reset");
        }
        await new Promise((resolve) => {
          releaseVerify = resolve;
        });
        return verifier.verify(url, options);
      },
      async start(options) {
        target = options.target;
        return {
          url: publicUrl,
          close: async () => {
            target = undefined;
            closes++;
          },
        };
      },
    },
  });
  const post = async (action) => {
    const response = await fetch(app.url + "api/remote", {
      method: "POST",
      headers: {
        Origin: new URL(app.url).origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const profile = join(root, "browser");
  await mkdir(profile);
  browser = spawn(
    "/usr/bin/chromium",
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-proxy-server",
      "--ignore-certificate-errors",
      "--host-resolver-rules=MAP pi-phone.test.ts.net 127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  browserExit = new Promise((resolve) => browser.once("exit", resolve));
  driver = await browserDriver(profile);
  const { call, evaluate, until } = driver;
  await call("Page.navigate", { url: app.url + `?agent=${second.id}#remote` });
  await until(
    "document.querySelector('#start-remote') && !document.querySelector('#view-remote').hidden",
  );
  await evaluate("document.querySelector('#start-remote').click()");
  await until(
    "document.querySelector('#network-status').textContent==='连接失败'",
  );
  assert.equal(
    await evaluate("document.querySelector('#connection-error').hidden"),
    false,
  );
  assert.equal(
    await evaluate("!!document.querySelector('#connection-qr img')"),
    false,
  );
  await evaluate("document.querySelector('#start-remote').click()");
  await until(
    "document.querySelector('#network-status').textContent==='验证公网连接'",
  );
  assert.equal(
    await evaluate("!!document.querySelector('#connection-qr img')"),
    false,
  );
  releaseVerify();
  await until(
    "document.querySelector('#network-status').textContent==='共享已开启' && !!document.querySelector('#connection-qr img')",
  );
  const qr = await evaluate("document.querySelector('#connection-qr img').src");
  const png = PNG.sync.read(Buffer.from(qr.split(",")[1], "base64"));
  const scan = jsQR(
    new Uint8ClampedArray(png.data),
    png.width,
    png.height,
  ).data;
  assert.equal(new URL(scan).searchParams.get("agent"), String(second.id));
  assert(
    !(
      await evaluate("document.querySelector('#connection-url').textContent")
    ).includes("connect="),
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await call("Page.navigate", { url: scan });
  await until(
    "document.querySelector('#connection-status')?.textContent==='Pi 已连接'",
  );
  assert.equal(await evaluate("location.hash"), "#workspace");
  assert.equal(
    await evaluate("document.querySelector('#session-title').textContent"),
    "Phone agent",
  );
  assert.equal(await evaluate("document.cookie"), "");
  assert.equal(await evaluate("!!window.piDesk"), false);
  assert.equal(
    await evaluate(
      "fetch('/api/state').then(response => response.headers.get('content-encoding'))",
    ),
    "br",
  );
  assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"));
  await evaluate("document.querySelector('[data-view=workspace]').click()");
  faux.setResponses([
    fauxAssistantMessage(
      "This answer streams through the authenticated tunnel into the mobile browser.",
    ),
  ]);
  await evaluate(
    "const box=document.querySelector('#prompt');box.value='message from phone';box.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#composer').requestSubmit()",
  );
  await until("!document.querySelector('#stop-button').hidden");
  await until(
    "document.querySelector('#messages').textContent.includes('This answer streams through') && document.querySelector('#stop-button').hidden",
    { timeoutMs: 20000 },
  );
  assert(
    (await workspace.read(second.id)).active.messages.some(
      (v) => v.text === "message from phone",
    ),
  );
  assert.equal((await workspace.read(first.id)).active.messages.length, 0);
  assert.equal(
    await evaluate("document.querySelector('#connection-status').textContent"),
    "Pi 已连接",
  );
  assert.equal(
    await evaluate("document.querySelector('#connection-status').textContent"),
    "Pi 已连接",
  );
  await evaluate(
    "document.querySelector('#prompt').value='draft survives reconnect'",
  );
  await call("Network.enable");
  await call("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await until("navigator.onLine===false");
  await call("Network.emulateNetworkConditions", {
    offline: false,
    latency: 100,
    downloadThroughput: 128000,
    uploadThroughput: 64000,
  });
  await until(
    "document.querySelector('#connection-status')?.textContent==='Pi 已连接'",
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('#agent-config-button')).display==='none'",
    ),
    true,
    "remote phone cannot open Agent host configuration",
  );
  for (const path of [
    "/api/plugins",
    "/api/providers",
    "/api/packages/update-all",
    "/api/settings",
    "/api/agent",
    "/api/command",
    "/api/reload-extensions",
  ])
    assert.equal(
      await evaluate(
        `(async()=> (await fetch(${JSON.stringify(path)})).status)()`,
      ),
      403,
      `remote clients cannot access ${path}`,
    );
  assert(
    await evaluate(
      "getComputedStyle(document.querySelector('#view-extensions')).display==='none'",
    ),
    "remote extension workbench is hidden even by hash view",
  );
  assert.equal(
    await evaluate("document.body.classList.contains('remote-client')"),
    true,
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('[data-view=plugins],[data-view=extensions],[data-view=remote]')].some((node)=>getComputedStyle(node).display!=='none')",
    ),
    false,
    "remote hides local settings and extension entries",
  );
  assert.equal(
    await evaluate("document.querySelector('#prompt').value"),
    "draft survives reconnect",
  );
  assert(
    (
      await evaluate("document.querySelector('#messages').textContent")
    ).includes("This answer streams through"),
  );
  await call("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await call("Page.reload");
  await until(
    "document.querySelector('#connection-status')?.textContent==='Pi 已连接'",
  );
  assert(
    (
      await evaluate("document.querySelector('#messages').textContent")
    ).includes("This answer streams through"),
  );
  await evaluate(
    `document.querySelector('[data-session-id="${first.id}"]').click()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Desktop agent'",
  );
  await call("Page.reload");
  await until(
    "document.querySelector('#connection-status')?.textContent==='Pi 已连接'",
  );
  assert.equal(
    await evaluate("document.querySelector('#session-title').textContent"),
    "Desktop agent",
  );
  await evaluate(
    `document.querySelector('[data-session-id="${second.id}"]').click()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Phone agent'",
  );
  await evaluate("document.querySelector('[data-view=workspace]').click()");
  for (const width of [320, 360, 390, 430]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert(
      await evaluate("document.documentElement.scrollWidth<=innerWidth"),
      `remote layout ${width}px`,
    );
    assert(
      await evaluate(
        "(()=>{const p=document.querySelector('#prompt');const r=p.getBoundingClientRect();return r.height>=28&&r.bottom<=innerHeight+1;})()",
      ),
      `remote composer ${width}px`,
    );
    assert(
      await evaluate(
        "(()=>{const c=getComputedStyle(document.querySelector('#composer'));const b=getComputedStyle(document.querySelector('#send-button'));return parseFloat(c.paddingBottom)>=12&&parseFloat(b.minHeight)>=40;})()",
      ),
      `remote safe area and touch target ${width}px`,
    );
  }
  assert.notEqual(
    await evaluate("(async()=> (await fetch('/api/git')).status)()"),
    403,
    "Git remains available to remote clients",
  );
  assert.equal(
    await evaluate(
      "(async () => (await fetch('/api/remote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'rotate'})})).status)()",
    ),
    403,
  );
  const created = await evaluate(
    "(async()=>{const r=await fetch('/api/new-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});const j=await r.json();return [r.status,j.sessionId]})()",
  );
  assert.equal(created[0], 200, "remote can create a session");
  assert(created[1], "remote new-session returns its Agent id");
  const fresh = await post("rotate");
  assert.equal(
    await evaluate("(async () => (await fetch('/api/state')).status)()"),
    401,
  );
  await call("Page.navigate", { url: fresh.url });
  await until(
    "document.querySelector('#connection-status')?.textContent==='Pi 已连接'",
  );
  assert(!new URL(await evaluate("location.href")).hash.includes("connect="));
  await post("stop");
  assert.equal(closes, 2);
  assert.equal((await fetch(app.url + "api/state")).status, 200);
  assert.deepEqual(driver.errors, []);
  console.log(
    "Remote Chromium passed: decoded QR, automatic HTTPS authorization, selected Agent, gzip mobile SSE answer despite held/failed plugin listings, JSON decompression, offline/throttled reconnect with preserved draft, cookie reconnect, control isolation and revocation. External Tailscale uses a local TLS proxy fixture.",
  );
} finally {
  releaseVerify?.();
  driver?.close();
  browser?.kill();
  if (browserExit) {
    await Promise.race([
      browserExit,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (browser.exitCode === null) {
      browser.kill("SIGKILL");
      await browserExit;
    }
  }
  await app?.stop();
  for (const socket of sockets) socket.destroy();
  if (edge)
    await new Promise((resolve) => {
      edge.close(resolve);
      edge.closeAllConnections();
    });
  // Chromium helpers can write profile files briefly after the main process exits.
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
