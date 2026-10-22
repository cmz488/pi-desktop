import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { desktopFixture, until as untilValue } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";
import { checkHostTaskPanelCompatibility } from "./host-task-panel-compat-check.mjs";

// 同号 task 必须经过真实两套 worker；工作台不再有跨 Agent 的发起表单。
const gates = { A: Promise.withResolvers(), B: Promise.withResolvers() };
const f = await desktopFixture({
  noExtensions: true,
  beforeModelResponse: async (input) => {
    for (const [name, gate] of Object.entries(gates))
      if (input.messages.at(-1)?.content === `SCOPED_CHILD_${name}`)
        await gate.promise;
  },
});
let browser, driver;
try {
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const workers = [];
  for (const name of ["A", "B"]) {
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: `工作台 ${name}`,
    });
    const prefix = `/agents/${actor.id}`;
    const parent = (await f.call(`${prefix}/api/state`)).sessionId;
    const launched = await f.call(`${prefix}/api/command?sessionId=${parent}`, {
      command: "subagent.spawn",
      id: Number(parent),
      sessionId: parent,
      name: `子代理 ${name}`,
      prompt: `SCOPED_CHILD_${name}`,
      requestId: `scope-${name}`,
    });
    workers.push({ ...actor, name, prefix, parent, taskId: launched.taskId });
  }
  const [a, b] = workers;
  assert.equal(
    a.taskId,
    b.taskId,
    "两个独立 SQLite 的同号 task 是本回归的前提",
  );
  const profile = join(f.root, "scoped-task-browser");
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
  const { call, evaluate, until } = driver;
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const url = new URL(f.app.url);
  url.searchParams.set("agent", a.id);
  await call("Page.navigate", { url: url.href });
  await until("!!document.querySelector('#projects [data-agent-id]')");
  await checkHostTaskPanelCompatibility({ driver, fixture: f, workers });
  console.log(
    "Host 兼容面板通过：公开导出、旧表单发起、同号任务、迟到详情和观察清理。",
  );
  const frame = "document.querySelector('#runtime')?.contentDocument";
  const chat = (source) => evaluate(`(()=>{const d=${frame};${source}})()`);
  async function showTasks() {
    await until(
      `(()=>{const d=${frame};return d?.querySelector('#connection-status')?.textContent === 'Pi 已连接';})()`,
    );
    await evaluate("document.querySelector('#extensions-entry').click()");
    await until(
      `(()=>{const d=${frame};return [...d.querySelectorAll('.extension-page-choice')].some(row=>row.textContent.includes('任务与子代理'));})()`,
    );
    await chat(
      "[...d.querySelectorAll('.extension-page-choice')].find(row=>row.textContent.includes('任务与子代理')).click();",
    );
  }
  async function inspect(taskId) {
    await until(
      `(()=>{const d=${frame};return !!d.querySelector('[data-task-inspect="${taskId}"]');})()`,
    );
    await chat(`d.querySelector('[data-task-inspect="${taskId}"]').click();`);
  }
  await showTasks();
  await inspect(a.taskId);
  await until(
    `(()=>{const d=${frame};return d.querySelector('.task-panel-detail')?.textContent.includes('SCOPED_CHILD_A');})()`,
  );
  assert.equal(
    await chat(
      "return d.querySelector('.task-panel-detail').textContent.includes('SCOPED_CHILD_B');",
    ),
    false,
  );
  await chat(
    "d.querySelector('[data-task-compose-toggle]').click();d.querySelector('[data-task-compose]').elements.prompt.value='同会话草稿';d.querySelector('[data-task-compose] button[type=button]').click();d.querySelector('[data-task-compose-toggle]').click();",
  );
  assert.equal(
    await chat(
      "return d.querySelector('[data-task-compose]').elements.prompt.value;",
    ),
    "同会话草稿",
    "收起表单不丢草稿",
  );
  await evaluate(
    `(()=>{const w=(${frame}).defaultView;const original=w.fetch.bind(w);let release;const gate=new Promise(resolve=>release=resolve);w.spawnProbe={inputs:[],urls:[],postReceiptRead:false,release};w.fetch=async(...args)=>{if(String(args[0]).includes('/api/command')&&args[1]?.body){const input=JSON.parse(args[1].body);if(input.command==='subagent.spawn'){w.spawnProbe.inputs.push(input);w.spawnProbe.urls.push(String(args[0]));const response=await original(...args);if(w.spawnProbe.inputs.length===1)throw new TypeError('模拟回执丢失');await gate;w.spawnProbe.released=true;return response;}}const observe=String(args[0]).includes('/api/tasks')&&w.spawnProbe.released&&!w.document.querySelector('[data-task-compose]');const response=await original(...args);if(observe){if(response.status===304)w.spawnProbe.postReceiptRead=true;else{const json=response.json.bind(response);response.json=async()=>{const value=await json();w.spawnProbe.postReceiptRead=true;return value;};}}return response;};})()`,
  );
  await chat(
    "const form=d.querySelector('[data-task-compose]');form.elements.name.value='幂等重试委托';form.elements.prompt.value='SCOPED_CHILD_A';form.requestSubmit();",
  );
  await until(
    `(()=>{const d=${frame};return d.querySelector('[data-task-compose]')?.textContent.includes('模拟回执丢失');})()`,
  );
  await chat("d.querySelector('[data-task-compose]').requestSubmit();");
  await until(
    `(()=>{const d=${frame};return d.defaultView.spawnProbe.inputs.length===2;})()`,
  );
  const attempts = await chat("return d.defaultView.spawnProbe.inputs;");
  const attemptUrls = await chat("return d.defaultView.spawnProbe.urls;");
  assert.ok(
    attemptUrls.every(
      (path) => new URL(path, f.app.url).searchParams.get("generation") === "0",
    ),
    "整合发起固定 iframe 的存储代际，不丢失原 Host 管理门禁",
  );
  assert.deepEqual(
    attempts[1],
    attempts[0],
    "不确定回执的同内容重试保持冻结目标、内容和 requestId",
  );
  await inspect(a.taskId);
  await evaluate(`(${frame}).defaultView.spawnProbe.release()`);
  await until(
    `(()=>{const d=${frame};return !d.querySelector('[data-task-compose]');})()`,
  );
  await until(`(${frame}).defaultView.spawnProbe.postReceiptRead===true`);
  await until(
    `(()=>{const d=${frame};return d.querySelector('.task-panel-detail')?.textContent.includes('原生任务 #${a.taskId}');})()`,
  );
  const retried = await untilValue(
    () => f.call(`${a.prefix}/api/task-monitor?sessionId=${a.parent}`),
    (value) => value.conversations.some((row) => row.name === "幂等重试委托"),
  );
  assert.equal(
    retried.conversations.filter((row) => row.name === "幂等重试委托").length,
    1,
    "真实后端仅创建一次委托",
  );
  assert.equal(
    await chat(
      `return d.querySelector('.task-panel-detail').textContent.includes('原生任务 #${a.taskId}');`,
    ),
    true,
    "迟到发起回执不能抢走后来改选的任务",
  );
  await chat(
    `d.querySelector('[data-task-action="wait:${a.taskId}"]').click();`,
  );
  await until(
    `(()=>{const d=${frame};return d.querySelector('[data-task-action="wait:${a.taskId}"]')?.dataset.waiting === 'true';})()`,
  );
  await evaluate(
    `document.querySelector('#projects button[data-agent-id="${b.id}"]:not([data-conversation-id])').click()`,
  );
  await showTasks();
  await inspect(b.taskId);
  await until(
    `(()=>{const d=${frame};return d.querySelector('.task-panel-detail')?.textContent.includes('SCOPED_CHILD_B');})()`,
  );
  assert.equal(
    await chat(
      "return d.querySelector('.task-panel-detail').textContent.includes('SCOPED_CHILD_A');",
    ),
    false,
    "同号 task 的详情不能跨 worker 混用",
  );
  for (const target of workers)
    assert.notEqual(
      (
        await f.call(
          `${target.prefix}/api/task-detail?sessionId=${target.parent}&taskId=${target.taskId}`,
        )
      ).task.status,
      "terminal",
      "切换 Agent 只撤观察，不中止任何工作",
    );
  await chat(
    `d.querySelector('[data-task-action="cancel:${b.taskId}"]').click();`,
  );
  await until(
    `(()=>{const d=${frame};return d.querySelector('[data-task-action="cancel:${b.taskId}"]')?.dataset.armed === 'true';})()`,
  );
  assert.notEqual(
    (
      await f.call(
        `${b.prefix}/api/task-detail?sessionId=${b.parent}&taskId=${b.taskId}`,
      )
    ).task.status,
    "terminal",
    "第一步中止只确认",
  );
  await chat(
    `d.querySelector('[data-task-action="cancel:${b.taskId}"]').click();`,
  );
  await untilValue(
    () =>
      f.call(
        `${b.prefix}/api/task-detail?sessionId=${b.parent}&taskId=${b.taskId}`,
      ),
    (value) => value.task.status === "terminal",
  );
  assert.notEqual(
    (
      await f.call(
        `${a.prefix}/api/task-detail?sessionId=${a.parent}&taskId=${a.taskId}`,
      )
    ).task.status,
    "terminal",
    "中止 B 的同号 task 不影响 A",
  );
  gates.A.resolve();
  gates.B.resolve();
  await untilValue(
    () =>
      f.call(
        `${a.prefix}/api/task-detail?sessionId=${a.parent}&taskId=${a.taskId}`,
      ),
    (value) => value.task.status === "terminal",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert.equal(
    await chat(
      "return d.documentElement.scrollWidth <= d.defaultView.innerWidth;",
    ),
    true,
    "窄屏工作台不横向溢出",
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    "Scoped workbench browser passed: two writers/same task id, drafts, native wait/cancel and current-session-only details.",
  );
} finally {
  for (const gate of Object.values(gates)) gate.resolve();
  driver?.close();
  if (browser && browser.exitCode === null) {
    const stopped = once(browser, "close");
    browser.kill("SIGTERM");
    await stopped;
  }
  await rm(join(f.root, "scoped-task-browser"), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  await f.close();
}
