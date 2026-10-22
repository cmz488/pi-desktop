import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";
import { measureSurfaceContrast } from "./surface-contrast.mjs";

const gate = Promise.withResolvers();
const f = await desktopFixture({
  noExtensions: true,
  modelReply: async (input) =>
    input.messages.at(-1)?.content === "WORKBENCH_APPROVAL"
      ? {
          toolCalls: [
            {
              id: "approval-write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: "browser-approval.txt",
                  content: "浏览器已批准",
                }),
              },
            },
          ],
        }
      : undefined,
  beforeModelResponse: async (input) => {
    if (input.messages.at(-1)?.content === "WORKBENCH_CHILD_HELD")
      await gate.promise;
  },
});
let browser, driver;
try {
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "工作台会话",
  });
  const prefix = `/agents/${actor.id}`;
  const parent = (await f.call(`${prefix}/api/state`)).sessionId;
  const launched = await f.call(`${prefix}/api/command?sessionId=${parent}`, {
    command: "subagent.spawn",
    id: Number(parent),
    sessionId: parent,
    prompt: "WORKBENCH_CHILD_HELD",
    name: "工作台子代理",
    requestId: "workbench-child",
  });
  await until(
    () => f.call(`${prefix}/api/tasks?sessionId=${parent}`),
    (value) => value.tasks.some((row) => row.id === launched.taskId),
  );
  const profile = join(f.root, "subagent-workbench-browser");
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
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const url = new URL(f.app.url);
  url.searchParams.set("agent", actor.id);
  await call("Page.navigate", { url: url.href });
  await ready("!!document.querySelector('#projects [data-agent-id]')");
  assert.equal(
    await evaluate("!!document.querySelector('#tasks-entry')"),
    false,
    "左侧栏不再提供独立任务监控入口",
  );
  assert.equal(
    await evaluate("!!document.querySelector('#host-task-dialog')"),
    false,
    "任务监控不能继续留在独立弹窗",
  );
  const frame = "document.querySelector('#runtime')?.contentDocument";
  const chat = (source) => evaluate(`(()=>{const d=${frame};${source}})()`);
  await ready(
    `(()=>{const d=${frame};return d?.querySelector('#connection-status')?.textContent === 'Pi 已连接';})()`,
  );
  await evaluate("document.querySelector('#extensions-entry').click()");
  await ready(
    `(()=>{const d=${frame};return [...d.querySelectorAll('.extension-page-choice')].some(row=>row.textContent.includes('任务与子代理'));})()`,
  );
  await chat(
    "[...d.querySelectorAll('.extension-page-choice')].find(row=>row.textContent.includes('任务与子代理')).click();",
  );
  await ready(
    `(()=>{const d=${frame};return !!d.querySelector('[data-task-id="${launched.taskId}"] [data-task-inspect]');})()`,
  );
  assert.equal(
    await chat(
      `return d.querySelector('[data-task-id="${launched.taskId}"]').textContent.includes('工作台子代理');`,
    ),
    true,
    "实时任务行使用原生 owned 子会话名称，而不只显示种类",
  );
  await chat(
    `d.querySelector('[data-task-id="${launched.taskId}"] [data-task-inspect]').focus();`,
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
    unmodifiedText: "\r",
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await ready(
    `(()=>{const d=${frame};return d.querySelector('.task-panel-detail')?.textContent.includes('WORKBENCH_CHILD_HELD');})()`,
  );
  assert.equal(
    await chat(
      `const button=d.querySelector('[data-task-inspect="${launched.taskId}"]');return button.getAttribute('aria-expanded')==='true'&&d.getElementById(button.getAttribute('aria-controls'))===d.querySelector('.task-panel-detail');`,
    ),
    true,
    "选中任务明确公开其展开状态及所控制的详情区域",
  );
  assert.equal(
    await chat("return d.activeElement.dataset.taskInspect;"),
    String(launched.taskId),
    "键盘 Enter 打开详情后焦点仍在任务操作上",
  );
  assert.equal(
    await chat(
      "return d.querySelector('#view-extensions .task-panel').getClientRects().length>0;",
    ),
    true,
    "实时列表和详情直接属于现有内置面板",
  );
  assert.equal(
    await chat("return d.querySelectorAll('.task-panel').length;"),
    1,
    "只保留一个任务与子代理面板，不叠加另一套监控 UI",
  );
  await evaluate(
    `(()=>{const w=(${frame}).defaultView;const original=w.fetch.bind(w);w.detailShapeFetch=original;w.detailShapeMutated=false;w.fetch=async(...args)=>{const detail=String(args[0]).includes('/api/task-detail');const init={...args[1],headers:new w.Headers(args[1]?.headers)};if(detail)init.headers.delete('if-none-match');const response=await original(args[0],init);if(detail){const data=await response.json();data.hasMoreChildren=true;w.detailShapeMutated=true;return new w.Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});}return response;};})()`,
  );
  await chat(
    `d.querySelector('[data-task-inspect="${launched.taskId}"]').click();`,
  );
  await ready(`(${frame}).defaultView.detailShapeMutated===true`);
  await ready(
    `(()=>{const d=${frame};return d.querySelector('.task-panel-detail')?.textContent.includes('部分子会话未显示');})()`,
  );
  await evaluate(
    `(()=>{const w=(${frame}).defaultView;w.fetch=w.detailShapeFetch;delete w.detailShapeFetch;})()`,
  );
  await chat(
    `d.querySelector('[data-task-inspect="${launched.taskId}"]').click();`,
  );
  await ready(
    `(()=>{const d=${frame};return !d.querySelector('.task-panel-detail')?.textContent.includes('部分子会话未显示');})()`,
  );
  await evaluate(
    `(()=>{const w=(${frame}).defaultView;const original=w.fetch.bind(w);let release;const gate=new Promise(resolve=>release=resolve);const probe={original,release,started:false};w.uiStatusProbe=probe;w.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/api/tasks?')&&!probe.started){probe.started=true;await gate;return new w.Response(JSON.stringify({error:'工作台读取测试中断'}),{status:503,headers:{'content-type':'application/json'}});}return response;};})()`,
  );
  await chat("d.querySelector('[data-task-refresh]').click();");
  await ready(`(${frame}).defaultView.uiStatusProbe.started`);
  assert.equal(
    await chat(
      "return d.querySelector('.task-panel').getAttribute('aria-busy');",
    ),
    "true",
    "公开 HTTP 读取未完成时保留明确加载状态",
  );
  await evaluate(`(${frame}).defaultView.uiStatusProbe.release()`);
  await ready(
    `(${frame}).querySelector('.task-panel-error')?.textContent.includes('工作台读取测试中断')`,
  );
  assert.equal(
    await chat(
      `return !!d.querySelector('[data-task-id="${launched.taskId}"]');`,
    ),
    true,
    "读取失败保留先前任务内容，不伪装为空清单",
  );
  await evaluate(
    `(()=>{const w=(${frame}).defaultView;w.fetch=w.uiStatusProbe.original;delete w.uiStatusProbe;})()`,
  );
  await chat("d.querySelector('[data-task-refresh]').click();");
  await ready(`!(${frame}).querySelector('.task-panel-error')`);
  const tree = await call("Page.getFrameTree");
  const world = await call("Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: "subagent-workbench-contrast",
  });
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `localStorage.setItem('pi-web-theme',${JSON.stringify(theme)});window.dispatchEvent(new StorageEvent('storage',{key:'pi-web-theme',newValue:${JSON.stringify(theme)}}));`,
    );
    await ready(
      `(${frame})?.body.classList.contains('dark') === ${theme === "dark"}`,
    );
    await chat(
      "return Promise.all(d.getAnimations().filter(item=>item instanceof d.defaultView.CSSTransition).map(item=>item.finished.catch(()=>{}))); ",
    );
    const result = await call("Runtime.evaluate", {
      contextId: world.executionContextId,
      returnByValue: true,
      expression: `(${measureSurfaceContrast.toString()})(['.task-panel-label','.task-panel-meta','.task-panel-management h3','.host-task-result-heading small','.host-task-message > small','.host-task-message-body'],${frame})`,
    });
    assert.equal(result.exceptionDetails, undefined);
    const contrast = result.result.value;
    assert.equal(contrast.length, 6);
    assert.ok(
      contrast.every((row) => row.ratio >= 4.5),
      `${theme} 整合详情文本对比度：${JSON.stringify(contrast)}`,
    );
    if (process.env.PI_SUBAGENT_UI_SCREENSHOTS) {
      await mkdir(process.env.PI_SUBAGENT_UI_SCREENSHOTS, { recursive: true });
      const shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(
          process.env.PI_SUBAGENT_UI_SCREENSHOTS,
          `subagent-workbench-${theme}.png`,
        ),
        Buffer.from(shot.data, "base64"),
      );
    }
  }
  await evaluate(
    `(()=>{const w=(${frame}).defaultView;const original=w.fetch.bind(w);let release;const gate=new Promise(resolve=>release=resolve);w.observationProbe={held:[],waits:[],historyGenerations:[],release};w.fetch=async(...args)=>{if(String(args[0]).includes('/api/subagent-history'))w.observationProbe.historyGenerations.push(new URL(args[0],w.location.href).searchParams.get('generation'));if(args[1]?.body&&JSON.parse(args[1].body).command==='wait'){const item={aborted:args[1].signal.aborted};args[1].signal.addEventListener('abort',()=>item.aborted=true,{once:true});w.observationProbe.waits.push(item);}const response=await original(...args);if(String(args[0]).includes('/api/task-detail')){const item={aborted:args[1].signal.aborted,generation:new URL(args[0],w.location.href).searchParams.get('generation')};args[1].signal.addEventListener('abort',()=>item.aborted=true,{once:true});w.observationProbe.held.push(item);await gate;}return response;};})()`,
  );
  await ready(
    `(()=>{const d=${frame};return d.defaultView.observationProbe.held.length>0;})()`,
  );
  assert.equal(
    await chat(
      "return d.defaultView.observationProbe.held.every(row=>row.generation==='0');",
    ),
    true,
    "实时详情固定 iframe 存储代际",
  );
  await chat(
    `d.querySelector('[data-task-action="wait:${launched.taskId}"]').click();`,
  );
  await ready(
    `(()=>{const d=${frame};return d.defaultView.observationProbe.waits.length>0;})()`,
  );
  await chat(
    "[...d.querySelectorAll('.extension-page-choice')].find(row=>row.textContent.includes('对话分支')).click();",
  );
  await ready(
    `(()=>{const d=${frame};return d.defaultView.observationProbe.waits.every(row=>row.aborted);})()`,
  );
  await ready(
    `(${frame}).querySelector('.branch-tree-note')?.textContent.includes('对话轮次')||(${frame}).querySelector('.branch-tree-note')?.textContent.includes('原生树记录')`,
  );
  await ready(
    `(()=>{const d=${frame};return d.defaultView.observationProbe.held.some(row=>row.aborted);})()`,
  );
  await evaluate(
    `(()=>{const w=(${frame}).defaultView;w.observationProbe.release();})()`,
  );
  await chat(
    "[...d.querySelectorAll('.extension-page-choice')].find(row=>row.textContent.includes('任务与子代理')).click();",
  );
  assert.equal(
    await chat("return !!d.querySelector('[data-task-compose-toggle]');"),
    true,
    "创建操作也必须整合进同一任务与子代理面板",
  );
  assert.equal(
    await chat(
      "return d.querySelector('[data-task-compose-toggle]').getAttribute('aria-expanded');",
    ),
    "false",
    "发起折叠状态向辅助技术明确公开",
  );
  await chat("d.querySelector('[data-task-compose-toggle]').click();");
  assert.equal(
    await chat(
      "return d.querySelector('[data-task-compose-toggle]').getAttribute('aria-expanded');",
    ),
    "true",
  );
  await chat(
    "d.querySelector('[data-task-compose] button[type=button]').click();",
  );
  assert.equal(
    await chat(
      "return d.querySelector('[data-task-compose-toggle]').getAttribute('aria-expanded');",
    ),
    "false",
    "表单内收起操作也必须同步折叠状态",
  );
  assert.equal(
    await chat(
      "return d.activeElement.hasAttribute('data-task-compose-toggle');",
    ),
    true,
    "收起后焦点返回可见的发起按钮",
  );
  await chat("d.querySelector('[data-task-compose-toggle]').click();");
  await chat(
    `const form=d.querySelector('[data-task-compose]');
    const original=d.defaultView.fetch.bind(d.defaultView);
    d.defaultView.fetch=(...args)=>{if(args[1]?.body){const body=JSON.parse(args[1].body);if(body.command==='subagent.spawn')d.defaultView.launchBudget=body.config?.maxTurns;}return original(...args);};
    form.elements.name.value='工作台新委托';form.elements.prompt.value='CREATED_IN_WORKBENCH';form.elements.maxTurns.value='5';form.requestSubmit();`,
  );
  const created = await until(
    () => f.call(`${prefix}/api/task-monitor?sessionId=${parent}`),
    (value) => value.conversations.some((row) => row.name === "工作台新委托"),
  );
  assert.equal(
    created.conversations.find((row) => row.name === "工作台新委托").owner
      .conversationId,
    Number(parent),
    "发起目标固定为当前会话，不提供其他 Agent 选择器",
  );
  assert.equal((await f.call("/api/workspace")).agents.length, 1);
  assert.equal(
    await chat("return d.defaultView.launchBudget;"),
    5,
    "高级配置的数值回合预算必须传入真实准入请求",
  );
  const createdChild = created.conversations.find(
    (row) => row.name === "工作台新委托",
  );
  await until(
    () =>
      f.call(
        `${prefix}/api/task-detail?sessionId=${parent}&taskId=${createdChild.owner.taskId}`,
      ),
    (value) => value.task.status === "terminal",
  );
  await ready(
    `(()=>{const d=${frame};return !d.querySelector('[data-child-id="${createdChild.id}"]');})()`,
  );
  await chat(
    "[...d.querySelectorAll('.extension-page-choice')].find(row=>row.textContent.includes('对话分支')).click();",
  );
  await ready(
    `(()=>{const d=${frame};return !!d.querySelector('[data-subagent-history]');})()`,
  );
  await chat("d.querySelector('[data-subagent-history] > summary').click();");
  await ready(
    `(()=>{const d=${frame};return !!d.querySelector('[data-subagent-record="${createdChild.owner.taskId}"]');})()`,
  );
  assert.equal(
    await chat(
      "return d.defaultView.observationProbe.historyGenerations.length>0&&d.defaultView.observationProbe.historyGenerations.every(value=>value==='0');",
    ),
    true,
    "终态历史读取同样固定存储代际",
  );
  assert.equal(
    await chat(
      `return !!d.querySelector('[data-subagent-record="${launched.taskId}"]');`,
    ),
    false,
    "仍运行的委托不冒充终态历史记录",
  );
  await chat(
    `const button=d.querySelector('[data-subagent-record="${createdChild.owner.taskId}"]');button.focus();d.defaultView.historyFocusProbe={before:d.activeElement.dataset.subagentRecord};button.click();d.defaultView.historyFocusProbe.after=d.activeElement.dataset.subagentRecord;`,
  );
  await ready(
    `(()=>{const d=${frame};return d.querySelector('.subagent-history-detail')?.textContent.includes('answer: CREATED_IN_WORKBENCH');})()`,
  );
  assert.equal(
    await chat("return d.activeElement.dataset.subagentRecord;"),
    String(createdChild.owner.taskId),
    `选中历史记录后键盘焦点仍属于同一记录：${JSON.stringify(await chat("return d.defaultView.historyFocusProbe;"))}`,
  );
  await chat(
    "[...d.querySelectorAll('.extension-page-choice')].find(row=>row.textContent.includes('任务与子代理')).click();",
  );
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await ready(
    `(()=>{const d=${frame};return !!d.querySelector('[data-task-inspect="${launched.taskId}"]');})()`,
  );
  await chat(
    `d.querySelector('[data-task-inspect="${launched.taskId}"]').click();d.querySelector('[data-task-compose-toggle]').click();`,
  );
  await ready(
    `(()=>{const d=${frame};return d.querySelector('.task-panel-detail')?.textContent.includes('WORKBENCH_CHILD_HELD');})()`,
  );
  assert.equal(
    await chat(
      "return d.documentElement.scrollWidth<=d.defaultView.innerWidth;",
    ),
    true,
    "390px 实时详情与表单不横向溢出",
  );
  const layout = await chat(
    "return {panel:d.querySelector('.task-panel').getBoundingClientRect().width,detail:d.querySelector('.task-panel-management').getBoundingClientRect().width};",
  );
  assert.ok(
    layout.detail >= layout.panel - 1,
    `窄屏详情与表单应占满可用栏宽：${JSON.stringify(layout)}`,
  );
  const targets = await chat(
    "return [...d.querySelectorAll('.task-panel .outline-button')].map(node=>{const r=node.getBoundingClientRect();return {label:node.textContent,height:r.height,width:r.width};});",
  );
  assert.ok(
    targets.every((row) => row.height >= 44 && row.width >= 44),
    `触屏动作保留 44px 触达目标：${JSON.stringify(targets)}`,
  );
  if (process.env.PI_SUBAGENT_UI_SCREENSHOTS) {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(
      join(
        process.env.PI_SUBAGENT_UI_SCREENSHOTS,
        "subagent-workbench-narrow.png",
      ),
      Buffer.from(shot.data, "base64"),
    );
  }
  const fields = await chat(
    "return [...d.querySelectorAll('.task-panel-field input,.task-panel-field select,.task-panel-advanced > summary')].filter(node=>node.getClientRects().length).map(node=>node.getBoundingClientRect().height);",
  );
  assert.ok(
    fields.length > 0 && fields.every((height) => height >= 44),
    "触屏表单与高级配置披露同样保留 44px 触达目标",
  );
  gate.resolve();
  await until(
    () => f.call(`${prefix}/api/tasks?sessionId=${parent}`),
    (value) => value.tasks.length === 0,
  );
  await ready(
    `(${frame}).querySelector('.task-panel-empty')?.textContent.includes('暂无进行中的任务')`,
  );
  assert.equal(
    await chat(
      "return d.querySelector('.task-panel').getAttribute('aria-busy');",
    ),
    "false",
    "原生工作真正结束后才展示稳定空态",
  );
  // 后台确认必须走现有父会话交互 UI，不能要求用户猜测子会话 URL。
  await f.command("agent.policy", { id: actor.id, mode: "ask-all" });
  for (const allow of [false, true]) {
    const approval = await f.call(`${prefix}/api/command?sessionId=${parent}`, {
      command: "subagent.spawn",
      id: Number(parent),
      sessionId: parent,
      requestId: `browser-approval-${allow}`,
      name: "浏览器审批子代理",
      prompt: "WORKBENCH_APPROVAL",
      config: { tools: ["write"] },
    });
    await ready(
      `(()=>{const d=${frame};return d.querySelector('#interaction-dialog').open&&d.querySelector('#interaction-title').textContent.includes('浏览器审批子代理');})()`,
    );
    await assert.rejects(readFile(join(f.cwd, "browser-approval.txt")), {
      code: "ENOENT",
    });
    await chat(`const form=d.querySelector('#interaction-form'),select=form.elements.value;
      select.value=[...select.options].find(row=>row.textContent===${JSON.stringify(allow ? "确认" : "取消")}).value;form.requestSubmit();`);
    await until(
      () =>
        f.call(
          `${prefix}/api/task-detail?sessionId=${parent}&taskId=${approval.taskId}`,
        ),
      (value) => value.task.status === "terminal",
    );
    await ready(`!(${frame}).querySelector('#interaction-dialog').open`);
  }
  assert.equal(
    await readFile(join(f.cwd, "browser-approval.txt"), "utf8"),
    "浏览器已批准",
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    "Subagent workbench passed: one embedded panel, owned live/history split, visibility cleanup, accessible composer, two themes and narrow touch layout.",
  );
} finally {
  gate.resolve();
  driver?.close();
  if (browser && browser.exitCode === null) {
    const ended = once(browser, "close");
    browser.kill("SIGTERM");
    await ended;
  }
  await rm(join(f.root, "subagent-workbench-browser"), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  await f.close();
}
