import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import { measureSurfaceContrast } from "./surface-contrast.mjs";
import { startWeb } from "../src/server/web.mjs";
import { concurrentFixture, until } from "./concurrent-fixture.mjs";
import {
  catalogFixtureHtml,
  createNativeNpmFixture,
  packageFixtureName,
} from "./package-fixture.mjs";
const root = await mkdtemp(join(tmpdir(), "pi-web-browser-"));
let app, browser, ws;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const cwd = join(root, "project"),
    agentDir = join(root, "agent");
  await mkdir(cwd);
  execFileSync(
    "git",
    [
      "init",
      "-q",
      "-b",
      "feature/pi-web-mobile-layout-with-a-long-branch-name",
    ],
    { cwd },
  );
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: "https://example.invalid/v1",
          api: "openai-completions",
          apiKey: "fixture-only-key",
          models: [
            { id: "fixture-model", name: "GPT-6.1 Sol", reasoning: true },
          ],
        },
      },
    }),
  );
  const npmFixture = await createNativeNpmFixture(agentDir);
  const catalogRequests = [];
  // Optional first-party HTML capture: parse it inertly in the isolated host;
  // never execute upstream scripts or install the described packages.
  const catalogCapture = process.env.PI_DESK_CATALOG_CAPTURE
    ? JSON.parse(await readFile(process.env.PI_DESK_CATALOG_CAPTURE, "utf8"))
    : null;
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      ...npmFixture.settings,
      defaultProvider: "fixture",
      defaultModel: "fixture-model",
    }),
  );
  await mkdir(join(agentDir, "skills", "web-fixture"), { recursive: true });
  await writeFile(
    join(agentDir, "skills", "web-fixture", "SKILL.md"),
    "---\nname: web-fixture\ndescription: Read fixture workspace safely\n---\nRead README.md.\n",
  );
  await mkdir(join(agentDir, "prompts"));
  await writeFile(
    join(agentDir, "prompts", "review.md"),
    "---\ndescription: Review a fixture file\n---\nReview $ARGUMENTS.\n",
  );
  await mkdir(join(agentDir, "extensions", "test-plugin"), { recursive: true });
  await writeFile(
    join(agentDir, "extensions", "test-plugin", "index.ts"),
    'export default function(pi) { pi.registerCommand("web-check", {description:"Fixture command",handler:async(_args,ctx)=>{ctx.ui.notify("Native extension command executed","info");}}); }',
  );
  await writeFile(
    join(agentDir, "extensions", "test-plugin", "config.json"),
    JSON.stringify({ enabled: true, secret: "private-fixture-token" }),
  );
  await writeFile(
    join(agentDir, "extensions", "test-plugin", "pi-web.config.json"),
    JSON.stringify({
      file: "config.json",
      fields: [
        { key: "enabled", label: "测试开关", type: "boolean", default: true },
        { key: "secret", label: "测试凭据", type: "string", secret: true },
      ],
    }),
  );
  const mcpFixture = join(cwd, "browser-mcp.mjs");
  await writeFile(
    mcpFixture,
    `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'browser-fixture',version:'1'}}:r.method==='tools/list'?{tools:[{name:'echo',description:'Browser fixture MCP tool',inputSchema:{type:'object',properties:{}}}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`,
  );
  app = await startWeb({
    cwd,
    agentDir,
    port: 0,
    lanAddresses: () => ["192.168.55.23", "10.8.0.2"],
    catalogFetch: async (url, options) => {
      catalogRequests.push({
        url: String(url),
        refresh: options.headers["Cache-Control"],
      });
      const captured =
        catalogCapture &&
        [catalogCapture.list, catalogCapture.detail].find(
          (page) => page.sourceUrl === String(url),
        );
      return new Response(captured?.html ?? catalogFixtureHtml(url), {
        headers: { "content-type": "text/html" },
      });
    },
  });
  app.runtime.session.setSessionName("Pi Web 集成检查");
  app.runtime.session.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "检查工作空间的配置。" }],
    timestamp: Date.now(),
  });
  app.runtime.session.sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "先核对当前工作空间与模型配置。" },
      { type: "text", text: "我会先阅读配置，再确认模型与扩展的状态。" },
      {
        type: "toolCall",
        id: "fixture-read",
        name: "read",
        arguments: { path: "package.json" },
      },
    ],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  app.runtime.session.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "fixture-read",
    toolName: "read",
    content: [
      {
        type: "text",
        text: 'package.json\n{ "pi": { "extensions": ["./index.ts"] } }',
      },
    ],
    isError: false,
    timestamp: Date.now(),
  });
  app.runtime.session.sessionManager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "text",
        text: "## 验证结果\n\n**配置正常**，公式 $E=mc^2$。\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n\n| 项目 | 状态 |\n| --- | --- |\n| 模型 | 已配置 |\n\n```js\nconst html = '<script>unsafe()</script>';\n```\n\n[危险链接](javascript:alert(1))\n<script>window.markdownAttack=true</script>",
      },
    ],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  browser = spawn(
    "/usr/bin/chromium",
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=9551",
      `--user-data-dir=${join(root, "browser")}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let pages;
  for (let i = 0; i < 100; i++) {
    try {
      pages = await (await fetch("http://127.0.0.1:9551/json/list")).json();
      break;
    } catch {
      await pause(50);
    }
  }
  assert(pages);
  ws = new WebSocket(
    pages.find((page) => page.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve) =>
    ws.addEventListener("open", resolve, { once: true }),
  );
  let serial = 0;
  const awaiting = new Map(),
    errors = [],
    conditionalResponses = [];
  ws.addEventListener("message", (event) => {
    const record = JSON.parse(event.data);
    if (record.id) {
      const handler = awaiting.get(record.id);
      awaiting.delete(record.id);
      record.error
        ? handler.reject(new Error(record.error.message))
        : handler.resolve(record.result);
    }
    if (
      record.method === "Network.responseReceivedExtraInfo" &&
      record.params.statusCode === 304
    )
      conditionalResponses.push(record.params.requestId);
    if (record.method === "Runtime.exceptionThrown")
      errors.push(
        record.params.exceptionDetails.exception?.description ??
          record.params.exceptionDetails.text,
      );
  });
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      awaiting.set(++serial, { resolve, reject });
      ws.send(
        JSON.stringify({
          id: serial,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  const evaluate = async (expression, sessionId) => {
    const result = await call(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  };
  const wait = async (predicate, sessionId) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(predicate, sessionId)) return;
      await pause(50);
    }
    console.error(
      await evaluate(
        `({status:document.querySelector('#connection-status')?.textContent,toast:document.querySelector('#toast')?.textContent,gitStatus:document.querySelector('#git-status')?.textContent,gitNotice:document.querySelector('#git-notice')?.textContent,gitButtons:[...document.querySelectorAll('[data-git-action="diff"]')].slice(0,3).map(button=>({disabled:button.disabled,expanded:button.getAttribute('aria-expanded')})),diff:document.querySelector('.git-file-diff')?.textContent})`,
      ),
      errors,
    );
    throw new Error("Browser condition timed out: " + predicate);
  };
  const shot = async (name) => {
    await pause(250);
    await evaluate(
      `document.querySelector('#toast').classList.remove('visible')`,
    );
    return writeFile(
      new URL(`../screenshots/${name}.png`, import.meta.url),
      Buffer.from((await call("Page.captureScreenshot")).data, "base64"),
    );
  };
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Network.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: app.url });
  await wait(
    `document.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
  );
  assert(
    await evaluate(`(() => {
    const composer=getComputedStyle(document.querySelector('#composer'));
    return !document.body.classList.contains('dark')
      && getComputedStyle(document.documentElement).colorScheme==='light'
      && getComputedStyle(document.body,'::before').backgroundImage.includes('radial-gradient')
      && parseFloat(composer.borderRadius)>=24 && composer.backdropFilter.includes('blur')
      && composer.backgroundColor.startsWith('rgba(') && composer.boxShadow!=='none';
  })()`),
    "A fresh workspace must open in day glass, with a floating translucent composer",
  );
  const assetTiming = await evaluate(`(() => {
    const asset = performance.getEntriesByType('resource').find(entry => entry.name.endsWith('/vendor/katex.mjs'));
    return {encoded:asset.encodedBodySize,decoded:asset.decodedBodySize};
  })()`);
  assert(
    assetTiming.encoded > 0 && assetTiming.encoded < assetTiming.decoded / 4,
    "The browser must receive compressed modules and render their decoded contents",
  );
  const conditionalBefore = conditionalResponses.length;
  assert.equal(
    await evaluate(
      `fetch('/vendor/katex.mjs', {cache:'no-cache'}).then(response=>response.text()).then(text=>new TextEncoder().encode(text).byteLength)`,
    ),
    assetTiming.decoded,
  );
  assert(
    conditionalResponses.length > conditionalBefore,
    "Browser revalidation must receive 304 instead of downloading the module again",
  );
  await call("Page.reload");
  await wait(
    `performance.getEntriesByType('navigation')[0]?.type==='reload' && document.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
  );
  console.log(
    `Browser asset transfer: KaTeX ${assetTiming.decoded} -> ${assetTiming.encoded} bytes; conditional reload verified.`,
  );
  await evaluate(
    `window.snapshotFetches=0;window.streamCloses=0;const fetchOriginal=window.fetch;window.fetch=(...args)=>{if(String(args[0]).includes('/api/state'))window.snapshotFetches++;return fetchOriginal(...args)};const closeOriginal=EventSource.prototype.close;EventSource.prototype.close=function(){window.streamCloses++;return closeOriginal.call(this)}`,
  );
  app.bridge.publish("state_changed", {});
  await wait(`window.snapshotFetches>0`);
  await pause(150);
  assert.equal(
    await evaluate(`window.streamCloses`),
    0,
    "Routine session updates must keep the current SSE connection open",
  );
  await evaluate(
    `window.webErrors=[];new MutationObserver(()=>{const message=document.querySelector('#toast').textContent;if(/Cannot read|TypeError|ReferenceError/.test(message)) window.webErrors.push(message)}).observe(document.querySelector('#toast'),{childList:true,subtree:true});`,
  );
  assert(
    await evaluate(
      `!!document.querySelector('#workspace-right #git-tool-card')&&!document.querySelector('.top-actions [data-action="git-review"]')`,
    ),
    "Git must be a persistent right-sidebar card, not a topbar modal button",
  );
  assert(
    await evaluate(
      `!!document.querySelector('[data-action="hide-right-sidebar"]')&&document.querySelector('[data-action="workspace-tools"]').checkVisibility()`,
    ),
    "The whole right sidebar needs a hide button and a visible desktop restore control",
  );
  const rightPaneWidth = await evaluate(
    `document.querySelector('#workspace-right').getBoundingClientRect().width`,
  );
  const chatBeforeHide = await evaluate(
    `document.querySelector('.conversation').getBoundingClientRect().width`,
  );
  await evaluate(
    `document.querySelector('[data-action="hide-right-sidebar"]').click()`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('#workspace-right').checkVisibility()`,
    ),
    false,
  );
  assert(
    (await evaluate(
      `document.querySelector('.conversation').getBoundingClientRect().width`,
    )) >
      chatBeforeHide + rightPaneWidth - 5,
    "Hiding the entire sidebar must reclaim its layout width",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-action="workspace-tools"]').getAttribute('aria-expanded')`,
    ),
    "false",
  );
  await evaluate(
    `document.querySelector('[data-action="workspace-tools"]').focus()`,
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  assert(
    await evaluate(
      `document.querySelector('#workspace-right').checkVisibility()`,
    ),
    "The restore control must work through native keyboard activation",
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-action="workspace-tools"]').getAttribute('aria-expanded')`,
    ),
    "true",
  );
  await evaluate(
    `document.querySelector('[data-right-view="tools"]').click();document.querySelector('#preview-content').textContent='Retained output';document.querySelector('[data-action="hide-right-sidebar"]').focus();document.querySelector('[data-action="hide-right-sidebar"]').click()`,
  );
  assert(
    await evaluate(
      `document.activeElement===document.querySelector('[data-action="workspace-tools"]')`,
    ),
  );
  await evaluate(
    `document.querySelector('[data-action="workspace-tools"]').click()`,
  );
  assert.equal(
    await evaluate(`document.querySelector('#workspace-right').dataset.view`),
    "tools",
  );
  assert.equal(
    await evaluate(`document.querySelector('#preview-content').textContent`),
    "Retained output",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await evaluate(
    `document.querySelector('[data-action="hide-right-sidebar"]').click()`,
  );
  assert(
    await evaluate(
      `document.querySelector('#workspace-right').inert && document.querySelector('[data-action="workspace-tools"]').getAttribute('aria-expanded')==='false'`,
    ),
  );
  await evaluate(
    `document.querySelector('[data-action="workspace-tools"]').click()`,
  );
  assert(
    await evaluate(
      `document.body.classList.contains('right-open') && !document.querySelector('#workspace-right').inert`,
    ),
  );
  await evaluate(
    `document.querySelector('[data-action="close-right-view"]').click()`,
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await wait(
    `document.querySelector('[data-action="workspace-tools"]').getAttribute('aria-expanded')==='true'`,
  );
  await evaluate(
    `document.querySelector('[data-action="hide-right-sidebar"]').click()`,
  );
  await call("Page.reload");
  await wait(
    `document.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
  );
  assert(
    await evaluate(
      `document.querySelector('#workspace-right').inert && !document.querySelector('#workspace-right').checkVisibility()`,
    ),
    "The frontend must remember an explicit whole-sidebar hide across reload",
  );
  assert(
    await evaluate(
      `(() => {const messages=document.querySelector('#messages');const style=getComputedStyle(messages);const content=messages.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);const bubble=document.querySelector('.assistant-turn > .message-body > .markdown-body');return content>=1000 && (!bubble || getComputedStyle(bubble).maxWidth.includes('860'));})()`,
    ),
    "Conversation content must use the available desktop width",
  );
  assert(
    await evaluate(
      `(() => {const primary=document.querySelector('.metrics-primary').getBoundingClientRect(),secondary=document.querySelector('.metrics-secondary').getBoundingClientRect();return Math.abs(primary.top-secondary.top)<10;})()`,
    ),
    "With the full-width conversation the session readings must share one row",
  );
  await evaluate(
    `document.querySelector('[data-action="workspace-tools"]').click();document.body.classList.add("dark");window.snapshotFetches=0;const afterSidebarReload=window.fetch;window.fetch=(...args)=>{if(String(args[0]).includes('/api/state'))window.snapshotFetches++;return afterSidebarReload(...args)};window.webErrors=[];new MutationObserver(()=>{const message=document.querySelector('#toast').textContent;if(/Cannot read|TypeError|ReferenceError/.test(message))window.webErrors.push(message)}).observe(document.querySelector('#toast'),{childList:true,subtree:true})`,
  );
  assert.equal(
    await evaluate(
      `getComputedStyle(document.body).getPropertyValue("--bg").trim()`,
    ),
    "#131d20",
    "Dark mode must use the Herta-derived charcoal/mint glass palette, not pi.dev",
  );
  assert(
    await evaluate(
      `!!document.querySelector(".sidebar-resize")&&!!document.querySelector("#workspace-right .preview-resize")`,
    ),
    "Both sidebar edges need real resize controls",
  );
  for (const [handleSelector, paneSelector, delta] of [
    [".sidebar-resize", ".sidebar", 60],
    [".preview-resize", "#workspace-right", -60],
  ]) {
    const initial = await evaluate(
      `document.querySelector("${paneSelector}").getBoundingClientRect().width`,
    );
    const point = await evaluate(
      `(()=>{const box=document.querySelector("${handleSelector}").getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+80}})()`,
    );
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x + delta,
      y: point.y,
      button: "left",
      buttons: 1,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x + delta,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    const width = await evaluate(
      `document.querySelector("${paneSelector}").getBoundingClientRect().width`,
    );
    assert(
      width > initial + 40,
      `${handleSelector} must resize its actual pane with real pointer capture`,
    );
    await evaluate(
      `document.querySelector("${handleSelector}").dispatchEvent(new KeyboardEvent("keydown",{key:"${delta > 0 ? "ArrowLeft" : "ArrowRight"}",bubbles:true}))`,
    );
    assert(
      (await evaluate(
        `document.querySelector("${paneSelector}").getBoundingClientRect().width`,
      )) < width,
      "Keyboard resizing must use the same pane and limits",
    );
  }
  await evaluate(
    `window.gitRequests=0;window.analysisRequests=0;window.legacyGit=true;window.gitFetch=window.fetch;window.fetch=async(...args)=>{const path=new URL(String(args[0]),location.href).pathname;if(path==='/api/git')window.gitRequests++;if(path==='/api/git-analysis')window.analysisRequests++;const response=await window.gitFetch(...args);if(path==='/api/state'&&(window.legacyGit||window.blockGitWrites)){const snapshot=await response.json();if(window.legacyGit)delete snapshot.gitManagement;if(window.blockGitWrites)snapshot.gitWritable=false;return new Response(JSON.stringify(snapshot),{headers:{'content-type':'application/json'}})}return response}`,
  );
  const snapshotsBeforeLegacy = await evaluate(`window.snapshotFetches`);
  app.bridge.publish("state_changed", {});
  await wait(`window.snapshotFetches>${snapshotsBeforeLegacy}`);
  await pause(150);
  await evaluate(
    `document.querySelector('[data-action="git-review"]').click()`,
  );
  assert(
    await evaluate(`!document.querySelector('#git-review-pane').hidden`),
    "A legacy host must open the Git panel rather than only showing the upgrade toast",
  );
  assert(
    await evaluate(
      `document.querySelector('#git-notice').textContent.includes('任务')&&document.querySelector('#git-branch').closest('#workspace-right')!==null`,
    ),
    "Legacy Git metadata and upgrade guidance belong inside the Git panel",
  );
  assert.equal(
    await evaluate(`window.gitRequests`),
    0,
    "An unsupported host must not receive Git API calls",
  );
  await evaluate(
    `document.querySelector('[data-action="close-right-view"]').click();window.legacyGit=false`,
  );
  const snapshotsBeforeUpgrade = await evaluate(`window.snapshotFetches`);
  app.bridge.publish("state_changed", {});
  await wait(`window.snapshotFetches>${snapshotsBeforeUpgrade}`);
  await pause(150);
  if (!app.manager.active.options.projectTrusted()) {
    const response = await fetch(app.url + "api/project-trust", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trusted: true, sessionId: app.manager.focusId }),
    });
    assert.equal(response.status, 200);
  }
  await writeFile(
    join(cwd, "review-error.ts"),
    'const value: number = "wrong";\n',
  );
  await writeFile(join(cwd, "review-error.json"), '{"value":}');
  await writeFile(
    join(cwd, "unrelated-large.bin"),
    Buffer.alloc(17 * 1024 * 1024),
  );
  execFileSync("git", ["config", "user.name", "Browser Fixture"], { cwd });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd,
  });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd });
  execFileSync("git", ["add", "--", "browser-mcp.mjs"], { cwd });
  execFileSync("git", ["commit", "-qm", "Browser history fixture"], { cwd });
  const graphBase = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
  const graphBranch = execFileSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["checkout", "-qb", "graph-topic"], { cwd });
  execFileSync(
    "git",
    ["commit", "--allow-empty", "-qm", "Graph topic fixture"],
    { cwd },
  );
  execFileSync("git", ["checkout", "-q", graphBranch], { cwd });
  execFileSync(
    "git",
    ["commit", "--allow-empty", "-qm", "Graph main fixture"],
    { cwd },
  );
  execFileSync("git", ["merge", "--no-ff", "--no-edit", "graph-topic"], {
    cwd,
  });
  for (const remote of ["origin", "other"])
    execFileSync(
      "git",
      ["remote", "add", remote, join(root, "unused-local-remote-" + remote)],
      { cwd },
    );
  await evaluate(
    `document.querySelector('[data-action="git-review"]').click()`,
  );
  await wait(
    `!document.querySelector('#git-review-pane').hidden && document.querySelector('#git-files [data-git-path]')?.disabled===false&&!document.querySelector('[data-git-action="refresh"]').disabled`,
  );
  assert(
    await evaluate(
      `document.querySelector('#git-source').value==='unstaged' && document.querySelector('#git-root').textContent.length>0`,
    ),
  );
  assert(
    await evaluate(
      `document.querySelector("#git-branch").closest(".composer")===null&&document.querySelector("#git-branch").closest("#git-tool-card")!==null`,
    ),
  );
  const beforeDiff = await evaluate(`window.gitRequests`);
  await evaluate(`document.querySelector('[data-git-action="diff"]').click()`);
  await wait(
    `document.querySelector('.git-file-diff:not([hidden])')?.textContent.length>0&&!document.querySelector('.git-file-diff:not([hidden])')?.textContent.includes('正在读取')`,
  );
  assert.equal(await evaluate(`window.gitRequests`), beforeDiff + 1);
  await evaluate(
    `document.querySelector('[data-git-action="diff"][aria-expanded="true"]').click();document.querySelector('[data-git-action="diff"]').click()`,
  );
  assert.equal(
    await evaluate(`window.gitRequests`),
    beforeDiff + 1,
    "Reopening the same revision should reuse its single diff cache",
  );
  assert(
    await evaluate(
      `document.querySelector('[data-git-action="commit"]').disabled`,
    ),
    "Empty staged changes and empty message cannot be committed",
  );
  for (const width of [320, 360, 390]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert(
      await evaluate(
        `(()=>{const panel=document.querySelector("#workspace-right"),box=panel.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&panel.scrollWidth<=panel.clientWidth+1&&!document.querySelector("#git-review-pane").hidden})()`,
      ),
      "Git panel must fit narrow screens",
    );
  }
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(
    `document.querySelector("#git-remote-select").value="other";document.querySelector('[data-git-action="log"]').click()`,
  );
  await wait(
    `!document.querySelector("#git-history-pane").hidden&&document.querySelector("#git-history-list").textContent.includes("Browser history fixture")&&document.querySelector(".git-history-row")?.disabled===false`,
  );
  assert(
    await evaluate(
      `document.querySelector("#git-remote-select").value==="other"`,
    ),
    "Reading history must not silently change the chosen remote",
  );
  assert(
    await evaluate(
      `document.querySelector(".git-graph [data-kind=head]")&&document.querySelectorAll(".git-graph path[data-edge=parent]").length>=4&&document.querySelector(".git-history-author").textContent.includes("Browser Fixture")&&document.querySelector(".git-ref-branch")`,
    ),
    "History must render real merge paths, HEAD, author and branch badges",
  );
  assert(
    await evaluate(
      `[...document.querySelectorAll(".git-graph-row")].every(row=>Math.abs(row.getBoundingClientRect().height-24)<1)`,
    ),
    "Graph lanes require contiguous fixed-height rows",
  );
  await shot("git-history-graph-dark");
  execFileSync("git", ["checkout", "-qb", "graph-unmerged"], { cwd });
  execFileSync(
    "git",
    [
      "commit",
      "--allow-empty",
      "-qm",
      'Unmerged <img src=x onerror="window.graphXss=true">',
    ],
    { cwd },
  );
  execFileSync("git", ["checkout", "-q", graphBranch], { cwd });
  await evaluate(
    `document.querySelector("#git-history-scope").value="all";document.querySelector("#git-history-scope").dispatchEvent(new Event("change"))`,
  );
  await wait(
    `document.querySelector("#git-history-list").textContent.includes("Unmerged <img")`,
  );
  assert(
    await evaluate(
      `!document.querySelector("#git-history-list img")&&!window.graphXss`,
    ),
    "Graph metadata must stay escaped text, never executable markup",
  );
  await evaluate(
    `document.querySelector("#git-history-scope").value="current";document.querySelector("#git-history-scope").dispatchEvent(new Event("change"))`,
  );
  await wait(
    `!document.querySelector("#git-history-scope").disabled&&!document.querySelector("#git-history-list").textContent.includes("Unmerged <img")`,
  );
  await evaluate(
    `document.querySelector('.git-history-row[data-git-ref="${graphBase}"]').click()`,
  );
  await wait(
    `document.querySelector("#git-history-detail").textContent.includes("browser-mcp.mjs")&&document.querySelector("#git-history-detail").textContent.includes("Browser history fixture")`,
  );
  await evaluate(
    `document.querySelector('[data-right-view="review"]').click()`,
  );
  await wait(
    `!document.querySelector("#git-review-pane").hidden&&!document.querySelector('[data-git-action="refresh"]').disabled`,
  );
  await evaluate(
    `document.querySelector('[data-git-action="refresh"]').click()`,
  );
  await wait(
    `!document.querySelector('[data-git-action="refresh"]').disabled&&document.querySelector("#git-remote-select").value==="other"`,
  );
  await evaluate(
    `document.querySelector("#git-message").value="Git draft fixture";document.querySelector("#git-message").dispatchEvent(new Event("input",{bubbles:true}))`,
  );
  await evaluate(`document.querySelector('[data-git-action="diff"]').click()`);
  await wait(`document.querySelector('[data-git-action="stage"]')`);
  await evaluate(`window.blockGitWrites=true`);
  const beforeBusySnapshot = await evaluate(`window.snapshotFetches`);
  app.bridge.publish("state_changed", {});
  await wait(
    `window.snapshotFetches>${beforeBusySnapshot}&&document.querySelector('[data-git-action="stage"]').disabled`,
  );
  assert(
    await evaluate(
      `!document.querySelector('[data-git-action="diff"]').disabled&&document.querySelector("#git-notice").textContent.includes("所有会话")`,
    ),
    "Shared write locks should block mutations but preserve diff reading",
  );
  await evaluate(`window.blockGitWrites=false`);
  const afterBusySnapshot = await evaluate(`window.snapshotFetches`);
  app.bridge.publish("state_changed", {});
  await wait(
    `window.snapshotFetches>${afterBusySnapshot}&&!document.querySelector('[data-git-action="stage"]').disabled`,
  );
  await evaluate(`document.querySelector('[data-git-action="stage"]').click()`);
  await wait(
    `document.querySelector('#dialog').open || document.querySelector('#git-status').textContent.includes('信任')`,
  );
  if (await evaluate(`document.querySelector('#dialog').open`))
    await evaluate(`document.querySelector('#dialog').close()`);
  assert.equal(
    await evaluate(`window.analysisRequests`),
    0,
    "Review must never launch LSP automatically",
  );
  for (const [path, code] of [
    ["review-error.ts", "2322"],
    ["review-error.json", "516"],
  ]) {
    await evaluate(
      `document.querySelector('[data-git-action="diff"][data-git-path="${path}"]').click()`,
    );
    await wait(
      `document.querySelector('[data-git-action="diff"][data-git-path="${path}"]').getAttribute("aria-expanded")==="true"&&!document.querySelector(".git-file-diff").textContent.includes("正在读取")`,
    );
    await evaluate(
      `document.querySelector('[data-git-action="analyze"]').click()`,
    );
    await wait(
      `document.querySelector("#git-diagnostics-list").textContent.includes("${code}")&&!document.querySelector('[data-git-action="analyze"]').disabled`,
    );
  }
  assert.equal(await evaluate(`window.analysisRequests`), 2);
  const originalBranch = execFileSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  }).trim();
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["config", "tag.gpgsign", "false"], { cwd });
  execFileSync("git", ["add", "--", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "Management fixture"], { cwd });
  await evaluate(
    `document.querySelector('[data-right-view="review"]').click()`,
  );
  await wait(`!document.querySelector('[data-git-action="refresh"]').disabled`);
  await evaluate(
    `document.querySelector('[data-right-view="manage"]').click()`,
  );
  const manage = async (action, fields) => {
    await evaluate(
      `document.querySelector("#git-manage-action").value=${JSON.stringify(action)};document.querySelector("#git-manage-action").dispatchEvent(new Event("change"));for(const [id,value] of Object.entries(${JSON.stringify(fields)})){document.querySelector("#"+id).value=value;document.querySelector("#"+id).dispatchEvent(new Event("change"));}document.querySelector('[data-git-action="manage"]').click()`,
    );
    await wait(`document.querySelector("#dialog").open`);
    assert(
      await evaluate(
        `document.querySelector("#dialog").textContent.includes(${JSON.stringify(action)})`,
      ),
      "Confirmation must identify the exact Git operation",
    );
    await evaluate(`document.querySelector("#dialog-form").requestSubmit()`);
    await wait(
      `!document.querySelector("#dialog").open&&!document.querySelector('[data-git-action="manage"]').disabled&&!document.querySelector("#git-manage-output").hidden&&!!document.querySelector("#git-manage-output").textContent`,
    );
  };
  await manage("checkout", {
    "git-checkout-mode": "create",
    "git-new-name": "ui-feature",
    "git-ref": "HEAD",
  });
  assert.equal(
    execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
    }).trim(),
    "ui-feature",
  );
  await manage("merge", { "git-ref": baseCommit });
  await manage("tag", {
    "git-tag-operation": "create",
    "git-new-name": "ui-tag",
    "git-ref": "HEAD",
  });
  assert(
    execFileSync("git", ["tag", "--list"], { cwd, encoding: "utf8" }).includes(
      "ui-tag",
    ),
  );
  await manage("tag", {
    "git-tag-operation": "delete",
    "git-new-name": "ui-tag",
  });
  assert(
    !execFileSync("git", ["tag", "--list"], { cwd, encoding: "utf8" }).includes(
      "ui-tag",
    ),
  );
  await manage("checkout", {
    "git-checkout-mode": "auto",
    "git-ref": originalBranch,
  });
  await manage("reset", { "git-reset-mode": "soft", "git-ref": baseCommit });
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim(),
    baseCommit,
  );
  await manage("reset", { "git-reset-mode": "mixed", "git-ref": baseCommit });
  assert.equal(
    execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd,
      encoding: "utf8",
    }).trim(),
    "",
  );
  assert(
    await evaluate(
      `!document.querySelector('#git-reset-mode option[value="hard"]')&&!document.querySelector('#git-checkout-mode option[value="restore"]')`,
    ),
    "Disallowed destructive modes must not exist in the GUI",
  );
  await evaluate(
    `document.querySelector('[data-right-view="review"]').click()`,
  );
  await wait(`!document.querySelector('[data-git-action="refresh"]').disabled`);
  await shot("git-review-light");
  await evaluate(`document.body.classList.add("dark")`);
  await shot("git-review-dark");
  await evaluate(
    `document.querySelector('[data-action="close-right-view"]').click()`,
  );
  assert(
    await evaluate(
      `!document.querySelector("#git-tool-card").hidden&&document.querySelector("#git-review-pane").hidden&&!document.querySelector("#git-dialog")`,
    ),
    "Closing review must retain the persistent card, not a Git modal",
  );
  const contrastCheck = async (selectors) => {
    // Theme tokens change immediately; wait for color transitions before checking.
    await evaluate(
      `Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished.catch(()=>{})))`,
    );
    const values = await evaluate(
      `(${measureSurfaceContrast.toString()})(${JSON.stringify(selectors)})`,
    );
    for (const value of values)
      assert(
        value.ratio >= 4.5,
        `${value.selector} contrast ${value.ratio.toFixed(2)} < 4.5 (${value.foreground} on ${value.background})`,
      );
  };
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `document.body.classList.toggle('dark',${theme === "dark"})`,
    );
    assert(
      await evaluate(
        `!document.querySelector("[data-action='preview-input']") && !document.querySelector("#input-preview")`,
      ),
      "Composer must not contain input preview",
    );
    assert(
      await evaluate(
        `document.querySelector("#attach-context").textContent.trim() === "+" && document.querySelector("#attach-context").getAttribute("aria-label") === "添加上下文"`,
      ),
      "Context entry must be an accessible plus-only button",
    );
    assert(
      await evaluate(
        `[".model-button", "#thinking-level", "#attach-context", "#stop-button"].every(selector=>{const s=getComputedStyle(document.querySelector(selector));return s.backgroundColor!=="rgba(0, 0, 0, 0)" && s.backgroundColor!==getComputedStyle(document.querySelector("#composer")).backgroundColor && parseFloat(s.borderTopWidth)>0})`,
      ),
      "Toolbar controls must have distinct surfaces and borders",
    );
    await contrastCheck([
      "#thinking-level",
      "#attach-context",
      "#workspace-name",
      ".new-session",
      "#runtime-label",
      "#connection-status",
      "#run-status",
      ".model-button",
      "#git-branch",
      "#git-card-stats .git-added",
      "#git-card-stats .git-removed",
    ]);
    assert(
      await evaluate(
        `(() => {const chip=getComputedStyle(document.querySelector('#token-total'));const cost=document.querySelector('#token-cost');return chip.borderRadius==='999px' && chip.backgroundColor.startsWith('rgba(') && cost.scrollWidth<=cost.clientWidth+1;})()`,
      ),
      "Session readings must be glass chips, without clipping",
    );
    assert(
      await evaluate(
        `document.querySelector('.composer-note').getBoundingClientRect().bottom<=innerHeight`,
      ),
    );
  }
  assert(
    await evaluate(
      `document.querySelector('#thinking-level').tagName==='BUTTON'`,
    ),
    "Thinking menu must use a themed in-page popup, not the OS native select",
  );
  await evaluate(`document.querySelector('#thinking-level').click()`);
  await wait(`!document.querySelector('#thinking-menu').hidden`);
  await contrastCheck(["#thinking-menu button"]);
  await shot("thinking-menu-dark");
  await evaluate(
    `document.querySelector('#thinking-menu button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
  );
  assert(await evaluate(`document.querySelector('#thinking-menu').hidden`));
  const currentSlot = app.manager.active,
    nativeSnapshot = currentSlot.options.snapshot;
  currentSlot.options.snapshot = () => ({
    ...nativeSnapshot(),
    thinkingEditable: undefined,
    idle: false,
  });
  app.bridge.publish("state_changed", {});
  await wait(
    `document.querySelector("#thinking-level").title.includes("旧宿主")`,
  );
  assert(await evaluate(`document.querySelector("#thinking-level").disabled`));
  currentSlot.options.snapshot = () => ({
    ...nativeSnapshot(),
    thinkingEditable: false,
  });
  app.bridge.publish("state_changed", {});
  await wait(
    `document.querySelector("#thinking-level").title.includes("初始化")`,
  );
  assert(await evaluate(`document.querySelector("#thinking-level").disabled`));
  currentSlot.options.snapshot = () => ({
    ...nativeSnapshot(),
    thinkingLevels: ["off"],
    thinkingLevel: "off",
  });
  app.bridge.publish("state_changed", {});
  await wait(
    `document.querySelector("#thinking-level").title.includes("没有可切换")`,
  );
  assert(
    await evaluate(
      `document.querySelector("#thinking-level").disabled && document.querySelectorAll("#thinking-menu button").length===1`,
    ),
  );
  currentSlot.options.snapshot = nativeSnapshot;
  app.bridge.publish("state_changed", {});
  await wait(`!document.querySelector("#thinking-level").disabled`);
  assert(
    await evaluate(
      `!document.querySelector('#tools-label') && !!document.querySelector('#cache-hit')`,
    ),
  );
  assert(
    await evaluate(
      `document.querySelector('.thinking-output').textContent.includes('核对当前工作空间')`,
    ),
  );
  assert(
    await evaluate(
      `document.querySelector('.tool-card').textContent.includes('package.json')`,
    ),
  );
  await evaluate(
    `document.querySelector('.thinking-output').open=true;document.querySelector('.tool-card').open=true`,
  );
  assert(
    await evaluate(
      `!document.querySelector('.turn-process') && document.querySelector('.thinking-output').closest('.message-body') === document.querySelector('.tool-card').closest('.message-body') && document.querySelector('.process-entry').textContent.includes('我会先阅读配置')`,
    ),
  );
  await shot("conversation-process-dark");
  const composerRegressions = [];
  const secondTarget = (
    await call("Target.createTarget", { url: "about:blank", newWindow: true })
  ).targetId;
  const secondSession = (
    await call("Target.attachToTarget", {
      targetId: secondTarget,
      flatten: true,
    })
  ).sessionId;
  await call("Page.enable", {}, secondSession);
  await call(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 700, deviceScaleFactor: 1, mobile: true },
    secondSession,
  );
  await call("Page.navigate", { url: app.url }, secondSession);
  await wait(
    `document.querySelector('#connection-status')?.textContent === 'Pi 已连接'`,
    secondSession,
  );
  const questionStore = app.manager.active.options.interactions;
  const fixtureQuestions = [
    {
      header: "Choice",
      question: "Choose?",
      options: [
        { label: "One", description: "First", preview: "**Preview**" },
        { label: "Two", description: "Second" },
      ],
    },
    {
      header: "Multi",
      question: "Which?",
      multiSelect: true,
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
    },
  ];
  await evaluate(
    `document.querySelector('#prompt').value='Draft before Ask User'`,
  );
  let fixtureAnswer;
  const askId = questionStore.start("Ask User", async (interaction) => {
    fixtureAnswer = await interaction.prompt({
      type: "questionnaire",
      questions: fixtureQuestions,
    });
  });
  await wait(`!document.querySelector('#ask-user').hidden`);
  await wait(`!document.querySelector('#ask-user').hidden`, secondSession);
  assert(
    await evaluate(
      `!document.querySelector('#interaction-dialog').open && document.querySelector('#ask-user').textContent.includes('Custom option') && document.querySelectorAll('#ask-user fieldset').length === 2`,
    ),
  );
  if (
    !(await evaluate(
      `document.querySelector('#composer').hidden && document.querySelector('#composer').getClientRects().length === 0 && document.querySelector('#ask-user').getClientRects().length > 0`,
    ))
  )
    composerRegressions.push(
      "Ask User must replace the composer, not appear above it",
    );
  assert(
    await evaluate(
      `document.querySelector('#composer').hidden && document.querySelector('#ask-user').checkVisibility()`,
      secondSession,
    ),
  );
  const askPrompt = questionStore.list().find((row) => row.id === askId)
    .prompt.id;
  await call("Page.reload", {}, secondSession);
  await wait(
    `document.querySelector('#connection-status')?.textContent === 'Pi 已连接' && !document.querySelector('#ask-user').hidden`,
    secondSession,
  );
  assert(
    await evaluate(
      `document.querySelector('#composer').hidden && document.querySelector('#ask-user').checkVisibility()`,
      secondSession,
    ),
  );
  await evaluate(
    `document.querySelector('[name="pick-0"][value="custom"]').click();document.querySelector('[name="custom-0"]').value='Literal custom';document.querySelector('[name="pick-1"][value="1"]').click();document.querySelector('#interaction-form').requestSubmit()`,
  );
  await until(() => fixtureAnswer);
  assert.equal(fixtureAnswer.answers[0].answer, "Literal custom");
  assert.deepEqual(fixtureAnswer.answers[1].selected, ["B"]);
  await wait(`document.querySelector('#ask-user').hidden`);
  await wait(`document.querySelector('#ask-user').hidden`, secondSession);
  assert.equal(
    await evaluate(`document.querySelector('#prompt').value`),
    "Draft before Ask User",
  );
  assert(await evaluate(`!document.querySelector('#composer').hidden`));
  await evaluate(`document.querySelector('#prompt').value=''`);
  assert.deepEqual(composerRegressions, [], "Composer regression symptoms");
  const duplicate = await fetch(new URL("/api/interaction-reply", app.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: askId, promptId: askPrompt, value: "[]" }),
  });
  assert([404, 409].includes(duplicate.status));
  const cancelId = questionStore.start("Ask User", async (interaction) => {
    try {
      await interaction.prompt({
        type: "questionnaire",
        questions: fixtureQuestions,
      });
    } catch {}
  });
  await wait(`!document.querySelector('#ask-user').hidden`);
  const cancellation = questionStore.list().find((row) => row.id === cancelId);
  questionStore.reply({
    id: cancelId,
    promptId: cancellation.prompt.id,
    cancel: true,
  });
  await wait(`document.querySelector('#ask-user').hidden`);
  assert(
    await evaluate(
      `!document.querySelector('#composer').hidden && document.querySelector('#composer').checkVisibility()`,
    ),
  );
  await call("Target.closeTarget", { targetId: secondTarget });
  console.log(
    "Composer passed: Ask User replaces input, preserves drafts and restores on submit/cancel, custom/multi/reload and synchronized replies.",
  );
  await evaluate(
    `document.querySelector('.thinking-output').open=false;document.querySelector('.tool-card').open=false`,
  );
  assert(
    await evaluate(
      `document.querySelectorAll('.assistant-turn').length===1 && document.querySelectorAll('.agent-avatar .pi-logo').length===1`,
    ),
  );
  assert(
    await evaluate(
      `document.querySelector('.session-metrics #context-usage') && !document.querySelector('.app-statusbar') && document.querySelectorAll('.sidebar [data-view="general"]').length===1 && !document.querySelector('.top-actions [data-view="general"]')`,
    ),
  );
  assert(
    await evaluate(
      `document.querySelector('.markdown-body h2')?.textContent==='验证结果' && document.querySelector('.markdown-body table') && document.querySelectorAll('.katex').length>=2`,
    ),
  );
  assert(
    await evaluate(
      `!window.markdownAttack && !document.querySelector('#messages a[href^="javascript:"]') && document.querySelector('#messages pre code').textContent.includes('<script>')`,
    ),
  );
  await evaluate(
    `document.querySelector("#prompt").value="**原始文字** $x^2$";document.querySelector("#prompt").dispatchEvent(new Event("input",{bubbles:true}))`,
  );
  assert.equal(
    await evaluate(`document.querySelector("#prompt").value`),
    "**原始文字** $x^2$",
  );
  await evaluate(`document.querySelector("#prompt").value=""`);
  await evaluate(
    `Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true});document.querySelector('#prompt').value='/copy';document.querySelector('#composer').requestSubmit()`,
  );
  await wait(
    `document.querySelector('#dialog').open && document.querySelector('.copy-response')`,
  );
  assert(
    await evaluate(
      `document.querySelector('.copy-response').value.includes('**配置正常**')`,
    ),
  );
  await evaluate(
    `document.querySelector('#dialog').close();delete navigator.clipboard;document.querySelector('#prompt').value=''`,
  );
  await evaluate(
    `(()=>{const prompt=document.querySelector('#prompt');prompt.value='line one';prompt.dispatchEvent(new Event('input',{bubbles:true}));prompt.focus();prompt.setSelectionRange(prompt.value.length,prompt.value.length);})()`,
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    windowsVirtualKeyCode: 13,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  assert.equal(
    await evaluate(`document.querySelector('#prompt').value`),
    "line one\n",
    "Enter should insert a newline without submitting the message",
  );
  await evaluate(
    `window.testPromptPosts=0;window.restoreComposerFetch=window.fetch;window.fetch=async(...args)=>{const url=new URL(String(args[0]),location.href);if(url.pathname.endsWith('/api/prompt')){window.testPromptPosts++;return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}})}return window.restoreComposerFetch(...args)}`,
  );
  await evaluate(
    `(()=>{const prompt=document.querySelector('#prompt');prompt.value='first sent';prompt.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#composer').requestSubmit();})()`,
  );
  await wait(
    `window.testPromptPosts===1 && document.querySelector('#prompt').value===''`,
  );
  await evaluate(
    `(()=>{const prompt=document.querySelector('#prompt');prompt.value='second sent';prompt.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#composer').requestSubmit();})()`,
  );
  await wait(
    `window.testPromptPosts===2 && document.querySelector('#prompt').value===''`,
  );
  await evaluate(
    `(()=>{const prompt=document.querySelector('#prompt');prompt.value='draft';prompt.dispatchEvent(new Event('input',{bubbles:true}));prompt.focus();prompt.setSelectionRange(prompt.value.length,prompt.value.length);prompt.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));})()`,
  );
  assert.equal(
    await evaluate(`document.querySelector('#prompt').value`),
    "second sent",
  );
  await evaluate(
    `document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))`,
  );
  assert.equal(
    await evaluate(`document.querySelector('#prompt').value`),
    "first sent",
  );
  await evaluate(
    `document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`,
  );
  assert.equal(
    await evaluate(`document.querySelector('#prompt').value`),
    "second sent",
  );
  await evaluate(
    `document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`,
  );
  assert.equal(
    await evaluate(`document.querySelector('#prompt').value`),
    "draft",
  );
  await evaluate(
    `document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}))`,
  );
  await wait(`window.testPromptPosts===3`);
  await evaluate(
    `window.fetch=window.restoreComposerFetch;delete window.restoreComposerFetch;document.querySelector('#prompt').value=''`,
  );
  await shot("desktop-dark");
  await evaluate(
    `(()=>{const prompt=document.querySelector('#prompt');prompt.value='/';prompt.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  assert(
    await evaluate(
      `!document.querySelector('#command-menu').hidden&&document.querySelector('#command-options').textContent.includes('/compact')&&document.querySelector('#command-options').textContent.includes('/skill:web-fixture')&&document.querySelector('#command-options').textContent.includes('/review')`,
    ),
  );
  await shot("commands-dark");
  await evaluate(
    `document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('#prompt').getAttribute('aria-activedescendant')`,
    ),
    "command-1",
  );
  await evaluate(
    `document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('#prompt').getAttribute('aria-activedescendant')`,
    ),
    "command-0",
  );
  await evaluate(
    `document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
  );
  assert(
    await evaluate(
      `document.querySelector('#command-menu').hidden&&document.querySelector('#prompt').value==='/'`,
    ),
  );
  await evaluate(
    `(()=>{const prompt=document.querySelector('#prompt');prompt.value='/skill:web';prompt.dispatchEvent(new Event('input',{bubbles:true}));prompt.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));})()`,
  );
  assert.equal(
    await evaluate(`document.querySelector('#prompt').value`),
    "/skill:web-fixture ",
  );
  await evaluate(
    `(()=>{const prompt=document.querySelector('#prompt');prompt.value='/web-check';prompt.dispatchEvent(new Event('input',{bubbles:true}));prompt.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));prompt.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));})()`,
  );
  await wait(
    `document.querySelector('#toast').textContent==='Native extension command executed'`,
  );
  await evaluate(
    `document.querySelector('#prompt').value='';document.body.classList.remove('dark')`,
  );
  console.log(
    "Light/dark contrast, slash keyboard navigation, native skill/prompt catalog and extension command passed.",
  );
  assert(
    await evaluate(
      `document.querySelector('#preview-panel').hidden&&!document.querySelector('.context-panel')`,
    ),
  );
  assert(
    !(await evaluate(`document.body.textContent.includes('fixture-only-key')`)),
  );
  await shot("desktop");
  await evaluate(`document.querySelector('[data-preview]').click()`);
  assert(
    await evaluate(
      `!document.querySelector('#preview-panel').hidden&&document.querySelector('#preview-content').textContent.includes('package.json')`,
    ),
  );
  await evaluate(
    `document.querySelector('[data-action="close-preview"]').click()`,
  );
  await evaluate(
    `(()=>{const prompt=document.querySelector('#prompt');prompt.value='/settings';prompt.dispatchEvent(new Event('input',{bubbles:true}));prompt.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));prompt.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));})()`,
  );
  await wait(`!document.querySelector('#view-general').hidden`);
  await wait(`document.querySelector('[data-settings-category="context"]')`);
  assert(
    await evaluate(
      `getComputedStyle(document.querySelector('.sidebar')).display==='none'`,
    ),
  );
  await evaluate(
    `document.querySelector('[data-settings-category="context"]').click()`,
  );
  await wait(
    `document.querySelector('[data-setting="compaction.reserveTokens"]')`,
  );
  await evaluate(
    `const control=document.querySelector('[data-setting="compaction.reserveTokens"]');control.value='8192';control.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#settings-form').requestSubmit()`,
  );
  await wait(
    `document.querySelector('#draft-label').textContent==='没有未保存的修改'&&document.querySelector('[data-setting="compaction.reserveTokens"]').value==='8192'`,
  );
  assert.equal(
    JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))
      .compaction.reserveTokens,
    8192,
  );
  await shot("settings");
  await evaluate(`document.body.classList.add('dark')`);
  await contrastCheck([
    "#view-general h1",
    ".setting-label",
    ".setting-label small",
    ".settings-nav button.active",
    "#discard-settings",
    ".outline-button",
  ]);
  await shot("settings-dark");
  await evaluate(
    `document.body.classList.remove('dark');document.querySelector('[data-settings-category="agent"]').click();(()=>{const input=document.querySelector('[data-setting="enabledModels"]');input.value='fixture/*';input.dispatchEvent(new Event('input',{bubbles:true}));})();document.querySelector('[data-settings-category="network"]').click();document.querySelector('[data-settings-category="agent"]').click()`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-setting="enabledModels"]').value`,
    ),
    "fixture/*",
  );
  await evaluate(`document.querySelector('#settings-form').requestSubmit()`);
  await wait(
    `document.querySelector('#draft-label').textContent==='没有未保存的修改'`,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))
      .enabledModels,
    ["fixture/*"],
  );
  assert(
    await evaluate(
      `!!document.querySelector('[data-action="refresh-market"]')&&!!document.querySelector('#market-type')&&!!document.querySelector('#market-sort')`,
    ),
    "Marketplace needs official directory refresh, type filters and sorting controls",
  );
  await evaluate(`
    window.viewEnterSeen=false;
    new MutationObserver(()=>{if(document.querySelector('#view-plugins')?.classList.contains('view-enter'))window.viewEnterSeen=true;}).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class']});
  `);
  await evaluate(`document.querySelector('[data-view="plugins"]').click()`);
  await wait(`window.viewEnterSeen===true`, undefined);
  await wait(
    `document.querySelector('[data-config-plugin="file:test-plugin"]')`,
  );
  await evaluate(
    `document.querySelector('[data-config-plugin="file:test-plugin"]').click()`,
  );
  await wait(`document.querySelector('#dialog').open`);
  assert(
    await evaluate(
      `document.querySelector('#dialog input[name="secret"]').value===''`,
    ),
  );
  await evaluate(
    `document.querySelector('#dialog select[name="enabled"]').value='false';document.querySelector('#dialog-form').requestSubmit()`,
  );
  await wait(`!document.querySelector('#dialog').open`);
  assert.equal(
    JSON.parse(
      await readFile(
        join(agentDir, "extensions", "test-plugin", "config.json"),
        "utf8",
      ),
    ).enabled,
    false,
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(agentDir, "extensions", "test-plugin", "config.json"),
        "utf8",
      ),
    ).secret,
    "private-fixture-token",
  );
  assert(
    await evaluate(
      `document.querySelector('#plugin-grid').textContent.includes('已安装 v1.0.0')`,
    ),
    "Installed versions must come from the native package manifest",
  );
  await wait(
    `!document.querySelector('[data-action="check-package-updates"]').disabled`,
  );
  await evaluate(
    `document.querySelector('[data-action="check-package-updates"]').click()`,
  );
  await wait(
    `!document.querySelector('[data-action="check-package-updates"]').disabled && document.querySelector('#plugin-grid').textContent.includes('Pi 原生报告有更新')`,
  );
  const nativeNpmCalls = (await readFile(npmFixture.log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(
    nativeNpmCalls.some(
      (args) => args[0] === "view" && args[1] === packageFixtureName,
    ),
    "Update hints must use Pi native npm version checks",
  );
  assert.equal(
    JSON.parse(await readFile(join(npmFixture.root, "package.json"), "utf8"))
      .version,
    "1.0.0",
    "Checking must not automatically update",
  );
  await evaluate(
    `document.querySelector('[data-filter="updates"]').click();document.querySelector('#plugin-grid [data-package-action="update"]').click()`,
  );
  await wait(`document.querySelector('#dialog').open`);
  assert(
    await evaluate(
      `document.querySelector('#dialog-body').textContent.includes('固定版本')&&document.querySelector('#dialog-body select').disabled`,
    ),
  );
  await evaluate(`document.querySelector('#dialog-form').requestSubmit()`);
  await wait(`!document.querySelector('#dialog').open`);
  assert.equal(
    JSON.parse(await readFile(join(npmFixture.root, "package.json"), "utf8"))
      .version,
    "2.0.0",
  );
  await evaluate(`document.querySelector('[data-filter="all"]').click()`);
  assert(
    await evaluate(
      `document.querySelector('#plugin-grid').textContent.includes('已安装 v2.0.0')&&document.querySelector('#reload-notice').checkVisibility()`,
    ),
    "Native update changes the installed version, not the running extension loadout",
  );
  await evaluate(`document.querySelector('[data-view="marketplace"]').click()`);
  await wait(`document.querySelector('#market-grid [data-market-detail]')`);
  assert(
    await evaluate(
      `document.querySelector('#market-status').textContent.includes('pi.dev 官方目录')&&document.querySelector('#market-grid').textContent.includes('12,345 次/月')&&document.querySelector('#market-grid').textContent.includes('<literal>')`,
    ),
  );
  const cachedRequests = catalogRequests.length;
  await evaluate(
    `document.querySelector('[data-action="refresh-market"]').click()`,
  );
  await wait(`document.querySelector('#market-grid [data-market-detail]')`);
  assert.equal(catalogRequests.length, cachedRequests + 1);
  assert.equal(catalogRequests.at(-1).refresh, "no-cache");
  await evaluate(
    `document.querySelector('#market-type').value='skill';document.querySelector('#market-type').dispatchEvent(new Event('change'))`,
  );
  await wait(
    `document.querySelector('#market-grid .catalog-types')?.textContent==='skill'`,
  );
  await evaluate(
    `document.querySelector('#market-sort').value='recent';document.querySelector('#market-sort').dispatchEvent(new Event('change'))`,
  );
  await wait(`document.querySelector('#market-grid [data-market-detail]')`);
  assert.equal(
    new URL(catalogRequests.at(-1).url).searchParams.get("type"),
    "skill",
  );
  assert.equal(
    new URL(catalogRequests.at(-1).url).searchParams.get("sort"),
    "recent",
  );
  await evaluate(
    `document.querySelector('#market-pages [data-market-page="2"]').click()`,
  );
  await wait(
    `document.querySelector('#market-grid').textContent.includes('pi-second-page')`,
  );
  assert.equal(
    new URL(catalogRequests.at(-1).url).searchParams.get("page"),
    "2",
  );
  await evaluate(
    `document.querySelector('[data-action="search-market-mcp"]').click()`,
  );
  await wait(`document.querySelector('#market-grid [data-market-detail]')`);
  assert.equal(
    new URL(catalogRequests.at(-1).url).searchParams.get("name"),
    "mcp",
  );
  assert.equal(
    new URL(catalogRequests.at(-1).url).searchParams.get("type"),
    null,
    "MCP must be a keyword search, not an invented official type",
  );
  await evaluate(
    `document.querySelector('#market-grid [data-market-detail="${packageFixtureName}"]').click()`,
  );
  await wait(
    `document.querySelector('.catalog-readme')?.textContent.includes('FULL-README-END')`,
  );
  assert(
    (await evaluate(
      `document.querySelector('.catalog-readme').textContent.length`,
    )) > 60000,
    "Full introduction must not inherit the chat markdown preview truncation",
  );
  assert(
    await evaluate(
      `document.querySelector('.package-metadata').textContent.includes('2.0.0')&&!document.querySelector('.catalog-readme [data-action],.catalog-readme script,.catalog-readme img,.catalog-readme iframe,.catalog-readme button,.catalog-readme [id],.catalog-readme a[href^="javascript:"]')&&!window.catalogAttack`,
    ),
    "Official author content must remain inert and cannot become local controls",
  );
  await evaluate(
    `document.querySelector('[data-action="close-dialog"]').click()`,
  );
  for (const width of [320, 360, 390]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert(
      await evaluate(`document.documentElement.scrollWidth<=innerWidth`),
      "Official marketplace filters and cards must not overflow on mobile",
    );
  }
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await shot("package-marketplace-dark");
  if (catalogCapture) {
    await evaluate(
      `document.querySelector('#market-type').value='';document.querySelector('#market-sort').value='downloads';document.querySelector('#market-search').value='pi-subagents';document.querySelector('#market-search-form').requestSubmit()`,
    );
    await wait(
      `document.querySelector('#market-grid [data-market-detail="pi-subagents"]')`,
    );
    assert(
      await evaluate(
        `document.querySelector('#market-status').textContent.includes('(of ')`,
      ),
    );
    await evaluate(
      `document.querySelector('#market-grid [data-market-detail="pi-subagents"]').click()`,
    );
    await wait(
      `document.querySelector('.catalog-readme')?.textContent.length>1000`,
    );
    assert(
      await evaluate(
        `document.querySelector('.package-metadata').textContent.includes('许可证') && !document.querySelector('.catalog-readme script,.catalog-readme img,.catalog-readme [data-action]')`,
      ),
    );
    await evaluate(
      `document.querySelector('[data-action="close-dialog"]').click()`,
    );
    console.log(
      "Current first-party pi.dev HTML capture passed actual inert Chromium list and complete-details rendering.",
    );
  }
  console.log(
    "Marketplace passed: official refresh/filter/sort/page, complete inert README, actual native npm update hints, confirmed reconciliation and 320/360/390px layout.",
  );
  await evaluate(`document.querySelector('[data-view="providers"]').click()`);
  await wait(`document.querySelector('[data-provider="fixture"]')`);
  await evaluate(`document.querySelector('[data-provider="fixture"]').click()`);
  await wait(`document.querySelector('#dialog').open`);
  assert(
    await evaluate(
      `document.querySelector('#dialog input[name="apiKey"]').value===''`,
    ),
  );
  await evaluate(
    `document.querySelector('[data-action="close-dialog"]').click()`,
  );
  await evaluate(`document.querySelector('[data-view="skills"]').click()`);
  await wait(`!!document.querySelector('[data-toggle-skill]')`);
  await evaluate(
    `([...document.querySelectorAll('[data-toggle-skill]')].find(button=>button.getAttribute('aria-label').includes('web-fixture'))).click()`,
  );
  await wait(
    `([...document.querySelectorAll('[data-toggle-skill]')].find(button=>button.getAttribute('aria-label').includes('web-fixture'))).getAttribute('aria-checked')==='false'`,
  );
  await evaluate(
    `document.querySelector('#view-skills [data-action="reload"]').click()`,
  );
  await pause(250);
  await evaluate(
    `document.querySelector('.settings-back').click();(()=>{const input=document.querySelector('#prompt');input.value='/skill:web-fixture';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  assert(
    !(await evaluate(
      `document.querySelector('#command-options').textContent.includes('/skill:web-fixture')`,
    )),
  );
  await evaluate(
    `document.querySelector('#prompt').value='';document.querySelector('[data-view="skills"]').click()`,
  );
  await wait(`!!document.querySelector('[data-toggle-skill]')`);
  await evaluate(
    `([...document.querySelectorAll('[data-toggle-skill]')].find(button=>button.getAttribute('aria-label').includes('web-fixture'))).click()`,
  );
  await wait(
    `([...document.querySelectorAll('[data-toggle-skill]')].find(button=>button.getAttribute('aria-label').includes('web-fixture'))).getAttribute('aria-checked')==='true'`,
  );
  await evaluate(`document.querySelector('[data-view="mcp"]').click()`);
  await wait(`!document.querySelector('#view-mcp').hidden`);
  await evaluate(`document.querySelector('[data-action="add-mcp"]').click()`);
  await wait(`document.querySelector('#dialog').open`);
  await evaluate(
    `(()=>{const form=document.querySelector('#dialog-form');form.elements.name.value='browser-mcp';form.elements.command.value=${JSON.stringify(process.execPath)};form.elements.args.value=${JSON.stringify(JSON.stringify([mcpFixture]))};document.querySelector('#dialog-submit').click()})()`,
  );
  await wait(
    `document.querySelector('#mcp-list').textContent.includes('browser-mcp')`,
  );
  await evaluate(
    `document.querySelector('#mcp-pending [data-action="reload"]').click()`,
  );
  await wait(
    `document.querySelector('#mcp-list').textContent.includes('已发现 1 个工具')`,
  );
  assert(
    await evaluate(
      `!!document.querySelector('.settings-nav [data-view="mcp"]')`,
    ),
  );
  await shot("mcp");
  await evaluate(`document.body.classList.add('dark')`);
  await contrastCheck([".mcp-card h2", ".mcp-card p", ".mcp-actions button"]);
  await shot("mcp-dark");
  await evaluate(`document.body.classList.remove('dark')`);
  await evaluate(`document.querySelector('[data-view="providers"]').click()`);
  await shot("providers");
  await evaluate(`document.body.classList.add('dark')`);
  await contrastCheck([
    "#view-providers h1",
    ".provider-heading h2",
    ".provider-endpoint",
    ".provider-actions button",
    ".provider-status",
    ".primary-button",
  ]);
  await shot("providers-dark");
  assert(
    await evaluate(
      `(()=>{const content=document.querySelector('.provider-content').getBoundingClientRect(),actions=document.querySelector('.provider-actions').getBoundingClientRect();return actions.left>=content.right})()`,
    ),
    "Provider buttons must not overlap provider metadata",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 2048,
    height: 1074,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert(!(await evaluate(`document.documentElement.scrollWidth>innerWidth`)));
  await shot("providers-wide-dark");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(
    `document.querySelector('[data-expand-provider="fixture"]').click()`,
  );
  assert(
    await evaluate(
      `document.querySelector('[data-model-provider="fixture"]').getClientRects().length>0`,
    ),
  );
  await evaluate(`document.body.classList.remove('dark')`);
  await evaluate(
    `document.querySelector('[data-action="add-provider"]').click();document.querySelector('[data-login-provider="openai"]').click()`,
  );
  await wait(
    `document.querySelector('#interaction-dialog').open&&document.querySelector('#interaction-form input[name="value"]')`,
  );
  await evaluate(
    `document.querySelector('#interaction-form input[name="value"]').value='sk-browser-fixture';document.querySelector('#interaction-form').requestSubmit()`,
  );
  await wait(`!document.querySelector('#interaction-dialog').open`);
  assert.equal(
    JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")).openai.key,
    "sk-browser-fixture",
  );
  assert(
    !(await evaluate(`document.body.innerHTML.includes('sk-browser-fixture')`)),
  );
  await evaluate(
    `document.querySelector('[data-action="git-commit"]').click()`,
  );
  await wait(
    `document.querySelector('[data-git-action="refresh"]').disabled===false&&document.querySelector("#git-message").value==="Git draft fixture"`,
  );
  await evaluate(
    `window.staleGitPosts=0;window.deferGitOnce=true;const beforeGitRace=window.fetch;window.fetch=async(...args)=>{const url=new URL(String(args[0]),location.href);if(url.pathname==="/api/git"&&args[1]?.method==="POST")window.staleGitPosts++;if(url.pathname==="/api/git"&&url.searchParams.get("action")==="status"&&window.deferGitOnce){window.deferGitOnce=false;await new Promise(resolve=>{window.releaseGitRead=resolve})}return beforeGitRace(...args)};document.querySelector("#prompt").value="/git stage browser-mcp.mjs";document.querySelector("#composer").requestSubmit()`,
  );
  await wait(`typeof window.releaseGitRead==="function"`);
  await evaluate(
    `document.querySelector('[data-action="new-session"]').click()`,
  );
  await wait(`document.querySelector('.empty-conversation')`);
  await wait(
    `document.querySelector("#git-message").value===""&&!document.querySelector('[data-git-action="refresh"]').disabled&&document.querySelector('[data-git-action="diff"]')?.disabled===false`,
  );
  await evaluate(`window.releaseGitRead()`);
  assert(
    await evaluate(
      `!document.querySelector("#git-files [aria-expanded=true]")&&document.querySelector("#git-message").value===""&&document.querySelector('[data-git-action="commit"]').disabled`,
    ),
    "Session changes must clear stale Git data and isolate commit drafts",
  );
  await evaluate(
    `document.querySelector('[data-action="close-right-view"]').click()`,
  );
  await wait(`document.querySelector('[data-session-id]')`);
  await evaluate(`document.querySelector('[data-session-id]').click()`);
  await wait(
    `document.querySelector('#messages').textContent.includes('检查工作空间的配置')`,
  );
  assert.equal(
    await evaluate(`window.staleGitPosts`),
    0,
    "A deferred /git stage opening must not prepare a write against the new focused session",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert(!(await evaluate(`document.documentElement.scrollWidth>innerWidth`)));
  for (const width of [320, 360, 390]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await evaluate(`document.querySelector('#thinking-level').click()`);
    await wait(`!document.querySelector('#thinking-menu').hidden`);
    assert(
      await evaluate(
        `(()=>{const bounds=document.querySelector('#thinking-menu').getBoundingClientRect();return bounds.left>=8 && bounds.right<=innerWidth-8})()`,
      ),
      `Thinking popup must fit the ${width}px viewport`,
    );
    await evaluate(`document.querySelector('#thinking-level').click()`);
    assert(
      await evaluate(
        `(()=>{const first=document.querySelector('.metrics-primary').getBoundingClientRect(),second=document.querySelector('.metrics-secondary').getBoundingClientRect();return second.top>=first.bottom && second.height<30 && document.querySelector('#context-detail').textContent.includes('/') && document.querySelector('#git-branch').title.includes('feature/pi-web') && [...document.querySelectorAll('.metrics-primary > *, .metrics-secondary > *')].every(node=>node.getBoundingClientRect().right<=innerWidth-8) && document.documentElement.scrollWidth<=innerWidth})()`,
      ),
      `Planned metric rows at ${width}px must fit, with a truncated long Git branch`,
    );
  }
  await shot("mobile");
  await evaluate(
    `document.querySelector('.topbar [data-action="sidebar"]').click()`,
  );
  assert(await evaluate(`document.body.classList.contains('sidebar-open')`));
  await evaluate(
    `document.querySelector('.sidebar [data-view="general"]').click()`,
  );
  await wait(`!document.querySelector('#view-general').hidden`);
  assert(!(await evaluate(`document.documentElement.scrollWidth>innerWidth`)));
  await shot("mobile-settings");
  await evaluate(`document.body.classList.add('dark')`);
  await shot("mobile-settings-dark");
  await evaluate(
    `document.querySelector('.settings-nav [data-view="mcp"]').click()`,
  );
  await wait(`!document.querySelector('#view-mcp').hidden`);
  assert(!(await evaluate(`document.documentElement.scrollWidth>innerWidth`)));
  await shot("mobile-mcp-dark");
  await evaluate(
    `document.querySelector('.settings-back').click();(()=>{const prompt=document.querySelector('#prompt');prompt.value='/';prompt.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  assert(
    await evaluate(
      `document.querySelector('#command-menu').getBoundingClientRect().right<=innerWidth`,
    ),
  );
  await shot("mobile-commands-dark");
  await evaluate(`document.querySelector('[data-view="remote"]').click()`);
  await evaluate(
    `document.querySelector('.settings-nav [data-view="remote"]').click()`,
  );
  await wait(`document.querySelector('#connection-qr img')?.complete`);
  assert(
    await evaluate(
      `document.querySelector('#connection-qr img').naturalWidth===280 && document.querySelector('#connection-url').textContent.startsWith('http://192.168.55.23:') && !document.querySelector('#connection-url').hash && document.querySelectorAll('[data-connection-address]').length===2`,
    ),
  );
  await evaluate(
    `document.querySelectorAll('[data-connection-address]')[1].click()`,
  );
  await wait(
    `document.querySelector('#connection-url').textContent.startsWith('http://10.8.0.2:')`,
  );
  assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`));
  await shot("mobile-remote");
  await call("Network.enable");
  await call("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await wait(
    `document.querySelector('#connection-status').textContent==='网络离线' || document.querySelector('#connection-status').textContent==='重连中'`,
  );
  await call("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await wait(
    `document.querySelector('#connection-status').textContent==='Pi 已连接'`,
  );
  await evaluate(
    `document.querySelector('.settings-back').click();document.querySelector('#prompt').value='断网恢复后保留的草稿';document.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}))`,
  );
  const rename = await fetch(new URL("/api/prompt", app.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "/name 手机与电脑同步会话" }),
  });
  assert.equal(rename.status, 200);
  await wait(
    `document.querySelector('#session-title').textContent==='手机与电脑同步会话'`,
  );
  assert(
    await evaluate(
      `document.querySelector('#prompt').value==='断网恢复后保留的草稿'`,
    ),
  );
  await evaluate(
    `document.querySelector('#prompt').value='';document.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}))`,
  );
  assert(
    await evaluate(
      `document.querySelector('#toast').getBoundingClientRect().bottom<document.querySelector('.composer-wrap').getBoundingClientRect().top`,
    ),
    "Notifications must leave the composer and session metrics visible",
  );
  await shot("mobile-shared-dark");
  assert.equal(
    (
      await fetch(new URL("/api/new-session", app.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    200,
  );
  await wait(`document.querySelector('.empty-conversation')`);
  assert(
    await evaluate(
      `document.querySelector('.empty-conversation').getBoundingClientRect().bottom<=document.querySelector('.composer-wrap').getBoundingClientRect().top && document.documentElement.scrollWidth<=innerWidth`,
    ),
    "Mobile welcome and composer must fit without overlapping",
  );
  await shot("mobile-welcome-dark");
  assert.deepEqual(await evaluate(`window.webErrors`), []);
  const concurrent = await concurrentFixture({ reasoning: true });
  let parallel;
  try {
    parallel = await startWeb({
      cwd: concurrent.root,
      agentDir: concurrent.agentDir,
      port: 0,
      noExtensions: true,
    });
    await parallel.ready;
    const aid = parallel.manager.focusId;
    await call("Page.navigate", { url: parallel.url });
    await wait(
      `document.querySelector('#connection-status').textContent==='Pi 已连接'`,
    );
    const type = async (text) =>
      evaluate(
        `document.querySelector('#prompt').value=${JSON.stringify(text)};document.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true}))`,
      );
    const send = async (text) => {
      await type(text);
      await evaluate(`document.querySelector('#composer').requestSubmit()`);
    };
    await send("/sessions help");
    await wait(`document.querySelector('#dialog').open`);
    assert(
      await evaluate(
        `document.querySelector('#dialog').textContent.includes('/sessions stop')`,
      ),
    );
    await evaluate(`document.querySelector('#dialog').close()`);
    assert.equal(
      parallel.runtime.session.messages.length,
      0,
      "management help never enters transcript",
    );
    await send("TASK A");
    await until(() => concurrent.entered.has("A"));
    await wait(`document.querySelector("#stop-button").hidden === false`);
    await evaluate(
      `document.querySelector('[data-action="hide-right-sidebar"]').click()`,
    );
    assert(
      !(await evaluate(
        `document.querySelector('#workspace-right').checkVisibility()`,
      )),
    );
    await evaluate(
      `document.querySelector('[data-action="workspace-tools"]').click()`,
    );
    assert(
      await evaluate(
        `document.querySelector('#workspace-right').checkVisibility()`,
      ),
    );
    assert.equal(parallel.runtime.session.isIdle, false);
    assert.equal(
      concurrent.closed.has("A"),
      false,
      "Hiding/restoring the pane must not abort a streaming Agent",
    );
    assert(
      await evaluate(`!document.querySelector("#thinking-level").disabled`),
      "Thinking must remain editable while the agent streams",
    );
    await evaluate(`document.querySelector("#thinking-level").click()`);
    await wait(`!document.querySelector("#thinking-menu").hidden`);
    await evaluate(
      `document.querySelector("#thinking-menu [data-thinking=low] span").click()`,
    );
    await wait(
      `document.querySelector("#thinking-level").textContent.startsWith("低")`,
    );
    assert.equal(parallel.runtime.session.thinkingLevel, "low");
    assert.equal(parallel.runtime.session.isIdle, false);
    await type("独立草稿-A");
    await evaluate(
      `document.querySelector('[data-action="new-session"]').click()`,
    );
    await until(() => parallel.manager.focusId !== aid);
    const bid = parallel.manager.focusId;
    await wait(
      `document.querySelector('#sessions .active').dataset.sessionId===${JSON.stringify(bid)}&&document.querySelector('#prompt').value===''`,
    );
    const a = parallel.manager.slots.get(aid).app.runtime.session;
    const b = parallel.manager.slots.get(bid).app.runtime.session;
    assert.equal(a.isIdle, false);
    await send("TASK B");
    await until(() => concurrent.entered.has("B"));
    await wait(
      `document.querySelector('#messages').textContent.includes('partial-B')`,
    );
    await type("独立草稿-B");
    await wait(
      `Array.from(document.querySelectorAll('#sessions small')).filter(node=>node.textContent.includes('运行中')).length===2`,
    );
    await evaluate(
      `document.querySelector('#sessions [data-session-id="${aid}"]').click()`,
    );
    await wait(
      `document.querySelector('#prompt').value==='独立草稿-A'&&document.querySelector('#sessions .active').dataset.sessionId===${JSON.stringify(aid)}`,
    );
    await evaluate(
      `document.querySelector('#sessions [data-session-id="${bid}"]').click()`,
    );
    await wait(
      `document.querySelector('#prompt').value==='独立草稿-B'&&document.querySelector('#sessions .active').dataset.sessionId===${JSON.stringify(bid)}`,
    );
    concurrent.release("A");
    await until(() => a.isIdle);
    await wait(
      `!document.querySelector('#sessions [data-session-id="${aid}"]').textContent.includes('运行中')`,
    );
    assert(
      !(await evaluate(
        `document.querySelector('#messages').textContent.includes('completed-A')||document.querySelector('#messages').textContent.includes('partial-A')`,
      )),
      "background A must not render into B",
    );
    assert.equal(b.isIdle, false);
    await send("/sessions stop");
    await until(() => b.isIdle);
    assert.equal(parallel.manager.focusId, bid);
    await send(`/sessions use ${aid.slice(0, 18)}`);
    await wait(
      `document.querySelector('#sessions .active').dataset.sessionId===${JSON.stringify(aid)}&&document.querySelector('#messages').textContent.includes('completed-A')`,
    );
    assert.equal(
      parallel.runtime.session,
      a,
      "switch reuses the existing writer",
    );
    assert(
      await evaluate(`document.querySelector('#prompt').value==='独立草稿-A'`),
      "late B command response must not clear A draft",
    );
    const notes = join(root, "context-notes.md"),
      picture = join(root, "context-image.png"),
      pdf = join(root, "unsupported.pdf"),
      brokenPicture = join(root, "broken.png");
    // This section covers remote upload behavior; local indexing is exercised
    // by context-files-browser-check.mjs through the real Electron preload.
    await call("Network.enable");
    await call("Network.setExtraHTTPHeaders", {
      headers: { "x-pi-remote-client": "1" },
    });
    await evaluate("location.reload()");
    await wait(
      "document.querySelector('#attach-context')?.title === '上传上下文文件' && !document.querySelector('#attach-context').disabled",
    );
    await writeFile(
      notes,
      "# Context fixture\n<script>window.contextAttack=true</script>",
    );
    await writeFile(picture, await QRCode.toBuffer("browser context"));
    await writeFile(pdf, "%PDF-1.7 fixture");
    await writeFile(brokenPicture, "broken PNG fixture");
    await call("DOM.enable");
    const chooseFiles = async (files) => {
      const document = (await call("DOM.getDocument")).root.nodeId;
      const nodeId = (
        await call("DOM.querySelector", {
          nodeId: document,
          selector: "#context-files",
        })
      ).nodeId;
      await call("DOM.setFileInputFiles", { nodeId, files });
    };
    const pasteFiles = async (names, text = "") =>
      evaluate(`(()=>{
      const data=new DataTransfer();for(const name of ${JSON.stringify(names)}) data.items.add(new File([name.endsWith(".pdf")?"%PDF-1.7 fixture":"# pasted context"],name,{type:name.endsWith(".pdf")?"application/pdf":"text/plain"}));
      if(${JSON.stringify(text)}) data.setData("text/plain",${JSON.stringify(text)});
      const event=new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true});
      document.querySelector("#prompt").dispatchEvent(event);return event.defaultPrevented;
    })()`);
    assert.equal(
      await pasteFiles(["clipboard.md"], "mixed clipboard text"),
      true,
    );
    await wait(
      `document.querySelector('[data-context-preview]:not([disabled])')`,
    );
    assert(
      await evaluate(
        `document.querySelector("#prompt").value.endsWith("mixed clipboard text") && document.querySelector("#context-attachments").textContent.includes("clipboard.md")`,
      ),
    );
    await evaluate(
      `document.querySelector("[data-context-remove]").click();document.querySelector("#prompt").value="";document.querySelector("#prompt").dispatchEvent(new Event("input",{bubbles:true}))`,
    );
    assert.equal(
      await pasteFiles([], "/home/example/file.txt"),
      false,
      "text and path paste must keep browser defaults, never become host-file reads",
    );
    assert.equal(await pasteFiles(["unsupported.pdf"]), true);
    await wait(
      `document.querySelector("#context-attachments").textContent.includes("不支持此格式")`,
    );
    await evaluate(`document.querySelector("[data-context-remove]").click()`);
    const clipboardPng = (await readFile(picture)).toString("base64");
    await evaluate(
      `(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(clipboardPng)}),c=>c.charCodeAt(0)), data=new DataTransfer();data.items.add(new File([bytes],"clipboard.png",{type:"image/png"}));document.querySelector("#prompt").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));})()`,
    );
    await wait(
      `document.querySelector('[data-context-preview]:not([disabled])')`,
    );
    await evaluate(`document.querySelector('[data-context-preview]').click()`);
    await wait(`document.querySelector('#dialog img')?.naturalWidth>0`);
    await evaluate(
      `document.querySelector("#dialog").close();document.querySelector('[data-context-remove]').click()`,
    );
    await pasteFiles(Array.from({ length: 9 }, (_, i) => "clip-" + i + ".txt"));
    await wait(
      `document.querySelectorAll('[data-context-preview]:not([disabled])').length===8`,
    );
    assert(
      await evaluate(
        `document.querySelectorAll('[data-context-remove]').length===8`,
      ),
    );
    await evaluate(
      `for(let i=0;i<8;i++) document.querySelector('[data-context-remove]').click()`,
    );
    await chooseFiles([pdf]);
    await wait(
      `document.querySelector('#context-attachments').textContent.includes('不支持')`,
    );
    assert(await evaluate(`document.querySelector('#send-button').disabled`));
    await evaluate(`document.querySelector('[data-context-remove]').click()`);
    await evaluate(
      `window.savedReader = FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL = function(){this.dispatchEvent(new ProgressEvent('error'));}`,
    );
    await chooseFiles([notes]);
    await wait(
      `document.querySelector('#context-attachments').textContent.includes('无法读取')`,
    );
    await evaluate(
      `FileReader.prototype.readAsDataURL = window.savedReader;document.querySelector('[data-context-remove]').click()`,
    );
    await chooseFiles([brokenPicture]);
    await wait(
      `document.querySelector('[data-context-preview]:not([disabled])')`,
    );
    await send("失败后保留草稿");
    await wait(
      `document.querySelector('#toast').textContent.includes('内容无效')`,
    );
    assert(
      await evaluate(
        `document.querySelector('#prompt').value === '失败后保留草稿' && document.querySelectorAll('[data-context-remove]').length === 1`,
      ),
    );
    await evaluate(`document.querySelector('[data-context-remove]').click()`);
    await chooseFiles([notes, picture]);
    await wait(
      `document.querySelectorAll('[data-context-preview]:not([disabled])').length === 2`,
    );
    await evaluate(`document.querySelector('[data-context-preview]').click()`);
    await wait(`document.querySelector('#dialog').open`);
    assert(
      await evaluate(
        `document.querySelector('#dialog pre').textContent.includes('<script>') && !window.contextAttack`,
      ),
    );
    await evaluate(`document.querySelector('#dialog').close()`);
    await evaluate(
      `document.querySelector('#sessions [data-session-id="${bid}"]').click()`,
    );
    await wait(
      `document.querySelector('#sessions .active').dataset.sessionId === ${JSON.stringify(bid)} && document.querySelector('#context-attachments').hidden`,
    );
    await evaluate(
      `document.querySelector('#sessions [data-session-id="${aid}"]').click()`,
    );
    await wait(
      `document.querySelectorAll('[data-context-preview]:not([disabled])').length === 2`,
    );
    await call("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await wait(`document.querySelector('#send-button').disabled`);
    await call("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await wait(
      `document.querySelector('#connection-status').textContent === 'Pi 已连接'`,
    );
    assert.equal(
      await evaluate(
        `document.querySelectorAll('[data-context-preview]:not([disabled])').length`,
      ),
      2,
    );
    for (const width of [320, 360, 390]) {
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      assert(
        await evaluate(
          `[...document.querySelectorAll('.composer-toolbar > button')].every(button => button.getBoundingClientRect().right <= innerWidth - 8) && document.documentElement.scrollWidth <= innerWidth`,
        ),
        "Attachment toolbar must remain usable on mobile",
      );
    }
    const beforeContext = a.messages.length;
    await send("Context attachment fixture");
    await until(() =>
      a.messages
        .slice(beforeContext)
        .some(
          (message) =>
            message.role === "user" &&
            message.content.some((block) => block.type === "image"),
        ),
    );
    await wait(
      `document.querySelector('#context-attachments').hidden && document.querySelector('#prompt').value === ''`,
    );
    const attachmentMessage = a.messages
      .slice(beforeContext)
      .find((message) => message.role === "user");
    const attachmentText = attachmentMessage.content.find(
      (block) => block.type === "text",
    )?.text;
    const cachedPath = /\/tmp\/pi-desk-context-cache\/[^\s"'\\]+\.md/.exec(
      attachmentText ?? "",
    )?.[0];
    assert(cachedPath, "Remote attachments must hand the Agent a cached path");
    assert.equal(
      await readFile(cachedPath, "utf8"),
      "# Context fixture\n<script>window.contextAttack=true</script>",
    );
    assert(!attachmentText.includes("Context fixture"));
    await until(() => a.isIdle);
    console.log(
      "Context browser passed: real file picker, text/image preview, removal/error, isolated drafts, reconnect preservation, mobile toolbar and real SDK submission.",
    );
    console.log(
      "Concurrent browser passed: /sessions help/new/use/stop, two running slots, isolated drafts, background tool completion, sidebar status and no cross-session streaming.",
    );
  } finally {
    await parallel?.stop();
    await concurrent.stop();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(
    await evaluate(`window.webErrors ?? []`),
    [],
    "Web dialogs must complete without caught JavaScript errors",
  );
  console.log(
    "Browser passed: native headless, settings, providers, MCP, Markdown, shared session, offline recovery, persistent stream, 1440 desktop and planned mobile rows at 320/360/390px.",
  );
} finally {
  ws?.close();
  browser?.kill("SIGTERM");
  if (app) await app.stop();
  await pause(100);
  await rm(root, { recursive: true, force: true });
}
