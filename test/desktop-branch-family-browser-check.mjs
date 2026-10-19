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
  await evaluate(
    `document.querySelector('#projects [data-agent-id="${actor.id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:140}))`,
  );
  await until("!document.querySelector('#agent-menu').hidden");
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('#agent-menu [role=menuitem]')].some(button=>button.textContent==='创建分支')",
    ),
    true,
    "左侧工作区会话右键菜单提供创建分支",
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
  const leftBranch = `#projects [data-project-id="${project.id}"] button[data-agent-id="${actor.id}"][data-conversation-id="${branch}"]`;
  await until(`!!document.querySelector(${JSON.stringify(leftBranch)})`, {
    timeoutMs: 4000,
  });
  assert.equal(
    await evaluate(
      `document.querySelector(${JSON.stringify(leftBranch)}).classList.contains('selected')`,
    ),
    true,
    "分支创建后在原工作区侧栏出现，并与内层当前会话同步选中",
  );
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
  await evaluate(
    `document.querySelector('#projects [data-agent-id="${actor.id}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:140}))`,
  );
  await evaluate(
    "document.querySelector('#agent-menu [data-command=\"conversation.fork\"]').click()",
  );
  await chatUntil(
    `d.querySelectorAll('#sessions [data-session-id]').length === 5 && d.querySelector('#sessions .session.active')?.dataset.sessionId !== ${JSON.stringify(replayFork)}`,
  );
  const sidebarFork = await chat(
    "return d.querySelector('#sessions .session.active').dataset.sessionId",
  );
  const sidebarTree = await f.call(
    `/agents/${actor.id}/api/tree?id=${sidebarFork}`,
  );
  assert.equal(
    sidebarTree.forkOf.conversationId,
    Number(source),
    "外层会话菜单固定原会话，不能偷用 iframe 当前选中的分支",
  );
  assert.deepEqual(
    (await snapshot(sidebarFork)).messages.map((row) => row.text),
    ["Q1"],
  );
  assert.equal(
    f.requests.length,
    4,
    "外层右键创建的是继承当前位置的新会话，不重放模型",
  );
  await call("Page.reload");
  await chatUntil(
    `d.querySelector('#connection-status')?.textContent === 'Pi 已连接' && d.querySelector('#sessions .session.active')?.dataset.sessionId === ${JSON.stringify(sidebarFork)}`,
  );
  await until(`!!document.querySelector(${JSON.stringify(leftBranch)})`);
  await evaluate(
    `document.querySelector('#projects button[data-agent-id="${actor.id}"]:not([data-conversation-id])').click()`,
  );
  await chatUntil(
    `d.querySelector('#sessions .session.active')?.dataset.sessionId === ${JSON.stringify(source)}`,
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(leftBranch)}).click()`,
  );
  await chatUntil(
    `d.querySelector('#sessions .session.active')?.dataset.sessionId === ${JSON.stringify(branch)}`,
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(leftBranch)}).focus()`,
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "F10",
    code: "F10",
    modifiers: 8,
    windowsVirtualKeyCode: 121,
  });
  await until("!document.querySelector('#agent-menu').hidden");
  assert.equal(
    await evaluate("document.querySelectorAll('#agent-menu button').length"),
    1,
    "历史分支菜单不把进程归档、人格或重命名误施加给外层 Agent",
  );
  await evaluate(
    "document.querySelector('#agent-menu [data-command=\"conversation.fork\"]').click()",
  );
  await chatUntil(
    `d.querySelectorAll('#sessions [data-session-id]').length === 6 && d.querySelector('#sessions .session.active')?.dataset.sessionId !== ${JSON.stringify(branch)}`,
  );
  const branchMenuFork = await chat(
    "return d.querySelector('#sessions .session.active').dataset.sessionId",
  );
  assert.equal(
    (await f.call(`/agents/${actor.id}/api/tree?id=${branchMenuFork}`)).forkOf
      .conversationId,
    Number(branch),
  );
  assert.deepEqual(
    (await snapshot(branchMenuFork)).messages.map((row) => row.text),
    ["Q1", "answer: Q1"],
  );
  assert.equal(f.requests.length, 4);
  await until(
    `document.querySelector('#projects button[data-conversation-id="${branchMenuFork}"]')?.classList.contains('selected')`,
  );
  await f.command("agent.stop", { id: actor.id });
  await until(
    "document.querySelector('#process-count').textContent === '0 个进程'",
  );
  assert.equal(
    await evaluate("document.querySelector('#agent-boot').hidden"),
    false,
    "已停止的分支不能冒充根会话的只读转录，应先启动原 worker",
  );
  await call("Page.reload");
  await until("!document.querySelector('#agent-boot').hidden");
  await evaluate("document.querySelector('#agent-boot-start').click()");
  await chatUntil(
    `d.querySelector('#connection-status')?.textContent === 'Pi 已连接' && d.querySelector('#sessions .session.active')?.dataset.sessionId === ${JSON.stringify(branchMenuFork)}`,
  );
  assert.deepEqual(
    (await snapshot(branchMenuFork)).messages.map((row) => row.text),
    ["Q1", "answer: Q1"],
  );
  const other = await f.command("conversation.create", {
    projectId: project.id,
    name: "并行会话 B",
  });
  await until(
    `!!document.querySelector('#projects button[data-agent-id="${other.id}"]')`,
  );
  await evaluate(
    `window.sidebarForkProbe={};(()=>{const original=window.fetch;window.fetch=async(input,options)=>{const response=await original(input,options);if(String(input).includes('/api/workspace/command')&&options?.body&&JSON.parse(options.body).command==='conversation.fork'){sidebarForkProbe.accepted=true;await new Promise(resolve=>sidebarForkProbe.release=resolve);}return response;};})()`,
  );
  await evaluate(
    `document.querySelector('#projects button[data-agent-id="${actor.id}"]:not([data-conversation-id])').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:140}));document.querySelector('#agent-menu [data-command="conversation.fork"]').click()`,
  );
  await until("sidebarForkProbe.accepted===true");
  await evaluate(
    `document.querySelector('#projects button[data-agent-id="${other.id}"]').click()`,
  );
  await chatUntil(
    "d.querySelector('#connection-status')?.textContent === 'Pi 已连接'",
  );
  await evaluate("sidebarForkProbe.release()");
  await until(
    `document.querySelector('#projects button[data-agent-id="${actor.id}"]').getAttribute('aria-busy')==='false'`,
  );
  assert.equal(
    await evaluate("document.querySelector('#runtime').dataset.owner"),
    other.id,
    "分支回执晚到不得把已切换的 B 导航回 A",
  );
  assert.equal(
    (await f.call(`/agents/${actor.id}/api/sessions`)).rows.length,
    7,
    "固定源会话的分支仍成功提交，切换客户端不会取消工作",
  );
  assert.equal(
    (await f.call(`/agents/${other.id}/api/sessions`)).rows.length,
    1,
    "不可变源目标不借用后来选中的 B",
  );
  assert.equal(f.requests.length, 4);
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
