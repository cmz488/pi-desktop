import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until as untilValue } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

const childGate = Promise.withResolvers();
const sideGate = Promise.withResolvers();
let sideStarted = false;
const f = await desktopFixture({
  noExtensions: false,
  modelReply: (input) => ({
    text: `answer: ${
      typeof input.messages.at(-1).content === "string"
        ? input.messages.at(-1).content
        : input.messages
            .at(-1)
            .content.filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
    }`,
  }),
  beforeModelResponse: async (input) => {
    if (input.messages.at(-1)?.content === "BROWSER_CHILD")
      await childGate.promise;
    const content = input.messages.at(-1)?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n")
          : "";
    if (text.includes("BROWSER_SIDE_CANCEL")) {
      sideStarted = true;
      await sideGate.promise;
    }
  },
});
const git = (args) => promisify(execFile)("git", args, { cwd: f.cwd });
let chrome, driver;
try {
  const modelsPath = join(f.agentDir, "models.json");
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  models.providers["desktop-fixture"].models.push({
    id: "second",
    name: "PARITY_SECOND_MODEL",
    contextWindow: 8192,
    maxTokens: 1024,
  });
  await writeFile(modelsPath, JSON.stringify(models));
  await mkdir(join(f.cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(f.cwd, ".pi", "extensions", "parity.ts"),
    `export default function(pi) {
 pi.registerCommand("btw", {description:"Local Desktop BTW fixture",handler:async()=>{}});
 pi.registerCommand("parity-card", {description:"Parity fixture",handler:async(_args,ctx)=>{
 ctx.ui.setStatus("parity","BROWSER_STATUS");ctx.ui.setTitle("BROWSER_TITLE");ctx.ui.setToolsExpanded(true);
 ctx.ui.setWidget("parity",["BROWSER_WIDGET","SECOND_WIDGET_LINE"]);
 pi.sendMessage({customType:"parity",content:"",display:true,details:{piDesktop:{version:1,title:"BROWSER_CARD",body:"Card body"}}});
 }});}`,
  );
  await writeFile(join(f.cwd, "parity.txt"), "BROWSER_FILE_CONTENT\n");
  await writeFile(join(f.cwd, "preview-new.txt"), "NEW_PREVIEW_CONTENT\n");
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["add", "."]);
  await git(["commit", "-m", "initial fixture"]);
  const workspace = await f.call("/api/workspace");
  const project = workspace.projects.find((row) => row.cwd === f.cwd);
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "BROWSER_ACTOR",
  });
  await untilValue(
    () => f.call("/api/workspace"),
    (value) =>
      value.agents.find((row) => row.id === actor.id)?.status === "running",
  );
  const profile = join(f.root, "parity-browser");
  chrome = spawn(
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
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__httpErrors=[];window.__requestPaths=[];window.__frameUrls=[];window.__uiErrors=[];window.addEventListener('error',e=>window.__uiErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__uiErrors.push(String(e.reason)));const original=window.fetch;window.fetch=async(...args)=>{window.__requestPaths.push(String(args[0]));const r=await original(...args);if(window.__holdSpawn && String(args[1]?.body).includes('subagent.spawn'))await new Promise(resolve=>{window.__releaseSpawn=()=>{window.__holdSpawn=false;resolve()}});if(window.__holdFile && String(args[0]).includes('/api/files?path=parity.txt')){await new Promise(resolve=>{window.__releaseFile=()=>{window.__holdFile=false;resolve()}});window.__fileReleased=true}if(String(args[0]).includes('/_browser/frame') && r.status===200)window.__frameUrls.push(String(args[0]));if(!r.ok)window.__httpErrors.push({path:String(args[0]),status:r.status});return r;};`,
  });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: f.app.url });
  await until(
    '!!document.querySelector(".sidebar") && !document.querySelector("#splash")',
  );
  const click = async (selector, text) => {
    await until(
      `!![...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.textContent.trim()===${JSON.stringify(text)} && !n.disabled)`,
    );
    return evaluate(
      `(()=>{const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.textContent.trim()===${JSON.stringify(text)});n.click()})()`,
    );
  };
  const fill = (selector, value) =>
    evaluate(
      `(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)throw new Error('Missing input '+${JSON.stringify(selector)});const setter=Object.getOwnPropertyDescriptor(n.tagName==='SELECT'?HTMLSelectElement.prototype:n.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  const confirm = async (title) => {
    await until(
      `!!document.querySelector('[role=dialog][aria-label=${JSON.stringify(title)}]')`,
    );
    await click(
      `[role=dialog][aria-label="${title}"] button`,
      title.startsWith("确认 Git ") ? "确认执行" : "确认",
    );
  };
  const pressEscape = async () => {
    for (const type of ["keyDown", "keyUp"])
      await call("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
  };
  const contextMenu = async (sessionId, label) => {
    await until(
      `!!document.querySelector('[data-session-id=${JSON.stringify(sessionId)}]')`,
    );
    await evaluate(
      `(()=>{const row=document.querySelector('[data-session-id=${JSON.stringify(sessionId)}]');if(!row)throw new Error('Missing session row '+${JSON.stringify(sessionId)});row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:320}));})()`,
    );
    await until(
      `!![...document.querySelectorAll('[role=menu] button')].find(n=>n.textContent.trim()===${JSON.stringify(label)})`,
    );
    await click("[role=menu] button", label);
  };
  const viewOption = async (label) => {
    if (
      !(await evaluate(
        "!!document.querySelector('[role=dialog][aria-label=\"视图选项\"]')",
      ))
    )
      await evaluate(
        'document.querySelector("button[aria-label=视图选项]").click()',
      );
    await until(
      "!!document.querySelector('[role=dialog][aria-label=\"视图选项\"]')",
    );
    await click('[role=dialog][aria-label="视图选项"] button', label);
    await until(
      `[...document.querySelectorAll('[role=dialog][aria-label="视图选项"] [role=radio]')].find(n=>n.textContent.trim()===${JSON.stringify(label)})?.getAttribute('aria-checked')==='true'`,
    );
  };
  const openRight = async (tab) => {
    if (
      !(await evaluate(
        'document.querySelector(".workspace-dock")?.classList.contains("open")',
      ))
    )
      await evaluate(
        'document.querySelector("button[aria-label=工作区侧栏]").click()',
      );
    await until(
      'document.querySelector(".workspace-dock")?.classList.contains("open")',
    );
    await click('.workspace-dock [aria-label="工作区面板"] button', tab);
  };
  const closeRight = () =>
    evaluate(
      'document.querySelector("button[aria-label=关闭工作区侧栏]").click()',
    );
  const openSettings = async (category) => {
    if (
      !(await evaluate('!!document.querySelector("[role=dialog][aria-modal]")'))
    )
      await click(".sidebar button", "设置");
    await until('!!document.querySelector("[role=dialog][aria-modal]")');
    await click("[role=dialog][aria-modal] nav button", category);
  };
  const closeSettings = () =>
    evaluate(
      'document.querySelector("[role=dialog][aria-modal] button[aria-label=关闭]").click()',
    );
  const send = async (text) => {
    await evaluate(
      'document.querySelector("[contenteditable=true][role=textbox]").focus()',
    );
    await call("Input.insertText", { text });
    if (text.startsWith("/")) {
      await until(
        `!![...document.querySelectorAll('button[data-index]')].find(n=>n.textContent.includes(${JSON.stringify(text)}))`,
      );
      await evaluate(
        `[...document.querySelectorAll('button[data-index]')].find(n=>n.textContent.includes(${JSON.stringify(text)})).click()`,
      );
      return;
    }
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
  };
  assert.equal(
    await evaluate(
      '!!document.querySelector(".desktop-workbench,.native-dialog,.desktop-toolbar")',
    ),
    false,
    "no second navigation shell",
  );
  await contextMenu(actor.id, "项目信任");
  await confirm("信任项目");
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/state`),
    (state) => state.projectTrusted,
  );
  await evaluate(
    `document.querySelector('[data-session-id="${actor.id}"]')?.click()`,
  );
  await until(
    `document.querySelector('[data-session-page]')?.dataset.sessionId===${JSON.stringify(actor.id)}`,
  );
  await send("BROWSER_CHAT");
  await until(
    'document.querySelector("[data-session-page]").innerText.includes("answer: BROWSER_CHAT")',
  );
  await f.call(`/agents/${actor.id}/api/model`, {
    provider: "desktop-fixture",
    id: "second",
  });
  await until(
    'document.querySelector("[data-session-page]").innerText.includes("PARITY_SECOND_MODEL")',
  );
  await send("/parity-card");
  await until(
    'document.querySelector("[contenteditable=true]").innerText.trim()===""',
  );
  await send("");
  await until(
    'document.querySelector(".desktop-card")?.innerText.includes("BROWSER_CARD") && document.title==="BROWSER_TITLE"',
  );
  await until(
    'document.querySelector("[data-session-page]").innerText.includes("BROWSER_WIDGET")',
  );
  await until(
    `!![...document.querySelectorAll('.desktop-card p')].find(n=>n.innerText.includes(${JSON.stringify("BROWSER_WIDGET\nSECOND_WIDGET_LINE")}))`,
  );
  assert(
    (
      await evaluate(
        `document.querySelector('[aria-label="Pi 扩展状态"]')?.innerText`,
      )
    ).includes("BROWSER_STATUS"),
  );
  console.log(
    "PASS left sidebar session/process/trust, chat, native model and extension status/card/widget",
  );
  await openRight("任务");
  await until(
    '!![...document.querySelectorAll(".workspace-dock button")].find(n=>n.textContent==="新建子代理" && !n.disabled)',
  );
  await click(".workspace-dock button", "新建子代理");
  await fill("[data-task-compose] input[name=name]", "BROWSER_CHILD_NAME");
  await fill("[data-task-compose] textarea[name=prompt]", "BROWSER_CHILD");
  await closeRight();
  await openRight("任务");
  await until(
    '!![...document.querySelectorAll(".workspace-dock button")].find(n=>n.textContent==="新建子代理" && !n.disabled)',
  );
  await click(".workspace-dock button", "新建子代理");
  await until(
    'document.querySelector("[data-task-compose] textarea[name=prompt]")?.value==="BROWSER_CHILD"',
  );
  await evaluate("window.__holdSpawn=true");
  await evaluate(
    'document.querySelector("[data-task-compose]").requestSubmit()',
  );
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/tasks`),
    (value) =>
      value.conversations?.some((row) => row.name === "BROWSER_CHILD_NAME"),
  );
  await until('typeof window.__releaseSpawn==="function"');
  assert(
    await evaluate(
      'document.querySelector("[data-task-compose] textarea[name=prompt]").matches(":disabled")',
    ),
    "pending submission locks its original draft",
  );
  await evaluate("window.__releaseSpawn()");
  await until('!document.querySelector("[data-task-compose]")');
  await closeRight();
  assert(
    (await f.call(`/agents/${actor.id}/api/tasks`)).tasks.some(
      (task) => task.kind === "desk.subagent-run" && task.status === "running",
    ),
    "closing observer leaves actual task alive",
  );
  childGate.resolve();
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/state`),
    (state) => state.idle,
  );
  await openRight("任务");
  await click('.workspace-dock [aria-label="任务分类"] button', "扩展面板");
  await until(
    'document.querySelector(".workspace-dock").innerText.includes("BROWSER_CARD")',
  );
  console.log(
    "PASS right task panel: retained draft, actual spawn, close isolation, extension panels",
  );
  await openRight("文件");
  await until(
    'document.querySelector("[aria-label=项目文件]")?.innerText.includes("parity.txt")',
  );
  await click("[aria-label=项目文件] button", "parity.txt");
  await until(
    'document.querySelector("[aria-label=文件预览]")?.innerText.includes("BROWSER_FILE_CONTENT")',
  );
  await evaluate("window.__holdFile=true");
  await click("[aria-label=项目文件] button", "parity.txt");
  await until('typeof window.__releaseFile==="function"');
  await click("[aria-label=项目文件] button", "preview-new.txt");
  await until(
    'document.querySelector("[aria-label=文件预览]")?.innerText.includes("NEW_PREVIEW_CONTENT")',
  );
  await evaluate("window.__releaseFile()");
  await until("window.__fileReleased===true");
  await evaluate("new Promise(requestAnimationFrame)");
  assert(
    (
      await evaluate(
        'document.querySelector("[aria-label=文件预览]").innerText',
      )
    ).includes("NEW_PREVIEW_CONTENT"),
    "late A response cannot replace last selected B",
  );
  assert(
    await evaluate(
      `(()=>{const tree=document.querySelector('[aria-label=文件树]').getBoundingClientRect();const preview=document.querySelector('[aria-label=文件预览]').getBoundingClientRect();return preview.left>=tree.right-1 && Math.abs(preview.top-tree.top)<2;})()`,
    ),
    "preview sits to the right of the file tree",
  );
  console.log(
    "PASS right sidebar file tree, preview and out-of-order selection",
  );
  const observer = await f.command("conversation.create", {
    projectId: project.id,
    name: "BROWSER_OBSERVER",
  });
  await untilValue(
    () => f.call("/api/workspace"),
    (value) =>
      value.agents.find((row) => row.id === observer.id)?.status === "running",
  );
  await f.call(`/agents/${observer.id}/api/prompt`, {
    message: "BROWSER_OBSERVER_HISTORY",
  });
  await untilValue(
    () => f.call(`/agents/${observer.id}/api/state`),
    (state) =>
      state.idle && state.messages.some((row) => row.role === "assistant"),
  );
  await until(
    `!!document.querySelector('select[aria-label=侧栏会话] option[value="${observer.id}"]')`,
  );
  await fill("select[aria-label=侧栏会话]", observer.id);
  await until(
    `window.__requestPaths.some(path=>path.startsWith('/agents/${observer.id}/api/files'))`,
  );
  assert.equal(
    await evaluate(
      'document.querySelector("[data-session-page]").dataset.sessionId',
    ),
    actor.id,
    "inspecting B does not change chat A",
  );
  await fill("select[aria-label=侧栏会话]", "");
  console.log(
    "PASS right sidebar inspection scope stays separate from the active conversation",
  );
  await openRight("网页");
  await until('!!document.querySelector(".native-browser-viewport canvas")');
  await fill(
    "input[aria-label=搜索或输入网址]",
    `${f.app.url.replace(/\/$/, "")}/api/health`,
  );
  await click(".workspace-dock button", "打开");
  await until(
    `window.__frameUrls.some(url=>url.startsWith('/agents/${actor.id}/_browser/frame'))`,
    { timeoutMs: 30000 },
  );
  console.log(
    "PASS right web browser: actual Chromium frame stays bound to the selected worker",
  );
  await closeRight();
  await evaluate(`(() => {
    const calls=[],tabs=new Map(),listeners=new Set();
    window.__electron={calls,tabs,listeners,visible:null};
    window.__electronFetch=window.fetch;
    window.fetch=async(...args)=>{
      const response=await window.__electronFetch(...args);
      if(String(args[0]).includes('/api/state')){
        const state=await response.clone().json(); state.capabilities.agentBrowser=false;
        return new Response(JSON.stringify(state),{status:response.status,headers:{'Content-Type':'application/json'}});
      }
      return response;
    };
    window.piDesk={onBrowserState(callback){listeners.add(callback);return()=>listeners.delete(callback)},async browserCommand(input){
      calls.push(input);
      if(input.action==='hide'){window.__electron.visible=null;return}
      if(!/^[a-f0-9-]{36}$/.test(input.owner)||!/^[a-f0-9-]{36}$/.test(input.id))throw Error('invalid native owner/tab');
      const key=input.owner+':'+input.id;
      if(input.action==='navigate'){
        const tab={owner:input.owner,id:input.id,url:input.url,title:'ELECTRON_TAB'};tabs.set(key,tab);listeners.forEach(callback=>callback(tab));return tab;
      }
      const tab=tabs.get(key);if(!tab)throw Error('unknown native tab');
      if(input.action==='layout')window.__electron.visible=input.id;
      else if(input.action==='close'){tabs.delete(key);return}
      else if(input.action!=='state')throw Error('unsupported native action '+input.action);
      return tab;
    }};
  })()`);
  await openRight("网页");
  await until("window.__electron.listeners.size===1");
  await fill(
    "input[aria-label=搜索或输入网址]",
    "https://example.invalid/native",
  );
  await click(".workspace-dock button", "打开");
  try {
    await until("window.__electron.visible!==null");
  } catch (error) {
    console.error(
      "Electron viewport:",
      await evaluate(
        '({calls:window.__electron.calls,bounds:document.querySelector(".native-browser-viewport")?.getBoundingClientRect().toJSON(),modal:document.querySelector(\'[role="dialog"][aria-modal]\')?.outerHTML.slice(0,500)})',
      ),
    );
    throw error;
  }
  assert.equal(await evaluate("window.__electron.tabs.size"), 1);
  await closeRight();
  await until(
    "window.__electron.visible===null && window.__electron.listeners.size===0",
  );
  await openRight("网页");
  await until(
    'window.__electron.visible!==null && document.querySelector(".workspace-dock").innerText.includes("ELECTRON_TAB")',
  );
  assert.equal(
    await evaluate(
      'window.__electron.calls.filter(row=>row.action==="navigate").length',
    ),
    1,
    "reopening observation restores the existing native tab",
  );
  await closeRight();
  await evaluate("window.fetch=window.__electronFetch;delete window.piDesk");
  console.log(
    "PASS Electron fallback UI: native protocol, viewport layout and retained tabs after reopen",
  );
  await writeFile(join(f.cwd, "parity.txt"), "BROWSER_FILE_CONTENT\nchanged\n");
  await openRight("Git");
  await until(
    `document.querySelector('[aria-label="Git 仓库管理"]')?.innerText.includes('parity.txt')`,
  );
  await until(
    '!![...document.querySelectorAll(".workspace-dock button")].find(n=>n.textContent==="全部暂存" && !n.disabled)',
  );
  await click(".workspace-dock button", "全部暂存");
  await confirm("确认 Git 暂存");
  await untilValue(
    () => git(["diff", "--cached", "--name-only"]),
    (value) => value.stdout.includes("parity.txt"),
  );
  await click('.workspace-dock [aria-label="Git 分类"] button', "提交");
  await fill("textarea[aria-label=提交说明]", "browser parity commit");
  await until(
    '!![...document.querySelectorAll(".workspace-dock button")].find(n=>n.textContent==="预览提交" && !n.disabled)',
  );
  await click(".workspace-dock button", "预览提交");
  await confirm("确认 Git 提交");
  await untilValue(
    () => git(["log", "-1", "--format=%s"]),
    (value) => value.stdout.trim() === "browser parity commit",
  );
  await until(
    `!![...document.querySelectorAll('.workspace-dock [aria-label="Git 分类"] button')].find(n=>n.textContent==='历史' && !n.disabled)`,
  );
  await click('.workspace-dock [aria-label="Git 分类"] button', "历史");
  await until(
    `!![...document.querySelectorAll('.workspace-dock [aria-label="Git 分类"] button')].find(n=>n.textContent==='历史' && n.getAttribute('aria-selected')==='true')`,
  );
  await until(
    'document.querySelector(".workspace-dock").innerText.includes("browser parity commit")',
  );
  console.log(
    "PASS right Git: staged changes, native confirmation, commit and history",
  );
  await writeFile(
    "/tmp/percho-integrated-wide.png",
    Buffer.from(
      (await call("Page.captureScreenshot", { format: "png" })).data,
      "base64",
    ),
  );
  await closeRight();
  await openSettings("通用");
  await until(`!!document.querySelector('input[aria-label="默认模型 ID"]')`);
  assert(
    await evaluate(
      `!![...document.querySelectorAll("[role=dialog] nav p")].find(n=>n.textContent.trim()==="模型与资源")`,
    ),
    "settings navigation uses grouped sections",
  );
  await evaluate(
    `(()=>{const label=[...document.querySelectorAll('[role=dialog] label')].find(n=>n.textContent.includes('隐藏思考内容'));label.querySelector('button[role=switch]').click()})()`,
  );
  await click("[role=dialog] button", "保存修改");
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/settings?scope=global`),
    (doc) => doc.values.hideThinkingBlock === true,
  );
  await openSettings("网络与重试");
  await until(`!!document.querySelector('input[aria-label="HTTP 代理"]')`);
  await openSettings("资源与 Shell");
  await until(`!!document.querySelector('section[aria-label="原生 Pi 配置"]')`);
  await openSettings("人格与提示词");
  await until(
    `!!document.querySelector('textarea[aria-label="全局 AGENTS.md"]')`,
  );
  await fill('textarea[aria-label="全局 AGENTS.md"]', "BROWSER_PERSONALITY");
  await click("[role=dialog] button", "保存并应用");
  await untilValue(
    () => f.call("/api/personality"),
    (doc) => doc.content === "BROWSER_PERSONALITY",
  );
  assert.equal(
    await evaluate(
      `!![...document.querySelectorAll("[role=dialog] nav button")].find(n=>n.textContent.trim()==="会话配置")`,
    ),
    false,
    "sessions inherit global settings; no per-session settings category",
  );
  console.log(
    "PASS global personality save and no per-session settings category",
  );
  await writeFile(
    "/tmp/percho-integrated-settings.png",
    Buffer.from(
      (await call("Page.captureScreenshot", { format: "png" })).data,
      "base64",
    ),
  );
  await openSettings("模型");
  await until(
    '!![...document.querySelectorAll("[role=dialog] button")].find(n=>n.textContent.includes("添加自定义 Provider"))',
  );
  await click("[role=dialog] button", "+ 添加自定义 Provider");
  for (const [placeholder, value] of [
    ["ID，如 ai-ops", "browser-provider"],
    ["baseUrl，如 https://api.deepseek.com", "http://127.0.0.1:9/v1"],
    ["模型 ID", "browser-model"],
  ])
    await fill(`input[placeholder="${placeholder}"]`, value);
  await click("[role=dialog] button", "保存");
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/providers`),
    (value) =>
      value.rows.some(
        (row) =>
          row.id === "browser-provider" &&
          row.models?.some((model) => model.id === "browser-model"),
      ),
  );
  await openSettings("扩展");
  await click("[role=dialog] button", "已安装");
  await until('!!document.querySelector("input[aria-label=安装来源]")');
  await closeSettings();
  console.log(
    "PASS Percho settings: native revisions/save, network/Shell, personality and provider/package panels",
  );
  const observerStatus = (await f.call("/api/workspace")).agents.find(
    (row) => row.id === observer.id,
  )?.status;
  if (observerStatus !== "running") {
    await contextMenu(observer.id, "启动进程");
    await untilValue(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.find((row) => row.id === observer.id)?.status ===
        "running",
    );
  }
  await contextMenu(observer.id, "停止进程");
  await confirm("停止进程");
  await untilValue(
    () => f.call("/api/workspace"),
    (value) =>
      value.agents.find((row) => row.id === observer.id)?.status === "stopped",
  );
  await contextMenu(observer.id, "归档会话");
  await until(
    `!!document.querySelector('[role=dialog][aria-label="归档此会话？"]')`,
  );
  await click('[role=dialog][aria-label="归档此会话？"] button', "归档会话");
  await untilValue(
    () => f.call("/api/workspace"),
    (value) => value.agents.find((row) => row.id === observer.id)?.archived,
  );
  await viewOption("仅显示已归档");
  await until(`!!document.querySelector('[data-session-id="${observer.id}"]')`);
  await contextMenu(observer.id, "恢复归档");
  await untilValue(
    () => f.call("/api/workspace"),
    (value) =>
      value.agents.find((row) => row.id === observer.id)?.archived === false,
  );
  assert.equal(
    await evaluate(
      'document.querySelector("[data-session-page]").dataset.sessionId',
    ),
    actor.id,
  );
  await viewOption("隐藏已归档");
  await pressEscape();
  await until(`!!document.querySelector('[data-session-id="${observer.id}"]')`);
  assert.equal(
    await evaluate(
      `document.querySelector('[data-session-id="${observer.id}"]').innerText.includes("已归档")`,
    ),
    false,
    "restored session returns to the normal list without the archived tag",
  );
  await viewOption("单列表");
  assert.equal(
    await evaluate(
      'document.querySelectorAll("[data-sidebar-group-key]").length',
    ),
    0,
  );
  assert(await evaluate('!!document.querySelector("[data-session-id]")'));
  await viewOption("按名称");
  await viewOption("按工作区");
  await viewOption("最近更新");
  await pressEscape();
  await until('!!document.querySelector("[data-sidebar-group-key]")');
  console.log(
    "PASS session right-click process/archive controls and archived filter preserve the active conversation",
  );

  await openRight("侧聊");
  await until('!!document.querySelector("textarea[aria-label=侧聊问题]")');
  await fill("textarea[aria-label=侧聊问题]", "BROWSER_SIDE_QUESTION");
  await until(
    '!![...document.querySelectorAll(".workspace-dock button")].find(n=>n.textContent==="提问" && !n.disabled)',
  );
  await click(".workspace-dock button", "提问");
  await until(
    '[...document.querySelectorAll(".workspace-dock pre")].some(n=>n.textContent.includes("BROWSER_SIDE_QUESTION") && n.textContent.includes("answer:"))',
  );
  assert(
    !(
      await evaluate('document.querySelector("[data-session-page]").innerText')
    ).includes("BROWSER_SIDE_QUESTION"),
    "side chat stays outside primary timeline",
  );
  await click(".workspace-dock button", "带回主对话输入框");
  await until(
    'document.querySelector("[contenteditable=true]").innerText.includes("BROWSER_SIDE_QUESTION")',
  );
  console.log("PASS right sidebar BTW isolation and bring-back");
  await click(".workspace-dock button", "新侧聊");
  await fill("textarea[aria-label=侧聊问题]", "BROWSER_SIDE_CANCEL");
  await click(".workspace-dock button", "提问");
  await untilValue(() => sideStarted, Boolean);
  assert(
    await evaluate(
      '[...document.querySelectorAll(".workspace-dock button")].find(n=>n.textContent==="提问").disabled',
    ),
  );
  await click(".workspace-dock button", "取消侧聊");
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/btw`, { action: "list" }),
    (value) => value.rows.every((row) => !row.running),
  );
  sideGate.resolve();
  console.log(
    "PASS cancelling a pending BTW model request without enabling duplicate submission",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 480,
    height: 850,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert(
    await evaluate(
      'document.querySelector(".workspace-dock").getBoundingClientRect().width<=innerWidth',
    ),
    "narrow right panel fits viewport",
  );
  await closeRight();
  await openSettings("外观");
  await click("[role=dialog] button", "深色");
  await until('document.documentElement.dataset.theme==="dark"');
  await openSettings("通用");
  await until(`!!document.querySelector('input[aria-label="默认模型 ID"]')`);
  await writeFile(
    "/tmp/percho-integrated-narrow.png",
    Buffer.from(
      (await call("Page.captureScreenshot", { format: "png" })).data,
      "base64",
    ),
  );
  assert(
    await evaluate(
      'document.querySelector("[role=dialog][aria-modal] > div").getBoundingClientRect().width<=innerWidth',
    ),
    "settings fits viewport",
  );
  assert.equal(
    await evaluate(
      '!!document.querySelector(".desktop-workbench,.native-dialog,.desktop-toolbar")',
    ),
    false,
  );
  assert.deepEqual(driver.errors, []);
  assert.deepEqual(await evaluate("window.__uiErrors"), []);
  assert.deepEqual(await evaluate("window.__httpErrors"), []);
  console.log(
    "PASS integrated Percho layout, narrow/dark, no runtime exceptions or failed requests",
  );
} finally {
  childGate.resolve();
  sideGate.resolve();
  driver?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill("SIGTERM");
    await exited;
  }
  await f.close();
}
