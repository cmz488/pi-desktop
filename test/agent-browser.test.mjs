import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentBrowser,
  validateBrowserArgs,
} from "../src/agent/agent-browser.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { until, desktopFixture } from "./desktop-fixture.mjs";

test("shared browser cannot change its connection or TLS policy; projectless writes are blocked", () => {
  for (const args of [
    ["open", "https://pi.dev", "--ignore-https-errors"],
    ["open", "https://pi.dev", "--cdp=9222"],
    ["--session", "other", "snapshot"],
    ["fill", "input", "x"],
    ["eval", "1+1"],
    ["screenshot", "/tmp/x"],
  ]) {
    assert.throws(() => validateBrowserArgs(args, true));
  }
  assert.deepEqual(
    validateBrowserArgs(["--session", "desktop", "snapshot", "-i"], true),
    ["snapshot", "-i"],
  );
  assert.throws(() => validateBrowserArgs(["open", "file:///tmp/x"]));
});

test(
  "independent Desktop workers expose native browser defaults and stopping one leaves the other browser live",
  { timeout: 60000 },
  async (t) => {
    const f = await desktopFixture();
    t.after(() => f.close());
    const a = await f.command("conversation.create", { projectId: null });
    const project = (await f.call("/api/workspace")).projects[0];
    const b = await f.command("conversation.create", { projectId: project.id });
    const pages = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(`<title>${req.url}</title><h1>${req.url}</h1>`);
    });
    await new Promise((resolve) => pages.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      pages.closeAllConnections();
      await new Promise((r) => pages.close(r));
    });
    const url = `http://127.0.0.1:${pages.address().port}`;
    for (const agent of [a, b]) {
      const state = await f.call(`/agents/${agent.id}/api/state`);
      assert(state.capabilities.agentBrowser);
      const descriptor = await f.call(`/agents/${agent.id}/api/agent`);
      assert(JSON.stringify(descriptor).includes("agent_browser"));
      await f.call(`/agents/${agent.id}/api/browser`, {
        action: "navigate",
        url: url + (agent === a ? "/A" : "/B"),
      });
    }
    const readA = await f.call(`/agents/${a.id}/api/browser`),
      readB = await f.call(`/agents/${b.id}/api/browser`);
    assert(readA.tabs.some((tab) => tab.url.endsWith("/A")));
    assert(!readA.tabs.some((tab) => tab.url.endsWith("/B")));
    assert(readB.tabs.some((tab) => tab.url.endsWith("/B")));
    await f.command("agent.stop", { id: a.id });
    await assert.rejects(
      f.call(`/agents/${a.id}/api/browser`),
      (error) => error.status === 409,
    );
    assert((await f.call(`/agents/${b.id}/api/browser`)).connected);
  },
);

test(
  "upstream Chromium shares tabs and frames, scopes navigation by tab and closes its private socket",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-browser-fixture-"));
    const pages = createServer((req, res) =>
      res.end(`<title>${req.url}</title><h1>Shared browser</h1>`),
    );
    await new Promise((resolve) => pages.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${pages.address().port}`;
    const browser = await createAgentBrowser({ directory });
    t.after(async () => {
      await browser.close();
      pages.closeAllConnections();
      await new Promise((r) => pages.close(r));
      await rm(directory, { recursive: true, force: true });
    });
    const a = await browser.execute({ action: "new", url: url + "/one" });
    const first = a.tabs.find((row) => row.url.endsWith("/one"));
    assert(first?.active, JSON.stringify(a));
    await until(
      () => browser.frame(),
      (value) => !!value,
    );
    assert(browser.frame().bytes.length > 100);
    assert(browser.frame().width > 0);
    const previousFrame = browser.frame().id;
    await browser.execute({ action: "resize", width: 720, height: 900 });
    await until(
      () => browser.frame(),
      (value) =>
        value.id > previousFrame &&
        value.width === 1440 &&
        value.height === 1800,
    );
    await browser.execute({ action: "new", url: url + "/two" });
    const value = await browser.execute({
      action: "navigate",
      id: first.id,
      url: url + "/changed",
    });
    assert(value.tabs.some((row) => row.url.endsWith("/two")));
    assert(
      value.tabs.some(
        (row) =>
          row.id === first.id && row.url.endsWith("/changed") && row.active,
      ),
    );
    const key = join(directory, "key.pem"),
      cert = join(directory, "cert.pem");
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
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
    const tls = createHttpsServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (_req, res) => res.end("untrusted fixture"),
    );
    await new Promise((r) => tls.listen(0, "127.0.0.1", r));
    t.after(async () => {
      tls.closeAllConnections();
      await new Promise((r) => tls.close(r));
    });
    await assert.rejects(
      browser.execute({
        action: "navigate",
        url: `https://127.0.0.1:${tls.address().port}`,
      }),
      /证书校验失败/,
    );
    await assert.rejects(
      browser.execute({
        action: "input",
        events: [{ type: "Runtime.evaluate" }],
      }),
      /输入无效/,
    );
    await browser.close();
    await assert.rejects(browser.execute({ action: "reload" }), /已关闭/);
  },
);

