import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until as settle } from "./desktop-fixture.mjs";
import { browserDriver, pause } from "./durable-browser-driver.mjs";

// 真实 Host、worker 与公开浏览器模块；仅在读完真实 HTTP 后延迟交付，模拟忽略取消的提供方。
const f = await desktopFixture();
let browser, driver;
try {
  await writeFile(join(f.agentDir, "AGENTS.md"), "PERSONALITY_OLD\n");
  const modelsPath = join(f.agentDir, "models.json");
  const modelsDoc = JSON.parse(await readFile(modelsPath, "utf8"));
  modelsDoc.providers["desktop-fixture"].models.push(
    ...Array.from({ length: 25 }, (_, index) => ({
      id: `choice-${index}`,
      name: `目录模型 ${index}`,
      contextWindow: 8192,
      maxTokens: 1024,
    })),
  );
  await writeFile(modelsPath, JSON.stringify(modelsDoc));
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "视图生命周期",
  });
  const prefix = `/agents/${actor.id}`;
  const a = (await f.call(`${prefix}/api/state`)).sessionId;
  await f.call(`${prefix}/api/prompt`, {
    sessionId: a,
    message: "views-source",
  });
  await settle(
    () => f.call(`${prefix}/api/state`),
    (value) =>
      value.idle &&
      value.messages.some((row) => row.text === "answer: views-source"),
  );
  const b = (await f.legacyFork(actor.id, a, { mode: "tail" })).sessionId;
  let mcp = await f.call(`${prefix}/api/mcp?sessionId=${a}`);
  await f.call(`${prefix}/api/mcp`, {
    sessionId: a,
    action: "save",
    scope: "global",
    name: "views-fixture",
    revision: mcp.revisions.global,
    config: {
      command: process.execPath,
      args: ["-e", ""],
      description: "MCP_OLD",
    },
  });

  const profile = join(f.root, "chat-views-browser");
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
    width: 1320,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
    if (window.parent === window) return;
    const original = window.fetch.bind(window);
    const probe = window.viewsProbe = {calls: [], holds: [], arm(path, method = 'GET') {
      let release; const promise = new Promise(resolve => release = resolve);
      const hold = {path, method, promise, release}; this.holds.push(hold); return this.holds.length - 1;
    }};
    window.fetch = async (path, options = {}) => {
      const url = new URL(String(path), location.href);
      const row = {path: url.pathname, owner: url.searchParams.get('sessionId'), method: options.method ?? 'GET', signal: options.signal};
      probe.calls.push(row);
      const hold = probe.holds.find(item => !item.row && row.path.endsWith(item.path) && item.method === row.method);
      if (hold) hold.row = row;
      const response = await original(path, options);
      if (!hold) { row.finished = true; return response; }
      const bytes = await response.arrayBuffer();
      row.received = true;
      await hold.promise;
      row.finished = true;
      return new Response(bytes, {status: response.status, headers: response.headers});
    };
  })();`,
  });
  const url = new URL(f.app.url);
  url.searchParams.set("agent", actor.id);
  await call("Page.navigate", { url: url.href });
  const frame = "document.querySelector('#runtime')?.contentDocument";
  const win = "document.querySelector('#runtime')?.contentWindow";
  const chat = (source) =>
    evaluate(`(() => {const d=${frame}, w=${win};${source}})()`);
  const ready = (expression) =>
    until(
      `(() => {const d=${frame}, w=${win};return !!d && !!w && (${expression});})()`,
    );
  await ready(
    "d.querySelector('#connection-status')?.textContent === 'Pi 已连接' && w.viewsProbe",
  );
  const view = async (name) => {
    await chat(`d.querySelector('[data-view="${name}"]').click()`);
    await ready(`!d.querySelector('#view-${name}').hidden`);
  };
  const select = async (id) => {
    await evaluate(
      `${win}.postMessage({type:'pi-desktop:select-conversation',conversationId:${Number(id)},generation:0},location.origin)`,
    );
    await ready(
      `w.sessionStorage.getItem(${JSON.stringify(`pi-durable-agent${prefix}`)}) === ${JSON.stringify(String(id))}`,
    );
  };
  const arm = (path, method) =>
    chat(
      `return w.viewsProbe.arm(${JSON.stringify(path)},${JSON.stringify(method ?? "GET")})`,
    );
  const held = (id) => ready(`w.viewsProbe.holds[${id}].row?.received`);
  const release = async (id) => {
    await chat(`w.viewsProbe.holds[${id}].release()`);
    await ready(`w.viewsProbe.holds[${id}].row?.finished`);
    await pause(60);
  };

  await view("general");
  await ready("d.querySelector('[data-setting=defaultModel]')");
  await chat(
    `const input = d.querySelector('[data-setting=defaultModel]'); input.value='未保存的配置草稿'; input.dispatchEvent(new Event('input',{bubbles:true})); w.viewsInput=input; const scroll=d.querySelector('.settings-content'); if(scroll)scroll.scrollTop=160;`,
  );
  await view("workspace");
  await view("general");
  assert.equal(
    await chat(
      "return d.querySelector('[data-setting=defaultModel]') === w.viewsInput && w.viewsInput.value === '未保存的配置草稿' && !d.querySelector('#save-settings').disabled",
    ),
    true,
    "离页不重建或清空同身份的配置草稿",
  );
  await chat(
    `w.viewsInput.focus(); const scroll=d.querySelector('.settings-content');w.viewsScroll=scroll?.scrollTop; d.querySelector('[data-settings-category=agent]').click()`,
  );
  assert.equal(
    await chat(
      "return d.activeElement === w.viewsInput && d.querySelector('[data-setting=defaultModel]') === w.viewsInput && d.querySelector('.settings-content')?.scrollTop === w.viewsScroll",
    ),
    true,
    "分类更新保留节点、焦点与阅读位置",
  );
  await chat("d.querySelector('[data-action=discard-settings]').click()");
  await ready(
    "d.querySelector('[data-setting=defaultModel]').value !== '未保存的配置草稿'",
  );

  const personality = await arm("/api/personality");
  await view("personality");
  await held(personality);
  await writeFile(join(f.agentDir, "AGENTS.md"), "PERSONALITY_NEW\n");
  await select(b);
  await ready(
    "d.querySelector('#personality-content').value === 'PERSONALITY_NEW\\n'",
  );
  assert.equal(
    await chat(`return w.viewsProbe.holds[${personality}].row.signal.aborted`),
    true,
  );
  await release(personality);
  assert.equal(
    await chat("return d.querySelector('#personality-content').value"),
    "PERSONALITY_NEW\n",
    "迟到 A 人格读取不能覆盖 B 表单",
  );
  await select(a);
  await ready(
    "d.querySelector('#personality-content').value === 'PERSONALITY_NEW\\n'",
  );

  const settings = await arm("/api/settings");
  await view("general");
  await held(settings);
  const settingsFile = join(f.agentDir, "settings.json");
  const settingsDoc = JSON.parse(await readFile(settingsFile, "utf8"));
  await writeFile(
    settingsFile,
    JSON.stringify({ ...settingsDoc, hideThinkingBlock: true }),
  );
  await select(b);
  await ready(
    "d.querySelector('[data-setting=hideThinkingBlock]')?.getAttribute('aria-checked') === 'true'",
  );
  await release(settings);
  assert.equal(
    await chat(
      "return d.querySelector('[data-setting=hideThinkingBlock]').getAttribute('aria-checked')",
    ),
    "true",
    "迟到设置不覆盖新身份",
  );
  await select(a);
  await ready(
    "d.querySelector('[data-setting=hideThinkingBlock]')?.getAttribute('aria-checked') === 'true'",
  );

  const mcpRead = await arm("/api/mcp");
  await view("mcp");
  await held(mcpRead);
  mcp = await f.call(`${prefix}/api/mcp?sessionId=${a}`);
  const mcpRow = mcp.rows.find((row) => row.name === "views-fixture");
  await f.call(`${prefix}/api/mcp`, {
    sessionId: a,
    action: "save",
    scope: mcpRow.scope,
    name: mcpRow.name,
    revision: mcpRow.revision,
    config: { description: "MCP_NEW" },
  });
  await select(b);
  await ready("d.querySelector('#mcp-list').textContent.includes('MCP_NEW')");
  await release(mcpRead);
  assert.equal(
    await chat(
      "return d.querySelector('#mcp-list').textContent.includes('MCP_OLD')",
    ),
    false,
  );
  await chat(
    "d.querySelector('[data-edit-mcp]').focus();w.viewsMcpButton=d.activeElement",
  );
  await pause(3300);
  assert.equal(
    await chat(
      "return w.viewsMcpButton === d.querySelector('[data-edit-mcp]') && d.activeElement === w.viewsMcpButton",
    ),
    true,
    "未变的资源补刷保留操作焦点",
  );
  await view("workspace");
  const mcpCalls = await chat(
    "return w.viewsProbe.calls.filter(row=>row.path.endsWith('/api/mcp')).length",
  );
  await pause(1800);
  assert.equal(
    await chat(
      "return w.viewsProbe.calls.filter(row=>row.path.endsWith('/api/mcp')).length",
    ),
    mcpCalls,
    "MCP 离页撤补刷观察",
  );

  await view("providers");
  await ready("d.querySelector('[data-all-models=desktop-fixture]')");
  await chat(
    "d.querySelector('[data-expand-provider=desktop-fixture]').click(); d.querySelector('[data-all-models=desktop-fixture]').click()",
  );
  await ready(
    "!d.querySelector('#view-workspace').hidden && !d.querySelector('#composer-model-popover').hidden && d.querySelectorAll('.model-menu-options [role=menuitemradio]').length === 26",
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
  });
  await ready("d.querySelector('#composer-model-popover').hidden");

  const remote = await arm("/api/remote");
  await view("remote");
  await held(remote);
  await view("appearance");
  await release(remote);
  assert.equal(
    await chat(
      "return w.viewsProbe.calls.filter(row=>row.path.endsWith('/api/remote') && row.method==='POST').length",
    ),
    0,
    "失效 GET 不启动 prepare 或 stop 共享动作",
  );
  const remoteCalls = await chat(
    "return w.viewsProbe.calls.filter(row=>row.path.endsWith('/api/remote')).length",
  );
  await pause(3200);
  assert.equal(
    await chat(
      "return w.viewsProbe.calls.filter(row=>row.path.endsWith('/api/remote')).length",
    ),
    remoteCalls,
    "远程页撤补刷 timer",
  );
  await chat(
    "const select=d.querySelector('#web-theme');select.value='dark';select.dispatchEvent(new Event('change',{bubbles:true}))",
  );
  assert.equal(await chat("return d.documentElement.dataset.theme"), "dark");

  await view("workspace");
  await chat(
    "const input=d.querySelector('#prompt');input.value='中文草稿';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))",
  );
  assert.equal(
    await chat("return d.querySelector('#prompt').value"),
    "中文草稿",
  );
  await pause(100);
  assert.equal(f.requests.length, 1, "IME Enter 不产生模型请求");

  // 页面卸载后的公开 dialog module 验证；生产实例已 dispose，不与第二实例共享监听器。
  await chat(
    "w.dispatchEvent(new w.PageTransitionEvent('pagehide',{persisted:false}))",
  );
  const frames = (await call("Page.getFrameTree")).frameTree.childFrames;
  const runtime = frames.find((row) =>
    new URL(row.frame.url).pathname.startsWith(prefix),
  );
  const { executionContextId } = await call("Page.createIsolatedWorld", {
    frameId: runtime.frame.id,
    worldName: "chat-dialog-contract",
  });
  const dialogResult = await call("Runtime.evaluate", {
    contextId: executionContextId,
    awaitPromise: true,
    returnByValue: true,
    expression: `(async()=>{
    const d=document;
    const {createChatDialog}=await import(${JSON.stringify(`${prefix}/chat-dialog.js`)});
    let identity='a', calls=0, release;
    const errors=[], gate=new Promise(resolve=>release=resolve);
    const dialog=createChatDialog({getIdentity:()=>identity,onError:error=>errors.push(error.message)});
    const first=dialog.open('first','<input name="value" value="旧表单">',async()=>{calls++;await gate;});
    d.querySelector('#dialog-form').requestSubmit();
    const second=dialog.open('second','<input name="value" value="新表单">',async()=>{calls++;});
    release();await Promise.resolve();await Promise.resolve();
    const retained=dialog.isCurrent(second)&&d.querySelector('#dialog-form').elements.value.value==='新表单';
    identity='b';d.querySelector('#dialog-form').requestSubmit();
    await Promise.resolve();
    const rejected=calls===1&&errors.length===1&&!dialog.isCurrent(first);
    dialog.dispose();dialog.dispose();
    return {retained,rejected,closed:!d.querySelector('#dialog').open};
  })()`,
  });
  assert.equal(
    dialogResult.exceptionDetails,
    undefined,
    JSON.stringify(dialogResult.exceptionDetails),
  );
  assert.deepEqual(dialogResult.result.value, {
    retained: true,
    rejected: true,
    closed: true,
  });
  const before = await chat("return w.viewsProbe.calls.length");
  await pause(3300);
  assert.equal(
    await chat("return w.viewsProbe.calls.length"),
    before,
    "卸载销毁所有设置观察，不复活定时读取",
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    "聊天视图通过：真实 A/B/A、配置草稿、人格/设置/MCP 迟到读取、焦点、远程撤观察、IME 与对话框保存代际。",
  );
} finally {
  driver?.close();
  if (browser && browser.exitCode === null) {
    const exit = once(browser, "exit");
    browser.kill("SIGKILL");
    await exit;
  }
  await f.close();
}
