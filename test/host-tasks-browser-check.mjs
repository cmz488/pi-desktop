import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { desktopFixture, until as untilValue } from "./desktop-fixture.mjs";
import { writeFile } from "node:fs/promises";
import { browserDriver } from "./durable-browser-driver.mjs";
import { measureSurfaceContrast } from "./surface-contrast.mjs";

// 使用默认 Host→worker→原生 SDK 与本地 provider；不能用独立面板假数据替代跨 writer 验证。
const gates = {
  HOST_A: Promise.withResolvers(),
  HOST_B: Promise.withResolvers(),
};
const streamNext = Promise.withResolvers(),
  streamDone = Promise.withResolvers();
const f = await desktopFixture({
  noExtensions: true,
  modelReply: (input) =>
    String(input.messages.at(-1)?.content).includes("HOST_B")
      ? {
          stream: (async function* () {
            yield "HOST_B_STREAM_FIRST";
            await streamNext.promise;
            yield " HOST_B_STREAM_SECOND";
            await streamDone.promise;
          })(),
        }
      : undefined,
  beforeModelResponse: async (input) => {
    for (const [key, gate] of Object.entries(gates))
      if (String(input.messages.at(-1)?.content).includes(key))
        await gate.promise;
  },
});
let browser, driver;
try {
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const a = await f.command("conversation.create", {
    projectId: project.id,
    name: "Host A",
  });
  const b = await f.command("conversation.create", {
    projectId: project.id,
    name: "Host B",
  });
  const profile = join(f.root, "host-task-browser");
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
  await driver.call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await driver.call("Page.navigate", { url: f.app.url });
  await driver.until("!!document.querySelector('#projects [data-agent-id]')");
  assert.equal(
    await driver.evaluate("!!document.querySelector('#tasks-entry')"),
    true,
    "Desktop 提供全 Host 任务监控入口",
  );
  const { evaluate, until, call } = driver;
  const selectAgent = async (id) =>
    evaluate(
      `(() => { const f=document.querySelector('#host-subagent-form');f.elements.agent.value=${JSON.stringify(`${id}:0`)};f.elements.agent.dispatchEvent(new Event('change')); })()`,
    );
  const group = (id) => `document.querySelector('[data-host-agent="${id}"]')`;
  const row = (id, taskId) =>
    `${group(id)}?.querySelector('[data-task-id="${taskId}"]')`;
  await evaluate("document.querySelector('#tasks-entry').click()");
  await until(
    "document.querySelector('#host-task-dialog').open && document.querySelector('#host-subagent-form').elements.agent.options.length===3",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#host-subagent-form').hidden && !document.querySelector('#host-subagent-form').getClientRects().length",
    ),
    true,
    "任务监控默认先展示清单，发起表单按需打开",
  );
  await evaluate(
    "document.querySelector('[data-host-toggle-compose]').click()",
  );
  await until(
    "!document.querySelector('#host-subagent-form').hidden && document.activeElement.name==='prompt'",
  );
  await evaluate(
    "document.querySelector('#host-subagent-form').elements.prompt.value='保留的草稿';document.querySelector('[data-host-toggle-compose]').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#host-subagent-form').hidden && document.querySelector('#host-subagent-form').elements.prompt.value==='保留的草稿'",
    ),
    true,
    "收起表单仅改变展示，不丢发起草稿",
  );
  await evaluate(
    "document.querySelector('[data-host-toggle-compose]').click()",
  );
  await selectAgent(a.id);
  await evaluate(
    "(() => {const f=document.querySelector('#host-subagent-form');f.elements.name.value='代理 A';f.elements.prompt.value='HOST_A';f.requestSubmit();})()",
  );
  await until(
    `${group(a.id)}?.querySelector('[data-kind="desk.subagent-run"]')?.textContent.includes('代理 A')`,
  );
  await selectAgent(b.id);
  await evaluate(
    "(() => {const f=document.querySelector('#host-subagent-form');f.elements.name.value='代理 B';f.elements.prompt.value='HOST_B';f.requestSubmit();})()",
  );
  await until(
    `${group(b.id)}?.querySelector('[data-kind="desk.subagent-run"]')?.textContent.includes('代理 B')`,
  );
  const live = await untilValue(
    () => f.call("/api/host/tasks"),
    (value) =>
      value.workers.every((worker) =>
        worker.data?.tasks.some((task) => task.kind === "pi.generation"),
      ) && f.requests.length === 2,
  );
  const aTask = live.workers
    .find((worker) => worker.agentId === a.id)
    .data.tasks.find((task) => task.kind === "desk.subagent-run");
  const bTask = live.workers
    .find((worker) => worker.agentId === b.id)
    .data.tasks.find((task) => task.kind === "desk.subagent-run");
  assert.equal(
    aTask.id,
    bTask.id,
    "受控两个 SQLite 产生同号任务，必须靠 Agent 命名空间隔离",
  );
  await evaluate(
    "document.querySelector('[data-host-toggle-compose]').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.host-task-inspection').getBoundingClientRect().left > document.querySelector('[data-host-workers]').getBoundingClientRect().right",
    ),
    true,
    "桌面任务清单与详情并列，不把详情推到发起表单下方",
  );
  if (process.env.PI_HOST_TASK_SCREENSHOTS) {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(
      join(process.env.PI_HOST_TASK_SCREENSHOTS, "host-tasks-active.png"),
      Buffer.from(shot.data, "base64"),
    );
  }
  await evaluate(
    `${row(a.id, aTask.id)}.querySelector('[data-task-action="wait:${aTask.id}"]').click()`,
  );
  await until(`${row(a.id, aTask.id)}?.querySelector('[data-waiting="true"]')`);
  await evaluate(
    `${row(a.id, aTask.id)}.querySelector('[data-waiting="true"]').click()`,
  );
  await until(
    "document.querySelector('[data-host-action-status]').textContent.includes('任务继续运行')",
  );
  assert.ok(
    (await f.call("/api/host/tasks")).workers
      .find((worker) => worker.agentId === a.id)
      .data.tasks.some((task) => task.id === aTask.id),
    "UI 取消等待不取消工作",
  );
  await evaluate(
    `${row(a.id, aTask.id)}.querySelector('[data-task-action="cancel:${aTask.id}"]').click()`,
  );
  await until(`${row(a.id, aTask.id)}?.querySelector('[data-armed="true"]')`);
  assert.equal(
    await evaluate(
      `${row(a.id, aTask.id)}.querySelector('[data-armed="true"]').textContent`,
    ),
    "确认中止",
    "确认保持独立第二次操作，但不靠长句撑破任务行",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#host-subagent-form').elements.agent.value",
    ),
    `${b.id}:0`,
    "管理按钮不能偷用当前发起表单的 Agent",
  );
  await evaluate(
    `${row(a.id, aTask.id)}.querySelector('[data-armed="true"]').click()`,
  );
  await untilValue(
    () => f.call("/api/host/tasks"),
    (value) =>
      !value.workers
        .find((worker) => worker.agentId === a.id)
        .data.tasks.some((task) => task.id === aTask.id),
  );
  assert.ok(
    (await f.call("/api/host/tasks")).workers
      .find((worker) => worker.agentId === b.id)
      .data.tasks.some((task) => task.id === bTask.id),
    "取消 A 不会命中 B 的任务 namespace",
  );
  await until(
    `${row(b.id, bTask.id)}?.querySelector('[data-task-action="wait:${bTask.id}"]')`,
  );
  await evaluate(
    `${row(b.id, bTask.id)}.querySelector('[data-task-action="wait:${bTask.id}"]').click()`,
  );
  await until(`${row(b.id, bTask.id)}?.querySelector('[data-waiting="true"]')`);
  await evaluate(
    `window.__previousHostWorker=${group(b.id)};${row(b.id, bTask.id)}.querySelector('[data-task-action="wait:${bTask.id}"]').focus()`,
  );
  const ro = await f.command("conversation.create", { name: "Host 只读" });
  await evaluate("document.querySelector('[data-host-refresh]').click()");
  await until(
    `${group(b.id)} && ${group(b.id)} !== window.__previousHostWorker`,
  );
  assert.equal(
    await evaluate("document.activeElement?.dataset.taskAction"),
    `wait:${bTask.id}`,
    "聚合更新保留任务操作的键盘焦点",
  );
  assert.equal(
    await evaluate(
      "document.activeElement.closest('[data-host-agent]')?.dataset.hostAgent",
    ),
    b.id,
  );
  // close 事件由浏览器异步派发；同一手势轮次内重开也必须失效旧观察。
  await evaluate(
    "(() => {document.querySelector('#host-task-dialog').close();document.querySelector('#tasks-entry').click();})()",
  );
  await until(
    `document.querySelector('#host-task-dialog').open && ${row(b.id, bTask.id)}?.querySelector('[data-task-action="wait:${bTask.id}"]')`,
    { timeoutMs: 3000 },
  );
  assert.equal(
    await evaluate(
      `${row(b.id, bTask.id)}.querySelector('[data-task-action="wait:${bTask.id}"]').dataset.waiting`,
    ),
    "false",
    "快速重开不能借用上一窗口的等待观察",
  );
  await evaluate(
    `${row(b.id, bTask.id)}.querySelector('[data-task-action="wait:${bTask.id}"]').click()`,
  );
  await until(`${row(b.id, bTask.id)}?.querySelector('[data-waiting="true"]')`);
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await until("!document.querySelector('#host-task-dialog').open");
  assert.ok(
    (await f.call("/api/host/tasks")).workers
      .find((worker) => worker.agentId === b.id)
      .data.tasks.some((task) => task.id === bTask.id),
    "关闭只销毁观察者",
  );
  await evaluate("document.querySelector('#tasks-entry').click()");
  await until(
    `${row(b.id, bTask.id)}?.querySelector('[data-waiting="false"]')`,
  );
  assert.equal(
    await evaluate(
      `${group(b.id)}.querySelectorAll('[data-waiting="true"]').length`,
    ),
    0,
  );
  const detailPath =
    "/api/host/tasks/detail?" +
    new URLSearchParams({
      agentId: b.id,
      generation: 0,
      conversationId: bTask.scopeId,
      taskId: bTask.id,
    });
  gates.HOST_B.resolve();
  await untilValue(
    () => f.call(detailPath),
    (value) => value.children[0]?.partial?.text.includes("HOST_B_STREAM_FIRST"),
  );
  await evaluate(
    "document.querySelector('[data-host-inspect]').dispatchEvent(new Event('change'))",
  );
  await until(
    "document.querySelector('[data-host-detail]').textContent.includes('HOST_B_STREAM_FIRST') && document.querySelector('[data-host-detail]').getAttribute('aria-busy')==='false'",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-host-detail] [data-host-partial]')?.textContent.includes('HOST_B_STREAM_FIRST')",
    ),
    true,
    "子代理实时输出使用独立可读段，不挤成等宽日志串",
  );
  const beforeStream = await f.call("/api/host/tasks");
  streamNext.resolve();
  await untilValue(
    () => f.call(detailPath),
    (value) =>
      value.children[0]?.partial?.text.includes("HOST_B_STREAM_SECOND"),
  );
  assert.deepEqual(
    await f.call("/api/host/tasks"),
    beforeStream,
    "流式片段更新不必改变任务图或 owner 读模型",
  );
  await until(
    "document.querySelector('[data-host-detail]').getAttribute('aria-busy')==='false'",
  );
  await evaluate("document.querySelector('[data-host-refresh]').click()");
  await until(
    "document.querySelector('[data-host-status]').getAttribute('aria-busy')==='false' && document.querySelector('[data-host-detail]').getAttribute('aria-busy')==='false'",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-host-detail]').textContent.includes('HOST_B_STREAM_SECOND')",
    ),
    true,
    "任务图 ETag 不变也必须读取新的原生过程片段",
  );
  streamDone.resolve();
  await until(
    "document.querySelector('[data-host-detail]').textContent.includes('已完成') && document.querySelector('[data-host-detail]').textContent.includes('HOST_B')",
    { timeoutMs: 15000 },
  );
  await until(
    `!!document.querySelector('#host-subagent-form option[value="${ro.id}:0"]')`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('#host-subagent-form option[value="${ro.id}:0"]').disabled`,
    ),
    true,
  );
  for (const mode of ["light", "dark"]) {
    await evaluate(
      `(async()=>{document.documentElement.dataset.theme=${JSON.stringify(mode)};for(const frame of document.querySelectorAll('iframe'))frame.contentDocument?.body?.classList.toggle('dark',${mode === "dark"});getComputedStyle(document.body).color;await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));})()`,
    );
    const contrast = await evaluate(
      `(${measureSurfaceContrast.toString()})(['.host-task-heading h2','[data-host-status]','.host-task-worker h3','.task-panel-label','.task-panel-meta','.task-panel-state','.host-task-result-heading strong','.host-task-message > small','.host-task-message-body','[data-host-toggle-compose]'])`,
    );
    assert.equal(contrast.length, 10);
    assert.ok(
      contrast.every((item) => item.ratio >= 4.5),
      `${mode} Host 任务文字对比度：${JSON.stringify(contrast)}`,
    );
    if (process.env.PI_HOST_TASK_SCREENSHOTS) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(process.env.PI_HOST_TASK_SCREENSHOTS, `host-tasks-${mode}.png`),
        Buffer.from(shot.data, "base64"),
      );
    }
  }
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await until("matchMedia('(max-width:900px)').matches");
  assert.equal(
    await evaluate(
      "(() => {const dialog=document.querySelector('#host-task-dialog');const rect=dialog.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&dialog.scrollWidth<=dialog.clientWidth&&document.documentElement.scrollWidth<=innerWidth;})()",
    ),
    true,
    "窄屏窗口有界，不把任务横向滚动扩散到页面",
  );
  if (process.env.PI_HOST_TASK_SCREENSHOTS) {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(
      join(process.env.PI_HOST_TASK_SCREENSHOTS, "host-tasks-narrow.png"),
      Buffer.from(shot.data, "base64"),
    );
  }
  assert.deepEqual(driver.errors, [], "真实 Host 任务窗口不产生浏览器错误");
  console.log(
    "Host tasks browser: launch A/B, scoped wait/cancel, observer disposal, native result and read-only capability passed",
  );
} finally {
  for (const gate of Object.values(gates)) gate.resolve();
  streamNext.resolve();
  streamDone.resolve();
  driver?.close();
  if (browser && browser.exitCode === null) {
    const exited = once(browser, "close");
    browser.kill("SIGTERM");
    await exited;
  }
  await f.close();
}
