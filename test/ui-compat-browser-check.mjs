import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { join } from "node:path";
import { concurrentFixture } from "./concurrent-fixture.mjs";
import { startWeb } from "../src/server/web.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";
const f = await concurrentFixture();
f.release("C");
let app, chrome, driver;
try {
  await promisify(execFile)("git", ["init", "-b", "main"], { cwd: f.root });
  app = await startWeb({
    cwd: f.root,
    agentDir: f.agentDir,
    host: "127.0.0.1",
    port: 0,
    noExtensions: true,
  });
  await app.ready;
  chrome = spawn(
    "/usr/bin/chromium",
    [
      "--headless",
      "--password-store=basic",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(f.root, "compat-browser")}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  driver = await browserDriver(join(f.root, "compat-browser"));
  const { call, evaluate, until } = driver;
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__failed=[];const previous=window.fetch;window.fetch=async(...args)=>{const r=await previous(...args);if(!r.ok && !String(args[0]).endsWith('/api/workspace'))window.__failed.push({url:String(args[0]),status:r.status});return r;};`,
  });
  await call("Page.navigate", { url: app.url });
  await until('!!document.querySelector(".sidebar") && !document.querySelector("#splash")');
  await until('!!document.querySelector(".sidebar button[data-session-id]")');
  await evaluate('document.querySelector(".sidebar button[data-session-id]").click()');
  await until('!!document.querySelector("[data-session-page]")?.dataset.sessionId');
  await until(
    '!!document.querySelector("[contenteditable=true][role=textbox]")',
  );
  await evaluate(
    'document.querySelector("[contenteditable=true][role=textbox]").focus()',
  );
  await call("Input.insertText", { text: "TASK C" });
  await until(
    'document.querySelector("[contenteditable=true]").innerText.includes("TASK C")',
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await until(
    'document.querySelector("[data-session-page]").innerText.includes("completed-C")',
    { timeoutMs: 15000 },
  );
  assert.deepEqual(driver.errors, []);
  assert.deepEqual(await evaluate("window.__failed"), []);
  console.log(
    "PASS SDK Web UUID session, actual Percho send/reply, native tool execution and compatibility controls",
  );
} finally {
  driver?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill("SIGTERM");
    await exited;
  }
  await app?.stop();
  await f.stop();
}
