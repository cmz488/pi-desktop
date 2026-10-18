import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

// 默认 Host/worker、真实任务与完整聊天控制器；仅在浏览器里延迟已读完的响应，模拟无法中止的晚到回复。
const holds = new Map(
  ["hold A", "hold B"].map((key) => [key, Promise.withResolvers()]),
);
const f = await desktopFixture({
  noExtensions: true,
  beforeModelResponse: async (input) => {
    const last = JSON.stringify(input.messages.at(-1).content);
    for (const [key, gate] of holds) if (last.includes(key)) await gate.promise;
  },
});
let browser, driver;
try {
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "Panel A",
  });
  const prefix = `/agents/${actor.id}`;
  const state = (id) =>
    f.call(`${prefix}/api/state${id === undefined ? "" : `?sessionId=${id}`}`);
  const source = (await state()).sessionId;
  const prompt = (id, message) =>
    f.call(`${prefix}/api/prompt?sessionId=${id}`, {
      sessionId: String(id),
      message,
    });
  await prompt(source, "seed");
  const seeded = await until(
    () => state(source),
    (value) =>
      value.idle && value.messages.some((row) => row.text === "answer: seed"),
  );
  const point = seeded.messages.find((row) => row.text === "seed").entryId;
  const branch = (
    await f.call(`${prefix}/api/command?sessionId=${source}`, {
      command: "fork",
      id: Number(source),
      sessionId: source,
      entryId: point,
    })
  ).sessionId;
  await prompt(source, "hold A");
  await prompt(branch, "hold B");
  await until(
    () => state(branch),
    (value) => !value.idle && f.requests.length === 3,
  );
  const url = new URL(f.app.url);
  url.searchParams.set("agent", actor.id);
  const profile = join(f.root, "panel-browser");
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
  const { call, evaluate, until: browserUntil } = driver;
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
const original=window.fetch.bind(window);
const probe=window.panelProbe={holds:new Set(),pending:[],commands:[],holdCommand:false,pendingCommands:[],caps:null,unsupportedTasks:false,unsupportedTree:false};
window.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href);
 const tasks=url.pathname.endsWith('/api/tasks'),tree=url.pathname.endsWith('/api/tree'),state=url.pathname.endsWith('/api/state'),command=url.pathname.endsWith('/api/command');
 if(url.pathname.endsWith('/api/command')&&options.body)probe.commands.push(JSON.parse(options.body));
 if(!tasks&&!tree&&!state&&!command)return original(input,options);
 const headers=new Headers(options.headers);headers.delete('If-None-Match');
 const response=await original(input,{...options,headers});if(!response.ok)return response;
 const value=await response.json();
 if(state&&probe.caps)value.capabilities={...value.capabilities,...probe.caps};
 if((tasks&&probe.unsupportedTasks)||(tree&&probe.unsupportedTree)){for(const key of Object.keys(value))delete value[key];value.supported=false;}
 const id=url.searchParams.get('id')??url.searchParams.get('sessionId');
 if(tasks&&probe.holds.has(id))await new Promise(resolve=>probe.pending.push({id,signal:options.signal,release:resolve}));
 if(command&&probe.holdCommand)await new Promise(resolve=>probe.pendingCommands.push({release:resolve}));
 headers.delete('Content-Length');headers.delete('ETag');headers.set('Content-Type','application/json');
 return new Response(JSON.stringify(value),{status:200,headers});
};
})()`,
  });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: url.href });
  const frame = "document.querySelector('#runtime')?.contentDocument";
  const chat = (source) =>
    evaluate(`(async()=>{const d=${frame};const w=d.defaultView;${source}})()`);
  const ready = (expression) =>
    browserUntil(`(()=>{const d=${frame};return !!d&&(${expression});})()`, {
      timeoutMs: 15000,
    });
  await ready(
    "d.querySelector('#connection-status')?.textContent==='Pi 已连接'",
  );
  await chat("d.querySelector('[data-view=extensions]').click()");
  await ready(
    "!!d.querySelector('[data-extension-key=\"desktop:task-panel\"]')",
  );
  await chat(
    "d.querySelector('[data-extension-key=\"desktop:task-panel\"]').click()",
  );
  await ready(
    `d.querySelector('.task-panel')?.dataset.taskPanel===${JSON.stringify(source)}&&!!d.querySelector('[data-task-id]')`,
  );
  const taskA = await chat(
    "return Number(d.querySelector('[data-task-id]').dataset.taskId)",
  );
  await chat(
    `w.staleCancel=d.querySelector('[data-task-action="cancel:${taskA}"]');w.staleCancel.click();w.panelProbe.holds.add(${JSON.stringify(source)});d.querySelector('[data-task-refresh]').click()`,
  );
  await ready(
    `d.defaultView.panelProbe.pending.some(row=>row.id===${JSON.stringify(source)})`,
  );
  const oldStillVisible = await chat(
    `d.querySelector('[data-session-id="${branch}"]').click();return !!d.querySelector('[data-task-id="${taskA}"]')`,
  );
  assert.equal(
    oldStillVisible,
    false,
    "实际聊天控制器在快照返回前就撤下旧面板",
  );
  assert.equal(
    await chat("return w.panelProbe.pending.every(row=>row.signal.aborted)"),
    true,
    "切换开始就中止未选中页的旧读取",
  );
  await ready(
    `d.querySelector('#sessions .session.active')?.dataset.sessionId===${JSON.stringify(branch)}&&!!d.querySelector('[data-extension-key="desktop:task-panel"]')`,
  );
  await chat(
    "d.querySelector('[data-extension-key=\"desktop:task-panel\"]').click()",
  );
  await ready(
    `d.querySelector('.task-panel')?.dataset.taskPanel===${JSON.stringify(branch)}&&!!d.querySelector('[data-task-id]')`,
  );
  await chat("w.staleCancel.click()");
  assert.equal(
    await chat("return w.panelProbe.commands.length"),
    0,
    "A 的旧回调不能对 B 发出任何任务命令",
  );
  await chat(
    "w.panelProbe.holds.clear();for(const item of w.panelProbe.pending.splice(0))item.release()",
  );
  assert.equal(
    await chat(`return !!d.querySelector('[data-task-id="${taskA}"]')`),
    false,
    "真实旧读模型晚到也不发布",
  );
  const taskB = await chat(
    "return Number(d.querySelector('[data-task-id]').dataset.taskId)",
  );
  await chat(`d.querySelector('[data-task-action="cancel:${taskB}"]').click()`);
  assert.equal(
    await chat("return w.panelProbe.commands.length"),
    0,
    "B 必须重新确认",
  );
  await chat(
    "w.panelProbe.holdCommand=true;d.querySelector('[data-extension-key=\"desktop:branch-tree\"]').click()",
  );
  await ready("!!d.querySelector('[data-branch-action=fork]')");
  await chat("d.querySelector('[data-branch-action=fork]').click()");
  await ready("d.defaultView.panelProbe.pendingCommands.length===1");
  await chat(`d.querySelector('[data-session-id="${source}"]').click()`);
  await ready(
    `d.querySelector('#sessions .session.active')?.dataset.sessionId===${JSON.stringify(source)}&&d.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
  );
  await chat(`d.querySelector('[data-session-id="${branch}"]').click()`);
  await ready(
    `d.querySelector('#sessions .session.active')?.dataset.sessionId===${JSON.stringify(branch)}&&!!d.querySelector('[data-extension-key="desktop:task-panel"]')`,
  );
  await ready(
    `d.querySelector('.branch-tree')?.dataset.branchTree===${JSON.stringify(branch)}&&!!d.querySelector('[data-branch-action=fork]')`,
  );
  await chat(
    "w.panelProbe.holdCommand=false;for(const item of w.panelProbe.pendingCommands.splice(0))item.release()",
  );
  await chat(
    "await new Promise(resolve=>w.requestAnimationFrame(()=>w.requestAnimationFrame(resolve)))",
  );
  assert.equal(
    await chat(
      "return d.querySelector('#sessions .session.active').dataset.sessionId",
    ),
    branch,
    "A/B/A 后旧分叉结果也不能自动改选新会话",
  );
  await chat(
    "d.querySelector('[data-extension-key=\"desktop:task-panel\"]').click()",
  );
  await ready(
    `d.querySelector('.task-panel')?.dataset.taskPanel===${JSON.stringify(branch)}&&!!d.querySelector('[data-task-id]')`,
  );
  const pulse = () =>
    chat(
      "Object.defineProperty(d,'hidden',{configurable:true,value:true});d.dispatchEvent(new w.Event('visibilitychange'));delete d.hidden;d.dispatchEvent(new w.Event('visibilitychange'))",
    );
  await chat("w.panelProbe.caps={readOnly:true}");
  await pulse();
  await ready(
    "!!d.querySelector('[data-task-action]')&&[...d.querySelectorAll('[data-task-action]')].every(node=>node.disabled)",
  );
  assert.equal(
    await chat("return !!d.querySelector('[data-armed=true]')"),
    false,
  );
  await chat(
    "w.panelProbe.caps={readOnly:false,remote:true,tasks:true,sessionTree:true}",
  );
  await pulse();
  await ready(
    "!!d.querySelector('[data-task-action]')&&[...d.querySelectorAll('[data-task-action]')].every(node=>node.disabled)",
  );
  assert.equal(
    await chat(
      "return d.querySelector('#stop-button').hidden||d.querySelector('#stop-button').disabled",
    ),
    false,
    "网关仍允许的会话中止入口不被面板门控禁用",
  );
  await chat(
    "w.panelProbe.caps={readOnly:false,remote:false,tasks:false,sessionTree:false}",
  );
  await pulse();
  await ready(
    "!d.querySelector('[data-extension-key=\"desktop:task-panel\"]')&&!d.querySelector('[data-extension-key=\"desktop:branch-tree\"]')",
  );
  await chat(
    "w.panelProbe.caps={readOnly:false,tasks:true,sessionTree:true};w.panelProbe.unsupportedTasks=true",
  );
  await pulse();
  await ready(
    "!!d.querySelector('[data-extension-key=\"desktop:branch-tree\"]')&&!d.querySelector('[data-extension-key=\"desktop:task-panel\"]')",
  );
  await chat(
    "w.panelProbe.unsupportedTree=true;d.querySelector('[data-extension-key=\"desktop:branch-tree\"]').click();d.querySelector('[data-branch-refresh]').click()",
  );
  await ready(
    "!d.querySelector('[data-extension-key=\"desktop:branch-tree\"]')",
  );
  await chat(
    `d.querySelector('[data-session-id="${branch}"]').dispatchEvent(new w.MouseEvent('contextmenu',{bubbles:true,clientX:90,clientY:120}))`,
  );
  assert.equal(
    await chat("return !!d.querySelector('.session-menu [data-command=tree]')"),
    false,
    "unsupported 连会话栏入口也隐藏",
  );
  for (const [id, taskId] of [
    [source, taskA],
    [branch, taskB],
  ]) {
    const graph = await f.call(`${prefix}/api/tasks?id=${id}`);
    assert.ok(
      graph.tasks.some((row) => row.id === taskId),
      "界面测试没有误取消任一真实任务",
    );
  }
  assert.deepEqual(driver.errors, []);
  console.log(
    "Default Desktop read panels passed: immediate switch invalidation, late native task replies, scoped confirmation, same-session permissions and declared/unsupported entries.",
  );
} finally {
  for (const gate of holds.values()) gate.resolve();
  driver?.close();
  if (browser && browser.exitCode === null) {
    const stopped = once(browser, "close");
    browser.kill("SIGTERM");
    await stopped;
  }
  await f.close();
}
