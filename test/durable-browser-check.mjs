import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

const root = await mkdtemp(join(tmpdir(), "pi-durable-browser-"));
let app, browser, driver;
try {
  const cwd = join(root, "project"),
    other = join(root, "other");
  await mkdir(cwd);
  await mkdir(other);
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 1000 });
  models.setProvider(faux.provider);
  const workspace = await openAgentWorkspace({
    storage: new MemoryStorage(),
    models,
    settings: { retry: { enabled: false } },
  });
  app = await startDurableDesk({ workspace, port: 0 });
  const profile = join(root, "browser");
  browser = spawn(
    "/usr/bin/chromium",
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  driver = await browserDriver(profile);
  const { call, evaluate, until } = driver;
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1320,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: app.url });
  await until(
    "document.querySelector('#connection-status')?.textContent==='Pi 已连接'",
  );
  assert(await evaluate("!!document.querySelector('#workspace-right')"));
  await evaluate(
    `document.querySelector('[data-action="new-session"]').click()`,
  );
  await until(
    "document.querySelector('#dialog').open && !!document.querySelector('[name=agentName]')",
  );
  await evaluate(
    `(() => {const form=document.querySelector('#dialog-form');form.elements.agentName.value='Agent A';form.elements.agentCwd.value=${JSON.stringify(cwd)};form.requestSubmit()})()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent A'",
  );
  const first = (await workspace.read()).agents.find(
    (agent) => agent.name === "Agent A",
  ).id;
  await evaluate("document.querySelector('#prompt').value='draft A'");
  await evaluate(
    `document.querySelector('[data-action="new-session"]').click()`,
  );
  await until(
    "document.querySelector('#dialog').open && !!document.querySelector('[name=agentName]')",
  );
  await evaluate(
    `(() => {const form=document.querySelector('#dialog-form');form.elements.agentName.value='Agent B';form.elements.agentCwd.value=${JSON.stringify(other)};form.requestSubmit()})()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent B'",
  );
  assert.equal(await evaluate("document.querySelector('#prompt').value"), "");
  await evaluate(
    `document.querySelector('[data-session-id="${first}"]').click()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent A'",
  );
  assert.equal(
    await evaluate("document.querySelector('#prompt').value"),
    "draft A",
  );
  faux.setResponses([
    fauxAssistantMessage(
      "## Durable response\n\n" + "Streamed output. ".repeat(100),
    ),
  ]);
  await evaluate(`window.originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await window.originalFetch(...args);
      if (new URL(args[0], location.href).pathname === '/api/prompt' && args[1]?.method === 'POST')
        return new Promise(resolve => {window.releasePrompt = () => resolve(response);});
      return response;
    };`);
  await evaluate("document.querySelector('#composer').requestSubmit()");
  await until("document.querySelector('#stop-button').hidden===false");
  await until("!!window.releasePrompt");
  const second = (await workspace.read()).agents.find(
    (agent) => agent.name === "Agent B",
  ).id;
  await evaluate(
    `document.querySelector('[data-session-id="${second}"]').click();document.querySelector('#prompt').value='new draft B'`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent B'",
  );
  assert.equal(
    await evaluate("document.querySelector('#prompt').value"),
    "new draft B",
  );
  await evaluate(
    "window.fetch=window.originalFetch;window.releasePrompt();new Promise(resolve=>setTimeout(resolve,0))",
  );
  assert.equal(
    await evaluate("document.querySelector('#session-title').textContent"),
    "Agent B",
  );
  assert.equal(
    await evaluate("document.querySelector('#prompt').value"),
    "new draft B",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('draft A')",
    ),
    false,
  );
  await evaluate(
    `document.querySelector('[data-session-id="${first}"]').click()`,
  );
  await until(
    "document.querySelector('#messages').innerText.includes('Durable response') && document.querySelector('#stop-button').hidden===true",
  );
  await evaluate("document.querySelector('#agent-config-button').click()");
  await until("document.querySelector('#dialog').open");
  assert(
    await evaluate(
      `document.querySelector('#dialog-form').elements.agentCwd.value===${JSON.stringify(cwd)}`,
    ),
  );
  await evaluate(
    "document.querySelector('#dialog [data-action=close-dialog]').click()",
  );
  const screenshot = join(tmpdir(), "pi-durable-desk-desktop.png");
  await writeFile(
    screenshot,
    Buffer.from((await call("Page.captureScreenshot")).data, "base64"),
  );
  for (const width of [320, 360, 390]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 820,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert(
      await evaluate("document.documentElement.scrollWidth<=innerWidth"),
      `page overflows at ${width}`,
    );
    await evaluate("document.querySelector('[data-action=sidebar]').click()");
    assert(await evaluate("document.body.classList.contains('sidebar-open')"));
    await evaluate(
      `document.querySelector('[data-session-id="${second}"]').click()`,
    );
    await until(
      "document.querySelector('#session-title').textContent==='Agent B'",
    );
    assert.equal(
      await evaluate("document.querySelector('#prompt').value"),
      "new draft B",
    );
    await evaluate("document.querySelector('#agent-config-button').click()");
    await until("document.querySelector('#dialog').open");
    assert(
      await evaluate(
        "document.querySelector('#dialog').getBoundingClientRect().right<=innerWidth",
      ),
    );
    await evaluate(
      "document.querySelector('#dialog [data-action=close-dialog]').click()",
    );
    await call("Emulation.setDeviceMetricsOverride", {
      width: 1320,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      `document.querySelector('[data-session-id="${first}"]').click()`,
    );
    await until(
      "document.querySelector('#session-title').textContent==='Agent A'",
    );
  }
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "fetch failed",
    }),
  ]);
  await evaluate(
    "document.querySelector('#prompt').value='reproduce failed model request';document.querySelector('#composer').requestSubmit()",
  );
  await until(
    "document.querySelector('#messages').innerText.includes('fetch failed') && document.querySelector('#stop-button').hidden===true",
  );
  assert(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('模型请求失败')",
    ),
  );
  assert(
    await evaluate(
      "getComputedStyle(document.querySelector('.model-request-error')).display==='flex' && document.querySelector('.model-request-error').getBoundingClientRect().height<=32 && !document.querySelector('.model-request-error').closest('.context-activity')",
    ),
    "failed model requests should use a compact row outside the activity fold",
  );
  faux.setResponses([fauxAssistantMessage("recovered response")]);
  await evaluate(
    "document.querySelector('#prompt').value='retry after network recovery';document.querySelector('#composer').requestSubmit()",
  );
  await until(
    "document.querySelector('#messages').innerText.includes('recovered response') && document.querySelector('#stop-button').hidden===true",
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    `Durable Chromium passed: project creation, independent drafts, background streaming, configuration, 320/360/390px; screenshot ${screenshot}`,
  );
} finally {
  driver?.close();
  if (browser && browser.exitCode === null)
    await new Promise((resolve) => {
      browser.once("exit", resolve);
      browser.kill();
    });
  await app?.stop();
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
