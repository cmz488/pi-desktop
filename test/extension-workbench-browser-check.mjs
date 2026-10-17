import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicAssets, assetFile } from "../src/server/asset-manifest.mjs";
import { projectMessage } from "../src/shared/conversation.mjs";
import { chatSnapshot } from "../src/shared/lazy-data.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";
import { measureSurfaceContrast } from "./surface-contrast.mjs";

// Real markup, styles and controller, isolated from user data and agent execution.
const source = await readFile(
  new URL("../src/ui/chat/index.html", import.meta.url),
  "utf8",
);
const html = source.replace(
  '<script type="module" src="prototype.js"></script>',
  `<script type="module">
import {createExtensionWorkbench} from '/extension-workbench.js';
import {createExtensionAdapterRegistry} from '/extension-adapters.mjs';
import DOMPurify from '/vendor/purify.mjs';
const root=document.querySelector('#view-extensions');
root.hidden=false;document.querySelector('#view-workspace').hidden=true;
document.body.classList.add('desktop-embedded');
let rows=[],owner='A',details=new Map(),gate,failNext=false;
const registry=createExtensionAdapterRegistry();
const loaded=[],errors=[];
const controller=createExtensionWorkbench({root,registry,sanitize:html=>DOMPurify.sanitize(html),onCount:count=>root.dataset.count=count,onError:error=>errors.push(error),
async loadDetails(ids){const session=owner;loaded.push(...ids);if(failNext){failNext=false;throw new Error('fixture detail failed');}if(gate)await gate;
if(session!==owner)return;rows=rows.map(row=>ids.includes(String(row.id))?details.get(String(row.id))??row:row);controller.update(rows,{sessionId:owner});}});
window.workbenchFixture={
render(next,session='A',full=[]){rows=next;owner=session;details=new Map(full);registry.setSession(session);controller.update(rows,{sessionId:owner});},
delay(){gate=new Promise(resolve=>window.releaseDetail=()=>{gate=undefined;resolve();});},
failNext(){failNext=true;},
get loaded(){return loaded;},get errors(){return errors;},registry};
controller.update([],{sessionId:owner});
</script>`,
);
const assets = publicAssets("chat");
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    const asset = assets.get(path);
    if (path !== "/" && !asset) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader(
      "Content-Type",
      path === "/" ? "text/html; charset=utf-8" : asset[1],
    );
    response.end(path === "/" ? html : await readFile(assetFile(asset[0])));
  } catch (error) {
    response.writeHead(500);
    response.end(error.message);
  }
});
const card = (id, extra = {}) =>
  projectMessage(
    {
      role: "custom",
      customType: "fixture",
      content: "fallback",
      details: {
        piDesktop: {
          version: 1,
          label: "构建",
          title: id,
          body: "<script>window.extensionAttack=true</script>",
          detailsLabel: "查看条目",
          items: Array.from({ length: 32 }, (_, i) => ({
            label: `步骤 ${i}`,
            status: i < 4 ? "完成" : "待办",
          })),
          ...extra,
        },
      },
    },
    id,
  );
