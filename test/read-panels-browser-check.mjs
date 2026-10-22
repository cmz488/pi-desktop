import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicAssets, assetFile } from "../src/server/asset-manifest.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";
import { measureSurfaceContrast } from "./surface-contrast.mjs";

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
let owner='1',capabilities={sessionTree:true,tasks:true,readOnly:false},taskReply={},taskStatus='waiting';
// 真实 chat.js 会在首次渲染后解除首屏隐藏；这个夹具取代了它，所以自己解除。
delete document.documentElement.dataset.booting;
const requests=[],commands=[],notices=[],held=new Set(),pending=[],unsupported=new Set(),versions=new Map(),treeOverrides=new Map();
const model=(kind,id,version)=>unsupported.has(kind)?{supported:false}:kind==='tasks'?{supported:true,sessionId:id,tasks:[{id:Number(id)*100+1,kind:'fixture.'+id+'.'+version,name:'后台资料整理',conversationId:Number(id),owner:null,background:true,status:taskStatus}],tools:[],conversations:[]}:{supported:true,sessionId:id,name:'Tree '+id,native:{leafId:'n'+id+'39',nodes:Array.from({length:40},(_,i)=>({id:'n'+id+i,parentId:i?'n'+id+(i-1):null,type:'message',role:'user',preview:'tree '+id+' '+i,entryId:Number(id)*100+i,active:true,leaf:i===39,children:i===39?0:1}))},branches:[]};
const read=(kind,id,options={})=>{const key=kind+':'+id;const version=(versions.get(key)??0)+1;versions.set(key,version);const record={kind,id,version,signal:options.signal};requests.push(record);const value=kind==='tree'&&treeOverrides.has(id)?treeOverrides.get(id):model(kind,id,version);return held.has(key)?new Promise(resolve=>pending.push({...record,resolve:()=>resolve(value)})):Promise.resolve(value);};
const root=document.querySelector('#view-extensions');root.hidden=false;document.querySelector('#view-workspace').hidden=true;
const branch=createBranchTreePanel({fetchTree:(id,options)=>read('tree',id,options),command:async(name,input)=>{commands.push({command:name,...input});return{};},toast:text=>notices.push(text),switchSession:async()=>{}});
const task=createTaskPanel({fetchTasks:(id,options)=>read('tasks',id,options),command:async input=>{commands.push(input);return taskReply;},toast:text=>notices.push(text),currentSession:()=>owner});
const pages=[branch,task];
const controller=createExtensionWorkbench({root,registry:createExtensionAdapterRegistry(),builtinPages:pages,sanitize:text=>text,onCount:count=>root.dataset.count=count,onError:text=>notices.push(text)});
const update=()=>controller.update([],{sessionId:owner,capabilities,sessionCommands:true});
window.panelFixture={requests,commands,notices,pages,
reply(value){taskReply=value;},
status(value){taskStatus=value;return task.refresh({force:true});},
update(id,caps=capabilities){owner=String(id);capabilities=caps;update();for(const page of pages)void page.refresh();},
select(kind){return controller.select(kind==='tasks'?task.key:branch.key);},
hold(kind,id){held.add(kind+':'+id);},
unhold(kind,id){held.delete(kind+':'+id);},
release(kind,id){held.delete(kind+':'+id);for(const item of pending.splice(0).filter(item=>{if(item.kind===kind&&item.id===id){item.resolve();return false;}return true;}))pending.push(item);},
unsupported(kind,value){if(value)unsupported.add(kind);else unsupported.delete(kind);},
tree(id,value){if(value)treeOverrides.set(String(id),value);else treeOverrides.delete(String(id));return branch.refresh({force:true});},
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
      "--password-store=basic",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      // 无真实鼠标的 headless 默认声明 hover:none；桌面悬浮用例须显式模拟细指针。
      "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
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
  for (const [status, label] of [
    ["pending", "排队"],
    ["running", "运行中"],
    ["waiting", "等待"],
    ["completing", "收尾"],
    ["future-phase", "future-phase"],
  ]) {
    await evaluate(`panelFixture.status(${JSON.stringify(status)})`);
    assert.equal(
      await evaluate(
        "document.querySelector('[data-task-id=\"101\"] .task-panel-state').textContent",
      ),
      label,
      "活跃态使用共用文案，未知原生阶段不推断为终态",
    );
  }
  await evaluate("panelFixture.status('waiting')");
  for (const [status, label] of [
    ["completed", "任务已完成"],
    ["failed", "任务失败"],
    ["aborted", "任务已中止"],
    ["orphaned", "任务无法恢复"],
    ["faulted", "任务执行故障"],
  ]) {
    const before = await evaluate("panelFixture.notices.length");
    await evaluate(
      `panelFixture.reply({task:{id:101,status:'terminal',outcome:{status:${JSON.stringify(status)}}}});document.querySelector('[data-task-action="wait:101"]').click()`,
    );
    await until(`panelFixture.notices.length>${before}`);
    assert.equal(
      await evaluate("panelFixture.notices.at(-1)"),
      label,
      `工作台按原生 ${status} 回执提示，不把等待成功冒充执行成功`,
    );
  }
  await evaluate(
    "panelFixture.reply({abortStatus:'terminal',task:{id:101,status:'terminal',outcome:{status:'completed'}}});document.querySelector('[data-task-action=\"cancel:101\"]').click()",
  );
  await until(
    "!!document.querySelector('[data-task-action=\"cancel:101\"][data-armed=true]')",
  );
  const cancelledNotices = await evaluate("panelFixture.notices.length");
  await evaluate(
    "document.querySelector('[data-task-action=\"cancel:101\"][data-armed=true]').click()",
  );
  await until(`panelFixture.notices.length>${cancelledNotices}`);
  assert.equal(
    await evaluate("panelFixture.notices.at(-1)"),
    "任务已完成",
    "已完成任务的中止回执不能改写成已中止",
  );
  await evaluate(
    "panelFixture.reply({abortStatus:'marked',task:{id:101,status:'completing',outcome:null}});document.querySelector('[data-task-action=\"cancel:101\"]').click()",
  );
  await until(
    "!!document.querySelector('[data-task-action=\"cancel:101\"][data-armed=true]')",
  );
  const markedNotices = await evaluate("panelFixture.notices.length");
  await evaluate(
    "document.querySelector('[data-task-action=\"cancel:101\"][data-armed=true]').click()",
  );
  await until(`panelFixture.notices.length>${markedNotices}`);
  assert.equal(
    await evaluate("panelFixture.notices.at(-1)"),
    "已提交任务中止请求，尚未确认终态",
    "原生 marked 回执不冒充 aborted",
  );
  await evaluate("panelFixture.reply({})");
  const legacyNotices = await evaluate("panelFixture.notices.length");
  await evaluate(
    "document.querySelector('[data-task-action=\"wait:101\"]').click()",
  );
  await until(`panelFixture.notices.length>${legacyNotices}`);
  assert.equal(
    await evaluate("panelFixture.notices.at(-1)"),
    "任务已结束",
    "旧宿主没有原生终态字段时不补造完成结果",
  );
  await evaluate(
    "panelFixture.reply({});panelFixture.commands.length=0;panelFixture.notices.length=0",
  );
  if (process.env.PI_SIDEBAR_UI_SCREENSHOTS)
    await mkdir(process.env.PI_SIDEBAR_UI_SCREENSHOTS, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `document.body.classList.toggle('dark',${theme === "dark"});document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
    );
    const contrast = await evaluate(
      `(${measureSurfaceContrast.toString()})(['.task-panel-heading strong','.task-panel-heading small','.task-panel-label','.task-panel-state','.task-panel-meta','[data-task-action="wait:101"]'])`,
    );
    assert.equal(contrast.length, 6);
    assert.ok(
      contrast.every((item) => item.ratio >= 4.5),
      `${theme} 工作台任务文字对比度：${JSON.stringify(contrast)}`,
    );
    if (process.env.PI_SIDEBAR_UI_SCREENSHOTS) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(process.env.PI_SIDEBAR_UI_SCREENSHOTS, `tasks-${theme}.png`),
        Buffer.from(shot.data, "base64"),
      );
    }
  }
  await evaluate(
    "document.body.classList.remove('dark');document.documentElement.dataset.theme='light'",
  );
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
  assert.equal(
    await evaluate("!!document.querySelector('svg[data-round-tree]')"),
    true,
    "分支树用 SVG 展示对话轮次，不再显示原生日志长链",
  );
  await evaluate(
    "document.querySelector('.branch-tree-content').style.width='1200px';panelFixture.pages[0].refresh({force:true})",
  );
  await until(
    "document.querySelector('[data-round-tree]').viewBox.baseVal.width===760",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-round-tree]').viewBox.baseVal.width",
    ),
    760,
    "宽容器的图面限制为 760px",
  );
  await evaluate(
    "document.querySelector('.branch-tree-content').style.width='120px'",
  );
  await until(
    "document.querySelector('[data-round-tree]').viewBox.baseVal.width===280",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-round-tree]').viewBox.baseVal.width",
    ),
    280,
    "无须新数据，容器 resize 就把图面裁剪到 280px 下限",
  );
  await evaluate(
    "document.querySelector('.branch-tree-content').style.width='0px';panelFixture.pages[0].refresh({force:true})",
  );
  await until(
    "document.querySelector('[data-round-tree]').viewBox.baseVal.width===460",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-round-tree]').viewBox.baseVal.width",
    ),
    460,
    "容器尚不可测量时保留 460px 初始回退",
  );
  await evaluate(
    "document.querySelector('.branch-tree-content').style.width='';panelFixture.pages[0].refresh({force:true})",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('[data-round-node]').length"),
    10,
    "默认只显示最近十轮，不删除源会话历史",
  );
  await evaluate(
    "(()=>{const input=document.querySelector('[data-round-limit]');input.value='40';input.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('[data-round-node]').length"),
    40,
    "显示窗口可配置，扩大窗口恢复旧节点而不是重新制造历史",
  );
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
  await evaluate(
    "document.querySelector('[data-toggle-node=n30]').dispatchEvent(new MouseEvent('click',{bubbles:true}))",
  );
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
  await evaluate(`(() => {
    const nodes=[];let parentId=null;
    for(let i=0;i<12;i++)for(const [suffix,role,preview,entryId] of [
      ['u','user','提问第'+(i+1)+'轮',i*10],
      ['p','assistant','不应单独成为节点的思考',i*10+1],
      ['t','toolResult','隐藏的工具日志',i*10+2],
      ['a','assistant','最终答复第'+(i+1)+'轮',i*10+3],
      ['c',null,null,null],
    ]){const id=suffix+i;nodes.push({id,parentId,type:role?'message':'custom',role,preview,entryId,active:true,leaf:id==='c11',children:id==='c11'?0:1});parentId=id;}
    window.roundModel={supported:true,sessionId:'4',name:'按轮次展示',idle:true,currentEntryId:113,native:{leafId:'c11',nodes},branches:[]};
    return panelFixture.tree('4',roundModel);
  })()`);
  await until("!!document.querySelector('[data-round-node=u11]')");
  assert.equal(
    await evaluate(
      "!!document.querySelector('[data-round-node=u11] [data-branch-action=fork]')",
    ),
    true,
    "当前位置的创建分支按钮位于节点标签内，而不是树底部",
  );
  await evaluate(
    "(()=>{const input=document.querySelector('[data-round-limit]');input.value='10';input.dispatchEvent(new Event('change',{bubbles:true}));})()",
  );
  assert.deepEqual(
    await evaluate(
      "[...document.querySelectorAll('[data-round-node]')].map(n=>n.dataset.roundNode)",
    ),
    ["u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10", "u11"],
    "一次提问到最终答复只有一个节点，工具、思考与扩展检查点不占名额",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.branch-round-detail [data-branch-action]').length",
    ),
    0,
    "底部摘要不再重复管理操作",
  );
  await evaluate(
    "document.activeElement.blur();document.querySelector('[data-round-node=u11]').scrollIntoView({block:'center'})",
  );
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  assert.equal(
    await evaluate("matchMedia('(hover:hover) and (pointer:fine)').matches"),
    true,
    "悬浮验收运行在真实细指针媒体模式，不能把触屏常显当作 hover 成功",
  );
  await until(
    "getComputedStyle(document.querySelector('[data-round-node=u11] .branch-round-actions')).opacity==='0'",
  );
  const currentBox = await evaluate(
    "(()=>{const box=document.querySelector('[data-round-node=u11] .branch-round-card').getBoundingClientRect();return{x:box.left+20,y:box.top+20}})()",
  );
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...currentBox });
  await until(
    "getComputedStyle(document.querySelector('[data-round-node=u11] .branch-round-actions')).opacity==='1'",
  );
  assert.equal(
    await evaluate(
      "!!document.querySelector('[data-round-node=u11] [data-branch-action=rewind]')",
    ),
    false,
    "当前位置不能同时提供退回按钮",
  );
  await evaluate("document.querySelector('[data-round-node=u11]').focus()");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  await until(
    "getComputedStyle(document.querySelector('[data-round-node=u11] .branch-round-actions')).opacity==='1'",
  );
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await until("document.activeElement.dataset.branchAction==='fork'");
  const keyboardCommands = await evaluate("panelFixture.commands.length");
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: "\r",
    unmodifiedText: "\r",
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await until(`panelFixture.commands.length===${keyboardCommands + 1}`);
  await until(
    "document.activeElement.dataset.branchAction==='fork' && document.activeElement.closest('[data-round-node]').dataset.roundNode==='u11'",
  );
  assert.equal(
    await evaluate("panelFixture.commands.at(-1).entryId"),
    113,
    "键盘激活命中当前位置，补刷保留按钮焦点",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-round-tree]').textContent.includes('隐藏的工具日志')",
    ),
    false,
  );
  await evaluate(
    "document.querySelector('[data-round-node=u10]').dispatchEvent(new MouseEvent('click',{bubbles:true}))",
  );
  assert.equal(
    await evaluate(
      "!!document.querySelector('[data-round-node=u10] [data-branch-action=fork]')",
    ),
    false,
    "历史节点只有退回入口",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[data-round-node=u10] [data-branch-action=rewind]').dataset.entryId",
    ),
    "103",
    "退回目标是整轮最后的已提交答复，不是其中某次工具调用",
  );
  await evaluate(
    "document.querySelector('[data-round-node=u10] [data-branch-action=rewind]').click()",
  );
  assert.deepEqual(await evaluate("panelFixture.commands.at(-1)"), {
    command: "rewind",
    id: 4,
    entryId: 103,
    sessionId: "4",
  });
  await evaluate(
    "document.querySelector('[data-round-node=u10]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))",
  );
  assert.equal(
    await evaluate("document.activeElement.dataset.roundNode"),
    "u11",
    "SVG 节点支持键盘选择，焦点跟随视觉顺序",
  );
  await evaluate("document.querySelector('[data-branch-action=fork]').click()");
  assert.deepEqual(await evaluate("panelFixture.commands.at(-1)"), {
    command: "fork",
    id: 4,
    entryId: 113,
    sessionId: "4",
    mode: "tail",
    expectedEntryId: 113,
  });
  await evaluate("panelFixture.tree('4',{...roundModel,idle:false})");
  assert.equal(
    await evaluate(
      "document.querySelector('[data-current=true] [data-branch-action=fork]').disabled",
    ),
    false,
    "忙碌时仍可创建原生快照分支",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('[data-current=false] [data-branch-action=rewind]')].every(button=>button.disabled)",
    ),
    true,
    "忙碌时每个历史节点都禁止退回",
  );
  await evaluate("panelFixture.tree('4',roundModel)");
  await until(
    "[...document.querySelectorAll('[data-current=false] [data-branch-action=rewind]')].every(button=>!button.disabled)",
  );
  if (process.env.PI_SIDEBAR_UI_SCREENSHOTS)
    await mkdir(process.env.PI_SIDEBAR_UI_SCREENSHOTS, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await evaluate(
      `document.body.classList.toggle('dark',${theme === "dark"});document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('[data-round-node=u4]').scrollIntoView({block:'center'});document.querySelector('[data-round-node=u4]').focus()`,
    );
    await until(
      "getComputedStyle(document.querySelector('[data-round-node=u4] .branch-round-actions')).opacity==='1'",
    );
    const contrast = await evaluate(
      `(${measureSurfaceContrast.toString()})(['.branch-round-number','.branch-round-question','.branch-round-answer','[data-round-node=u4] .branch-round-action','.extension-page-choice[aria-current] strong','.extension-page-choice:not([aria-current]) strong'])`,
    );
    assert.equal(contrast.length, 6);
    assert.ok(
      contrast.every((item) => item.ratio >= 4.5),
      `${theme} 轮次文本对比度：${JSON.stringify(contrast)}`,
    );
    if (process.env.PI_SIDEBAR_UI_SCREENSHOTS) {
      const screenshot = await call("Page.captureScreenshot", {
        format: "png",
      });
      await writeFile(
        join(process.env.PI_SIDEBAR_UI_SCREENSHOTS, `branches-${theme}.png`),
        Buffer.from(screenshot.data, "base64"),
      );
    }
  }
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(
    "document.querySelector('[data-round-node=u11]').scrollIntoView({block:'center'});document.querySelector('[data-round-node=u11]').focus()",
  );
  await until(
    "(()=>{const box=document.querySelector('[data-round-node=u11] [data-branch-action=fork]').getBoundingClientRect();return box.left>=0 && box.right<=390 && box.width>=44})()",
  );
  assert.equal(
    await evaluate("document.documentElement.scrollWidth<=innerWidth"),
    true,
    "390px 下页面不横向溢出，节点动作仍可见",
  );
  await until(
    "getComputedStyle(document.querySelector('[data-round-node=u11] .branch-round-actions')).opacity==='1'",
  );
  if (process.env.PI_SIDEBAR_UI_SCREENSHOTS) {
    const screenshot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(
      join(process.env.PI_SIDEBAR_UI_SCREENSHOTS, "branches-narrow.png"),
      Buffer.from(screenshot.data, "base64"),
    );
  }
  await call("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  await until("matchMedia('(pointer:coarse)').matches");
  await evaluate("document.activeElement.blur()");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  await until(
    "getComputedStyle(document.querySelector('[data-round-node=u11] .branch-round-actions')).opacity==='1'",
  );
  assert.ok(
    await evaluate(
      "document.querySelector('[data-round-node=u11] [data-branch-action=fork]').getBoundingClientRect().height>=44",
    ),
    "触屏无需悬浮，主操作保留至少 44px 触达高度",
  );
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('[data-toggle-node]')].every(node=>{const r=node.querySelector('rect').getBoundingClientRect();const graph=node.ownerSVGElement.getBoundingClientRect();const label=node.parentNode.querySelector('foreignObject').getBoundingClientRect();return r.width>=44&&r.height>=44&&r.left>=graph.left&&r.right<=label.left;})",
    ),
    true,
    "折叠轮次的触达区域至少 44px，不被 SVG 裁掉或压住标签",
  );
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.branch-round-actions')).transitionDuration",
    ),
    "0s",
    "减少动态效果偏好覆盖悬浮渐变",
  );
  await call("Emulation.setEmulatedMedia", { features: [] });
  await call("Emulation.setTouchEmulationEnabled", { enabled: false });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(
    "document.body.classList.remove('dark');document.documentElement.dataset.theme='light'",
  );
  await evaluate("panelFixture.tree('4',null)");
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
  // Chromium 的子进程可能在主进程关闭后完成 profile 的原子替换。
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
