import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicAssets, assetFile } from "../src/server/asset-manifest.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";

// 真实面板与工作台，只有读模型和命令受控；故意忽略 abort，才能验证晚到结果的身份检查。
const source = await readFile(
  new URL("../src/ui/chat/index.html", import.meta.url),
  "utf8",
);
const html = source.replace(
  '<script type="module" src="prototype.js"></script>',
  `<script type="module">
import {createExtensionWorkbench} from '/extension-workbench.js';
import {createExtensionAdapterRegistry} from '/extension-adapters.mjs';
import {createBranchTreePanel} from '/branch-tree-panel.js';
import {createTaskPanel} from '/task-panel.js';
let owner='1',capabilities={sessionTree:true,tasks:true,readOnly:false};
const requests=[],commands=[],notices=[],held=new Set(),pending=[],unsupported=new Set(),versions=new Map();
const model=(kind,id,version)=>unsupported.has(kind)?{supported:false}:kind==='tasks'?{supported:true,sessionId:id,tasks:[{id:Number(id)*100+1,kind:'fixture.'+id+'.'+version,conversationId:Number(id),owner:null,background:true,status:'waiting'}],tools:[],conversations:[]}:{supported:true,sessionId:id,name:'Tree '+id,native:{leafId:'n'+id+'39',nodes:Array.from({length:40},(_,i)=>({id:'n'+id+i,parentId:i?'n'+id+(i-1):null,type:'message',role:'user',preview:'tree '+id+' '+i,entryId:Number(id)*100+i,active:true,leaf:i===39,children:i===39?0:1}))},branches:[]};
const read=(kind,id,options={})=>{const key=kind+':'+id;const version=(versions.get(key)??0)+1;versions.set(key,version);const record={kind,id,version,signal:options.signal};requests.push(record);const value=model(kind,id,version);return held.has(key)?new Promise(resolve=>pending.push({...record,resolve:()=>resolve(value)})):Promise.resolve(value);};
const root=document.querySelector('#view-extensions');root.hidden=false;document.querySelector('#view-workspace').hidden=true;
const branch=createBranchTreePanel({fetchTree:(id,options)=>read('tree',id,options),command:async(name,input)=>{commands.push({command:name,...input});return{};},toast:text=>notices.push(text),switchSession:async()=>{}});
const task=createTaskPanel({fetchTasks:(id,options)=>read('tasks',id,options),command:async input=>{commands.push(input);return{};},toast:text=>notices.push(text),currentSession:()=>owner});
const pages=[branch,task];
const controller=createExtensionWorkbench({root,registry:createExtensionAdapterRegistry(),builtinPages:pages,sanitize:text=>text,onCount:count=>root.dataset.count=count,onError:text=>notices.push(text)});
const update=()=>controller.update([],{sessionId:owner,capabilities,sessionCommands:true});
window.panelFixture={requests,commands,notices,pages,
update(id,caps=capabilities){owner=String(id);capabilities=caps;update();for(const page of pages)void page.refresh();},
select(kind){return controller.select(kind==='tasks'?task.key:branch.key);},
hold(kind,id){held.add(kind+':'+id);},
unhold(kind,id){held.delete(kind+':'+id);},
release(kind,id){held.delete(kind+':'+id);for(const item of pending.splice(0).filter(item=>{if(item.kind===kind&&item.id===id){item.resolve();return false;}return true;}))pending.push(item);},
unsupported(kind,value){if(value)unsupported.add(kind);else unsupported.delete(kind);},
get pending(){return pending.map(({kind,id,version})=>({kind,id,version}));},
dispose(){for(const page of pages)page.dispose();}
};update();
</script>`,
);
const assets = publicAssets("chat");
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  const asset = assets.get(path);
  if (path !== "/" && !asset) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader(
    "Content-Type",
    path === "/" ? "text/html; charset=utf-8" : asset[1],
  );
  response.end(path === "/" ? html : await readFile(assetFile(asset[0])));
});
const root = await mkdtemp(join(tmpdir(), "pi-read-panels-"));
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
  await until("!!window.panelFixture");
  await evaluate("panelFixture.select('tasks')");
  await until("!!document.querySelector('[data-task-id=\"101\"]')");
  await evaluate(
    "panelFixture.hold('tasks','1');document.querySelector('[data-task-refresh]').click()",
  );
  await until(
    "panelFixture.pending.some(row=>row.kind==='tasks'&&row.id==='1')",
  );
  await evaluate("panelFixture.update('2')");
  assert.equal(
    await evaluate(
      "panelFixture.requests.findLast(row=>row.kind==='tasks'&&row.id==='1').signal?.aborted===true",
    ),
    true,
    "未选中的任务页也在切换时中止读取",
  );
  await evaluate(
    "panelFixture.release('tasks','1');panelFixture.update('1');panelFixture.select('tasks')",
  );
  await until("!!document.querySelector('[data-task-id=\"101\"]')");
  await evaluate(
    "window.staleCancel=document.querySelector('[data-task-action=background]');staleCancel.click();panelFixture.hold('tasks','2');panelFixture.update('2');panelFixture.select('tasks')",
  );
  assert.equal(
    await evaluate("!!document.querySelector('[data-task-id=\"101\"]')"),
    false,
    "切会话立即清除旧任务行，不等新请求结束",
  );
  assert.equal(
    await evaluate("!!document.querySelector('[data-armed=true]')"),
    false,
    "待确认不能跨会话保留",
  );
  await evaluate("staleCancel.click()");
  assert.equal(
    await evaluate("panelFixture.commands.length"),
    0,
    "过期 DOM 回调不能向新会话发命令",
  );
  await until(
    "panelFixture.pending.some(row=>row.kind==='tasks'&&row.id==='2')",
  );
  await evaluate("panelFixture.release('tasks','2')");
  await until("!!document.querySelector('[data-task-id=\"201\"]')");
  await evaluate(
    "document.querySelector('[data-task-action=background]').click()",
  );
  assert.equal(
    await evaluate("panelFixture.commands.length"),
    0,
    "B 仍需要自己的首次确认",
  );
  await evaluate(
    "document.querySelector('[data-task-action=background]').click()",
  );
  await until("panelFixture.commands.length===1");
  assert.equal(
    await evaluate("Object.isFrozen(panelFixture.commands[0])"),
    true,
    "命令捕获的目标不可变",
  );
  assert.deepEqual(await evaluate("panelFixture.commands[0]"), {
    command: "cancel",
    id: 2,
    sessionId: "2",
    background: true,
  });

  // 读模型故意不响应 abort：必须靠代际检查丢弃已离开的会话。
  await evaluate(
    "panelFixture.hold('tasks','1');panelFixture.update('1');panelFixture.select('tasks');document.querySelector('[data-task-refresh]').click()",
  );
  await until(
    "panelFixture.pending.some(row=>row.kind==='tasks'&&row.id==='1')",
  );
  await evaluate("panelFixture.update('3');panelFixture.select('tasks')");
  await until("!!document.querySelector('[data-task-id=\"301\"]')");
  await evaluate("panelFixture.release('tasks','1')");
  await until("document.querySelector('.task-panel')?.dataset.taskPanel==='3'");
  assert.equal(
    await evaluate("!!document.querySelector('[data-task-id=\"101\"]')"),
    false,
    "旧请求晚到不能覆盖当前会话",
  );

  await evaluate(
    "panelFixture.hold('tasks','1');panelFixture.update('1');panelFixture.select('tasks');document.querySelector('[data-task-refresh]').click()",
  );
  await until(
    "panelFixture.pending.some(row=>row.kind==='tasks'&&row.id==='1')",
  );
  await evaluate(
    "panelFixture.unhold('tasks','1');panelFixture.update('2');panelFixture.select('tasks')",
  );
  await until("!!document.querySelector('[data-task-id=\"201\"]')");
  await evaluate("panelFixture.update('1');panelFixture.select('tasks')");
  await until("!!document.querySelector('[data-task-id=\"101\"]')");
  const latestKind = await evaluate(
    "document.querySelector('[data-task-id=\"101\"]').dataset.kind",
  );
  await evaluate("panelFixture.release('tasks','1')");
  assert.equal(
    await evaluate(
      "document.querySelector('[data-task-id=\"101\"]').dataset.kind",
    ),
    latestKind,
    "旧 A 晚到不能覆盖新一代 A",
  );
  await evaluate("panelFixture.update('3');panelFixture.select('tree')");
  await until("!!document.querySelector('[data-node-id=n339]')");
  await evaluate(
    "document.querySelector('.extension-page-detail').scrollTop=200",
  );
  const scroll = await evaluate(
    "document.querySelector('.extension-page-detail').scrollTop",
  );
  assert.ok(scroll > 0);
  await evaluate("document.querySelector('[data-branch-refresh]').click()");
  await until("!!document.querySelector('[data-node-id=n339]')");
  assert.equal(
    await evaluate(
      "document.querySelector('.extension-page-detail').scrollTop",
    ),
    scroll,
    "补刷不重置滚动位置",
  );
  await evaluate("document.querySelector('[data-toggle-node=n30]').click()");
  assert.equal(
    await evaluate("document.querySelectorAll('[data-node-id]').length"),
    1,
  );
  await evaluate("document.querySelector('[data-branch-refresh]').click()");
  await until("!document.querySelector('[data-node-id=n339]')");
  assert.equal(
    await evaluate(
      "document.querySelector('[data-toggle-node=n30]').getAttribute('aria-expanded')",
    ),
    "false",
    "同一身份补刷保留折叠",
  );
  await evaluate(
    "panelFixture.hold('tree','4');panelFixture.update('4');panelFixture.select('tree')",
  );
  assert.equal(
    await evaluate("!!document.querySelector('[data-node-id=n30]')"),
    false,
    "分支树也立即使旧数据失效",
  );
  await evaluate("panelFixture.release('tree','4')");
  await until("!!document.querySelector('[data-node-id=n439]')");

  await evaluate(
    "panelFixture.update('4',{sessionTree:true,tasks:true,readOnly:true});panelFixture.select('tasks')",
  );
  await until("!!document.querySelector('[data-task-id=\"401\"]')");
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('[data-task-action]')].some(node=>!node.disabled)",
    ),
    false,
    "只读可查看，不把管理按钮伪装为可用",
  );
  await evaluate("panelFixture.select('tree')");
  await until("!!document.querySelector('[data-node-id=n439]')");
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('[data-branch-action]')].some(node=>!node.disabled)",
    ),
    false,
  );
  await evaluate(
    "panelFixture.update('4',{sessionTree:true,tasks:true,readOnly:false});panelFixture.select('tasks')",
  );
  await until("!!document.querySelector('[data-task-id=\"401\"]')");
  assert.equal(
    await evaluate(
      "document.querySelector('[data-task-action=background]').disabled",
    ),
    false,
  );
  await evaluate(
    "document.querySelector('[data-task-action=background]').click();panelFixture.update('4',{sessionTree:true,tasks:true,readOnly:true});panelFixture.select('tasks')",
  );
  assert.equal(
    await evaluate("!!document.querySelector('[data-armed=true]')"),
    false,
    "同会话撤回管理权限也撤销确认",
  );
  const beforeDisabled = await evaluate("panelFixture.requests.length");
  await evaluate("panelFixture.update('6',{});");
  assert.equal(
    await evaluate("panelFixture.requests.length"),
    beforeDisabled,
    "未声明能力不探测读端点",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.extension-page-choice').length",
    ),
    0,
    "未声明能力不显示内置入口",
  );
  await evaluate(
    "panelFixture.unsupported('tasks',true);panelFixture.update('7',{sessionTree:true,tasks:true});panelFixture.select('tasks')",
  );
  await until(
    "![...document.querySelectorAll('.extension-page-choice')].some(node=>node.dataset.extensionKey==='desktop:task-panel')",
  );
  await evaluate(
    "panelFixture.unsupported('tasks',false);panelFixture.update('8',{sessionTree:true,tasks:true,remote:true});panelFixture.select('tasks')",
  );
  await until("!!document.querySelector('[data-task-id=\"801\"]')");
  assert.equal(
    await evaluate(
      "document.querySelector('[data-task-action=background]').disabled",
    ),
    false,
    "远程的本会话取消不能被笼统禁用",
  );
  await evaluate(
    "document.querySelector('[data-task-action=\"wait:801\"]').click()",
  );
  await until("panelFixture.commands.some(row=>row.command==='wait')");
  assert.equal(
    await evaluate(
      "Object.isFrozen(panelFixture.commands.findLast(row=>row.command==='wait'))",
    ),
    true,
    "等待命令同样捕获不可变目标",
  );
  await evaluate("panelFixture.dispose()");
  const reads = await evaluate("panelFixture.requests.length");
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(
    await evaluate("panelFixture.requests.length"),
    reads,
    "销毁清理节流补刷，不能继续拉取",
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    "Read panels browser passed: scoped confirmation, immediate invalidation, delayed replies, capability/read-only/remote gates, folds and cleanup.",
  );
} finally {
  driver?.close();
  if (browser && browser.exitCode === null) {
    const stopped = once(browser, "close");
    browser.kill("SIGTERM");
    await stopped;
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
