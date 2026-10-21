import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";
import { measureSurfaceContrast } from "./surface-contrast.mjs";

const stream = Promise.withResolvers();
const f = await desktopFixture({
  modelReply: async (input) => {
    if (
      !String(input.messages.at(-1)?.content).includes(
        "SKILL_AUTOMATIC_SENTINEL",
      )
    )
      return;
    return {
      stream: (async function* () {
        yield "INPUT_STREAM_START";
        await stream.promise;
        yield "INPUT_STREAM_END";
      })(),
    };
  },
});
let browser, driver;
try {
  const skill =
    "---\nname: input-browser\ndescription: Browser input fixture\n---\nSKILL_AUTOMATIC_SENTINEL\n";
  const folder = join(f.agentDir, "skills", "input-browser");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "SKILL.md"), skill);
  const extension = join(f.root, "input-extension.mjs");
  await writeFile(
    extension,
    `export default function(pi){pi.registerCommand("origin-auto",{handler:async args=>{await pi.sendUserMessage("EXTENSION_AUTOMATIC_SENTINEL:"+args,{deliverAs:"followUp"});}});}`,
  );
  const settingsPath = join(f.agentDir, "settings.json");
  await writeFile(
    settingsPath,
    JSON.stringify({
      ...JSON.parse(await readFile(settingsPath, "utf8")),
      extensions: [extension],
    }),
  );
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "原始输入",
  });
  const prefix = `/agents/${actor.id}`;
  const owner = (await f.call(`${prefix}/api/state`)).sessionId;
  const raw =
    "  /skill:input-browser   USER_KEEP <skill>手写标签</skill>\n第二行  ";
  const profile = join(f.root, "input-browser");
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
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `if(window.parent!==window){window.inputOriginalObservations=[];addEventListener('DOMContentLoaded',()=>new MutationObserver(()=>{for(const node of document.querySelectorAll('.user-message [data-input-original]')){if(window.inputOriginalObservations.length<500)window.inputOriginalObservations.push(node.textContent);}}).observe(document.body,{subtree:true,childList:true,characterData:true}));}`,
  });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const url = new URL(f.app.url);
  url.searchParams.set("agent", actor.id);
  await call("Page.navigate", { url: url.href });
  const frame = "document.querySelector('#runtime')?.contentDocument";
  const chat = (source) => evaluate(`(()=>{const d=${frame};${source}})()`);
  const connected = () =>
    ready(
      `(${frame})?.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
    );
  const send = async (text) =>
    chat(
      `d.querySelector('#prompt').value=${JSON.stringify(text)};d.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));d.querySelector('#send-button').click();`,
    );
  await connected();
  await send(raw);
  await ready(
    `(${frame}).querySelector('#messages').textContent.includes('INPUT_STREAM_START')`,
  );
  assert.equal(
    await chat(
      "return d.querySelector('.user-message [data-input-original]')?.textContent;",
    ),
    raw,
    "流式过程中正文仍是完整原始输入",
  );
  assert.equal(
    await chat("return d.querySelector('[data-input-injection]')?.open;"),
    false,
    "自动展开默认折叠",
  );
  assert.equal(
    await chat(
      "return d.defaultView.inputOriginalObservations.every(text=>!text.includes('SKILL_AUTOMATIC_SENTINEL'));",
    ),
    true,
    "发送与流式刷新不得短暂把展开内容塞回用户正文",
  );
  stream.resolve();
  await until(
    () => f.call(`${prefix}/api/state?sessionId=${owner}`),
    (value) => value.idle,
  );
  await chat("d.querySelector('[data-input-injection] > summary').click();");
  assert.equal(
    await chat(
      "return d.querySelector('[data-input-injection]').textContent.includes('SKILL_AUTOMATIC_SENTINEL');",
    ),
    true,
  );
  const command = "/origin-auto   NEXT_ARGUMENT";
  await send(command);
  await ready(
    `(${frame}).querySelector('.automatic-input [data-input-injection]')`,
  );
  assert.equal(
    await chat(
      "return d.querySelector('.automatic-input [data-input-original]')===null;",
    ),
    true,
    "自动输入不能伪造用户原文",
  );
  assert.equal(
    await chat(
      "return d.querySelector('.automatic-input [data-input-injection]').open;",
    ),
    false,
  );
  assert.equal(
    await chat(
      `return [...d.querySelectorAll('.user-message [data-input-original]')].some(node=>node.textContent===${JSON.stringify(command)});`,
    ),
    true,
    "自行处理的扩展命令保留原文",
  );
  await until(
    () => f.call(`${prefix}/api/state?sessionId=${owner}`),
    (value) => value.idle,
  );
  const literal = "<skill>我亲自输入的标签</skill>\n**literal Markdown**";
  await send(literal);
  await ready(
    `(()=>{const d=${frame};return [...d.querySelectorAll('.user-message [data-input-original]')].some(node=>node.textContent===${JSON.stringify(literal)});})()`,
  );
  assert.equal(
    await chat(
      `return [...d.querySelectorAll('.user-message')].find(node=>node.querySelector('[data-input-original]')?.textContent===${JSON.stringify(literal)}).querySelector('[data-input-injection]')===null;`,
    ),
    true,
    "手写标签不能按正则折叠",
  );
  await until(
    () => f.call(`${prefix}/api/state?sessionId=${owner}`),
    (value) => value.idle,
  );
  await call("Page.reload", { ignoreCache: true });
  await connected();
  assert.equal(
    await chat(
      `return [...d.querySelectorAll('[data-input-original]')].some(node=>node.textContent===${JSON.stringify(raw)});`,
    ),
    true,
    "刷新历史仍保留完整命令",
  );
  await chat("d.querySelector('#prompt').focus();");
  for (let index = 0; index < 2; index++) {
    await call("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "ArrowUp",
      code: "ArrowUp",
      windowsVirtualKeyCode: 38,
    });
    await call("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "ArrowUp",
      code: "ArrowUp",
      windowsVirtualKeyCode: 38,
    });
  }
  assert.equal(
    await chat("return d.querySelector('#prompt').value;"),
    command,
    "输入历史不把扩展自动内容当作用户输入",
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowUp",
    code: "ArrowUp",
    windowsVirtualKeyCode: 38,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowUp",
    code: "ArrowUp",
    windowsVirtualKeyCode: 38,
  });
  assert.equal(
    await chat("return d.querySelector('#prompt').value;"),
    raw,
    "输入历史恢复完整原始命令，而不是展开后的模型文本",
  );
  await chat(
    "d.querySelector('#prompt').value='';d.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}));",
  );
  const created = await f.command("conversation.fork", {
    id: actor.id,
    generation: 0,
    conversationId: Number(owner),
  });
  const target = `#projects button[data-agent-id="${created.agentId}"]:not([data-conversation-id])`;
  await ready(`!!document.querySelector(${JSON.stringify(target)})`);
  await evaluate(`document.querySelector(${JSON.stringify(target)}).click()`);
  await connected();
  await ready(
    `document.querySelector('#runtime').dataset.owner===${JSON.stringify(created.agentId)}&&(${frame})?.querySelector('[data-input-original]')`,
  );
  assert.equal(
    await chat(
      `return [...d.querySelectorAll('[data-input-original]')].some(node=>node.textContent===${JSON.stringify(raw)});`,
    ),
    true,
    "新会话继承后正文一致",
  );
  assert.equal(
    await chat(
      "return d.querySelector('.automatic-input [data-input-injection]')?.open;",
    ),
    false,
  );
  assert.equal(
    await chat(
      "return d.querySelector('.user-message [data-input-injection]')?.open;",
    ),
    false,
    "不能把来源会话的展开状态串到新会话",
  );
  const tree = await call("Page.getFrameTree");
  const world = await call("Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: "input-presentation-contrast",
  });
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `localStorage.setItem('pi-web-theme',${JSON.stringify(theme)});window.dispatchEvent(new StorageEvent('storage',{key:'pi-web-theme',newValue:${JSON.stringify(theme)}}));`,
    );
    await ready(
      `(${frame}).body.classList.contains('dark')===${theme === "dark"}`,
    );
    await chat(
      "return Promise.all(d.getAnimations().filter(item=>item.effect?.getTiming().iterations!==Infinity).map(item=>item.finished.catch(()=>{}))); ",
    );
    await chat("d.querySelector('#messages').scrollTop=0;");
    const result = await call("Runtime.evaluate", {
      contextId: world.executionContextId,
      returnByValue: true,
      expression: `(${measureSurfaceContrast.toString()})(['.input-original','.input-injection > summary'],${frame})`,
    });
    assert.equal(result.exceptionDetails, undefined);
    assert.equal(result.result.value.length, 2);
    assert.ok(
      result.result.value.every((row) => row.ratio >= 4.5),
      `${theme} 原文与折叠文字对比度`,
    );
    if (process.env.PI_INPUT_UI_SCREENSHOTS) {
      await mkdir(process.env.PI_INPUT_UI_SCREENSHOTS, { recursive: true });
      const image = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(process.env.PI_INPUT_UI_SCREENSHOTS, `input-${theme}.png`),
        Buffer.from(image.data, "base64"),
      );
    }
  }
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(
    await chat(
      "return d.documentElement.scrollWidth<=d.defaultView.innerWidth;",
    ),
    true,
  );
  assert.equal(
    await chat(
      "return [...d.querySelectorAll('.input-injection > summary')].every(node=>node.getBoundingClientRect().height>=44);",
    ),
    true,
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    "Input presentation browser passed: real composer and stream, literal tags, registered command/automatic split, reload, independent inheritance, two themes and narrow touch layout.",
  );
} finally {
  stream.resolve();
  driver?.close();
  if (browser && browser.exitCode === null) {
    const stopped = once(browser, "close");
    browser.kill("SIGTERM");
    await stopped;
  }
  await f.close();
}
