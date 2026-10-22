import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import {
  embeddedPiSdk as sdk,
  loadEmbeddedPiSdk,
} from "../src/agent/pi-sdk.mjs";
import { nativeSessionDirectory } from "../src/session/pi-session-storage.mjs";
import { desktopFixture, until } from "./desktop-fixture.mjs";
import { browserDriver, pause } from "./durable-browser-driver.mjs";

await loadEmbeddedPiSdk();
const f = await desktopFixture({ noExtensions: true });
const scriptGate = Promise.withResolvers();
const stateGate = Promise.withResolvers();
let browser, driver, proxy;
let scriptHeld = false,
  stateHeld = false,
  failScript = false;
try {
  const manager = sdk.SessionManager.create(
    f.other,
    await nativeSessionDirectory(f.other, f.agentDir),
  );
  manager.appendSessionInfo("首屏历史会话");
  manager.appendMessage({
    role: "user",
    content: "首屏历史消息",
    timestamp: Date.now(),
  });
  const catalog = await until(
    () => f.call("/api/workspace"),
    (value) => value.agents.some((row) => row.source === "pi"),
  );
  const history = catalog.agents.find((row) => row.source === "pi");
  const project = catalog.projects.find((row) => row.cwd === f.cwd);
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "首屏运行会话",
  });
  const prefix = `/agents/${history.id}`;
  const target = new URL(f.app.url);
  // 只延迟真实 HTTP，不替换页面、样式或启动代码；延迟模块和首份状态是两个独立阶段。
  proxy = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === `${prefix}/prototype.js`) {
      scriptHeld = true;
      await scriptGate.promise;
      if (failScript) {
        response.writeHead(503, { "Content-Type": "text/plain" });
        response.end("fixture script failure");
        return;
      }
    }
    if (path === `${prefix}/api/state`) {
      stateHeld = true;
      await stateGate.promise;
    }
    const headers = { ...request.headers, host: target.host };
    if (headers.origin) headers.origin = target.origin;
    const upstream = httpRequest(
      new URL(request.url, target),
      { method: request.method, headers },
      (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502);
      response.end(error.message);
    });
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const profile = join(f.root, "first-paint-browser");
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
  await call("Network.enable");
  await call("Network.setCacheDisabled", { cacheDisabled: true });
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `if (location.protocol === 'http:') localStorage.setItem('pi-web-theme','dark');`,
  });
  await call("Page.navigate", {
    url: `${origin}/?agent=${actor.id}`,
  });
  const frame = "document.querySelector('#runtime')";
  const doc = `${frame}?.contentDocument`;
  const sourceReady = `(()=>{const f=${frame},d=f?.contentDocument;return f?.dataset.owner===${JSON.stringify(actor.id)}&&d?.querySelector('#connection-status')?.textContent==='Pi 已连接';})()`;
  await ready(sourceReady, { timeoutMs: 15000 });
  await evaluate(`(()=>{
    const prompt=(${doc}).querySelector('#prompt');
    prompt.value='首屏切换草稿';
    prompt.dispatchEvent(new Event('input',{bubbles:true}));
  })()`);
  const select = (id) =>
    evaluate(
      `document.querySelector(${JSON.stringify(`.agent[data-agent-id="${id}"]:not([data-conversation-id])`)}).click()`,
    );
  await select(history.id);
  await ready(`(()=>{
    const f=${frame},d=f?.contentDocument;
    return f?.dataset.owner===${JSON.stringify(history.id)}&&d?.querySelector('.app')&&d.querySelector('link[href="chat-shell.css"]')?.sheet;
  })()`);
  assert(scriptHeld, "必须真正阻塞目标会话的聊天模块，不能只观察缓存中的旧帧");
  const loadingPaint = () =>
    evaluate(`(()=>{
      const f=${frame},d=f.contentDocument,s=(node,pseudo)=>d.defaultView.getComputedStyle(node,pseudo);
      return {
        owner:f.dataset.owner,
        opacity:getComputedStyle(f).opacity,
        theme:d.documentElement.dataset.theme,
        scheme:s(d.body).colorScheme,
        canvas:s(d.body).getPropertyValue('--canvas').trim(),
        background:s(d.body).backgroundColor,
        before:s(d.body,'::before').content,
        after:s(d.body,'::after').content,
        app:s(d.querySelector('.app')).visibility,
        title:s(d.querySelector('#session-title')).visibility,
        status:d.querySelector('.chat-boot-status')?s(d.querySelector('.chat-boot-status')).display:null,
      };
    })()`);
  const early = await loadingPaint();
  // 旧实现会在 4 秒后暴露演示内容；必须在健康但缓慢的模块加载期间跨过这个边界。
  const PREVIOUS_BOOT_REVEAL_MS = 4000;
  await pause(PREVIOUS_BOOT_REVEAL_MS + 250);
  const late = await loadingPaint();
  const expectedLoading = {
    owner: history.id,
    opacity: "1",
    theme: "dark",
    scheme: "dark",
    canvas: "#131d20",
    background: "rgba(0, 0, 0, 0)",
    before: "none",
    after: "none",
    app: "hidden",
    title: "hidden",
    status: "grid",
  };
  assert.deepEqual(
    early,
    expectedLoading,
    "冷启动首帧必须沿用深色并隐藏演示布局",
  );
  assert.deepEqual(
    late,
    expectedLoading,
    "模块慢于 4 秒也不能重新显示演示布局",
  );
  scriptGate.resolve();
  await until(() => stateHeld, Boolean);
  await ready(`!!(${doc})?.querySelector('.conversation-loading')`);
  assert(
    await evaluate(`(()=>{
      const d=${doc};
      return d.defaultView.getComputedStyle(d.querySelector('.conversation-loading')).visibility==='visible'
        &&!d.querySelector('#session-title').textContent.includes('搭建 pi 工作空间')
        &&!d.querySelector('#runtime-label').textContent.includes('演示');
    })()`),
    "模块已就绪但首份快照未到时，骨架可见且导航不能冒充示例会话",
  );
  stateGate.resolve();
  await ready(
    `(${doc})?.querySelector('#messages')?.textContent.includes('首屏历史消息')`,
  );
  assert.equal(
    await evaluate(`(${doc}).querySelector('#session-title').textContent`),
    "首屏历史会话",
  );
  await select(actor.id);
  await ready(sourceReady);
  assert.equal(
    await evaluate(`(${doc}).querySelector('#prompt').value`),
    "首屏切换草稿",
  );
  // 真正的脚本失败必须提供可恢复的失败面，而不是把演示页当成兜底。
  failScript = true;
  await select(history.id);
  await ready(`(()=>{
    const f=${frame},d=f?.contentDocument;
    return f?.dataset.owner===${JSON.stringify(history.id)}&&d?.documentElement.hasAttribute('data-boot-error');
  })()`);
  assert.deepEqual(await loadingPaint(), expectedLoading);
  assert(
    await evaluate(`(()=>{
      const d=${doc},error=d.querySelector('.chat-boot-error'),retry=d.querySelector('.chat-boot-status a');
      const current=new URL(d.URL),next=retry&&new URL(retry.href);
      return error?.textContent.includes('加载失败')&&d.defaultView.getComputedStyle(error).display!=='none'
        &&next?.origin===current.origin&&next.pathname===current.pathname&&next.search===current.search;
    })()`),
    "启动失败时应明确说明失败，并提供同一会话的重新加载入口",
  );
  console.log(
    "首屏回归通过：真实 Host 运行会话切到历史会话、深色与透明背景、超过 4 秒的模块加载、首份快照等待、草稿保持及脚本失败恢复入口。",
  );
} finally {
  scriptGate.resolve();
  stateGate.resolve();
  driver?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    const exited = once(browser, "exit");
    browser.kill();
    await exited;
  }
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  await f.close();
}
