import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { desktopFixture, until as settled } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

// 新创建走默认 Host；存量族内记录仅由 legacyFork 布置，不能拿它冒充新语义验收。
const f = await desktopFixture({ noExtensions: true });
let browser, driver;
try {
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const source = await f.command("conversation.create", {
    projectId: project.id,
    name: "分支来源",
  });
  const url = new URL(f.app.url);
  url.searchParams.set("agent", source.id);
  const profile = join(f.root, "family-browser");
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
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: url.href });
  const frame = "document.querySelector('#runtime')?.contentDocument";
  const chat = (source) =>
    evaluate(`(async()=>{const d=${frame};${source}})()`);
  const ready = (condition) =>
    until(`(()=>{const d=${frame};return !!d&&(${condition});})()`, {
      timeoutMs: 15000,
    });
  const actorId = () =>
    evaluate("document.querySelector('#runtime')?.dataset.owner");
  const waitActor = async (id) => {
    await until(
      `document.querySelector('#runtime')?.dataset.owner===${JSON.stringify(id)}`,
    );
    await ready(
      "d.querySelector('#connection-status')?.textContent==='Pi 已连接'",
    );
  };
  const state = (id) => f.call(`/agents/${id}/api/state`);
  const submit = async (message) => {
    await chat(
      `d.querySelector('#prompt').value=${JSON.stringify(message)};d.querySelector('#composer').requestSubmit()`,
    );
    await ready(
      `d.querySelector('#messages').textContent.includes(${JSON.stringify("answer: " + message)})&&d.querySelector('#stop-button').hidden`,
    );
  };
  const messageMenu = async (entryId) => {
    await chat(
      `d.querySelector('#messages [data-entry-id="${entryId}"]').dispatchEvent(new d.defaultView.MouseEvent('contextmenu',{bubbles:true,clientX:80,clientY:80}))`,
    );
    await ready("!!d.querySelector('.message-menu')");
  };
  const commandMessage = async (entryId, command) => {
    await messageMenu(entryId);
    await chat(
      `d.querySelector('.message-menu [data-command=${command}]').click()`,
    );
  };
  const openLeftMenu = async (id, conversationId) => {
    const selector = `#projects button[data-agent-id="${id}"]${conversationId === undefined ? ":not([data-conversation-id])" : `[data-conversation-id="${conversationId}"]`}`;
    await evaluate(
      `(()=>{if(!document.querySelector(${JSON.stringify(selector)}))document.querySelector('#projects .more-sessions')?.click();})()`,
    );
    await until(`!!document.querySelector(${JSON.stringify(selector)})`);
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:140}))`,
    );
    await until("!document.querySelector('#agent-menu').hidden");
  };
  const createdSince = async (before) => {
    let catalog;
    try {
      catalog = await settled(
        () => f.call("/api/workspace"),
        (value) => value.agents.some((row) => !before.has(row.id)),
      );
    } catch (error) {
      console.error(
        "创建诊断",
        await chat(
          "return {toast:d.querySelector('#toast')?.textContent,buttons:[...d.querySelectorAll('[data-branch-action]')].map(node=>({...node.dataset,disabled:node.disabled}))}",
        ),
      );
      const tree = await f.call(`/agents/${await actorId()}/api/tree`);
      console.error(
        "当前树",
        JSON.stringify({
          currentEntryId: tree.currentEntryId,
          rewinds: tree.rewinds,
          active: tree.native.nodes.filter((node) => node.active),
        }),
      );
      throw error;
    }
    return catalog.agents.find((row) => !before.has(row.id));
  };
  const ids = async () =>
    new Set((await f.call("/api/workspace")).agents.map((row) => row.id));
  const openBranches = async () => {
    await evaluate("document.querySelector('#extensions-entry').click()");
    await ready(
      "[...d.querySelectorAll('.extension-page-choice')].some(node=>node.textContent.includes('对话分支'))",
    );
    await chat(
      "[...d.querySelectorAll('.extension-page-choice')].find(node=>node.textContent.includes('对话分支')).click()",
    );
    await ready("!!d.querySelector('[data-branch-action=fork]')");
  };
  await waitActor(source.id);
  await submit("Q1");
  const before = await state(source.id);
  const sourceToken = await chat(
    "return d.querySelector('#token-total').textContent",
  );
  assert.notEqual(sourceToken, "Token 0");

  let known = await ids();
  await openLeftMenu(source.id);
  await evaluate(
    "document.querySelector('#agent-menu [data-command=\"conversation.fork\"]').click()",
  );
  const first = await createdSince(known);
  await waitActor(first.id);
  assert.equal(
    await evaluate("document.activeElement?.dataset.agentId"),
    first.id,
  );
  assert.equal(
    await chat(
      "return d.querySelectorAll('#sessions [data-session-id]').length",
    ),
    1,
  );
  await ready(
    "d.querySelector('#messages').textContent.includes('answer: Q1')&&d.querySelector('#token-total').textContent==='Token 0'",
  );
  assert.equal((await f.call(`/agents/${first.id}/api/tree`)).forkOf, null);
  assert.equal(first.createdFrom.agentId, source.id);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#projects button[data-conversation-id]').length",
    ),
    0,
  );

  known = await ids();
  await chat(
    "d.querySelector('#sessions .session.active').dispatchEvent(new d.defaultView.MouseEvent('contextmenu',{bubbles:true,clientX:90,clientY:120}))",
  );
  await ready("!!d.querySelector('.session-menu [data-command=fork]')");
  await chat("d.querySelector('.session-menu [data-command=fork]').click()");
  const second = await createdSince(known);
  await waitActor(second.id);
  await ready(
    "d.querySelector('#messages').textContent.includes('Q1')&&d.querySelector('#token-total').textContent==='Token 0'",
  );
  assert.equal(second.createdFrom.agentId, first.id);
  assert.equal(f.requests.length, 1, "创建不重放源模型回合");
  assert.deepEqual((await state(source.id)).messages, before.messages);
  assert.deepEqual((await state(source.id)).stats, before.stats);

  await submit("Q2");
  const q2 = (await state(second.id)).messages.find((row) => row.text === "Q2");
  await submit("Q3");
  await commandMessage(q2.entryId, "rewind");
  await ready("!d.querySelector('#messages').textContent.includes('Q3')");
  await submit("Q4");
  const q4 = (await state(second.id)).messages.find((row) => row.text === "Q4");
  await commandMessage(q4.entryId, "rewind");
  await ready(
    "!d.querySelector('#messages').textContent.includes('answer: Q4')",
  );
  const q1 = (await state(second.id)).messages.find((row) => row.text === "Q1");
  await messageMenu(q1.entryId);
  assert.equal(
    await chat(
      "return d.querySelector('.message-menu [data-command=fork]').disabled",
    ),
    true,
  );
  await chat("d.querySelector('.message-menu [data-command=rewind]').click()");
  await ready(
    "d.querySelector('#messages').textContent.includes('Q1')&&!d.querySelector('#messages').textContent.includes('Q2')",
  );
  assert.equal(
    await chat(
      "return Number(d.querySelector('#messages [data-entry-id]').dataset.entryId)",
    ),
    q1.entryId,
  );
  const rewrittenSource = await state(second.id);

  known = await ids();
  await openBranches();
  await ready(
    `d.querySelector('[data-branch-action=fork]')?.dataset.entryId===${JSON.stringify(String(q1.entryId))}`,
  );
  await chat("d.querySelector('[data-branch-action=fork]').click()");
  const third = await createdSince(known);
  await waitActor(third.id);
  assert.deepEqual(
    (await state(third.id)).messages.map((row) => row.text),
    ["Q1"],
  );
  assert.equal(third.createdFrom.agentId, second.id);
  assert.equal(f.requests.length, 4);
  await submit("Q5");
  await openBranches();
  await ready(
    "!!d.querySelector('[data-branch-action=rewind]:not(:disabled)')",
  );
  await chat(
    "d.querySelector('[data-branch-action=rewind]:not(:disabled)').click()",
  );
  await settled(
    () => state(third.id),
    (value) => !value.messages.some((row) => row.text === "Q5"),
  );
  await evaluate(
    `document.querySelector('#projects button[data-agent-id="${third.id}"]:not([data-conversation-id])').click()`,
  );
  await ready("!d.querySelector('#messages').textContent.includes('Q5')");
  assert.deepEqual(
    (await state(second.id)).messages,
    rewrittenSource.messages,
    "新会话退回不改源上下文",
  );

  const legacy = await f.legacyFork(source.id, before.sessionId, {
    mode: "tail",
  });
  await f.call(
    `/agents/${source.id}/api/prompt?sessionId=${legacy.sessionId}`,
    {
      sessionId: legacy.sessionId,
      message: "LEGACY_ONLY",
    },
  );
  await settled(
    () =>
      f.call(`/agents/${source.id}/api/state?sessionId=${legacy.sessionId}`),
    (value) =>
      value.idle &&
      value.messages.some((row) => row.text === "answer: LEGACY_ONLY"),
  );
  const leftLegacy = `#projects button[data-agent-id="${source.id}"][data-conversation-id="${legacy.sessionId}"]`;
  await until(`!!document.querySelector(${JSON.stringify(leftLegacy)})`);
  await evaluate(
    `document.querySelector(${JSON.stringify(leftLegacy)}).click()`,
  );
  await waitActor(source.id);
  await ready(
    `d.querySelector('#sessions .session.active')?.dataset.sessionId===${JSON.stringify(legacy.sessionId)}`,
  );
  await evaluate(
    `document.querySelector(${JSON.stringify(leftLegacy)}).focus()`,
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
    "存量分支仍不授予根进程管理操作",
  );
  known = await ids();
  await evaluate(
    "document.querySelector('#agent-menu [data-command=\"conversation.fork\"]').click()",
  );
  const fromLegacy = await createdSince(known);
  await waitActor(fromLegacy.id);
  assert.equal(fromLegacy.createdFrom.conversationId, Number(legacy.sessionId));
  assert.deepEqual(
    (await state(fromLegacy.id)).messages.map((row) => row.text),
    ["Q1", "answer: Q1", "LEGACY_ONLY", "answer: LEGACY_ONLY"],
  );
  assert.equal(
    (await f.call("/api/workspace")).agents.find((row) => row.id === source.id)
      .branches.length,
    1,
  );
  await call("Page.reload");
  await waitActor(fromLegacy.id);
  await ready(
    "d.querySelector('#messages').textContent.includes('answer: Q1')",
  );
  await f.command("agent.stop", { id: source.id });
  await settled(
    () => f.call("/api/workspace"),
    (value) =>
      value.agents.find((row) => row.id === source.id)?.status === "stopped",
  );
  assert.equal(
    (await f.call("/api/workspace")).agents.find(
      (row) => row.id === fromLegacy.id,
    ).status,
    "running",
  );
  await submit("SOURCE_STOPPED_STILL_ACTIVE");

  const other = await f.command("conversation.create", {
    projectId: project.id,
    name: "并行会话",
  });
  await until(
    `!!document.querySelector('#projects button[data-agent-id="${other.id}"]')`,
  );
  await evaluate(
    `window.forkReceiptProbe={};window.forkReceiptFrame=document.querySelector('#runtime');(()=>{const w=forkReceiptFrame.contentDocument.defaultView,fetcher=w.fetch.bind(w);w.fetch=async(...args)=>{const response=await fetcher(...args);if(String(args[0]).includes('/api/command')&&args[1]?.body&&JSON.parse(args[1].body).command==='fork'){forkReceiptProbe.accepted=true;await new Promise(resolve=>forkReceiptProbe.release=resolve);}return response;};})()`,
  );
  known = await ids();
  await chat(
    "d.querySelector('#sessions .session.active').dispatchEvent(new d.defaultView.MouseEvent('contextmenu',{bubbles:true,clientX:90,clientY:120}))",
  );
  await chat("d.querySelector('.session-menu [data-command=fork]').click()");
  await until("forkReceiptProbe.accepted===true");
  await evaluate(
    `document.querySelector('#projects button[data-agent-id="${other.id}"]').click()`,
  );
  await waitActor(other.id);
  await evaluate("forkReceiptProbe.release()");
  await createdSince(known);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await actorId(),
    other.id,
    "内层创建迟到回执不能抢走新的导航意图",
  );
  assert.equal(
    (await f.call(`/agents/${other.id}/api/sessions`)).rows.length,
    1,
  );
  known = await ids();
  await evaluate(
    `window.sidebarReceiptProbe={};(()=>{const fetcher=fetch.bind(window);window.fetch=async(...args)=>{const response=await fetcher(...args);if(String(args[0]).includes('/api/workspace/command')&&args[1]?.body&&JSON.parse(args[1].body).command==='conversation.fork'){sidebarReceiptProbe.accepted=true;await new Promise(resolve=>sidebarReceiptProbe.release=resolve);}return response;};})()`,
  );
  await openLeftMenu(first.id);
  await evaluate(
    "document.querySelector('#agent-menu [data-command=\"conversation.fork\"]').click()",
  );
  await until("sidebarReceiptProbe.accepted===true");
  await evaluate(
    `document.querySelector('#projects button[data-agent-id="${second.id}"]:not([data-conversation-id])').click()`,
  );
  await waitActor(second.id);
  await evaluate("sidebarReceiptProbe.release()");
  const late = await createdSince(known);
  await until(
    `document.querySelector('#projects button[data-agent-id="${first.id}"]').getAttribute('aria-busy')==='false'`,
  );
  assert.equal(await actorId(), second.id, "外层右键迟到回执也不能抢选择");
  assert.equal(
    late.createdFrom.agentId,
    first.id,
    "不可变来源不借用后来选中的会话",
  );
  assert.deepEqual(
    (await state(source.id)).messages.map(({ role, text }) => ({ role, text })),
    before.messages.map(({ role, text }) => ({ role, text })),
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    "默认独立分支浏览器通过：左侧同级与焦点、内层菜单、工作台创建及退回、重复退回来源、存量分支兼容、停止源不影响新会话、重载与迟到回执。",
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
