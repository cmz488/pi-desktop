import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  embeddedPiSdk as sdk,
  loadEmbeddedPiSdk,
} from "../src/agent/pi-sdk.mjs";
import { nativeSessionDirectory } from "../src/session/pi-session-storage.mjs";
import { desktopFixture } from "./desktop-fixture.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

await loadEmbeddedPiSdk();
let pickerCalls = 0;
let prepared = 0;
let runtimeState = { phase: "off", backendState: "", managed: true };
const f = await desktopFixture({
  defaultConversation: true,
  directoryPicker: {
    async pick() {
      return ++pickerCalls === 1 ? null : f.other;
    },
  },
  remoteFunnel: {
    runtimeState: () => runtimeState,
    async prepare() {
      prepared++;
      runtimeState = {
        phase: "running",
        backendState: "NeedsLogin",
        managed: true,
      };
    },
    async start() {
      throw new Error("fixture requires explicit login");
    },
  },
});
const electronMode = process.argv.includes("--electron");
const pages = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<html><head><title>${request.url === "/second" ? "Second browser page" : "Native browser fixture"}</title></head><body><h1>Browser fixture</h1><a style="position:fixed;left:10px;top:100px" href="/second">Next</a><script>document.body.dataset.isolated=String(typeof window.piDesk==='undefined' && typeof process==='undefined');</script></body></html>`,
  );
});
await new Promise((resolve) => pages.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${pages.address().port}/first`;

let browser,
  driver,
  log = "";
