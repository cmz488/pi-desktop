import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until as untilValue } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

const childGate = Promise.withResolvers();
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
    source: `window.__httpErrors=[];window.__requestPaths=[];window.__frameUrls=[];window.__uiErrors=[];window.addEventListener('error',e=>window.__uiErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__uiErrors.push(String(e.reason)));const original=window.fetch;window.fetch=async(...args)=>{window.__requestPaths.push(String(args[0]));const r=await original(...args);if(String(args[0]).includes('/_browser/frame') && r.status===200)window.__frameUrls.push(String(args[0]));if(!r.ok)window.__httpErrors.push({path:String(args[0]),status:r.status});return r;};`,
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
  await click(".sidebar button", "会话进程");
  await until(`!!document.querySelector('[data-native-agent="${actor.id}"]')`);
  await evaluate(
    `document.querySelector('[data-native-agent="${actor.id}"] button[aria-label="管理会话 BROWSER_ACTOR"]').click()`,
  );
  await click(`[data-native-agent="${actor.id}"] button`, "项目信任");
  await confirm("信任项目");
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/state`),
    (state) => state.projectTrusted,
  );
  await click(
    `[data-native-agent="${actor.id}"] button`,
    "BROWSER_ACTORrunning",
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
  await evaluate(
    'document.querySelector("[data-task-compose]").requestSubmit()',
  );
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/tasks`),
    (value) =>
      value.conversations?.some((row) => row.name === "BROWSER_CHILD_NAME"),
  );
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
  console.log("PASS right sidebar file tree and preview");
  const observer = await f.command("conversation.create", {
    projectId: project.id,
    name: "BROWSER_OBSERVER",
  });
  await untilValue(
    () => f.call("/api/workspace"),
    (value) =>
      value.agents.find((row) => row.id === observer.id)?.status === "running",
  );
  await f.call(`/agents/${observer.id}/api/prompt`, { message: "BROWSER_OBSERVER_HISTORY" });
  await untilValue(() => f.call(`/agents/${observer.id}/api/state`), state => state.idle && state.messages.some(row => row.role === "assistant"));
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
  await openSettings("会话配置");
  await until('!!document.querySelector("input[aria-label=名称]")');
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
    "PASS Percho settings: native revisions/save, network/Shell, personality, Agent and provider/package panels",
  );
  await click(".sidebar button", "会话进程");
  await evaluate(
    `document.querySelector('[data-native-agent="${observer.id}"] button[aria-label="管理会话 BROWSER_OBSERVER"]').click()`,
  );
  await click(`[data-native-agent="${observer.id}"] button`, "停止进程");
  await confirm("停止进程");
  await untilValue(
    () => f.call("/api/workspace"),
    (value) =>
      value.agents.find((row) => row.id === observer.id)?.status === "stopped",
  );
  await click(`[data-native-agent="${observer.id}"] button`, "归档");
  await click("[role=dialog][aria-label=归档会话] button", "归档");
  await untilValue(
    () => f.call("/api/workspace"),
    (value) => value.agents.find((row) => row.id === observer.id)?.archived,
  );
  await click(".sidebar button", "归档会话");
  await until(
    `!!document.querySelector('[data-native-agent="${observer.id}"]')`,
  );
  await evaluate(
    `document.querySelector('[data-native-agent="${observer.id}"] button[aria-label="管理会话 BROWSER_OBSERVER"]').click()`,
  );
  await click(`[data-native-agent="${observer.id}"] button`, "恢复归档");
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
  await click(".sidebar button", "归档会话");
  console.log(
    "PASS left process/archive/restore controls preserve the active conversation",
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
  driver?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = once(chrome, "exit");
    chrome.kill("SIGTERM");
    await exited;
  }
  await f.close();
}
