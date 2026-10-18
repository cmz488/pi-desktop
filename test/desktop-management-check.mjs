import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";
import {
  embeddedPiSdk as sdk,
  loadEmbeddedPiSdk,
} from "../src/agent/pi-sdk.mjs";
import { nativeSessionDirectory } from "../src/session/pi-session-storage.mjs";

await loadEmbeddedPiSdk();
const f = await desktopFixture();
let browser, driver;
try {
  const manager = sdk.SessionManager.create(
    f.other,
    await nativeSessionDirectory(f.other, f.agentDir),
  );
  manager.appendSessionInfo("Archive fixture");
  manager.appendMessage({
    role: "user",
    content: "fixture question",
    timestamp: 1,
  });
  const source = await readFile(manager.getSessionFile(), "utf8");
  const catalog = await until(
    () => f.call("/api/workspace"),
    (value) => value.agents.some((row) => row.source === "pi"),
  );
  const row = catalog.agents.find((row) => row.source === "pi");
  const project = catalog.projects.find(
    (candidate) => candidate.id === row.projectId,
  );
  const profile = join(f.root, "browser");
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
  const { call, evaluate, until: wait } = driver;
  await call("Page.navigate", { url: f.app.url });
  await wait(`!!document.querySelector('.agent[data-agent-id="${row.id}"]')`);
  await evaluate(
    `document.querySelector('.agent[data-agent-id="${row.id}"]').click()`,
  );
  await wait(
    "document.querySelector('#runtime')?.contentDocument?.querySelector('#messages')?.textContent.includes('fixture question')",
  );
  await evaluate(
    `document.querySelector('.agent[data-agent-id="${row.id}"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:180,clientY:200}))`,
  );
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.equal(
    await evaluate(
      "document.querySelector('#agent-menu [data-command=\"agent.archive\"]').disabled",
    ),
    false,
    "Stopped native history must remain archivable while the menu is open across polling",
  );
  await evaluate(
    "document.querySelector('#agent-menu [data-command=\"agent.archive\"]').click()",
  );
  const started = performance.now();
  await wait(`!document.querySelector('.agent[data-agent-id="${row.id}"]')`, {
    timeoutMs: 5000,
  });
  console.log(
    `Selected native history archive: ${Math.round(performance.now() - started)}ms`,
  );
  await assert.rejects(readFile(manager.getSessionFile()), { code: "ENOENT" });
  await evaluate(
    'document.querySelector("#filter-toggle").click();document.querySelector(\'#agent-menu [data-view-option="archived:only"]\').click()',
  );
  await wait(`!!document.querySelector('.agent[data-agent-id="${row.id}"]')`);
  await evaluate(
    `document.querySelector('.agent[data-agent-id="${row.id}"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:180,clientY:200}))`,
  );
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.equal(
    await evaluate(
      "document.querySelector('#agent-menu [data-command=\"agent.restore\"]').disabled",
    ),
    false,
    "Archived history must remain restorable across polling",
  );
  await evaluate(
    "document.querySelector('#agent-menu [data-command=\"agent.restore\"]').click()",
  );
  await wait(`!document.querySelector('.agent[data-agent-id="${row.id}"]')`);
  await evaluate(
    'document.querySelector("#filter-toggle").click();document.querySelector(\'#agent-menu [data-view-option="archived:hide"]\').click()',
  );
  assert.equal(await readFile(manager.getSessionFile(), "utf8"), source);
  await wait(`!!document.querySelector('.agent[data-agent-id="${row.id}"]')`);
  await f.command("agent.resume", { id: row.id });
  await wait(
    `!!document.querySelector('.agent[data-agent-id="${row.id}"] .dot.running')`,
  );
  await evaluate(
    `document.querySelector('.agent[data-agent-id="${row.id}"]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:180,clientY:200}))`,
  );
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.equal(
    await evaluate(
      "document.querySelector('#agent-menu [data-command=\"agent.archive\"]').disabled",
    ),
    true,
    "Running sessions must stay protected across polling",
  );
  await evaluate(
    "document.querySelector('#agent-menu [data-command=\"agent.stop\"]').click()",
  );
  await wait(
    `!!document.querySelector('.agent[data-agent-id="${row.id}"] .dot.stopped')`,
  );
  const stoppedSource = await readFile(manager.getSessionFile(), "utf8");
  await evaluate(
    `document.querySelector('.project[data-project-id="${project.id}"] .project-name').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:180,clientY:200}))`,
  );
  assert(
    await evaluate(
      "[...document.querySelector('#agent-menu').children].some(item => /移除|删除/.test(item.textContent))",
    ),
    "Workspace context menu must allow removing the workspace",
  );
  await evaluate(
    "document.querySelector('#agent-menu [data-command=\"project.remove\"]').click()",
  );
  await wait('document.querySelector("#remove-project-dialog").open');
  assert(
    await evaluate(
      'document.querySelector("#remove-project-description").textContent.includes("会保留")',
    ),
  );
  await evaluate('document.querySelector("#remove-project-cancel").click()');
  assert(
    await evaluate(
      `!!document.querySelector('.project[data-project-id="${project.id}"]')`,
    ),
  );
  await evaluate(
    `document.querySelector('.project[data-project-id="${project.id}"] .project-name').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true,clientX:180,clientY:200}));document.querySelector('#agent-menu [data-command="project.remove"]').click();document.querySelector('#remove-project-form').requestSubmit()`,
  );
  await wait(
    `!document.querySelector('.project[data-project-id="${project.id}"]') && !document.querySelector('#remove-project-dialog').open`,
  );
  assert.equal(await readFile(manager.getSessionFile(), "utf8"), stoppedSource);
  await new Promise((resolve) => setTimeout(resolve, 5500));
  assert.equal(
    await evaluate(
      `!!document.querySelector('.agent[data-agent-id="${row.id}"]')`,
    ),
    false,
    "Polling must not resurrect removed workspaces",
  );
  const restored = await f.command("project.save", {
    cwd: project.cwd,
    name: project.name,
  });
  assert.equal(restored.id, project.id);
  await wait(`!!document.querySelector('.agent[data-agent-id="${row.id}"]')`);
  assert.deepEqual(driver.errors, []);
  console.log("Workspace management acceptance passed.");
} finally {
  driver?.close();
  browser?.kill();
  await f.close();
}
