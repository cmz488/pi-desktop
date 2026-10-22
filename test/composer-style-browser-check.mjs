import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture } from "./desktop-fixture.mjs";
import { browserDriver, pause } from "./durable-browser-driver.mjs";

// 可选的临时前后快照只写调用者指定位置；不以源码选择器或截图像素猜测实际 cascade。
const writeIndex = process.argv.indexOf("--write-baseline");
const compareIndex = process.argv.indexOf("--baseline");
const writePath = writeIndex < 0 ? undefined : process.argv[writeIndex + 1];
const comparePath =
  compareIndex < 0 ? undefined : process.argv[compareIndex + 1];
if (writeIndex >= 0) assert(writePath, "缺少基线输出路径");
if (compareIndex >= 0) assert(comparePath, "缺少比较基线路径");
const selectors = [
  ".composer-wrap",
  ".composer",
  "#prompt",
  ".composer-toolbar",
  "#attach-context",
  "#send-button",
  "#composer-tools",
  "#composer-permission",
  "#analysis-control",
  "#model-controls",
  "#thinking-level",
  ".composer-context",
  ".context-selector",
  ".context-trigger",
  ".context-menu:not([hidden])",
  ".context-option",
  ".composer-note",
  ".session-metrics",
  ".metrics-primary",
  ".metrics-secondary",
  "#send-mode",
  "#token-total",
  "#context-usage",
  "#cache-hit",
  ".composer-model-popover:not([hidden])",
  ".model-menu-row",
  ".messages",
];
const properties = [
  "display",
  "position",
  "box-sizing",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "gap",
  "row-gap",
  "column-gap",
  "order",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "flex-direction",
  "flex-wrap",
  "align-items",
  "justify-content",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "border-top-width",
  "border-top-color",
  "border-top-style",
  "border-radius",
  "color",
  "background-color",
  "box-shadow",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "overflow-x",
  "overflow-y",
  "outline-width",
  "outline-color",
  "outline-style",
  "grid-template-columns",
  "container-type",
  "container-name",
];
const viewports = [
  [1280, 900],
  [700, 900],
  [480, 800],
  [430, 900],
  [390, 844],
  [360, 780],
  [320, 740],
  [844, 390],
];
const f = await desktopFixture();
const snapshots = {};
let browser, driver;
try {
  const projectId = (await f.call("/api/workspace")).projects[0].id;
  const actor = await f.command("conversation.create", {
    projectId,
    name: "输入区样式夹具",
  });
  const profile = join(f.root, "composer-style-browser");
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
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  for (const embedded of [false, true]) {
    const url = new URL(
      embedded ? f.app.url : `${f.app.url}agents/${actor.id}/`,
    );
    if (embedded) url.searchParams.set("agent", actor.id);
    await call("Page.navigate", { url: url.href });
    const doc = embedded
      ? "document.querySelector('#runtime')?.contentDocument"
      : "document";
    const win = embedded
      ? "document.querySelector('#runtime')?.contentWindow"
      : "window";
    const chat = (source) =>
      evaluate(`(()=>{const d=${doc},w=${win};${source}})()`);
    const ready = (expression) =>
      until(`(()=>{const d=${doc};return !!d && (${expression})})()`);
    await ready(
      "d.querySelector('#connection-status')?.textContent === 'Pi 已连接'",
    );
    await chat("return d.fonts.ready.then(()=>true)");
    if (!writePath) {
      const owners = await chat(`const violations=[];
        const controls=/[.#](?:composer(?:-[\\w-]+)?|context-(?:selector|trigger(?:-label)?|menu|option|native|add|attachments)|model-(?:button|controls|trigger-(?:label|effort)|menu-[\\w-]+)|thinking-picker|analysis-control|attach-context|send-button)(?![\\w-])/;
        function visit(rules,source){for(const rule of rules){if(rule.selectorText && controls.test(rule.selectorText) && !new URL(source,location.href).pathname.endsWith('/composer.css')) violations.push([rule.selectorText,source]);if(rule.cssRules)visit(rule.cssRules,source);}}
        for(const sheet of d.styleSheets)visit(sheet.cssRules,sheet.href);return violations;`);
      assert.deepEqual(
        owners,
        [],
        "输入控件的基础／皮肤／嵌入／响应式规则必须由 composer.css 独占",
      );
    }
    for (const theme of ["light", "dark"]) {
      await chat(
        `w.localStorage.setItem('pi-web-theme',${JSON.stringify(theme)});w.dispatchEvent(new w.Event('storage'))`,
      );
      await ready(
        `d.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
      );
      for (const [width, height] of viewports) {
        await call("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: width <= 480 || height <= 480,
        });
        await call("Emulation.setTouchEmulationEnabled", {
          enabled: width <= 480 || height <= 480,
          maxTouchPoints: 1,
        });
        await pause(90);
        const key = `${embedded ? "embedded" : "direct"}/${theme}/${width}x${height}`;
        async function capture(state) {
          snapshots[`${key}/${state}`] =
            await chat(`const selectors=${JSON.stringify(selectors)},properties=${JSON.stringify(properties)};
            return Object.fromEntries(selectors.map(selector=>[selector,[...d.querySelectorAll(selector)].slice(0,8).map(node=>{
              const style=w.getComputedStyle(node),rect=node.getBoundingClientRect();
              return {rect:[rect.x,rect.y,rect.width,rect.height].map(value=>Math.round(value*100)/100), style:Object.fromEntries(properties.map(property=>[property,style.getPropertyValue(property)]))};
            })]));`);
        }
        await chat(
          "d.activeElement?.blur();const input=d.querySelector('#prompt');input.value='';input.dispatchEvent(new w.Event('input',{bubbles:true}))",
        );
        await capture("idle");
        await chat(
          "const input=d.querySelector('#prompt');input.value='中文输入草稿';input.dispatchEvent(new w.Event('input',{bubbles:true}));input.focus()",
        );
        await capture("focus");
        const bounds = await chat(
          "const root=d.querySelector('#composer').getBoundingClientRect(), button=d.querySelector('#send-button').getBoundingClientRect();return {root:[root.left,root.right,root.bottom],button:[button.left,button.right,button.width,button.height],viewport:w.innerWidth,scroll:d.documentElement.scrollWidth}",
        );
        assert(
          bounds.root[0] >= -1 && bounds.root[1] <= bounds.viewport + 1,
          `${key} 输入区超出视口`,
        );
        assert(bounds.root[2] <= height + 1, `${key} 输入区底部不可见`);
        assert(bounds.scroll <= bounds.viewport + 1, `${key} 页面横向溢出`);
        if (embedded) {
          assert(
            (width > 480 && height > 480) ||
              (bounds.button[2] >= 44 && bounds.button[3] >= 44),
            `${key} 发送按钮触达不足`,
          );
          await chat(
            "d.querySelector('.composer-context .context-trigger').click()",
          );
          await ready(
            "d.querySelector('.composer-context .context-trigger').getAttribute('aria-expanded') === 'true'",
          );
          await capture("context-menu");
          const menu = await chat(
            "const rect=d.querySelector('.composer-context .context-menu:not([hidden])').getBoundingClientRect();return [rect.left,rect.right,rect.top,rect.bottom,w.innerWidth,w.innerHeight]",
          );
          assert(
            menu[0] >= -1 &&
              menu[1] <= menu[4] + 1 &&
              menu[2] >= -1 &&
              menu[3] <= menu[5] + 1,
            `${key} 项目菜单超出视口`,
          );
          await call("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Escape",
            code: "Escape",
          });
          await ready(
            "d.querySelector('.composer-context .context-trigger').getAttribute('aria-expanded') === 'false'",
          );
          await chat("d.querySelector('#analysis-control').click()");
          await ready("!d.querySelector('#composer-model-popover').hidden");
          await capture("model-menu");
          await call("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Escape",
            code: "Escape",
          });
          await ready("d.querySelector('#composer-model-popover').hidden");
        }
      }
    }
  }
  assert.deepEqual(driver.errors, []);
  if (writePath)
    await writeFile(writePath, JSON.stringify(snapshots, null, 2) + "\n");
  if (comparePath) {
    const before = JSON.parse(await readFile(comparePath, "utf8"));
    assert.deepEqual(Object.keys(snapshots), Object.keys(before));
    for (const [key, value] of Object.entries(snapshots))
      assert.deepEqual(value, before[key], `计算样式／几何变化：${key}`);
  }
  console.log(
    `Composer 样式通过：${Object.keys(snapshots).length} 个真实计算样式状态，双主题、独立／嵌入、320–1280px、横屏、键盘菜单和触达边界${comparePath ? "，与重构前完全一致" : ""}。`,
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