test(
  "Pi native agent_browser tool uses the sidebar Chromium and retains Pi approval hooks",
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-native-browser-fixture-"));
    const cwd = join(root, "project"),
      agentDir = join(root, "agent"),
      directory = join(root, "data");
    await Promise.all([cwd, agentDir].map((path) => mkdir(path)));
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "browser-fixture",
        defaultModel: "local",
        cacheWarming: "off",
        defaultTools: ["agent_browser"],
        extensions: [
          fileURLToPath(
            new URL(
              "../node_modules/pi-agent-browser-native/dist/extensions/agent-browser/index.js",
              import.meta.url,
            ),
          ),
        ],
      }),
    );
    const pages = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<title>Native shared fixture</title><input id=\"name\"><button onclick=\"document.querySelector('h1').textContent=document.querySelector('input').value\">Apply</button><h1>Before</h1>",
      );
    });
    await new Promise((resolve) => pages.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${pages.address().port}/`;
    const providers = await openDurableModels({ agentDir, directory });
    const faux = fauxProvider({
      provider: "browser-fixture",
      models: [{ id: "local", input: ["text", "image"] }],
      tokensPerSecond: 10000,
    });
    providers.models.setProvider(faux.provider);
    const app = await startDurableDesk({
      cwd,
      agentDir,
      directory,
      providers,
      embeddedUI: true,
      port: 0,
    });
    t.after(async () => {
      await app.stop();
      pages.closeAllConnections();
      await new Promise((r) => pages.close(r));
      await rm(root, { recursive: true, force: true });
    });
    const origin = new URL(app.url).origin;
    const call = async (path, input) => {
      const response = await fetch(
        origin + path,
        input === undefined
          ? {}
          : {
              method: "POST",
              headers: { Origin: origin, "Content-Type": "application/json" },
              body: JSON.stringify(input),
            },
      );
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data;
    };
    await until(
      () => call("/api/state"),
      (value) => !value.initializing,
    );
    assert.equal((await call("/api/state")).capabilities.agentBrowser, true);
    let index = 0;
    async function tool(args, approval = false) {
      const id = `browser-${++index}`;
      faux.setResponses([
        fauxAssistantMessage(
          [
            {
              type: "toolCall",
              id,
              name: "agent_browser",
              arguments: { args },
            },
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(`finished ${id}`),
      ]);
      await call("/api/prompt", { message: id, requestId: id });
      if (approval) {
        const job = await until(
          () => call("/api/interactions"),
          (value) => value.rows.some((row) => row.prompt),
        );
        const row = job.rows.find((row) => row.prompt);
        await call("/api/interaction-reply", {
          id: row.id,
          promptId: row.prompt.id,
          value: "yes",
        });
      }
      const state = await until(
        () => call("/api/state"),
        (value) =>
          value.idle &&
          value.messages.some((row) => row.text === `finished ${id}`),
        45000,
      );
      const result = state.messages.find((row) => row.toolCallId === id);
      assert(result && !result.isError, JSON.stringify(result));
      return result.text;
    }
    await call("/api/approval", { mode: "ask-risky" });
    const opened = await tool(["open", url], true);
    const shared = await call("/api/browser");
    await call("/api/approval", { mode: "yolo" });
    await tool(["tab", "list"]);
    assert(
      shared.tabs.some((tab) => tab.url === url),
      JSON.stringify({ opened, shared }),
    );
    await call("/api/approval", { mode: "yolo" });
    await tool(["fill", "#name", "Shared from Pi"]);
    await tool(["click", "button"]);
    assert.match(await tool(["get", "text", "h1"]), /Shared from Pi/);
    await until(
      async () => {
        const r = await fetch(origin + "/_browser/frame");
        return {
          status: r.status,
          data: new Uint8Array(await r.arrayBuffer()),
        };
      },
      (value) => value.status === 200 && value.data.length > 100,
    );
    await tool(["focus", "#name"]);
    const browser = await call("/api/browser");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(
      "/tmp/pi-native-browser-fixture.jpg",
      Buffer.from(
        await (await fetch(origin + "/_browser/frame")).arrayBuffer(),
      ),
    );
    await call("/api/browser", {
      action: "input",
      id: browser.tabs.find((row) => row.active).id,
      events: [
        {
          type: "input_mouse",
          eventType: "mousePressed",
          x: 20,
          y: 15,
          button: "left",
          clickCount: 1,
        },
        {
          type: "input_mouse",
          eventType: "mouseReleased",
          x: 20,
          y: 15,
          button: "left",
        },
        {
          type: "input_keyboard",
          eventType: "keyDown",
          key: "U",
          code: "KeyU",
          text: "U",
          windowsVirtualKeyCode: 85,
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.match(await tool(["get", "value", "#name"]), /U/);
    await call("/api/browser", {
      action: "input",
      events: [{ type: "input_keyboard", eventType: "char", text: "中文" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(await tool(["get", "value", "#name"]), /中文/);
    const entries = await readFile(
      join(directory, "browser-profile", "Default", "Preferences"),
      "utf8",
    ).catch(() => "");
    assert(!entries.includes('"ignore_certificate_errors":true'));
  },
);
