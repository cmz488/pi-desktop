import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({
  stdin: {
    contents: `export { NativeBrowserSession } from './src/ui-next/percho/renderer/src/components/native/native-browser.ts'; export { createBrowserPanels } from './src/desktop/browser-panels.mjs';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "electron-fixture",
      setup(api) {
        api.onResolve({ filter: /^electron$/ }, () => ({
          path: "electron",
          namespace: "fixture",
        }));
        api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: `
      import { EventEmitter } from 'node:events';
      class Contents extends EventEmitter {
        session = Object.assign(new EventEmitter(), {setPermissionRequestHandler(){},setPermissionCheckHandler(){}});
        navigationHistory = {getActiveIndex:()=>0,length:()=>1};
        url=''; destroyed=false;
        isDestroyed(){return this.destroyed} getURL(){return this.url} getTitle(){return this.url} isLoading(){return false}
        setWindowOpenHandler(){} async loadURL(url){this.url=url;this.emit('did-navigate')} close(){this.destroyed=true} reload(){}
      }
      export class WebContentsView { webContents=new Contents(); setVisible(value){this.visible=value} setBounds(value){this.bounds=value} }
    `,
        }));
      },
    },
  ],
});
const { NativeBrowserSession, createBrowserPanels } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
function fixture() {
  const views = [],
    calls = [],
    events = [],
    observed = [];
  let session;
  const window = {
    on() {},
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 800, height: 600 }),
    contentView: {
      addChildView: (view) => views.push(view),
      removeChildView() {},
    },
    webContents: {
      send: (_channel, state) => {
        events.push(state);
        observed.push(session.accept(state));
      },
    },
  };
  const panels = createBrowserPanels(window);
  const host = {
    browserCommand: async (input) => {
      calls.push(input);
      return panels.execute(input);
    },
  };
  session = new NativeBrowserSession(host);
  return { views, calls, events, observed, session };
}
test("Electron 适配使用真实主进程动作、owner、标签 UUID 与单标签回执", async () => {
  const f = fixture();
  await f.session.execute("layout", {
    bounds: { x: 10, y: 20, width: 400, height: 300 },
  });
  assert.equal(f.calls.length, 0, "未创建标签时不向主进程发送无效布局");
  let state = await f.session.execute("new", {
    url: "https://example.invalid/first",
  });
  const first = state.tabs[0].id;
  assert.equal(f.calls[0].action, "navigate");
  assert.match(f.calls[0].owner, /^[a-f0-9-]{36}$/);
  assert.match(first, /^[a-f0-9-]{36}$/);
  assert.equal(state.tabs[0].active, true);
  assert.equal(state.tabs[0].url, "https://example.invalid/first");
  assert.equal(f.events[0].tabs, undefined, "实际 Electron 事件是单标签回执");
  assert.equal(
    f.observed[0].tabs[0].active,
    true,
    "IPC Promise 返回前的事件也具备当前标签身份",
  );
  await f.session.execute("layout", {
    bounds: { x: 10, y: 20, width: 400, height: 300 },
  });
  assert.equal(f.views[0].visible, true);
  assert.deepEqual(f.views[0].bounds, {
    x: 10,
    y: 20,
    width: 400,
    height: 300,
  });
  state = await f.session.execute("new", {
    url: "https://example.invalid/second",
  });
  const second = state.tabs.find((tab) => tab.active).id;
  state = await f.session.execute("select", { id: first });
  assert.equal(f.calls.at(-1).action, "state");
  assert.equal(state.tabs.find((tab) => tab.active).id, first);
  await f.session.execute("hide");
  assert(
    f.views.every((view) => !view.visible && !view.webContents.isDestroyed()),
    "关闭观察不关闭原生网页",
  );
  state = await f.session.execute("close", { id: first });
  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0].id, second);
  assert.equal(state.tabs[0].active, true);
  await f.session.execute("layout", {
    bounds: { x: 0, y: 0, width: 320, height: 240 },
  });
  assert.equal(f.views[1].visible, true, "重新挂载观察可恢复剩余标签");
});
test("Electron 异步标签事件仅更新所属观察会话，不劫持当前标签", async () => {
  const f = fixture();
  const first = (
    await f.session.execute("new", { url: "https://example.invalid/first" })
  ).tabs[0];
  await f.session.execute("new", { url: "https://example.invalid/second" });
  const before = f.session.state();
  assert.equal(
    f.session.accept({
      owner: "another-owner",
      id: first.id,
      url: "https://example.invalid/foreign",
      title: "foreign",
    }),
    undefined,
  );
  assert.deepEqual(f.session.state(), before);
  const state = f.session.accept({ ...f.events[0], title: "background title" });
  assert.equal(
    state.tabs.find((tab) => tab.id === first.id).title,
    "background title",
  );
  assert.equal(
    state.tabs.find((tab) => tab.active).id,
    before.tabs.find((tab) => tab.active).id,
  );
});