try {
  const profile = electronMode
    ? join(f.root, "config", "pi-desk")
    : join(f.root, "browser");
  if (electronMode) {
    await f.app.stop();
    const tailCli = join(f.root, "tailscale-fixture");
    await writeFile(
      tailCli,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({BackendState:'NeedsLogin'}));\n",
      { mode: 0o700 },
    );
    const entry = join(f.root, "desktop-fixture-entry.mjs");
    await writeFile(
      entry,
      `import {dialog} from 'electron'; import {writeFile} from 'node:fs/promises'; let calls=0; dialog.showOpenDialog=async (_window, options)=>{await writeFile(${JSON.stringify(join(f.root, "picker.json"))},JSON.stringify(options));return ++calls===1?{canceled:true,filePaths:[]}:{canceled:false,filePaths:[${JSON.stringify(f.other)}]};}; await import(${JSON.stringify(fileURLToPath(new URL("../src/desktop/desktop.mjs", import.meta.url)))});`,
    );
    browser = spawn(
      "xvfb-run",
      [
        "-a",
        "/usr/bin/electron43",
        "--no-sandbox",
        "--disable-gpu",
        "--ozone-platform=x11",
        "--remote-debugging-port=0",
        entry,
        "--managed",
        JSON.stringify({
          cwd: f.cwd,
          agentDir: f.agentDir,
          directory: f.directory,
        }),
      ],
      {
        env: {
          ...process.env,
          PI_DESK_TAILSCALE: tailCli,
          XDG_CONFIG_HOME: join(f.root, "config"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } else {
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
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  }
  browser.stdout.on("data", (chunk) => {
    log += chunk;
  });
  browser.stderr.on("data", (chunk) => {
    log += chunk;
  });
  driver = await browserDriver(profile);
  const { call, evaluate, until } = driver;
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (!electronMode) await call("Page.navigate", { url: f.app.url });
  await until("!!document.querySelector('.project-title')");
  if (electronMode)
    assert.equal(
      await evaluate("typeof window.piDesk.pickDirectory"),
      "function",
    );
  const originalSettings = JSON.parse(
    await readFile(join(f.agentDir, "settings.json"), "utf8"),
  );
  await writeFile(
    join(f.agentDir, "settings.json"),
    JSON.stringify({
      ...originalSettings,
      extensions: [join(f.cwd, "extension.mjs")],
      skills: [join(f.cwd, "skills")],
      prompts: [join(f.cwd, "prompts")],
    }),
  );
  const modelDocument = JSON.parse(
    await readFile(join(f.agentDir, "models.json"), "utf8"),
  );
  modelDocument.providers["desktop-fixture"].models.push({
    id: "second-model",
    name: "Second model",
    contextWindow: 8192,
    maxTokens: 1024,
  });
  await writeFile(
    join(f.agentDir, "models.json"),
    JSON.stringify(modelDocument),
  );
  async function create(name) {
    await evaluate(
      "document.querySelector('.project-title button:last-child').click()",
    );
    await until("document.querySelector('#editor').open");
    await evaluate(
      `(() => { const form=document.querySelector('#editor-form'); form.elements.name.value=${JSON.stringify(name)}; form.requestSubmit(); })()`,
    );
    await until("!document.querySelector('#editor').open");
    // Creating an Agent now starts its process before closing the form.
    await until(
      "document.querySelector('#runtime')?.title.startsWith(" +
        JSON.stringify(name) +
        ")",
    );
    await until(
      "document.querySelector('#runtime')?.contentDocument?.querySelector('#connection-status')?.textContent==='Pi 已连接'",
      { timeoutMs: 15000 },
    );
    assert(
      await evaluate(
        "document.querySelector('#runtime').contentDocument.body.classList.contains('desktop-embedded')",
      ),
    );
  }
  await until(
    "document.querySelector('#runtime')?.contentDocument?.querySelector('#connection-status')?.textContent==='Pi 已连接'",
    { timeoutMs: 15000 },
  );

  // The parent owns the frost; embedded HTML/body must remain truly transparent.
  assert.equal(
    await evaluate("document.documentElement.dataset.theme"),
    "light",
  );
  assert(
    await evaluate(`(() => {
    const doc=document.querySelector('#runtime').contentDocument;
    const s=node=>node.ownerDocument.defaultView.getComputedStyle(node);
    const nav=s(document.querySelector('#workspace-nav'));
    return s(doc.documentElement).backgroundColor==='rgba(0, 0, 0, 0)'
      && s(doc.body).backgroundColor==='rgba(0, 0, 0, 0)'
      && s(doc.documentElement).colorScheme==='light'
      && parseFloat(nav.borderRadius)>=24 && nav.backgroundImage.includes('linear-gradient')
      && nav.backdropFilter.includes('blur')
      && getComputedStyle(document.body,'::before').backgroundImage.includes('radial-gradient');
  })()`),
    "Desktop must share one continuous jelly backdrop with its iframe",
  );

  // Brand replaces LOCAL with a toggle, and a collapsed shell remains restorable.
  await evaluate("document.querySelector('#sidebar-collapse').click()");
  await until("document.querySelector('#workspace-nav').inert");
  await until(
    "document.querySelector('#runtime').contentDocument.body.classList.contains('host-sidebar-collapsed')",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.topbar [data-action=sidebar]').click()",
  );
  await until("!document.querySelector('#workspace-nav').inert");
  await evaluate("document.querySelector('#filter-toggle').click()");
  await until(
    "document.querySelector('#agent-menu [data-view-option=\"groupBy:flat\"]')",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#agent-menu [role=menuitemradio]').length",
    ),
    8,
  );
  await evaluate(
    "document.querySelector('#agent-menu [data-view-option=\"groupBy:flat\"]').click()",
  );
  await until(
    "document.querySelector('#projects .agent') && !document.querySelector('#projects .project-title')",
  );
  await evaluate(
    "document.querySelector('#filter-toggle').click(); document.querySelector('#agent-menu [data-view-option=\"groupBy:workspace\"]').click()",
  );
  await until("document.querySelector('#projects .project-title')");
  {
    const before = await evaluate(
      "document.querySelectorAll('#projects .project').length",
    );
    await evaluate("document.querySelector('#add-project').click()");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      await evaluate("document.querySelectorAll('#projects .project').length"),
      before,
    );
    await evaluate("document.querySelector('#add-project').click()");
    await until(
      `document.querySelectorAll('#projects .project').length===${before + 1}`,
    );
    if (electronMode)
      assert.deepEqual(
        JSON.parse(await readFile(join(f.root, "picker.json"), "utf8"))
          .properties,
        ["openDirectory"],
      );
  }
  assert(
    (
      await evaluate("document.querySelector('#subtitle').textContent")
    ).includes("无项目"),
  );
  assert(
    await evaluate(
      "getComputedStyle(document.querySelector('#home svg path')).fill===getComputedStyle(document.querySelector('#home svg')).color",
    ),
    "The Pi mark must be monochrome, not the website palette",
  );
  assert.equal(
    await evaluate(
      "!!document.querySelector('#tabs') || !!document.querySelector('#configure')",
    ),
    false,
  );
  await evaluate("document.querySelector('#settings').click()");
  await until(
    "document.querySelector('#workspace-nav').inert && document.body.classList.contains('sidebar-collapsed')",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#workspace-nav').getBoundingClientRect().width",
    ),
    0,
  );

  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#page-label').textContent==='Pi 配置'",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('[data-view=appearance]').click()",
  );
  await until(
    "!document.querySelector('#runtime').contentDocument.querySelector('#view-appearance').hidden",
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument; const event=new KeyboardEvent('keydown',{key:'=',code:'Equal',ctrlKey:true,bubbles:true,cancelable:true}); doc.dispatchEvent(event); return event.defaultPrevented;})()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.documentElement.style.getPropertyValue('--ui-font-size')==='15px'",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#web-font-size').value",
    ),
    "15",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.dispatchEvent(new KeyboardEvent('keydown',{key:'-',code:'Minus',ctrlKey:true,bubbles:true,cancelable:true}))",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.documentElement.style.getPropertyValue('--ui-font-size')==='14px'",
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument; const select=doc.querySelector('#web-font-size'); select.value='22'; select.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.documentElement.style.getPropertyValue('--ui-font-size')==='22px'",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.dispatchEvent(new KeyboardEvent('keydown',{key:'=',code:'Equal',ctrlKey:true,bubbles:true,cancelable:true}))",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.documentElement.style.getPropertyValue('--ui-font-size')==='23px'",
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument; const select=doc.querySelector('#web-font-size'); select.value='24'; select.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.documentElement.style.getPropertyValue('--ui-font-size')==='24px'",
  );
  await evaluate(
    "(() => {const node=document.querySelector('#runtime').contentDocument.querySelector('#web-theme'); node.value='light'; node.dispatchEvent(new Event('change', {bubbles:true}));})()",
  );
  await until(
    "document.documentElement.dataset.theme==='light' && !document.querySelector('#runtime').contentDocument.body.classList.contains('dark')",
  );
  await evaluate(
    "(() => {const node=document.querySelector('#runtime').contentDocument.querySelector('#web-theme'); node.value='dark'; node.dispatchEvent(new Event('change', {bubbles:true}));})()",
  );
  await until(
    "document.documentElement.dataset.theme==='dark' && document.querySelector('#runtime').contentDocument.body.classList.contains('dark') && getComputedStyle(document.querySelector('#runtime').contentDocument.documentElement).colorScheme==='dark'",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.settings-back').click()",
  );
  await until("!document.body.classList.contains('sidebar-collapsed')");
  await evaluate("document.querySelector('#conversations .agent').click()");
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#page-label').textContent==='会话'",
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument; doc.querySelector('#prompt').value='projectless UI hello'; doc.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true})); doc.querySelector('#composer').requestSubmit();})()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#messages').innerText.includes('answer: projectless UI hello')",
  );
  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.body.classList.contains('projectless') && document.querySelector('#runtime').contentDocument.body.classList.contains('right-collapsed')",
    ),
  );
  const homeShot = await call("Page.captureScreenshot", { format: "png" });
  await (
    await import("node:fs/promises")
  ).writeFile(
    "/tmp/pi-desktop-projectless.png",
    Buffer.from(homeShot.data, "base64"),
  );
  const beforeNewChat = await evaluate(
    "document.querySelector('#runtime').dataset.owner",
  );
  await evaluate("document.querySelector('#new-chat').click()");
  await until("document.querySelectorAll('#conversations .agent').length===2");
  await until(
    `document.querySelector('#runtime')?.dataset.owner!==${JSON.stringify(beforeNewChat)} && !!document.querySelector('#runtime')?.contentDocument?.querySelector('#prompt') && document.querySelector('#runtime')?.contentDocument?.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
    { timeoutMs: 15000 },
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#prompt').value",
    ),
    "",
  );
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  assert(
    await evaluate(`(() => {
      const body=getComputedStyle(document.body), nav=getComputedStyle(document.querySelector('#workspace-nav'));
      return body.transitionProperty.includes('grid-template-columns') && nav.transitionProperty.includes('transform');
    })()`),
    "Shell layout changes must animate instead of jumping: " +
      JSON.stringify(
        await evaluate(
          "({b:getComputedStyle(document.body).transitionProperty,n:getComputedStyle(document.querySelector('#workspace-nav')).transitionProperty,match:matchMedia('(prefers-reduced-motion: no-preference)').matches})",
        ),
      ),
  );
  await evaluate(`(() => {
    window.bootSeen=false; window.emptySeen=false;
    new MutationObserver(()=>{
      const boot=document.querySelector('#agent-boot');
      if(boot&&!boot.hidden)window.bootSeen=true;
      const empty=document.querySelector('#empty');
      if(empty&&!empty.hidden)window.emptySeen=true;
    }).observe(document.body,{subtree:true,attributes:true,attributeFilter:['hidden']});
  })()`);
  await create("UI Agent A");
  assert(
    await evaluate(
      "window.emptySeen===false && !!document.querySelector('#agent-boot') && document.querySelector('#agent-boot').hidden",
    ),
    "Switching or creating Agents must never flash the project hero",
  );
  await until(
    "!!document.querySelector('#runtime').contentDocument.querySelector('#desktop-composer-context') && !document.querySelector('#runtime').contentDocument.querySelector('#desktop-composer-context').hidden",
  );
  assert(
    await evaluate(`(() => {
      const doc=document.querySelector('#runtime').contentDocument, win=doc.defaultView;
      const pills=[...doc.querySelectorAll('#desktop-composer-context .context-selector, #composer-permission')];
      const select=win.getComputedStyle(doc.querySelector('#composer-project'));
      return pills.length>=3 && pills.every(pill=>{const s=win.getComputedStyle(pill);return s.borderRadius==='999px'&&s.backgroundColor.startsWith('rgba(')&&parseFloat(s.borderTopWidth)>0;})
        && select.backgroundColor==='rgba(0, 0, 0, 0)' && parseFloat(select.paddingLeft)===0;
    })()`),
    "Composer context selects must be designed glass pills, not unstyled native controls",
  );
  assert(
    await evaluate(`(() => {
      const doc=document.querySelector('#runtime').contentDocument, win=doc.defaultView;
      const shell=doc.querySelector('#composer-permission');
      const trigger=shell?.querySelector('.context-trigger');
      if(!trigger) return false;
      shell.querySelector('[data-dsh-icon]').click();
      const menu=shell.querySelector('.context-menu');
      const rows=menu?[...menu.querySelectorAll('.context-option')]:[];
      const result=!!menu&&!menu.hidden&&parseFloat(win.getComputedStyle(menu).borderRadius)>=12
        && rows.map(row=>row.textContent).includes('高风险请求确认');
      doc.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      return result;
    })()`),
    "The permission select must use the same themed, whole-pill listbox",
  );
  await evaluate(
    "(() => { const doc=document.querySelector('#runtime').contentDocument; doc.querySelector('#analysis-control').click(); })()",
  );
  assert(
    await evaluate(
      "!document.querySelector('#runtime').contentDocument.querySelector('#composer-model-popover').hidden",
    ),
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#dialog').open",
    ),
    false,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('.model-trigger-label').textContent",
    ),
    "local",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#composer-model-popover button').click()",
  );
  await until(
    "!!document.querySelector('#runtime').contentDocument.querySelector('#composer-model-popover input')",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#composer-model-popover').innerText.includes('Second model')",
  );
  await evaluate(
    "(()=>{const doc=document.querySelector('#runtime').contentDocument;const input=doc.querySelector('#composer-model-popover input');input.value='no such model';input.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#composer-model-popover').innerText.includes('没有匹配')",
    ),
  );
  await evaluate(
    "(()=>{const doc=document.querySelector('#runtime').contentDocument;const input=doc.querySelector('#composer-model-popover input');input.value='Second model';input.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.model-menu-options button').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#composer-model-popover').hidden",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('.model-trigger-label').textContent==='Second model'",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#analysis-control').click()",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelectorAll('#composer-model-popover button')[1].click()",
  );
  await until(
    "!!document.querySelector('#runtime').contentDocument.querySelector('.model-menu-options button')",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.model-menu-options button').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#composer-model-popover').hidden",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#analysis-control').click()",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#composer-model-popover button').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#composer-model-popover').getAnimations().every(animation=>animation.playState==='finished')",
  );
  const modelShot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/tmp/pi-desktop-model-picker.png",
    Buffer.from(modelShot.data, "base64"),
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#analysis-control').click()",
  );

  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#analysis-control').click()",
  );
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('#runtime').contentDocument.querySelector('#composer-model-popover')).animationName",
    ),
    "none",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#analysis-control').click()",
  );
  await call("Emulation.setEmulatedMedia", { features: [] });
  await evaluate(
    "(() => { const node=document.querySelector('#runtime').contentDocument.querySelector('#composer-approval'); node.value='ask-all'; node.dispatchEvent(new Event('change', {bubbles:true})); })()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#composer-approval').value==='ask-all'",
  );
  await evaluate(
    "(() => { const node=document.querySelector('#runtime').contentDocument.querySelector('#composer-system-prompt'); node.value='__new__'; node.dispatchEvent(new Event('change', {bubbles:true})); })()",
  );
  await until("document.querySelector('#editor').open");
  await evaluate(
    "(() => { const form=document.querySelector('#editor-form'); form.elements.name.value='UI review'; form.elements.instructions.value='UI_SELECTED_SYSTEM_PROMPT'; form.requestSubmit(); })()",
  );
  await until("!document.querySelector('#editor').open");
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#composer-system-prompt').selectedOptions[0].textContent==='UI review'",
  );
  // The whole pill, not only its text, opens a themed menu.
  await evaluate(`(() => {
    const doc=document.querySelector('#runtime').contentDocument;
    doc.querySelector('#composer-system-prompt').closest('.context-selector').querySelector('[data-dsh-icon]').click();
  })()`);
  await until(
    "(() => {const doc=document.querySelector('#runtime').contentDocument;const m=doc.querySelector('#composer-system-prompt').closest('.context-selector').querySelector('.context-menu');return m&&!m.hidden;})()",
  );
  assert(
    await evaluate(`(() => {
      const doc=document.querySelector('#runtime').contentDocument;
      const m=doc.querySelector('#composer-system-prompt').closest('.context-selector').querySelector('.context-menu');
      const s=doc.defaultView.getComputedStyle(m);
      return parseFloat(s.borderRadius)>=12 && s.backgroundColor.startsWith('rgba(')
        && [...m.querySelectorAll('.context-option')].some(row=>row.textContent==='标准模式');
    })()`),
    "The composer dropdown must be a themed listbox",
  );
  await evaluate(`(() => {
    const doc=document.querySelector('#runtime').contentDocument;
    const m=doc.querySelector('#composer-system-prompt').closest('.context-selector').querySelector('.context-menu');
    [...m.querySelectorAll('.context-option')].find(row=>row.textContent==='标准模式').click();
  })()`);
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#composer-system-prompt').value==='standard'",
  );
  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#composer-system-prompt').closest('.context-selector').querySelector('.context-trigger').textContent==='标准模式'",
    ),
    "The trigger label must follow the chosen option",
  );

  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#composer').getBoundingClientRect().height<145",
    ),
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument;const toggle=doc.querySelector('[data-action=workspace-tools]');if(toggle.getAttribute('aria-expanded')==='false')toggle.click(); doc.querySelector('.panel-shortcut[aria-label=文件]').click();})()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('.panel-file-row')?.innerText.includes('prompts')",
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument;[...doc.querySelectorAll('.panel-file-row')].find(row=>row.querySelector('span')?.textContent==='extension.mjs').click();})()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('.panel-file-text')?.textContent.includes('fixture_marker')",
  );
  // The tree is a container-query pane; widen the dock as a reader would.
  await evaluate(
    "document.querySelector('#runtime').contentDocument.documentElement.style.setProperty('--right-width','640px')",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('.panel-file-tree')?.getBoundingClientRect().width>150",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelectorAll('.panel-file-tree-row').length>0",
  );
  assert(
    await evaluate(`(() => {
      const doc=document.querySelector('#runtime').contentDocument;
      const tree=doc.querySelector('.panel-file-tree').getBoundingClientRect();
      const body=doc.querySelector('.panel-file-body').getBoundingClientRect();
      return tree.width>=150 && body.width>=240 && body.right<=tree.left+1;
    })()`),
    "The file viewer must dock a project tree beside the document",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.panel-file-tree-row[data-tree-path=prompts]').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('.panel-file-tree-row[data-tree-path=\"prompts/fixture-template.md\"]')",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.panel-file-tree-row[data-tree-path=\"prompts/fixture-template.md\"]').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('.panel-tab [aria-selected=true]')?.textContent==='fixture-template.md'",
  );
  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('.panel-file-text').textContent.includes('Template fixture')",
    ),
  );
  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('.panel-file-tree-row[aria-selected=true]')?.dataset.treePath==='prompts/fixture-template.md'",
    ),
    "Opening a tree file must select it in the tree",
  );
  {
    const treeShot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(
      "/tmp/pi-desktop-file-tree.png",
      Buffer.from(treeShot.data, "base64"),
    );
  }
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#panel-new-tab').click()",
  );
  await evaluate(
    `(() => {const doc=document.querySelector('#runtime').contentDocument;doc.querySelector('#panel-address-input').value=${JSON.stringify(pageUrl)};doc.querySelector('.panel-address').requestSubmit();})()`,
  );
  await until(
    "(() => {const d=document.querySelector('#runtime').contentDocument,c=d.querySelector('#agent-browser-canvas'),r=d.querySelector('.panel-browser-resolution');return c?.width===Math.max(320,Math.min(1600,Math.round(d.querySelector('#panel-web-viewport').getBoundingClientRect().width)))*2&&r.textContent===`${c.width} × ${c.height}`;})()",
    { timeoutMs: 15000 },
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#panel-address-input').value.endsWith('/first')",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.panel-address [aria-label=刷新网页]').click()",
  );
  await until(
    "(() => {const d=document.querySelector('#runtime').contentDocument;return d.querySelector('#agent-browser-canvas')?.width===Math.max(320,Math.min(1600,Math.round(d.querySelector('#panel-web-viewport').getBoundingClientRect().width))*2);})()",
    { timeoutMs: 15000 },
  );
  assert(
    await evaluate(
      "!document.querySelector('#runtime').contentDocument.querySelector('#workspace-right').inert",
    ),
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await until(
    "(() => {const d=document.querySelector('#runtime').contentDocument; return d.querySelector('#agent-browser-canvas').width===Math.max(320,Math.min(1600,Math.round(d.querySelector('#panel-web-viewport').getBoundingClientRect().width))*2);})()",
    { timeoutMs: 15000 },
  );
  await evaluate(
    "(() => {const canvas=document.querySelector('#runtime').contentDocument.querySelector('#agent-browser-canvas');const b=canvas.getBoundingClientRect(); const x=b.x+25*b.width/canvas.width,y=b.y+110*b.height/canvas.height;for(const type of ['pointerdown','pointerup'])canvas.dispatchEvent(new PointerEvent(type,{clientX:x,clientY:y,button:0,pointerId:1}));})()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#panel-address-input').value.endsWith('/second')",
    { timeoutMs: 15000 },
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.panel-address [aria-label=后退]').click()",
  );
  await new Promise((r) => setTimeout(r, 500));
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#panel-address-input').value.endsWith('/first')",
  );
  {
    const runtimeUrl = await evaluate(
      "document.querySelector('#runtime').contentDocument.location.pathname",
    );
    await evaluate(`(() => {
      const doc=document.querySelector('#runtime').contentDocument;
      const a=doc.createElement('a');
      a.href=${JSON.stringify(pageUrl.replace(/\/first$/, "/second"))};
      a.textContent='chat link';
      doc.querySelector('#messages').append(a);
      a.click();
    })()`);
    await until(
      "document.querySelector('#runtime').contentDocument.querySelector('#panel-address-input').value.endsWith('/second')",
      { timeoutMs: 15000 },
    );
    assert.equal(
      await evaluate(
        "document.querySelector('#runtime').contentDocument.location.pathname",
      ),
      runtimeUrl,
      "A chat link must open the workspace browser instead of navigating the chat",
    );
  }
  await evaluate("document.querySelector('#settings').click()");
  await until("document.querySelector('#workspace-nav').inert");
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.settings-back').click()",
  );
  await until("!document.querySelector('#workspace-nav').inert");
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#panel-new-tab').click()",
  );
  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#workspace-right').dataset.panelKind==='home'",
    ),
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#prompt').value='draft A'",
  );
  const first = await evaluate("document.querySelector('#runtime').src");
  await create("UI Agent B");
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#prompt').value",
    ),
    "",
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument; if(doc.body.classList.contains('settings-open')) doc.querySelector('.settings-back').click();})()",
  );
  await until("!document.body.classList.contains('sidebar-collapsed')");
  await evaluate(
    "[...document.querySelectorAll('#projects .agent')].find(row => row.querySelector('span').textContent==='UI Agent A').click()",
  );
  await until(
    `document.querySelector('#runtime')?.src===${JSON.stringify(first)}`,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#prompt').value",
    ),
    "draft A",
  );
  await evaluate("document.querySelector('#settings').click()");
  await until(
    "document.querySelector('#workspace-nav').inert && document.body.classList.contains('sidebar-collapsed')",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#workspace-nav').getBoundingClientRect().width",
    ),
    0,
  );

  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#page-label').textContent==='Pi 配置'",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.settings-nav [data-view=plugins]').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#page-label').textContent==='已安装插件'",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.settings-nav [data-view=skills]').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.body.innerText.includes('fixture-skill')",
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument; if(doc.body.classList.contains('settings-open')) doc.querySelector('.settings-back').click();})()",
  );
  await until("!document.body.classList.contains('sidebar-collapsed')");
  await evaluate(
    "[...document.querySelectorAll('#projects .agent')].find(row => row.querySelector('span').textContent==='UI Agent A').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#page-label').textContent==='会话'",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#prompt').value",
    ),
    "draft A",
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument; doc.querySelector('#prompt').value='UI hello'; doc.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true})); doc.querySelector('#composer').requestSubmit();})()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#messages').innerText.includes('answer: UI hello')",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#cache-hit').textContent==='缓存 75.0%'",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#context-detail').textContent",
    ),
    "1.2k / 8.2k",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#token-total').click()",
  );
  await until(
    "!document.querySelector('#runtime').contentDocument.querySelector('#usage-details').hidden",
  );
  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#usage-breakdown').innerText.includes('900')",
    ),
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#usage-close').click()",
  );
  const agentA = await evaluate(
    "[...document.querySelectorAll('#projects .agent')].find(row=>row.querySelector('span').textContent==='UI Agent A').dataset.agentId",
  );
  const agentB = await evaluate(
    "[...document.querySelectorAll('#projects .agent')].find(row=>row.querySelector('span').textContent==='UI Agent B').dataset.agentId",
  );
  async function menu(command, selector = `[data-agent-id="${agentA}"]`) {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:220}))`,
    );
    await until("!document.querySelector('#agent-menu').hidden");
    await until(
      `!document.querySelector('#agent-menu [data-command="${command}"]').disabled`,
    );
    await evaluate(
      `document.querySelector('#agent-menu [data-command="${command}"]').click()`,
    );
  }
  // Operate on B without changing the selected A or its draft/transcript.
  const current = await evaluate(
    "document.querySelector('#runtime').dataset.owner",
  );
  await menu("agent.stop", `[data-agent-id="${agentB}"]`);
  await until(
    `document.querySelector('[data-agent-id="${agentB}"] small').textContent==='已停止'`,
  );
  assert.equal(
    await evaluate("document.querySelector('#runtime').dataset.owner"),
    current,
  );
  await menu("agent.restart");
  await until(
    "document.querySelector('#runtime')?.contentDocument?.querySelector('#messages')?.innerText.includes('answer: UI hello')",
    { timeoutMs: 15000 },
  );
  await menu("agent.stop");
  await until(
    "document.querySelector('#runtime')?.contentDocument?.querySelector('#native-history-toolbar')?.hidden===false && document.querySelector('#runtime')?.contentDocument?.querySelector('#composer')?.hidden===true",
  );
  await evaluate("document.querySelector('#settings').click()");
  await until(
    "document.querySelector('#workspace-nav').inert && document.body.classList.contains('sidebar-collapsed')",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#workspace-nav').getBoundingClientRect().width",
    ),
    0,
  );

  await until("!document.querySelector('#offline-settings').hidden");
  await evaluate("document.querySelector('#settings-start').click()");
  await until(
    "document.querySelector('#runtime')?.contentDocument?.querySelector('#connection-status')?.textContent==='Pi 已连接'",
    { timeoutMs: 15000 },
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.settings-nav [data-view=personality]').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#personality-file').innerText.endsWith('/AGENTS.md')",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('[data-view=injections]')",
    ),
    null,
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument; doc.querySelector('#personality-content').value='UI_GLOBAL_PERSONA'; doc.querySelector('#personality-form').requestSubmit();})()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#personality-status').innerText.includes('已保存')",
  );
  assert.equal(
    await readFile(join(f.agentDir, "AGENTS.md"), "utf8"),
    "UI_GLOBAL_PERSONA",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.settings-nav [data-view=remote]').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#network-status').textContent==='需要登录 Tailscale'",
  );
  if (!electronMode) assert.equal(prepared, 1);
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.settings-nav [data-view=personality]').click()",
  );
  const personaShot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/tmp/pi-desktop-personality.png",
    Buffer.from(personaShot.data, "base64"),
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.settings-nav [data-view=plugins]').click()",
  );
  await until(
    "!document.querySelector('#runtime').contentDocument.querySelector('.desktop-update-all').hidden",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('.desktop-update-all').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#dialog').open && document.querySelector('#runtime').contentDocument.querySelector('#dialog-body').textContent.includes('pi update --extensions')",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('#dialog').close()",
  );

  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument; if(doc.body.classList.contains('settings-open')) doc.querySelector('.settings-back').click();})()",
  );
  await until("!document.body.classList.contains('sidebar-collapsed')");
  await evaluate(
    "[...document.querySelectorAll('#projects .agent')].find(row => row.querySelector('span').textContent==='UI Agent A').click()",
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#page-label').textContent==='会话'",
  );

  // Transfer a local file index without moving history. The plain-browser
  // fixture supplies the path bridge that real Electron provides in preload.
  const contextPath = join(f.cwd, "context.md");
  await writeFile(contextPath, "fixture context");
  await evaluate(
    `(() => { const doc=document.querySelector('#runtime').contentDocument; ${electronMode ? "" : `doc.defaultView.piDesk = {filePath: () => ${JSON.stringify(contextPath)}};`} doc.querySelector('#prompt').value='cross-project draft'; doc.querySelector('#prompt').dispatchEvent(new Event('input',{bubbles:true})); const data=new DataTransfer(); data.items.add(new File(['fixture context'], 'context.md', {type:'text/plain'})); doc.querySelector('#context-files').files=data.files; doc.querySelector('#context-files').dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
  await until(
    "document.querySelector('#runtime').contentDocument.querySelector('#context-attachments').innerText.includes('本地引用')",
  );
  const sourceOwner = await evaluate(
    "document.querySelector('#runtime').dataset.owner",
  );
  await evaluate(
    "(() => { const node=document.querySelector('#runtime').contentDocument.querySelector('#composer-project'); node.value=''; node.dispatchEvent(new Event('change',{bubbles:true})); })()",
  );
  await until(
    `document.querySelector('#runtime')?.dataset.owner!==${JSON.stringify(sourceOwner)} && document.querySelector('#runtime')?.contentDocument?.querySelector('#prompt')?.value==='cross-project draft'`,
    { timeoutMs: 15000 },
  );
  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#context-attachments').innerText.includes('context.md')",
    ),
  );
  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.body.classList.contains('projectless')",
    ),
  );
  await evaluate(
    `document.querySelector('[data-agent-id="${sourceOwner}"]').click()`,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#prompt').value",
    ),
    "cross-project draft",
  );
  assert(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#context-attachments').innerText.includes('context.md')",
    ),
  );
  if (!electronMode) {
    const selectedBefore = await evaluate(
      "document.querySelector('#runtime').src",
    );
    const manager = sdk.SessionManager.create(
      f.other,
      await nativeSessionDirectory(f.other, f.agentDir),
    );
    manager.appendSessionInfo("Browser TUI history");
    manager.appendModelChange("desktop-fixture", "local");
    manager.appendThinkingLevelChange("high");
    for (let n = 0; n < 310; n++)
      manager.appendMessage({
        role: "user",
        content: `Native history message ${n}`,
        timestamp: Date.now(),
      });
    manager.appendMessage({
      role: "assistant",
      api: "openai-completions",
      provider: "desktop-fixture",
      model: "local",
      content: [
        {
          type: "thinking",
          thinking: "Thinking prefix. ".repeat(100) + "THINKING_DETAIL_END",
        },
        {
          type: "toolCall",
          id: "lazy-tool",
          name: "fixture_marker",
          arguments: { note: "arguments ".repeat(100) + "ARGUMENT_DETAIL_END" },
        },
      ],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "lazy-tool",
      toolName: "fixture_marker",
      content: [
        {
          type: "text",
          text: "Output prefix. ".repeat(100) + "TOOL_DETAIL_END",
        },
      ],
      isError: false,
      timestamp: Date.now(),
    });
    await until(
      "Array.from(document.querySelectorAll('.agent')).some(row=>row.textContent.includes('Browser TUI history'))",
      { timeoutMs: 15000 },
    );
    await evaluate(
      "Array.from(document.querySelectorAll('.agent')).find(row=>row.textContent.includes('Browser TUI history')).click()",
    );
    await until(
      "document.querySelector('#runtime')?.contentDocument?.querySelector('#native-history-toolbar')?.hidden===false",
    );
    assert(
      await evaluate(
        "document.querySelector('#runtime').contentDocument.querySelector('#composer').hidden",
      ),
    );
    assert(
      await evaluate(
        "document.querySelector('#runtime').contentDocument.querySelector('#prompt').disabled",
      ),
    );
    assert(
      await evaluate(
        "document.querySelector('#runtime').contentDocument.querySelector('#messages').textContent.includes('Native history message 309')",
      ),
    );
    assert(
      await evaluate(
        "!document.querySelector('#runtime').contentDocument.querySelector('#native-history-older').hidden",
      ),
    );
    assert(
      await evaluate(
        "!document.querySelector('#runtime').contentDocument.querySelector('#messages').innerText.includes('TOOL_DETAIL_END')",
      ),
    );
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('.tool-card summary').click()",
    );
    await until(
      "document.querySelector('#runtime').contentDocument.querySelector('.tool-details').textContent.includes('TOOL_DETAIL_END')",
    );
    assert(
      await evaluate(
        "document.querySelector('#runtime').contentDocument.querySelector('.tool-details').textContent.includes('ARGUMENT_DETAIL_END')",
      ),
    );
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('.thinking-output summary').click()",
    );
    await until(
      "document.querySelector('#runtime').contentDocument.querySelector('.thinking-output').innerText.includes('THINKING_DETAIL_END')",
    );
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#native-history-older').click()",
    );
    await until(
      "document.querySelector('#runtime').contentDocument.querySelector('#messages').textContent.includes('Native history message 0')",
    );
    await evaluate(
      "Array.from(document.querySelectorAll('.agent')).find(row=>row.textContent.includes('Browser TUI history')).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:400}))",
    );
    assert(
      await evaluate(
        "!!document.querySelector('#agent-menu [data-command=\"agent.resume\"]') && !document.querySelector('#agent-menu [data-command=\"agent.stop\"]')",
      ),
    );
    await evaluate(
      "document.querySelector('#agent-menu').hidden=true;document.querySelector('#runtime').contentDocument.querySelector('#native-history-resume').click()",
    );
    await until(
      "document.querySelector('#runtime')?.contentDocument?.querySelector('#composer')?.hidden===false && document.querySelector('#runtime')?.contentDocument?.querySelector('#prompt')?.disabled===false",
      { timeoutMs: 15000 },
    );
    await evaluate(
      "Array.from(document.querySelectorAll('.agent')).find(row=>row.textContent.includes('Browser TUI history')).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:400}))",
    );
    assert(
      await evaluate(
        "document.querySelector('#agent-menu [data-command=\"agent.archive\"]').disabled",
      ),
    );
    await evaluate(
      "document.querySelector('#agent-menu [data-command=\"agent.stop\"]').click()",
    );
    await until(
      "Array.from(document.querySelectorAll('.agent')).find(row=>row.textContent.includes('Browser TUI history'))?.querySelector('small')?.textContent==='已停止'",
    );
    await evaluate(
      "Array.from(document.querySelectorAll('.agent')).find(row=>row.textContent.includes('Browser TUI history')).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:400}));Array.from(document.querySelector('#agent-menu').children).find(button=>button.textContent==='归档会话').click()",
    );
    await until(
      "!Array.from(document.querySelectorAll('.agent')).some(row=>row.textContent.includes('Browser TUI history'))",
    );
    await evaluate(
      "document.querySelector('#filter-toggle').click();document.querySelector('#agent-menu [data-view-option=\"archived:only\"]').click()",
    );
    await until(
      "Array.from(document.querySelectorAll('.agent')).some(row=>row.textContent.includes('Browser TUI history'))",
    );
    await evaluate(
      "Array.from(document.querySelectorAll('.agent')).find(row=>row.textContent.includes('Browser TUI history')).click()",
    );
    await until(
      "document.querySelector('#runtime')?.contentDocument?.querySelector('#native-history-label')?.textContent==='已归档 · SQLite 记录'",
    );
    assert(
      await evaluate(
        "document.querySelector('#runtime').contentDocument.querySelector('#native-history-resume').hidden",
      ),
    );
    await evaluate(
      "Array.from(document.querySelectorAll('.agent')).find(row=>row.textContent.includes('Browser TUI history')).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:400}));document.querySelector('#agent-menu [data-command=\"agent.restore\"]').click()",
    );
    await until(
      "!Array.from(document.querySelectorAll('.agent')).some(row=>row.textContent.includes('Browser TUI history'))",
    );
    await evaluate(
      "document.querySelector('#filter-toggle').click();document.querySelector('#agent-menu [data-view-option=\"archived:hide\"]').click()",
    );
    const former = new URL(selectedBefore).pathname.split("/")[2];
    await evaluate(
      `document.querySelector('.agent[data-agent-id="${former}"]').click()`,
    );
    await until(
      "document.querySelector('#runtime')?.contentDocument?.querySelector('#composer')?.hidden===false",
    );
  }
  // Extension detail pages are a workspace surface, not a settings route.
  const navigationWasCollapsed = await evaluate(
    "document.body.classList.contains('sidebar-collapsed')",
  );
  await evaluate("document.querySelector('#extensions-entry').click()");
  await until(
    "document.querySelector('#runtime')?.contentDocument?.querySelector('#view-extensions')?.hidden===false",
  );
  assert.equal(
    await evaluate("document.body.classList.contains('sidebar-collapsed')"),
    navigationWasCollapsed,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#extensions-entry').getAttribute('aria-pressed')",
    ),
    "true",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#settings').getAttribute('aria-pressed')",
    ),
    "false",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('[data-workspace-view=extensions]').getAttribute('aria-pressed')",
    ),
    "true",
  );
  await evaluate(
    "document.querySelector('#runtime').contentDocument.querySelector('[data-workspace-view=workspace]').click()",
  );
  await until(
    "document.querySelector('#runtime')?.contentDocument?.querySelector('#view-workspace')?.hidden===false && document.querySelector('#extensions-entry').getAttribute('aria-pressed')==='false'",
  );
  assert.deepEqual(driver.errors, []);
  assert.equal(
    await evaluate("document.querySelector('#agent-menu').hidden"),
    true,
  );
  await evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(
    join(f.root, "workspace.png"),
    Buffer.from(screenshot.data, "base64"),
  );
  const { copyFile } = await import("node:fs/promises");
  await copyFile(
    join(f.root, "workspace.png"),
    "/tmp/pi-desktop-workspace.png",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 951,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // CDP resizing returns before the iframe's resize handler updates its button.
  // Wait for the actual layout and accessibility state before toggling a pane.
  await until(
    "innerWidth===951 && (()=>{const frame=document.querySelector('#runtime'),doc=frame.contentDocument;const pane=doc.querySelector('#workspace-right');return Math.abs(doc.defaultView.innerWidth-frame.getBoundingClientRect().width)<1 && doc.querySelector('[data-action=workspace-tools]').getAttribute('aria-expanded')===String(pane.getBoundingClientRect().width>0);})()",
  );
  await evaluate(
    "(() => {const doc=document.querySelector('#runtime').contentDocument;const toggle=doc.querySelector('[data-action=workspace-tools]');if(toggle.getAttribute('aria-expanded')==='false')toggle.click();})()",
  );
  try {
    await until(
      "(() => {const doc=document.querySelector('#runtime').contentDocument;const chat=doc.querySelector('.conversation').getBoundingClientRect();const panel=doc.querySelector('#workspace-right').getBoundingClientRect();return chat.width>=320 && panel.width>=240 && chat.right<=panel.left+1;})()",
    );
  } catch (error) {
    console.log(
      await evaluate(
        "(()=>{const frame=document.querySelector('#runtime'),doc=frame.contentDocument;return {frame:frame.getBoundingClientRect().toJSON(),chat:doc.querySelector('.conversation').getBoundingClientRect().toJSON(),panel:doc.querySelector('#workspace-right').getBoundingClientRect().toJSON(),innerWidth:doc.defaultView.innerWidth,classes:doc.body.className,right:getComputedStyle(doc.querySelector('#workspace-right')).cssText};})()",
      ),
    );
    throw error;
  }

  for (const width of [320, 360, 390]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await until("document.querySelector('#workspace-nav').inert");
    assert(
      await evaluate("document.documentElement.scrollWidth <= innerWidth + 1"),
    );
    assert(
      await evaluate(
        "document.querySelector('#runtime').getBoundingClientRect().width <= innerWidth + 1",
      ),
    );
    assert(
      await evaluate(
        "(() => {const frame=document.querySelector('#runtime');return frame.contentDocument.documentElement.scrollWidth<=frame.clientWidth+1;})()",
      ),
    );
    await evaluate("document.querySelector('#navigation-toggle').click()");
    assert(await evaluate("!document.querySelector('#workspace-nav').inert"));
    await evaluate(
      "[...document.querySelectorAll('#projects .agent')].find(row => row.querySelector('span').textContent==='UI Agent A').click()",
    );
    assert(
      await evaluate("!document.body.classList.contains('navigation-open')"),
    );
  }
  if (electronMode) {
    // Close the window while the shared Chromium session is still live.
    await call("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      "document.querySelector('#runtime').contentDocument.querySelector('#panel-new-tab').click()",
    );
    await evaluate(
      `(() => {const doc=document.querySelector('#runtime').contentDocument;doc.querySelector('#panel-address-input').value=${JSON.stringify(pageUrl)};doc.querySelector('.panel-address').requestSubmit();})()`,
    );
    await until(
      "document.querySelector('#runtime').contentDocument.querySelector('.panel-tab [aria-selected=true]')?.textContent==='Native browser fixture'",
      { timeoutMs: 15000 },
    );
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    const origin = await evaluate("location.origin");
    await evaluate("window.close()");
    for (let index = 0; index < 100; index++) {
      try {
        await fetch(origin + "/api/workspace");
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        break;
      }
    }
    await assert.rejects(fetch(origin + "/api/workspace"));
    const exitCode = await Promise.race([
      exited,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "Electron did not exit after closing native browser tabs",
              ),
            ),
          8000,
        ),
      ),
    ]);
    assert.equal(exitCode, 0);
  }
  console.log(
    `Desktop ${electronMode ? "Electron" : "browser"} acceptance passed: projects, separate workers, embedded chat, skills/plugins, drafts, stop/resume and host shutdown.`,
  );
} catch (error) {
  console.error(log.slice(-5000));
  throw error;
} finally {
  driver?.close();
  if (browser && browser.exitCode === null) {
    const done = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill();
    await done;
  }
  pages.closeAllConnections();
  await new Promise((resolve) => pages.close(resolve));
  await f.close();
}
