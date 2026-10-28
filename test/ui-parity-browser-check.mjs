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
    pi.registerCommand("btw", { description: "Local fixture for Desktop BTW", handler: async () => {} });
    pi.registerCommand("parity-card", { description: "Parity fixture", handler: async (_args, ctx) => {
      ctx.ui.setStatus("parity", "BROWSER_STATUS"); ctx.ui.setTitle("BROWSER_TITLE"); ctx.ui.setToolsExpanded(true);
      ctx.ui.setWidget("parity", ["BROWSER_WIDGET", "SECOND_WIDGET_LINE"]);
      pi.sendMessage({ customType: "parity", content: "", display: true, details: { piDesktop: {version: 1, title: "BROWSER_CARD", body: "Card body"} } });
    }});
  }`,
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
    source: `window.__httpErrors=[]; window.confirm=()=>true; const original=window.fetch; window.fetch=async(...args)=>{const r=await original(...args);if(!r.ok)window.__httpErrors.push({path:String(args[0]),status:r.status});return r;};`,
  });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: f.app.url });
  await until(
    '!!document.querySelector(".desktop-toolbar button") && !document.querySelector("#splash")',
  );
  const clickText = (selector, text) =>
    evaluate(
      `(() => { const node=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.textContent.trim()===${JSON.stringify(text)});if(!node)throw new Error("Missing button: "+${JSON.stringify(text)});node.click(); })()`,
    );
  const open = async (tab) => {
    if (!(await evaluate('!!document.querySelector(".native-dialog")')))
      await clickText(".desktop-toolbar button", "Pi 工作台");
    await until('!!document.querySelector(".native-dialog[open]")');
    await clickText(".native-dialog > .native-tabs button", tab);
  };
  const close = () =>
    evaluate(
      `document.querySelector('.native-header [aria-label="关闭 Pi 工作台"]').click()`,
    );
  const fill = (selector, value) =>
    evaluate(
      `(() => {const n=document.querySelector(${JSON.stringify(selector)});const setter=Object.getOwnPropertyDescriptor(n.tagName==="SELECT"?HTMLSelectElement.prototype:n.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,"value").set;setter.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event("input",{bubbles:true}));n.dispatchEvent(new Event("change",{bubbles:true}));})()`,
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
  await open("会话与进程");
  await until(
    '!![...document.querySelectorAll(".native-agent")].find(n=>n.textContent.includes("BROWSER_ACTOR"))',
  );
  await evaluate(
    '[...document.querySelectorAll(".native-agent")].find(n=>n.textContent.includes("BROWSER_ACTOR")).querySelectorAll("button");[...[...document.querySelectorAll(".native-agent")].find(n=>n.textContent.includes("BROWSER_ACTOR")).querySelectorAll("button")].find(n=>n.textContent==="项目信任").click()',
  );
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/state`),
    (state) => state.projectTrusted,
  );
  await evaluate(
    '[...[...document.querySelectorAll(".native-agent")].find(n=>n.textContent.includes("BROWSER_ACTOR")).querySelectorAll("button")].find(n=>n.textContent==="打开").click()',
  );
  await until(
    `document.querySelector('[data-session-page]')?.dataset.sessionId===${JSON.stringify(actor.id)}`,
  );
  await until('!document.querySelector(".native-dialog")');
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
  console.log("PASS external model change updates the current UI metadata");
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
    `!![...document.querySelectorAll('.desktop-card p')].find(n=>n.innerText.includes('BROWSER_WIDGET\\nSECOND_WIDGET_LINE'))`,
  );
  assert(
    (
      await evaluate('document.querySelector(".desktop-toolbar").innerText')
    ).includes("BROWSER_STATUS"),
  );
  console.log("PASS chat, editor, extension card/status/title");
  await open("扩展与任务");
  await until(
    'document.querySelector(".native-extensions").innerText.includes("BROWSER_CARD")',
  );
  await evaluate(
    '[...document.querySelectorAll(".extension-page-choice strong")].find(n=>n.textContent==="任务与子代理").closest("button").click()',
  );
  await until(
    'document.querySelector("[data-task-compose-toggle]")?.disabled===false',
  );
  await evaluate(
    'document.querySelector("[data-task-compose-toggle]").click()',
  );
  await until(
    '!!document.querySelector(".task-panel-compose-slot textarea[name=prompt]")',
  );
  await fill(".task-panel-compose-slot input[name=name]", "BROWSER_CHILD_NAME");
  await fill(".task-panel-compose-slot textarea[name=prompt]", "BROWSER_CHILD");
  await close();
  await open("扩展与任务");
  await until('!!document.querySelector(".extension-page-choice strong")');
  await evaluate(
    '[...document.querySelectorAll(".extension-page-choice strong")].find(n=>n.textContent==="任务与子代理").closest("button").click()',
  );
  await until(
    'document.querySelector("[data-task-compose-toggle]")?.disabled===false',
  );
  await evaluate(
    'document.querySelector("[data-task-compose-toggle]").click()',
  );
  await until(
    'document.querySelector(".task-panel-compose-slot textarea[name=prompt]")?.value==="BROWSER_CHILD"',
  );
  await evaluate(
    'document.querySelector(".task-panel-compose-slot form").requestSubmit()',
  );
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/tasks`),
    (value) =>
      value.conversations?.some((row) => row.name === "BROWSER_CHILD_NAME"),
  );
  await close();
  assert(
    (await f.call(`/agents/${actor.id}/api/tasks`)).tasks.some(
      (task) => task.kind === "desk.subagent-run" && task.status === "running",
    ),
    "closing workbench keeps the actual task alive",
  );
  childGate.resolve();
  await untilValue(
    () => f.call(`/agents/${actor.id}/api/state`),
    (state) => state.idle,
  );
  console.log("PASS task UI spawn and observation cleanup");
  await open("文件与浏览器");
  await until(
    'document.querySelector(".native-files").innerText.includes("parity.txt")',
  );
  await evaluate(
    '[...document.querySelectorAll(".native-files button")].find(n=>n.textContent.includes("parity.txt")).click()',
  );
  await until(
    'document.querySelector(".native-files").innerText.includes("BROWSER_FILE_CONTENT")',
  );
  console.log("PASS file tree and preview");
  await writeFile(join(f.cwd, "parity.txt"), "BROWSER_FILE_CONTENT\nchanged\n");
  await open("Git");
  await until(
    'document.querySelector("#git-files").innerText.includes("parity.txt")',
  );
  await evaluate(
    'document.querySelector("[data-git-action=stage-all]").click()',
  );
  await untilValue(
    () => git(["diff", "--cached", "--name-only"]),
    (value) => value.stdout.includes("parity.txt"),
  );
  await evaluate('document.querySelector("[data-right-view=commit]").click()');
  await fill("#git-message", "browser parity commit");
  await until(
    'document.querySelector("#git-commit-pane").hidden===false && document.querySelector("[data-git-action=commit]").disabled===false',
  );
  await evaluate('document.querySelector("[data-git-action=commit]").click()');
  await untilValue(
    () => git(["log", "-1", "--format=%s"]),
    (value) => value.stdout.trim() === "browser parity commit",
  );
  console.log("PASS Git stage/preview/confirmed commit");
  await open("Pi 设置与资源");
  await until(
    'document.querySelectorAll("#settings-groups input,#settings-groups select").length>0',
  );
  await clickText(".native-settings > .native-tabs button", "提供商");
  await until('!!document.querySelector("[data-action=add-provider]")');
  await evaluate(
    'document.querySelector("[data-action=add-provider]").click()',
  );
  await until('document.querySelector("#dialog").open');
  await evaluate(
    'document.querySelector("#dialog [data-action=custom-provider]").click()',
  );
  await until('!!document.querySelector("#dialog [name=id]")');
  for (const [name, value] of Object.entries({
    id: "browser-provider",
    baseUrl: "http://127.0.0.1:9/v1",
    modelId: "browser-model",
  }))
    await fill(`#dialog [name=${name}]`, value);
  await evaluate('document.querySelector("#dialog-form").requestSubmit()');
  await until('!document.querySelector("#dialog").open');
  assert(
    (await f.call(`/agents/${actor.id}/api/providers`)).rows.some(
      (row) =>
        row.id === "browser-provider" &&
        row.models.some((model) => model.id === "browser-model"),
    ),
  );
  console.log("PASS native settings descriptor and provider save");
  await open("侧聊");
  await until('!!document.querySelector(".native-body textarea")');
  await fill(".native-body textarea", "BROWSER_SIDE_QUESTION");
  await evaluate('document.querySelector(".native-body form").requestSubmit()');
  await until(
    'document.querySelector(".native-answer")?.innerText.includes("BROWSER_SIDE_QUESTION")',
  );
  assert(
    !(await f.call(`/agents/${actor.id}/api/state`)).messages.some((row) =>
      row.text?.includes("BROWSER_SIDE_QUESTION"),
    ),
  );
  await clickText(".native-body button", "带回主对话输入框");
  await until('!document.querySelector(".native-dialog")');
  await until(
    'document.querySelector("[contenteditable=true]").innerText.includes("BROWSER_SIDE_QUESTION")',
  );
  console.log("PASS BTW isolation and bring-back");
  assert.deepEqual(driver.errors, []);
  assert.deepEqual(await evaluate("window.__httpErrors"), []);
  const wide = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/tmp/pi-ui-parity-wide.png",
    Buffer.from(wide.data, "base64"),
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await open("Pi 设置与资源");
  await until(
    'document.querySelectorAll("#settings-groups input,#settings-groups select").length>0',
  );
  await evaluate('document.documentElement.dataset.theme="dark"');
  assert.notEqual(
    await evaluate(
      'getComputedStyle(document.querySelector(".native-dialog")).backgroundColor',
    ),
    "rgb(255, 255, 255)",
  );
  const bounds = await evaluate(
    '({w:innerWidth,dialog:document.querySelector(".native-dialog").getBoundingClientRect().width})',
  );
  assert(bounds.dialog <= bounds.w + 1);
  const narrow = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/tmp/pi-ui-parity-narrow.png",
    Buffer.from(narrow.data, "base64"),
  );
  console.log(
    "PASS narrow viewport; no runtime exceptions or failed HTTP requests",
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
