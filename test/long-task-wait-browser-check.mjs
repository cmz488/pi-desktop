import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

const WAIT_DURATION_MS = 16500;
const gate = Promise.withResolvers();
const observerGate = Promise.withResolvers();
const branchGate = Promise.withResolvers();
const f = await desktopFixture({
  noExtensions: true,
  beforeModelResponse: async (input) =>
    input.messages.at(-1).content === "cancel observer"
      ? observerGate.promise
      : input.messages.at(-1).content === "protected branch"
        ? branchGate.promise
        : gate.promise,
});
let browser, driver, releaseTimer;
try {
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "Long wait",
  });
  const prefix = `/agents/${actor.id}`;
  const state = () => f.call(`${prefix}/api/state`);
  const source = (await state()).sessionId;
  await f.call(`${prefix}/api/prompt?sessionId=${source}`, {
    sessionId: source,
    message: "long foreground task",
  });
  await until(state, (value) => !value.idle && f.requests.length === 1);
  const url = new URL(f.app.url);
  url.searchParams.set("agent", actor.id);
  const profile = join(f.root, "wait-browser");
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
  const { call, evaluate, until: browserUntil } = driver;
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
const fetcher=window.fetch.bind(window),schedule=window.setTimeout.bind(window),unschedule=window.clearTimeout.bind(window);
const probe=window.waitProbe={notices:[],requests:[],timers:[],readTimeouts:[],held:[]};
window.setTimeout=(fn,ms,...args)=>{const id=schedule(fn,ms,...args);probe.timers.push({id,ms,fn,args,cleared:false});return id;};
window.clearTimeout=id=>{const timer=probe.timers.findLast(row=>row.id===id);if(timer)timer.cleared=true;return unschedule(id);};
probe.expire=()=>{const timer=probe.timers.findLast(row=>row.ms===300000&&!row.cleared);if(!timer)throw Error('没有等待期限');timer.fn(...timer.args);};
window.fetch=async(input,options={})=>{let command;try{command=JSON.parse(options.body??'{}');}catch{}
 if(command.command!=='wait'){if(String(input).includes('/api/tasks')){probe.readTimeouts.push(probe.timers.at(-1)?.ms);if(probe.unsupportedOnce){probe.unsupportedOnce=false;return new Response(JSON.stringify({supported:false}),{status:200,headers:{'Content-Type':'application/json'}});}}return fetcher(input,options);}
 const request={input:command,started:performance.now(),signal:options.signal,timeout:probe.timers.at(-1)?.ms};probe.requests.push(request);
 if(probe.leaseOnce){probe.leaseOnce=false;request.status=408;return new Response(JSON.stringify({error:'等待租约已到期，任务继续运行'}),{status:408,headers:{'Content-Type':'application/json'}});}
 const hold=probe.holdSuccess;probe.holdSuccess=false;
 try{let response=await fetcher(input,options);request.status=response.status;
  if(response.ok)request.task=(await response.clone().json()).task;
  if(hold&&response.ok){const value=await response.json();response=new Response(JSON.stringify(value),{status:response.status,headers:{'Content-Type':'application/json'}});await new Promise(release=>probe.held.push({release}));}
  request.finished=performance.now();return response;}
 catch(error){request.error=error.message;request.finished=performance.now();throw error;}
};
window.addEventListener('DOMContentLoaded',()=>{const node=document.querySelector('#toast');if(node)new MutationObserver(()=>{if(node.textContent)probe.notices.push(node.textContent);}).observe(node,{childList:true,subtree:true,characterData:true});},{once:true});
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
  const chat = (code) =>
    evaluate(`(async()=>{const d=${frame};const w=d.defaultView;${code}})()`);
  const ready = (expression) =>
    browserUntil(`(()=>{const d=${frame};return !!d&&(${expression});})()`, {
      timeoutMs: 25000,
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
    '!!d.querySelector(\'[data-kind="pi.generation"] [data-task-action^="wait:"]\')',
  );
  const taskId = await chat(
    "return Number(d.querySelector('[data-kind=\"pi.generation\"]').dataset.taskId)",
  );
  await chat(
    'w.waitProbe.notices.length=0;d.querySelector(\'[data-kind="pi.generation"] [data-task-action^="wait:"]\').click()',
  );
  await ready("d.defaultView.waitProbe.requests.length===1");
  const started = Date.now();
  releaseTimer = setTimeout(() => gate.resolve(), WAIT_DURATION_MS);
  await new Promise((resolve) => setTimeout(resolve, 13000));
  assert.equal((await state()).idle, false, "13 秒时真实前台任务仍未结束");
  assert.deepEqual(
    await chat("return w.waitProbe.notices"),
    [],
    "12 秒后不能提前成功或报通用中止",
  );
  assert.equal(await chat("return !!w.waitProbe.requests[0].error"), false);
  await ready("d.defaultView.waitProbe.notices.includes('任务已完成')");
  assert.equal(
    await chat("return w.waitProbe.requests[0].task.status"),
    "terminal",
  );
  assert.equal(
    await chat("return w.waitProbe.requests[0].task.outcome.status"),
    "completed",
  );
  assert.ok(Date.now() - started >= WAIT_DURATION_MS);
  assert.equal((await state()).idle, true);
  assert.ok(
    (await state()).messages.some(
      (row) => row.text === "answer: long foreground task",
    ),
  );
  assert.equal(await chat("return w.waitProbe.requests[0].status"), 200);
  assert.equal(
    await chat("return w.waitProbe.requests[0].input.taskId"),
    taskId,
  );
  const userEntry = (await state()).messages.find(
    (row) => row.role === "user",
  ).entryId;
  const branch = (
    await f.call(`${prefix}/api/command?sessionId=${source}`, {
      command: "fork",
      id: Number(source),
      sessionId: source,
      entryId: userEntry,
    })
  ).sessionId;
  await f.call(`${prefix}/api/prompt?sessionId=${source}`, {
    sessionId: source,
    message: "cancel observer",
  });
  await until(state, (value) => !value.idle && f.requests.length === 2);
  await f.call(`${prefix}/api/prompt?sessionId=${branch}`, {
    sessionId: branch,
    message: "protected branch",
  });
  const branchState = () => f.call(`${prefix}/api/state?sessionId=${branch}`);
  await until(branchState, (value) => !value.idle && f.requests.length === 3);
  await ready(
    `!!d.querySelector('[data-kind="pi.generation"] [data-task-action^="wait:"]')`,
  );
  const heldTask = await chat(
    "return Number(d.querySelector('[data-kind=\"pi.generation\"]').dataset.taskId)",
  );
  await chat(
    `d.querySelector('[data-task-action="wait:${heldTask}"]').focus();d.querySelector('[data-task-action="wait:${heldTask}"]').click()`,
  );
  await ready("d.defaultView.waitProbe.requests.length===2");
  assert.match(
    await chat(
      `return d.querySelector('[data-task-action="wait:${heldTask}"]').textContent`,
    ),
    /取消等待/,
    "在途等待提供独立取消，不混用任务中止",
  );
  assert.equal(
    await chat(`return d.activeElement?.dataset.taskAction`),
    `wait:${heldTask}`,
    "重画保留等待操作焦点",
  );
  await chat(
    `d.querySelector('[data-task-action="wait:${heldTask}"]').click()`,
  );
  assert.equal(
    await chat("return w.waitProbe.requests[1].signal.aborted"),
    true,
    "取消等待中止物理观察请求",
  );
  assert.equal((await state()).idle, false, "取消等待后真实任务仍运行");
  assert.ok(
    (await f.call(`${prefix}/api/tasks?id=${source}`)).tasks.some(
      (row) => row.id === heldTask,
    ),
  );
  assert.equal(
    await chat("return w.waitProbe.requests[1].input.command"),
    "wait",
  );
  assert.equal(
    await chat("return w.waitProbe.notices.at(-1)"),
    "已取消等待，任务继续运行",
  );

  const beforeLease = await chat("return w.waitProbe.notices.slice()");
  await chat(
    `w.waitProbe.leaseOnce=true;d.querySelector('[data-task-action="wait:${heldTask}"]').click()`,
  );
  await ready("d.defaultView.waitProbe.requests.length>=3");
  await chat(
    "await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  assert.equal(
    await chat("return w.waitProbe.requests.length"),
    4,
    "408 续租继续观察，不把到期误报成终态",
  );
  assert.deepEqual(
    await chat("return w.waitProbe.requests[2].input"),
    await chat("return w.waitProbe.requests[3].input"),
    "408 只续同一个不可变目标",
  );
  assert.deepEqual(
    await chat("return w.waitProbe.notices"),
    beforeLease,
    "租约结束不等于任务结束，不提前提示成功",
  );
  assert.equal(
    await chat("return w.waitProbe.timers.filter(row=>row.ms===300000).length"),
    3,
    "续租不重置总期限",
  );
  await chat("w.waitProbe.expire()");
  assert.equal(
    await chat("return w.waitProbe.requests[3].signal.aborted"),
    true,
  );
  assert.equal(
    await chat("return w.waitProbe.notices.at(-1)"),
    "等待时间已到，任务继续运行，可重新等待",
  );
  assert.equal((await state()).idle, false, "观察到期不中止 A");
  assert.equal((await branchState()).idle, false, "观察取消或到期不影响 B");

  await chat(
    `w.waitProbe.holdSuccess=true;d.querySelector('[data-task-action="wait:${heldTask}"]').click()`,
  );
  await ready("d.defaultView.waitProbe.requests.length===5");
  observerGate.resolve();
  await until(state, (value) => value.idle);
  await ready("d.defaultView.waitProbe.held.length===1");
  await ready(`!!d.querySelector('[data-session-id="${branch}"]')`);
  await chat(`d.querySelector('[data-session-id="${branch}"]').click()`);
  assert.equal(
    await chat("return w.waitProbe.requests[4].signal.aborted"),
    true,
    "切换开始即取消旧等待，不等新快照",
  );
  await ready(
    `d.querySelector('#sessions .session.active')?.dataset.sessionId===${JSON.stringify(branch)}`,
  );
  await chat(
    "d.querySelector('[data-extension-key=\"desktop:task-panel\"]').click()",
  );
  await ready(
    `d.querySelector('.task-panel')?.dataset.taskPanel===${JSON.stringify(branch)}&&!!d.querySelector('[data-kind="pi.generation"]')`,
  );
  const notices = await chat("return w.waitProbe.notices.slice()");
  await chat(
    "for(const entry of w.waitProbe.held.splice(0))entry.release();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  assert.equal(
    await chat("return w.waitProbe.requests[4].status"),
    200,
    "旧成功故意忽略 abort 后仍晚到",
  );
  assert.deepEqual(
    await chat("return w.waitProbe.notices"),
    notices,
    "旧等待成功不向另一会话发布结果",
  );
  assert.equal(
    await chat(
      "return d.querySelector('#sessions .session.active')?.dataset.sessionId",
    ),
    String(branch),
  );
  assert.equal(
    (await branchState()).idle,
    false,
    "B 的真实工作不受旧 A 结果影响",
  );
  assert.equal(
    await chat(
      "return w.waitProbe.timers.filter(row=>row.ms===300000&&!row.cleared).length",
    ),
    0,
    "终态、取消、过期和切换都撤销总期限定时器",
  );
  assert.ok(
    await chat(
      "return w.waitProbe.readTimeouts.length>0&&w.waitProbe.readTimeouts.every(ms=>ms===12000)",
    ),
    "普通 API 保持 12 秒超时，不跟随长等待加长",
  );
  assert.ok(
    await chat("return w.waitProbe.requests.every(row=>row.timeout===45000)"),
  );
  const branchTask = await chat(
    "return Number(d.querySelector('[data-kind=\"pi.generation\"]').dataset.taskId)",
  );
  await chat(
    `d.querySelector('[data-task-action="wait:${branchTask}"]').click()`,
  );
  await ready("d.defaultView.waitProbe.requests.length===6");
  await chat(
    "const timer=w.waitProbe.timers.findLast(row=>row.ms===45000&&!row.cleared);timer.fn(...timer.args)",
  );
  await ready("!!d.defaultView.waitProbe.requests[5].error");
  await chat(
    "await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  assert.equal(
    await chat("return w.waitProbe.notices.at(-1)"),
    "等待连接超时，任务继续运行，可重新等待",
    "HTTP 等待超时提供语义错误，不报通用中止",
  );
  assert.equal(
    (await branchState()).idle,
    false,
    "HTTP 连接超时也不中止 B 的工作",
  );
  assert.equal(
    await chat(
      "return w.waitProbe.timers.filter(row=>row.ms===300000&&!row.cleared).length",
    ),
    0,
  );
  await chat(
    `d.querySelector('[data-task-action="wait:${branchTask}"]').click()`,
  );
  await ready("d.defaultView.waitProbe.requests.length===7");
  await chat(
    "w.waitProbe.unsupportedOnce=true;d.querySelector('[data-task-refresh]').click()",
  );
  await ready(
    "!d.querySelector('[data-extension-key=\"desktop:task-panel\"]')",
  );
  assert.equal(
    await chat("return w.waitProbe.requests[6].signal.aborted"),
    true,
    "unsupported 隐藏面板时也释放正在等待的观察者",
  );
  assert.equal(
    await chat(
      "return w.waitProbe.timers.filter(row=>row.ms===300000&&!row.cleared).length",
    ),
    0,
  );
  assert.equal((await branchState()).idle, false);
  assert.deepEqual(driver.errors, []);
  console.log(
    "Default Desktop long wait passed: >12s native completion, independent cancellation/expiry, lease renewal, stale success, bounded timers and unchanged ordinary API deadlines.",
  );
} finally {
  clearTimeout(releaseTimer);
  gate.resolve();
  observerGate.resolve();
  branchGate.resolve();
  driver?.close();
  if (browser && browser.exitCode === null) {
    const stopped = once(browser, "close");
    browser.kill("SIGTERM");
    await stopped;
  }
  await f.close();
}