const state = { mode: "state", key: "fixture/build" };
const first = card("First", { presentation: state });
const next = card("Next", { presentation: state });
const ordinary = card("Record");
const root = await mkdtemp(join(tmpdir(), "pi-extension-pages-"));
let browser, driver;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = join(root, "browser");
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
    { stdio: "ignore" },
  );
  driver = await browserDriver(profile);
  const { call, evaluate, until } = driver;
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", {
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  await until("!!window.workbenchFixture");
  assert(
    await evaluate(
      "!document.querySelector('.extension-workbench-empty').hidden && document.querySelector('.extension-workbench-layout').hidden",
    ),
  );
  await evaluate(
    `workbenchFixture.render(${JSON.stringify([first, ordinary])})`,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.extension-page-choice').length",
    ),
    2,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.extension-page-content details[open]').length",
    ),
    1,
  );
  assert.equal(await evaluate("window.extensionAttack"), undefined);
  assert(
    await evaluate(`(() => {
    const list=getComputedStyle(document.querySelector('.extension-page-list'));
    const detail=getComputedStyle(document.querySelector('.extension-page-detail'));
    return list.flexDirection==='row' && parseFloat(detail.borderRadius)>=24
      && detail.backgroundColor.startsWith('rgba(') && detail.boxShadow!=='none';
  })()`),
    "Desktop extension pages must use a floating horizontal shelf and one glass detail surface",
  );
  // Guard the contrast checker itself: raw white RGB would falsely pass this.
  await evaluate(`(() => {
    const probe=document.createElement('div');probe.id='alpha-contrast-probe';
    probe.style.cssText='position:fixed;top:0;left:0;background:#000';
    probe.innerHTML='<span style="background:rgba(255,255,255,.5);color:#767676">Alpha fixture</span>';
    document.body.append(probe);
  })()`);
  assert(
    (
      await evaluate(
        `(${measureSurfaceContrast.toString()})(['#alpha-contrast-probe span'])`,
      )
    )[0].ratio < 1.3,
  );
  await evaluate(
    "document.querySelector('#alpha-contrast-probe span').style.background='linear-gradient(90deg,#000,#fff)'",
  );
  assert.equal(
    (
      await evaluate(
        `(${measureSurfaceContrast.toString()})(['#alpha-contrast-probe span'])`,
      )
    )[0].ratio,
    1,
    "A gradient can fail contrast between otherwise passing endpoints",
  );
  await evaluate("document.querySelector('#alpha-contrast-probe').remove()");
  assert(
    await evaluate(
      "document.querySelector('.extension-page-content').textContent.includes('<script>')",
    ),
  );
  // Selection, native summary keyboard focus, disclosure and scroll survive state updates.
  await evaluate(
    "document.querySelector('.extension-page-choice:last-child').click()",
  );
  await evaluate(
    `workbenchFixture.render(${JSON.stringify([next, ordinary])})`,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.extension-page-choice[aria-current]').querySelector('strong').textContent",
    ),
    "Record",
  );
  await evaluate(
    "document.querySelector('.extension-page-choice:first-child').click();document.querySelector('.extension-page-content summary').focus()",
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: " ",
    code: "Space",
    windowsVirtualKeyCode: 32,
  });
  await until(
    "!document.querySelector('.extension-page-content details').open",
  );
  await evaluate(
    `workbenchFixture.render(${JSON.stringify([first, ordinary])})`,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.extension-page-content details').open",
    ),
    false,
  );
  assert.equal(await evaluate("document.activeElement.tagName"), "SUMMARY");
  await evaluate(
    "document.querySelector('.extension-page-content summary').click();document.querySelector('.extension-page-detail').scrollTop=180",
  );
  await until("document.querySelector('.extension-page-content details').open");
  await evaluate(
    `workbenchFixture.render(${JSON.stringify([next, ordinary])})`,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.extension-page-detail').scrollTop",
    ),
    180,
  );
  // Rehydration uses the existing lazy-message reference and preserves page identity.
  const full = {
    ...card("Hydrated", { presentation: state }),
    role: "toolResult",
    toolCallId: "hydrate-call",
  };
  const lazy = chatSnapshot({ messages: [full] }).messages[0];
  await evaluate(
    `workbenchFixture.render(${JSON.stringify([lazy])},'lazy',${JSON.stringify([[full.id, full]])})`,
  );
  const key = await evaluate(
    "document.querySelector('.extension-page-choice').dataset.extensionKey",
  );
  await evaluate(
    "document.querySelector('.extension-page-content summary').click()",
  );
  await until("!document.querySelector('[data-load-extension]')");
  assert.equal(
    await evaluate(
      "document.querySelector('.extension-page-content details').open",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.extension-page-choice').dataset.extensionKey",
    ),
    key,
  );
  assert.deepEqual(await evaluate("workbenchFixture.loaded"), [
    String(full.id),
  ]);
  // A failed open-fold load stays retryable without a programmatic-toggle retry storm.
  await evaluate(
    `workbenchFixture.render(${JSON.stringify([lazy])},'retry',${JSON.stringify([[full.id, full]])});workbenchFixture.failNext();document.querySelector('.extension-page-content summary').click()`,
  );
  await until(
    "workbenchFixture.errors.length===1 && document.querySelector('[data-load-extension]')?.disabled===false",
  );
  const failedAttempts = await evaluate("workbenchFixture.loaded.length");
  await evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  assert.equal(
    await evaluate("workbenchFixture.loaded.length"),
    failedAttempts,
  );
  await evaluate("document.querySelector('[data-load-extension]').click()");
  await until("!document.querySelector('[data-load-extension]')");
  assert.equal(
    await evaluate(
      "document.querySelector('.extension-page-content details').open",
    ),
    true,
  );
  // Stale detail completion cannot populate another session, even with the same state key.
  await evaluate(
    `workbenchFixture.render(${JSON.stringify([lazy])},'pending',${JSON.stringify([[full.id, full]])});workbenchFixture.delay();document.querySelector('[data-load-extension]').click()`,
  );
  await until("document.querySelector('[data-load-extension]').disabled");
  await evaluate("workbenchFixture.render([],'other');releaseDetail()");
  await until("!document.querySelector('.extension-workbench-empty').hidden");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.extension-page-choice').length",
    ),
    0,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.extension-page-detail').textContent",
    ),
    "",
  );
  // A trusted renderer still crosses a sanitization boundary; errors get a visible fallback.
  await evaluate(
    `window.releaseRenderer=workbenchFixture.registry.register({id:'trusted',version:1,project:()=>({title:'Registered'}),render:()=>'<p>SAFE_RENDERER</p><img src="x" onerror="window.extensionAttack=true"><script>window.extensionAttack=true</script>'});workbenchFixture.render([{id:'registered',role:'custom',extensionView:{adapterId:'trusted',version:1,title:'Registered'}}],'registered')`,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.extension-page-content script, .extension-page-content [onerror]').length",
    ),
    0,
  );
  assert.equal(await evaluate("window.extensionAttack"), undefined);
  await evaluate(
    "releaseRenderer();window.releasePlain=workbenchFixture.registry.register({id:'trusted',version:1,project:()=>({title:'Plain'}),render:()=> 'Plain renderer text'});workbenchFixture.render([{id:'plain',role:'custom',extensionView:{adapterId:'trusted',version:1,title:'Plain'}}],'plain')",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.extension-page-content').textContent",
    ),
    "Plain renderer text",
  );
  await evaluate(
    "releasePlain();workbenchFixture.registry.register({id:'trusted',version:1,project:()=>({title:'Broken'}),render:()=>{throw new Error('fixture renderer failed')}});workbenchFixture.render([{id:'broken',role:'custom',extensionView:{adapterId:'trusted',version:1,title:'Broken'}}],'broken')",
  );
  assert(
    await evaluate(
      "document.querySelector('.extension-page-content').textContent.includes('暂时无法渲染')",
    ),
  );
  // Narrow desktop/mobile, long labels, both themes and reduced motion.
  await evaluate(
    `workbenchFixture.render(${JSON.stringify([card("很长的页面标题".repeat(30), { presentation: state }), ordinary])},'narrow')`,
  );
  await call("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  for (const width of [800, 560, 375]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: width === 375,
    });
    await until(`innerWidth===${width}`);
    assert(
      await evaluate(
        "document.documentElement.scrollWidth<=innerWidth && document.querySelector('.extension-page-detail').getBoundingClientRect().width>250",
      ),
      `workbench overflow at ${width}px`,
    );
    assert.equal(
      await evaluate(
        "getComputedStyle(document.querySelector('.extension-page-list')).flexDirection",
      ),
      "row",
    );
    if (width === 375)
      assert(
        await evaluate(
          "document.querySelector('.extension-page-list').scrollWidth>document.querySelector('.extension-page-list').clientWidth",
        ),
        "overflowing page index must scroll horizontally",
      );
  }
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `document.body.classList.toggle('dark',${theme === "dark"})`,
    );
    assert.equal(
      await evaluate("getComputedStyle(document.body).colorScheme"),
      theme,
    );
    await evaluate(
      "Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished.catch(()=>{})))",
    );
    const contrasts = await evaluate(
      `(${measureSurfaceContrast.toString()})(['.extension-page-choice small','.extension-page-choice strong','.extension-page-choice span','.extension-page-meta','.extension-card header span','.extension-card-title'])`,
    );
    for (const value of contrasts)
      assert(
        value.ratio >= 4.5,
        `${theme} ${value.selector}: contrast ${value.ratio}`,
      );
  }
  assert(
    await evaluate(
      "getComputedStyle(document.querySelector('.workspace-view-switch button')).minHeight==='44px'",
    ),
  );
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  assert(
    await evaluate(`(() => {
    const surface=getComputedStyle(document.querySelector('.extension-page-detail'));
    const composer=getComputedStyle(document.querySelector('#composer'));
    return surface.backgroundColor.startsWith('rgb(') && composer.backdropFilter==='none';
  })()`),
    "Reduced transparency must provide opaque surfaces without backdrop filters",
  );
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.extension-page-choice')).transitionDuration",
    ),
    "0s",
  );
  assert.deepEqual(await evaluate("workbenchFixture.errors"), [
    "fixture detail failed",
  ]);
  assert.deepEqual(driver.errors, []);
  await writeFile(
    "/tmp/pi-desktop-extension-mobile.png",
    Buffer.from(
      (await call("Page.captureScreenshot", { format: "png" })).data,
      "base64",
    ),
  );
  console.log(
    "Extension workbench browser checks passed: safe rendering, state identity, selection, keyboard disclosures, scrolling, lazy hydration, session races, fallback, responsive themes and reduced motion.",
  );
} finally {
  driver?.close();
  if (browser && browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill("SIGTERM");
    await exited;
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
