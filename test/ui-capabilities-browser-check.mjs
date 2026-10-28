import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

const f = await desktopFixture({ defaultConversation: false });
let chrome, driver;
try {
  const profile = join(f.root, "capabilities-browser");
  chrome = spawn(
    "/usr/bin/chromium",
    [
      "--headless",
      "--password-store=basic",
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
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__failures=[]; addEventListener('unhandledrejection',e=>__failures.push(String(e.reason))); addEventListener('error',e=>__failures.push(e.message));`,
  });
  await call("Page.navigate", { url: f.app.url });
  await until(
    '!!document.querySelector(".sidebar") && !document.querySelector("#splash")',
  );
  await evaluate(
    `[...document.querySelectorAll('button')].find(n=>n.textContent.trim()==='设置').click()`,
  );
  await until(`!!document.querySelector('[role=dialog][aria-modal]')`);
  const clickIfPresent = (text) =>
    evaluate(
      `(()=>{const n=[...document.querySelector('[role=dialog][aria-modal]').querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(n&&!n.disabled){n.click();return true;}return false;})()`,
    );
  await clickIfPresent("外观");
  // These controls used to call unsupported APIs from unhandled async callbacks.
  await clickIfPresent("选择图片");
  if (await clickIfPresent("UI 插件")) {
    await until(
      `!!document.querySelector('[role=dialog][aria-modal] [role=switch]')`,
    );
    await evaluate(
      `document.querySelector('[role=dialog][aria-modal] [role=switch]').click()`,
    );
  }
  await clickIfPresent("关于");
  await clickIfPresent("检查更新");
  await clickIfPresent("导出更新诊断");
  // An awaited metadata round trip also lets preceding event-handler rejections publish.
  await evaluate("window.pi.getAppInfo()");
  assert.deepEqual(await evaluate("window.__failures"), []);
  assert.deepEqual(driver.errors, []);
  assert.equal(
    await evaluate(
      `!![...document.querySelector('[role=dialog][aria-modal] nav').querySelectorAll('button')].find(n=>n.textContent.includes('SSH'))`,
    ),
    false,
  );
  await clickIfPresent("外观");
  assert.equal(await clickIfPresent("UI 插件"), false);
  assert.equal(await clickIfPresent("选择图片"), false);
  await clickIfPresent("深色");
  await until('document.documentElement.dataset.theme==="dark"');
  await clickIfPresent("模型");
  assert.equal(await clickIfPresent("Subagent 配置"), false);
  await evaluate(
    `window.pi.supports=((original)=>(channel)=>channel==='update:check'||original(channel))(window.pi.supports);window.pi.checkForUpdates=async()=>{throw new Error('FIXTURE_UPDATE_FAILURE')}`,
  );
  await clickIfPresent("关于");
  assert.equal(await clickIfPresent("检查更新"), true);
  await until(
    `document.querySelector('[role=dialog][aria-modal] [role=alert]')?.textContent.includes('FIXTURE_UPDATE_FAILURE')`,
  );
  await evaluate(
    `window.pi.checkForUpdates=async()=>{window.__updateRetried=true}`,
  );
  await clickIfPresent("检查更新");
  await until("window.__updateRetried===true");
  assert.equal(
    await evaluate(
      `!!document.querySelector('[role=dialog][aria-modal] [role=alert]')`,
    ),
    false,
  );
  await evaluate("window.pi.checkForUpdates=undefined");
  await clickIfPresent("检查更新");
  await until(
    `document.querySelector('[role=dialog][aria-modal] [role=alert]')?.textContent.includes('checkForUpdates')`,
  );
  assert.deepEqual(await evaluate("window.__failures"), []);
  assert.equal(
    (await f.call("/api/workspace")).agents.length,
    0,
    "settings and discovery do not start a worker",
  );
  await evaluate(
    `document.querySelector('[role=dialog][aria-modal] button[aria-label="关闭"]').click()`,
  );
  await evaluate(
    `document.querySelector('button[aria-label="添加项目"]').click()`,
  );
  await until(
    `!!document.querySelector('[role=dialog][aria-label="添加项目"] input')`,
  );
  const enterProject = (path) =>
    evaluate(
      `(()=>{const node=document.querySelector('[role=dialog][aria-label="添加项目"] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(path)});node.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  const submitProject = () =>
    evaluate(
      `document.querySelector('[role=dialog][aria-label="添加项目"] form').requestSubmit()`,
    );
  await enterProject(f.other + "/missing");
  await submitProject();
  await until(
    `document.querySelector('[role=dialog][aria-label="添加项目"] [role=alert]')?.textContent.includes('项目目录不存在或不可访问')`,
  );
  await enterProject(f.other);
  await submitProject();
  await until(
    `!document.querySelector('[role=dialog][aria-label="添加项目"]')`,
  );
  const afterAdd = await f.call("/api/workspace");
  assert(
    afterAdd.projects.some((project) => project.cwd === f.other),
    "manual project creation reaches the real Host",
  );
  assert.equal(
    afterAdd.agents.length,
    0,
    "adding a directory does not start a worker",
  );
  assert.deepEqual(await evaluate("window.__failures"), []);
  console.log(
    "PASS add project: real validation error, corrected method and persisted directory without starting workers",
  );
  console.log(
    "PASS empty Host settings: no unsupported controls, uncaught exceptions, or accidental worker; theme remains usable",
  );
} finally {
  driver?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill("SIGTERM");
    await exited;
  }
  await f.close();
}
