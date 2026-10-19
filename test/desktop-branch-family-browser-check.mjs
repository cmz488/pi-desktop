import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

// 不能用注入 workspace 的浏览器夹具替代默认 worker，否则 singleAgent 的拒绝路径不会被测到。
const f = await desktopFixture({ noExtensions: true });
let browser, driver;
try {
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "分支来源",
  });
  const url = new URL(f.app.url);
  url.searchParams.set("agent", actor.id);
  const profile = join(f.root, "family-browser");
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
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: url.href });
  const frame = "document.querySelector('#runtime')?.contentDocument";
  const chat = (source) =>
    evaluate(`(async () => { const d = ${frame}; ${source} })()`);
  const chatUntil = (expression) =>
    until(`(() => { const d = ${frame}; return !!d && (${expression}); })()`, {
      timeoutMs: 15000,
    });
  await chatUntil(
    "d.querySelector('#connection-status')?.textContent === 'Pi 已连接'",
  );
  await chat(
    "d.querySelector('#prompt').value='Q1'; d.querySelector('#composer').requestSubmit()",
  );
  await chatUntil(
    "d.querySelector('#messages').textContent.includes('answer: Q1') && d.querySelector('#stop-button').hidden",
  );
  const source = await chat(
    "return d.querySelector('#sessions .session.active').dataset.sessionId",
  );
  const tokenText = await chat(
    "return d.querySelector('#token-total').textContent",
  );
  assert.notEqual(tokenText, "Token 0");
  const snapshot = (id) =>
    chat(
      `return (await d.defaultView.fetch(${JSON.stringify(`/agents/${actor.id}/api/state`)} + '?sessionId=' + ${JSON.stringify(id)}, {cache:'no-store'})).json()`,
    );
  const before = await snapshot(source);
  const openMenu = (id) =>
    chat(
      `const row = d.querySelector('[data-session-id="${id}"]'); row.dispatchEvent(new d.defaultView.MouseEvent('contextmenu', {bubbles:true, clientX:90, clientY:120}));`,
    );
  await openMenu(source);
  await chatUntil("!!d.querySelector('.session-menu')");
  await chat("d.querySelector('.session-menu [data-command=fork]').click()");
  await chatUntil(
    `d.querySelectorAll('#sessions [data-session-id]').length === 2 && d.querySelector('#sessions .session.active')?.dataset.sessionId !== ${JSON.stringify(source)}`,
  );
  await chatUntil("d.querySelector('#token-total').textContent === 'Token 0'");
  const branch = await chat(
    "return d.querySelector('#sessions .session.active').dataset.sessionId",
  );
  assert.equal((await snapshot(branch)).stats.tokens.total, 0);
  await openMenu(branch);
  assert.equal(
    await chat(
      "return d.querySelector('.session-menu [data-command=rewind]').disabled",
    ),
    false,
    "默认分支也绑定了自己的原生转录",
  );
  await chat("d.querySelector('.session-menu [data-command=tree]').click()");
  await chatUntil(
    "!!d.querySelector('#view-extensions [data-branch-action=fork]')",
  );
  const point = await chat(
    "return Number(d.querySelector('#view-extensions [data-branch-action=fork]').dataset.entryId)",
  );
  await chat(
    "d.querySelector('#view-extensions [data-branch-action=fork]').click()",
  );
  await chatUntil(
    `d.querySelectorAll('#sessions [data-session-id]').length === 3 && ![${JSON.stringify(source)},${JSON.stringify(branch)}].includes(d.querySelector('#sessions .session.active')?.dataset.sessionId)`,
  );
  await chatUntil("d.querySelector('#token-total').textContent === 'Token 0'");
  const child = await chat(
    "return d.querySelector('#sessions .session.active').dataset.sessionId",
  );
  const tree = await chat(
    `return (await d.defaultView.fetch(${JSON.stringify(`/agents/${actor.id}/api/tree`)} + '?id=' + ${JSON.stringify(child)}, {cache:'no-store'})).json()`,
  );
  assert.deepEqual(tree.forkOf, {
    conversationId: Number(branch),
    entryId: point,
  });
  assert.ok(tree.native);
  const unchanged = await snapshot(source);
  assert.deepEqual(unchanged.messages, before.messages);
  assert.deepEqual(unchanged.stats, before.stats);
  await chat("d.querySelector('[data-view=workspace]').click()");
  await chat(`d.querySelector('[data-session-id="${source}"]').click()`);
  await chatUntil(
    `d.querySelector('#sessions .session.active')?.dataset.sessionId === ${JSON.stringify(source)} && d.querySelector('#token-total').textContent === ${JSON.stringify(tokenText)}`,
  );
  assert.deepEqual(driver.errors, []);
  assert.equal(f.requests.length, 1, "分叉没有重新调用模型或重放源回答");
  const submit = async (message) => {
    await chat(
      `d.querySelector('#prompt').value=${JSON.stringify(message)}; d.querySelector('#composer').requestSubmit()`,
    );
    await chatUntil(
      `d.querySelector('#messages').textContent.includes(${JSON.stringify(`answer: ${message}`)}) && d.querySelector('#stop-button').hidden`,
    );
  };
  const messageCommand = async (entryId, command) => {
    await chat(
      `d.querySelector('#messages [data-entry-id="${entryId}"]').dispatchEvent(new d.defaultView.MouseEvent('contextmenu', {bubbles:true, clientX:80, clientY:80}))`,
    );
    await chatUntil("!!d.querySelector('.message-menu')");
    await chat(
      `d.querySelector('.message-menu [data-command=${command}]').click()`,
    );
  };
  await submit("Q2");
  const q2 = (await snapshot(source)).messages.find((row) => row.text === "Q2");
  await submit("Q3");
  await messageCommand(q2.entryId, "rewind");
  await chatUntil("!d.querySelector('#messages').textContent.includes('Q3')");
  await submit("Q4");
  const q4 = (await snapshot(source)).messages.find((row) => row.text === "Q4");
  await messageCommand(q4.entryId, "rewind");
  await chatUntil(
    "!d.querySelector('#messages').textContent.includes('answer: Q4')",
  );
  const q1 = before.messages.find((row) => row.text === "Q1");
  assert.equal(
    await chat(
      "return Number(d.querySelector('#messages [data-entry-id]').dataset.entryId)",
    ),
    q1.entryId,
    "第二次退回后可见 Q1 仍带原始消息目标",
  );
  await chat(
    `d.querySelector('#messages [data-entry-id="${q1.entryId}"]').dispatchEvent(new d.defaultView.MouseEvent('contextmenu', {bubbles:true,clientX:80,clientY:80}))`,
  );
  assert.equal(
    await chat(
      "return d.querySelector('.message-menu [data-command=fork]').disabled",
    ),
    true,
    "历史消息只提供退回，不能绕过 SVG 从历史位置直接分支",
  );
  await chat("d.querySelector('.message-menu [data-command=rewind]').click()");
  await chatUntil(
    "d.querySelector('#messages').textContent.includes('Q1') && !d.querySelector('#messages').textContent.includes('Q2')",
  );
  await messageCommand(q1.entryId, "fork");
  await chatUntil(
    `d.querySelectorAll('#sessions [data-session-id]').length === 4 && d.querySelector('#sessions .session.active')?.dataset.sessionId !== ${JSON.stringify(source)}`,
  );
  await chatUntil("d.querySelector('#token-total').textContent === 'Token 0'");
  const replayFork = await chat(
    "return d.querySelector('#sessions .session.active').dataset.sessionId",
  );
  assert.deepEqual(
    (await snapshot(replayFork)).messages.map((row) => row.text),
    ["Q1"],
  );
  assert.equal(
    f.requests.length,
    4,
    "退回历史节点后从当前位置分支，不重放模型",
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    "Default Desktop branch browser passed: sidebar/tree forks, native identity, independent usage, unchanged source, switching and Q1/Q2/Q3 → rewind Q2 → Q4 → rewind Q4 → rewind Q1 → fork current.",
  );
} finally {
  driver?.close();
  if (browser && browser.exitCode === null) {
    const stopped = once(browser, "close");
    browser.kill("SIGTERM");
    await stopped;
  }
  await f.close();
}
