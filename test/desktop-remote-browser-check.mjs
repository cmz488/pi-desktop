import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpsRequest } from "node:https";
import { request } from "node:http";
import assert from "node:assert/strict";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { desktopFixture, until as settle } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";
import { createTailscaleFunnel } from "../src/remote/tailscale-funnel.mjs";

const root = await mkdtemp(join(tmpdir(), "pi-desktop-phone-"));
let f, edge, target, browser, driver, browserExit;
const sockets = new Set();
let slowPolling = false;
let slowPairing = false;
let stallNextSnapshot = false;
let heldSnapshot;
const liveStreams = new Set();
const polling = new Map();
const requests = new Map();
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
      const pathname = new URL(req.url, "https://fixture.test").pathname;
      requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
      const kind =
        pathname === "/api/workspace"
          ? "workspace"
          : req.url.includes("/api/interactions")
            ? "interactions"
            : undefined;
      const serve = () => {
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
      };
      if (pathname.endsWith("/api/events")) {
        liveStreams.add(res);
        res.once("close", () => liveStreams.delete(res));
      }
      if (stallNextSnapshot && pathname.endsWith("/api/state")) {
        stallNextSnapshot = false;
        heldSnapshot = res;
        const timer = setTimeout(serve, 12000);
        res.once("close", () => clearTimeout(timer));
        return;
      }
      if (slowPairing && pathname === "/_pi/connect") {
        const timer = setTimeout(serve, 2500);
        res.once("close", () => clearTimeout(timer));
        return;
      }
      if (slowPolling && kind) {
        const record = polling.get(kind) ?? { pending: 0, peak: 0, calls: 0 };
        polling.set(kind, record);
        record.pending++;
        record.calls++;
        record.peak = Math.max(record.peak, record.pending);
        const timer = setTimeout(serve, 2700);
        res.once("close", () => {
          clearTimeout(timer);
          record.pending--;
        });
      } else serve();
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
  const verifier = createTailscaleFunnel({
    requestPublic: (url, options, callback) =>
      httpsRequest(
        url,
        {
          ...options,
          ca: awaitedCert,
          lookup: (_host, options, done) =>
            options.all
              ? done(null, [{ address: "127.0.0.1", family: 4 }])
              : done(null, "127.0.0.1", 4),
        },
        callback,
      ),
  });
  const awaitedCert = await readFile(cert);
  f = await desktopFixture({
    defaultConversation: true,
    remoteFunnel: {
      verify: verifier.verify,
      async start({ target: gateway }) {
        target = gateway;
        return {
          url: "https://pi-phone.test.ts.net:8443/",
          close: async () => {
            target = undefined;
          },
        };
      },
    },
  });
  let catalog = await settle(
    () => f.call("/api/workspace"),
    (v) => v.agents[0]?.status === "running",
  );
  const home = catalog.agents[0];
  const project = catalog.projects[0];
  await writeFile(
    join(f.cwd, "remote-preview.txt"),
    "PHONE_SELECTED_FILE_ONLY",
  );
  await writeFile(
    join(f.cwd, "remote-image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n0kAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await writeFile(join(f.cwd, "remote-large.txt"), "L".repeat(600 * 1024));
  await writeFile(
    join(f.cwd, "remote-binary.bin"),
    Buffer.from([0, 1, 2, 3, 0, 255]),
  );
  const agent = await f.command("conversation.create", {
    name: "Phone project agent",
    projectId: project.id,
  });
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
  await call("Page.navigate", { url: f.app.url + `?agent=${agent.id}` });
  await until(
    `document.querySelector('#runtime')?.dataset.owner===${JSON.stringify(agent.id)} && document.querySelector('#runtime').contentDocument?.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
  );
  const doc = "document.querySelector('#runtime')?.contentDocument";
  await evaluate(
    `${doc}.querySelector('.settings-nav [data-view=remote]').click()`,
  );
  await until(
    `${doc}.querySelector('#start-remote') && !${doc}.querySelector('#view-remote').hidden`,
  );
  await evaluate(`${doc}.querySelector('#start-remote').click()`);
  await until(
    `${doc}.querySelector('#network-status').textContent==='共享已开启' && !!${doc}.querySelector('#connection-qr img')`,
    { timeoutMs: 15000 },
  );
  const qr = await evaluate(`${doc}.querySelector('#connection-qr img').src`);
  const png = PNG.sync.read(Buffer.from(qr.split(",")[1], "base64"));
  const scan = jsQR(
    new Uint8ClampedArray(png.data),
    png.width,
    png.height,
  ).data;
  assert.equal(new URL(scan).searchParams.get("agent"), agent.id);
  slowPairing = true;
  requests.clear();
  await call("Page.navigate", { url: scan });
  await settle(
    () => requests.get("/_pi/connect") ?? 0,
    (value) => value > 0,
  );
  assert(
    await evaluate("location.hash.includes('connect=')"),
    "a browser-mode reload during pairing retains the QR credential until success",
  );
  await call("Network.setUserAgentOverride", {
    userAgent:
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/150.0.0.0 Mobile Safari/537.36",
  });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await call("Page.reload");
  await until(
    `${doc}?.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
    { timeoutMs: 15000 },
  );
  assert.equal(
    await evaluate("document.querySelector('#runtime').dataset.owner"),
    agent.id,
  );
  assert.equal(await evaluate("document.cookie"), "");
  assert.equal(await evaluate("!!window.piDesk"), false);
  assert.equal(
    await evaluate(
      "location.search.includes('agent=') || location.hash.includes('connect=')",
    ),
    false,
  );
  slowPairing = false;
  await until("document.body.classList.contains('remote-client')");
  assert.equal(
    await evaluate(
      "['extensions-entry','skill-center','settings','add-project'].every((id)=>getComputedStyle(document.getElementById(id)).display==='none')",
    ),
    true,
    "desktop remote hides local workspace management entries",
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.mobile-header')).display!=='none'",
    ),
    true,
    "desktop remote keeps the navigation header reachable",
  );
  assert.equal(
    await evaluate(
      `${doc}.body.querySelector('#agent-config-button') ? getComputedStyle(${doc}.body.querySelector('#agent-config-button')).display==='none' : true`,
    ),
    true,
    "remote phone cannot open Agent host configuration",
  );
  await evaluate(`${doc}.querySelector('[data-action=sidebar]').click()`);
  await until(`${doc}.body.classList.contains('sidebar-open')`);
  assert(
    await evaluate(
      `(()=>{const s=${doc}.querySelector('#sessions');const r=s.getBoundingClientRect();return r.width>100&&r.height>0;})()`,
    ),
    "remote phone exposes a tappable session list",
  );
  await evaluate(`${doc}.querySelector('.sidebar-dismiss').click()`);
  await call("Network.setUserAgentOverride", {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36",
  });
  await call("Page.reload");
  await until(
    `${doc}?.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
    { timeoutMs: 15000 },
  );
  await call("Network.setUserAgentOverride", {
    userAgent:
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/150.0.0.0 Mobile Safari/537.36",
  });
  const withoutFragment = new URL(scan);
  withoutFragment.hash = "";
  await call("Page.navigate", { url: withoutFragment.href });
  await until(
    `${doc}?.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
    { timeoutMs: 15000 },
  );
  await call("Page.navigate", { url: scan });
  await until(
    `${doc}?.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
    { timeoutMs: 15000 },
  );
  assert.equal(
    (await f.call("/api/remote")).tunnel.devices,
    1,
    "preview changes and rescans reuse the phone cookie",
  );
  assert.equal(
    await evaluate(
      `(async()=> (await fetch('/agents/${agent.id}/api/settings')).status)()`,
    ),
    403,
    "remote settings stay on the computer",
  );
  assert.equal(
    await evaluate(`${doc}.body.classList.contains('remote-client')`),
    true,
  );
  assert(
    await evaluate(
      `(()=>{const frame=document.querySelector('#runtime');const input=${doc}.querySelector('#prompt');const rect=input.getBoundingClientRect();return frame.getBoundingClientRect().height>200&&!input.disabled&&rect.height>0&&rect.bottom<=${doc}.defaultView.innerHeight;})()`,
    ),
    "phone composer is visible and enabled",
  );
  for (const suffix of ["plugins", "providers", "files", "browser", "commands"])
    assert.equal(
      requests.get(`/agents/${agent.id}/api/${suffix}`) ?? 0,
      0,
      `${suffix} is not prefetched on phone`,
    );
  await evaluate(
    `${doc}.querySelector('[data-action=workspace-tools]').click()`,
  );
  await until(`${doc}.querySelector('.panel-shortcut')`);
  await until(
    `${doc}.querySelector('.panel-content')?.textContent.includes('浏览器仅在电脑本地运行')`,
  );
  assert(
    await evaluate(
      `(()=>{const d=${doc};return d.querySelector('.panel-address').hidden&&d.querySelector('#panel-new-tab').hidden&&![...d.querySelectorAll('.panel-shortcut span')].some((row)=>row.textContent==='网页');})()`,
    ),
    "phone workspace hides local Chromium navigation controls",
  );
  await evaluate(`${doc}.querySelectorAll('.panel-shortcut')[1].click()`);
  await until(`${doc}.querySelector('[data-panel-path="remote-preview.txt"]')`);
  await evaluate(
    `${doc}.querySelector('[data-panel-path="remote-preview.txt"]').click()`,
  );
  await until(
    `${doc}.querySelector('.panel-content')?.innerText.includes('PHONE_SELECTED_FILE_ONLY')`,
  );
  assert.equal(
    requests.get(`/agents/${agent.id}/api/files`),
    2,
    "phone loads just one directory and its selected file",
  );
  await evaluate(
    `${doc}.querySelector('[data-tree-path="remote-image.png"]').click()`,
  );
  await until(`${doc}.querySelector('.panel-file-image')`);
  await evaluate(
    `${doc}.querySelector('[data-tree-path="remote-large.txt"]').click()`,
  );
  await until(
    `${doc}.querySelector('.panel-content')?.innerText.includes('文件超过预览上限')`,
  );
  await evaluate(
    `${doc}.querySelector('[data-tree-path="remote-binary.bin"]').click()`,
  );
  await until(
    `${doc}.querySelector('.panel-content')?.innerText.includes('不是可预览')`,
  );
  await evaluate(`${doc}.querySelector('[aria-label="收起右侧边栏"]').click()`);
  slowPolling = true;
  await until("true");
  await new Promise((resolve) => setTimeout(resolve, 8500));
  for (const kind of ["workspace", "interactions"]) {
    const record = polling.get(kind);
    assert(record?.calls > 1, `${kind} polling continues on slow network`);
    assert.equal(
      record.peak,
      1,
      `${kind} has only one in-flight poll on a slow network`,
    );
  }
  slowPolling = false;
  await evaluate(
    `(()=>{const doc=${doc};doc.querySelector('#prompt').value='phone project message';doc.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));doc.querySelector('#composer').requestSubmit();})()`,
  );
  await until(
    `${doc}.querySelector('#messages').innerText.includes('answer: phone project message')`,
    { timeoutMs: 15000 },
  );
  assert(
    (await f.call(`/agents/${agent.id}/api/state`)).messages.some(
      (row) => row.text === "phone project message",
    ),
  );
  await evaluate(
    `(()=>{const input=${doc}.querySelector('#prompt');input.value='draft survives a stalled reconnect';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  stallNextSnapshot = true;
  await f.call(`/agents/${agent.id}/api/prompt`, {
    message: "reconnect regression",
    requestId: "reconnect-regression",
  });
  await settle(
    () => !!heldSnapshot,
    (value) => value,
  );
  const beforeReconnect = Date.now();
  for (const stream of liveStreams) stream.destroy();
  await until(
    `${doc}.querySelector('#messages').innerText.includes('answer: reconnect regression') && ${doc}.querySelector('#connection-status').textContent==='Pi 已连接'`,
    { timeoutMs: 5000 },
  );
  assert(
    Date.now() - beforeReconnect < 5000,
    "a stalled old snapshot does not impose its 12 second wait on the recovered stream",
  );
  assert(
    await evaluate(
      `${doc}.querySelector('#prompt').value==='draft survives a stalled reconnect'`,
    ),
  );
  assert(
    await evaluate(`${doc}.querySelector('#send-button').disabled===false`),
  );
  console.log(
    `Phone stalled-snapshot recovery: ${Date.now() - beforeReconnect} ms; draft preserved.`,
  );
  assert.equal(
    (await f.call(`/agents/${home.id}/api/state`)).messages.length,
    0,
  );
  await evaluate("document.querySelector('#navigation-toggle').click()");
  await until("document.body.classList.contains('navigation-open')");
  await evaluate(
    `document.querySelector('[data-agent-id="${home.id}"]').click()`,
  );
  await until(
    `document.querySelector('#runtime').dataset.owner===${JSON.stringify(home.id)} && ${doc}?.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
  );
  await call("Page.reload");
  await until(
    `document.querySelector('#runtime').dataset.owner===${JSON.stringify(home.id)} && ${doc}?.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
  );
  for (const path of ["/api/remote", `/agents/${home.id}/api/remote`])
    assert.equal(
      await evaluate(
        `fetch(${JSON.stringify(path)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'start'})}).then(r=>r.status)`,
      ),
      403,
    );
  await evaluate(`${doc}.querySelector('[data-view=workspace]').click()`);
  for (const width of [320, 360, 390, 430]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert(await evaluate("document.documentElement.scrollWidth<=innerWidth"));
    assert(
      await evaluate(
        `${doc}.documentElement.scrollWidth<=${doc}.defaultView.innerWidth`,
      ),
    );
    assert(
      await evaluate(
        `(()=>{const p=${doc}.querySelector('#prompt');const r=p.getBoundingClientRect();return r.height>=28&&r.bottom<=${doc}.defaultView.innerHeight+1;})()`,
      ),
      `desktop remote composer ${width}px`,
    );
    assert(
      await evaluate(
        `(()=>{const c=${doc}.defaultView.getComputedStyle(${doc}.querySelector('#composer'));const b=${doc}.defaultView.getComputedStyle(${doc}.querySelector('#send-button'));return parseFloat(c.paddingBottom)>=12&&parseFloat(b.minHeight)>=40;})()`,
      ),
      `desktop remote safe area and touch target ${width}px`,
    );
  }
  assert.equal(
    await evaluate(
      `(async()=> (await fetch('/api/workspace/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:'project.save',cwd:'/tmp'})})).status)()`,
    ),
    403,
    "remote cannot add arbitrary projects",
  );
  assert.equal(
    await evaluate(
      `(async()=> (await fetch('/api/workspace/command',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command:'conversation.create',projectId:${JSON.stringify(project.id)}})})).status)()`,
    ),
    200,
    "remote can create a session in the selected project",
  );
  await f.call("/api/remote", { action: "rotate" });
  assert.equal(
    await evaluate("fetch('/api/workspace').then(r=>r.status)"),
    401,
  );
  assert.equal(driver.errors.length, 0, driver.errors.join("\n"));
  console.log(
    "Desktop phone acceptance passed: real QR decoding, HTTPS cookie, selected project, isolated Pi messages, session switching/reload, 320/360/390/430px, remote session drawer and revocation.",
  );
} finally {
  driver?.close();
  browser?.kill("SIGTERM");
  if (browserExit) await browserExit;
  await f?.close();
  for (const socket of sockets) socket.destroy();
  if (edge) await new Promise((resolve) => edge.close(resolve));
  await rm(root, { recursive: true, force: true });
}
