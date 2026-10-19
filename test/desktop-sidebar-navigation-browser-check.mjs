import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

// 只延迟真实 HTTP 的观察回执，不能用假状态替代首次加载时的导航竞态。
const f = await desktopFixture({ noExtensions: true });
let browser, driver;
try {
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "加载期导航",
  });
  const prefix = `/agents/${actor.id}`;
  const source = (await f.call(`${prefix}/api/state`)).sessionId;
  await f.call(`${prefix}/api/prompt?sessionId=${source}`, {
    sessionId: source,
    message: "navigation source",
  });
  await until(
    () => f.call(`${prefix}/api/state`),
    (value) =>
      value.idle &&
      value.messages.some((row) => row.text === "answer: navigation source"),
  );
  const branches = [];
  for (let index = 0; index < 2; index++)
    branches.push(
      (await f.command("conversation.fork", { id: actor.id, generation: 0 }))
        .sessionId,
    );
  const profile = join(f.root, "navigation-browser");
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
  const { call, evaluate, until: ready } = driver;
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
    if (window.parent===window) return;
    const fetcher=window.fetch.bind(window);let released=false,release;
    const gate=new Promise(resolve=>release=resolve);
    const probe=window.navigationProbe={held:[],selections:[],switches:[],release(){released=true;release();}};
    window.addEventListener('message',event=>{if(event.data?.type==='pi-desktop:select-conversation')probe.selections.push(event.data);});
    window.fetch=async(...args)=>{
      if(String(args[0]).includes('/api/switch-session'))probe.switches.push(JSON.parse(args[1].body));
      const response=await fetcher(...args);
      if(String(args[0]).includes('/api/state')&&!released){probe.held.push(String(args[0]));await gate;}
      return response;
    };
  })()`,
  });
  const url = new URL(f.app.url);
  url.searchParams.set("agent", actor.id);
  await call("Page.navigate", { url: url.href });
  const frame = "document.querySelector('#runtime')?.contentDocument";
  const left = (id) =>
    `#projects button[data-agent-id="${actor.id}"][data-conversation-id="${id}"]`;
  await ready(
    `(()=>{const d=${frame};return d?.defaultView.navigationProbe?.held.length>0;})()`,
  );
  for (const branch of branches) {
    await ready(`!!document.querySelector(${JSON.stringify(left(branch))})`);
    await evaluate(
      `document.querySelector(${JSON.stringify(left(branch))}).click()`,
    );
  }
  await ready(
    `(()=>{const d=${frame};return d.defaultView.navigationProbe.selections.some(row=>row.conversationId===${Number(branches[1])});})()`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(left(branches[1]))}).classList.contains('selected')`,
    ),
    true,
  );
  await evaluate(
    `(()=>{const d=${frame};d.defaultView.navigationProbe.release();})()`,
  );
  await ready(
    `(()=>{const d=${frame};return d?.querySelector('#connection-status')?.textContent==='Pi 已连接'&&d.querySelector('#sessions .session.active')?.dataset.sessionId===${JSON.stringify(branches[1])};})()`,
    { timeoutMs: 15000 },
  );
  assert.equal(
    await evaluate(
      `(()=>{const d=${frame};return d.querySelector('#sessions .session.active').dataset.sessionId;})()`,
    ),
    branches[1],
    "首次状态回执不得丢弃加载期间最后选择的分支",
  );
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(left(branches[1]))}).classList.contains('selected')`,
    ),
    true,
    "初始根会话通知不能覆盖侧栏最新选择",
  );
  const switches = await evaluate(
    `(()=>{const d=${frame};return d.defaultView.navigationProbe.switches.length;})()`,
  );
  await evaluate(
    `document.querySelector('#runtime').contentWindow.postMessage({type:'pi-desktop:select-conversation',conversationId:${Number(source)},generation:1},location.origin)`,
  );
  await ready(
    `(()=>{const d=${frame};return d.defaultView.navigationProbe.selections.some(row=>row.generation===1);})()`,
  );
  assert.equal(
    await evaluate(
      `(()=>{const d=${frame};return d.defaultView.navigationProbe.switches.length;})()`,
    ),
    switches,
    "代际过期的选择消息不能到达会话 API",
  );
  const rootButton = `#projects button[data-agent-id="${actor.id}"]:not([data-conversation-id])`;
  await evaluate(
    `document.querySelector(${JSON.stringify(rootButton)}).click()`,
  );
  await ready(
    `(()=>{const d=${frame};return d.querySelector('#sessions .session.active')?.dataset.sessionId===${JSON.stringify(source)};})()`,
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(rootButton)}).click()`,
  );
  await evaluate(
    `(()=>{const d=${frame};d.querySelector('#sessions [data-session-id="${branches[0]}"]').click();})()`,
  );
  await ready(
    `document.querySelector(${JSON.stringify(left(branches[0]))})?.classList.contains('selected')`,
  );
  assert.equal(
    await evaluate(
      `(()=>{const d=${frame};return d.querySelector('#sessions .session.active').dataset.sessionId;})()`,
    ),
    branches[0],
    "重复根选择不阻断随后内层发起的会话选择",
  );
  await call("Page.reload", { ignoreCache: true });
  await ready(
    `(()=>{const d=${frame};return d?.defaultView.navigationProbe?.held.length>0;})()`,
  );
  await evaluate(
    `(()=>{const d=${frame};d.defaultView.navigationProbe.release();})()`,
  );
  await ready(
    `(()=>{const d=${frame};return d.querySelector('#sessions .session.active')?.dataset.sessionId===${JSON.stringify(branches[0])};})()`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(left(branches[0]))}).classList.contains('selected')`,
    ),
    true,
    "重载保留同代际的最新选择",
  );
  assert.equal(f.requests.length, 1, "导航只调用会话 API，不重放模型");
  assert.deepEqual(driver.errors, []);
  console.log(
    "Sidebar loading navigation passed: latest branch intent survives initial state and both selectors agree.",
  );
} finally {
  driver?.close();
  if (browser && browser.exitCode === null) {
    const exited = once(browser, "close");
    browser.kill("SIGTERM");
    await exited;
  }
  await f.close();
}
