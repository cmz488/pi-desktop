import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
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
      (await f.legacyFork(actor.id, source, { mode: "tail" })).sessionId,
    );
  const profile = join(f.root, "navigation-browser");
  browser = spawn(
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
    let releaseSelection;
    const selectionGate=new Promise(resolve=>releaseSelection=resolve);
    const probe=window.navigationProbe={held:[],selections:[],switches:[],selectionHeld:[],holdSelection:'',release(){released=true;release();},releaseSelection(){probe.holdSelection='';releaseSelection();}};
    window.addEventListener('message',event=>{if(event.data?.type==='pi-desktop:select-conversation')probe.selections.push(event.data);});
    window.fetch=async(...args)=>{
      if(String(args[0]).includes('/api/switch-session'))probe.switches.push(JSON.parse(args[1].body));
      const response=await fetcher(...args);
      if(String(args[0]).includes('/api/state')&&!released){probe.held.push(String(args[0]));await gate;}
      else if(String(args[0]).includes('/api/state')&&probe.holdSelection&&new URL(String(args[0]),location.href).searchParams.get('sessionId')===probe.holdSelection){probe.selectionHeld.push(String(args[0]));await selectionGate;}
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
    `(()=>{const d=${frame};d.defaultView.navigationProbe.holdSelection=${JSON.stringify(branches[1])};d.defaultView.navigationProbe.release();})()`,
  );
  await ready(
    `(()=>{const d=${frame};return d.defaultView.navigationProbe.selectionHeld.length>0;})()`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(left(branches[1]))}).classList.contains('selected')`,
    ),
    true,
    "新分支仍在加载时，初始根通知也不能覆盖最后选择",
  );
  await evaluate(
    `(()=>{const d=${frame};d.defaultView.navigationProbe.releaseSelection();})()`,
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
  const frameTree = await call("Page.getFrameTree");
  const childFrame = frameTree.frameTree.childFrames.find((row) =>
    new URL(row.frame.url).pathname.startsWith(prefix + "/"),
  );
  const { executionContextId } = await call("Page.createIsolatedWorld", {
    frameId: childFrame.frame.id,
    worldName: "navigation-message-source",
  });
  await call("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `window.postMessage({type:'pi-desktop:select-conversation',conversationId:${Number(source)},generation:0},location.origin)`,
  });
  await ready(
    `(()=>{const d=${frame};return d.defaultView.navigationProbe.selections.some(row=>row.generation===0&&row.conversationId===${Number(source)});})()`,
  );
  assert.equal(
    await evaluate(
      `(()=>{const d=${frame};return d.defaultView.navigationProbe.switches.length;})()`,
    ),
    switches,
    "非父窗口发来的同源消息不能切换会话",
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
  const other = await f.command("conversation.create", {
    projectId: project.id,
    name: "旧窗口来源",
  });
  const otherButton = `#projects button[data-agent-id="${other.id}"]:not([data-conversation-id])`;
  await ready(`!!document.querySelector(${JSON.stringify(otherButton)})`);
  await evaluate(
    `document.querySelector(${JSON.stringify(otherButton)}).click()`,
  );
  await ready(
    `(()=>{const d=${frame};return d?.defaultView.navigationProbe?.held.length>0;})()`,
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(left(branches[0]))}).click()`,
  );
  await ready(
    `document.querySelector('#runtime')?.dataset.owner===${JSON.stringify(actor.id)}`,
  );
  const oldFrame = `document.querySelector('iframe[data-owner="${other.id}"]')?.contentDocument`;
  await evaluate(
    `(()=>{const d=${oldFrame};d.defaultView.navigationProbe.release();})()`,
  );
  await evaluate(
    `(()=>{const w=(${oldFrame}).defaultView;window.foreignNavigationMessages=0;window.addEventListener('message',event=>{if(event.source===w&&['pi-desktop:ready','pi-desktop:session-changed'].includes(event.data?.type))window.foreignNavigationMessages++;});})()`,
  );
  const cachedFrames = await call("Page.getFrameTree");
  const cachedFrame = cachedFrames.frameTree.childFrames.find((row) =>
    new URL(row.frame.url).pathname.startsWith(`/agents/${other.id}/`),
  );
  const foreignContext = await call("Page.createIsolatedWorld", {
    frameId: cachedFrame.frame.id,
    worldName: "old-agent-message-source",
  });
  await call("Runtime.evaluate", {
    contextId: foreignContext.executionContextId,
    expression: `window.parent.postMessage({type:'pi-desktop:ready'},location.origin);window.parent.postMessage({type:'pi-desktop:session-changed',conversationId:${Number(source)},initial:false},location.origin)`,
  });
  await ready("window.foreignNavigationMessages>=2");
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(left(branches[0]))}).classList.contains('selected')`,
    ),
    true,
    "旧 Agent 窗口的就绪与首次状态不能覆盖当前 Agent 的选择",
  );
  assert.equal(
    await evaluate(
      `(()=>{const d=${frame};return d.querySelector('#sessions .session.active').dataset.sessionId;})()`,
    ),
    branches[0],
  );
  assert.equal(f.requests.length, 1, "导航只调用会话 API，不重放模型");
  await f.command("agent.stop", { id: actor.id });
  await f.command("agent.archive", { id: actor.id });
  await evaluate("document.querySelector('#filter-toggle').click()");
  await ready("!document.querySelector('#agent-menu').hidden");
  await evaluate(
    "[...document.querySelectorAll('#agent-menu [role=menuitemradio]')].find(node=>node.textContent.startsWith('显示归档')).click()",
  );
  await call("Page.reload", { ignoreCache: true });
  await ready(`!!document.querySelector(${JSON.stringify(left(branches[0]))})`);
  await evaluate(
    `document.querySelector(${JSON.stringify(left(branches[0]))}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:160}))`,
  );
  await ready("!document.querySelector('#agent-menu').hidden");
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('#agent-menu [data-command]')].map(node=>node.dataset.command)",
    ),
    [],
    "归档分支菜单不能提供会话族恢复或其他 Agent 命令",
  );
  assert.equal(
    await evaluate("document.activeElement.getAttribute('aria-disabled')"),
    "true",
    "只读说明可被聚焦，但不伪装可执行恢复",
  );
  assert.match(
    await evaluate("document.querySelector('#agent-menu').textContent"),
    /Agent 菜单恢复整个会话族/,
    "归档说明必须明确真正的恢复作用域",
  );
  assert.equal(
    (await f.call("/api/workspace")).agents.find((row) => row.id === actor.id)
      .archived,
    true,
    "查看归档分支菜单不恢复所属 Agent",
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await ready("document.querySelector('#agent-menu').hidden");
  assert.equal(
    await evaluate(
      `document.activeElement.matches(${JSON.stringify(left(branches[0]))})`,
    ),
    true,
    "Escape 关闭只读菜单并归还焦点",
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(rootButton)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:160}))`,
  );
  await ready("!document.querySelector('#agent-menu').hidden");
  assert.equal(
    await evaluate(
      "!!document.querySelector('#agent-menu [data-command=\"agent.restore\"]:not(:disabled)')",
    ),
    true,
    "归档根 Agent 仍提供可执行的整族恢复入口",
  );
  await evaluate(
    "document.querySelector('#agent-menu [data-command=\"agent.restore\"]').click()",
  );
  const restored = await until(
    () => f.call("/api/workspace"),
    (value) =>
      value.agents.find((row) => row.id === actor.id).archived === false,
  );
  const restoredAgent = restored.agents.find((row) => row.id === actor.id);
  assert.equal(
    restoredAgent.branches.length,
    2,
    "根 Agent 菜单仍恢复整个会话族，保留全部分支",
  );
  assert.equal(restoredAgent.status, "stopped", "恢复文件不自动启动 Agent");
  assert.deepEqual(driver.errors, []);
  console.log(
    "Sidebar navigation passed: latest loading intent, generation guard, reload, and archived branch/Agent menu isolation.",
  );
} finally {
  driver?.close();
  if (browser && browser.exitCode === null) {
    const exited = once(browser, "close");
    browser.kill("SIGTERM");
    await exited;
  }
  // Chromium 关闭后，子进程可能仍在完成 profile 的原子替换。
  await rm(join(f.root, "navigation-browser"), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  await f.close();
}
