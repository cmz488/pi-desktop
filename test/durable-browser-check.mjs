import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import { browserDriver, pause } from "./durable-browser-driver.mjs";
import { createBackgroundFixture } from "./background-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "pi-durable-browser-"));
let app, browser, driver;
try {
  const cwd = join(root, "project"),
    other = join(root, "other");
  await mkdir(cwd);
  await mkdir(other);
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 1000 });
  models.setProvider(faux.provider);
  const backgroundFixture = createBackgroundFixture();
  const workspace = await openAgentWorkspace({
    storage: new MemoryStorage(),
    models,
    extensions: [backgroundFixture.extension],
    settings: { retry: { enabled: false } },
  });
  // 原生转录绑定在宿主启动时接管的 Agent 上（默认多进程宿主每个 Agent 一个 worker）。
  // 本夹具先建好 Agent A 并声明它的 owner 与目录，使退回能写回 Pi JSONL 会话树。
  const agentDir = join(root, "agent");
  const agentA = await workspace.execute("create", {
    cwd,
    name: "Agent A",
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
  });
  app = await startDurableDesk({
    workspace,
    port: 0,
    agentDir,
    directory: join(agentDir, "agents", String(agentA.id)),
    nativeSessionOwner: `${agentA.id}:0`,
    resources: false,
  });
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
  // Count snapshot fetches from the page. Streaming text must arrive as delta
  // events instead of making the page pull the whole chat snapshot per batch.
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__req={};const original=window.fetch;
window.fetch=async(...args)=>{const path=new URL(String(args[0]),location.href).pathname;
window.__req[path]=(window.__req[path]??0)+1;return original(...args);};`,
  });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1320,
    height: 860,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", { url: app.url });
  await until(
    "document.querySelector('#connection-status')?.textContent==='Pi 已连接'",
  );
  assert(
    ((await evaluate("window.__req['/api/state']")) ?? 0) >= 1,
    "the snapshot counter must observe the initial state fetch",
  );
  assert(await evaluate("!!document.querySelector('#workspace-right')"));
  await until(
    "document.querySelector('#session-title').textContent==='Agent A'",
  );
  const first = agentA.id;
  await evaluate("document.querySelector('#prompt').value='draft A'");
  await evaluate(
    `document.querySelector('[data-action="new-session"]').click()`,
  );
  await until(
    "document.querySelector('#dialog').open && !!document.querySelector('[name=agentName]')",
  );
  await evaluate(
    `(() => {const form=document.querySelector('#dialog-form');form.elements.agentName.value='Agent B';form.elements.agentCwd.value=${JSON.stringify(other)};form.requestSubmit()})()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent B'",
  );
  assert.equal(await evaluate("document.querySelector('#prompt').value"), "");
  await evaluate(
    `document.querySelector('[data-session-id="${first}"]').click()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent A'",
  );
  assert.equal(
    await evaluate("document.querySelector('#prompt').value"),
    "draft A",
  );
  faux.setResponses([
    fauxAssistantMessage(
      "## Durable response\n\n" + "Streamed output. ".repeat(100),
    ),
  ]);
  await evaluate(`window.originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await window.originalFetch(...args);
      if (new URL(args[0], location.href).pathname === '/api/prompt' && args[1]?.method === 'POST')
        return new Promise(resolve => {window.releasePrompt = () => resolve(response);});
      return response;
    };`);
  await evaluate("document.querySelector('#composer').requestSubmit()");
  await until("document.querySelector('#stop-button').hidden===false");
  await until("!!window.releasePrompt");
  const second = (await workspace.read()).agents.find(
    (agent) => agent.name === "Agent B",
  ).id;
  await evaluate(
    `document.querySelector('[data-session-id="${second}"]').click();document.querySelector('#prompt').value='new draft B'`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent B'",
  );
  assert.equal(
    await evaluate("document.querySelector('#prompt').value"),
    "new draft B",
  );
  await evaluate("window.__req={}");
  await evaluate(
    "window.fetch=window.originalFetch;window.releasePrompt();new Promise(resolve=>setTimeout(resolve,0))",
  );
  assert.equal(
    await evaluate("document.querySelector('#session-title').textContent"),
    "Agent B",
  );
  assert.equal(
    await evaluate("document.querySelector('#prompt').value"),
    "new draft B",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('draft A')",
    ),
    false,
  );
  await evaluate(
    `document.querySelector('[data-session-id="${first}"]').click()`,
  );
  await until(
    "document.querySelector('#messages').innerText.includes('Durable response') && document.querySelector('#stop-button').hidden===true",
  );
  const streamedFetches = (await evaluate("window.__req['/api/state']")) ?? 0;
  assert(
    streamedFetches <= 5,
    `a streamed answer must not refetch the chat snapshot per batch (${streamedFetches})`,
  );
  await evaluate("document.querySelector('#agent-config-button').click()");
  await until("document.querySelector('#dialog').open");
  assert(
    await evaluate(
      `document.querySelector('#dialog-form').elements.agentCwd.value===${JSON.stringify(cwd)}`,
    ),
  );
  await evaluate(
    "document.querySelector('#dialog [data-action=close-dialog]').click()",
  );
  const screenshot = join(tmpdir(), "pi-durable-desk-desktop.png");
  await writeFile(
    screenshot,
    Buffer.from((await call("Page.captureScreenshot")).data, "base64"),
  );
  for (const width of [320, 360, 390]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 820,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert(
      await evaluate("document.documentElement.scrollWidth<=innerWidth"),
      `page overflows at ${width}`,
    );
    await evaluate("document.querySelector('[data-action=sidebar]').click()");
    assert(await evaluate("document.body.classList.contains('sidebar-open')"));
    await evaluate(
      `document.querySelector('[data-session-id="${second}"]').click()`,
    );
    await until(
      "document.querySelector('#session-title').textContent==='Agent B'",
    );
    assert.equal(
      await evaluate("document.querySelector('#prompt').value"),
      "new draft B",
    );
    await evaluate("document.querySelector('#agent-config-button').click()");
    await until("document.querySelector('#dialog').open");
    assert(
      await evaluate(
        "document.querySelector('#dialog').getBoundingClientRect().right<=innerWidth",
      ),
    );
    await evaluate(
      "document.querySelector('#dialog [data-action=close-dialog]').click()",
    );
    await call("Emulation.setDeviceMetricsOverride", {
      width: 1320,
      height: 860,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(
      `document.querySelector('[data-session-id="${first}"]').click()`,
    );
    await until(
      "document.querySelector('#session-title').textContent==='Agent A'",
    );
  }
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "fetch failed",
    }),
  ]);
  await evaluate(
    "document.querySelector('#prompt').value='reproduce failed model request';document.querySelector('#composer').requestSubmit()",
  );
  await until(
    "document.querySelector('#messages').innerText.includes('fetch failed') && document.querySelector('#stop-button').hidden===true",
  );
  assert(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('模型请求失败')",
    ),
  );
  assert(
    await evaluate(
      "getComputedStyle(document.querySelector('.model-request-error')).display==='flex' && document.querySelector('.model-request-error').getBoundingClientRect().height<=32 && !document.querySelector('.model-request-error').closest('.context-activity')",
    ),
    "failed model requests should use a compact row outside the activity fold",
  );
  faux.setResponses([fauxAssistantMessage("recovered response")]);
  await evaluate(
    "document.querySelector('#prompt').value='retry after network recovery';document.querySelector('#composer').requestSubmit()",
  );
  await until(
    "document.querySelector('#messages').innerText.includes('recovered response') && document.querySelector('#stop-button').hidden===true",
  );
  // 消息动作：右键消息可退回或分叉，两者都写回 Pi JSONL 会话树。
  const entryIds = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('#messages [data-entry-id]')].map((row) => row.dataset.entryId))`,
    ),
  );
  assert(entryIds.length >= 2, "message rows expose their entry id");
  const openMenu = (selector) =>
    evaluate(`(() => {
      const row = document.querySelector('${selector}');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 80 }));
    })()`);
  await openMenu("#messages [data-entry-id]");
  await until("!!document.querySelector('.message-menu')");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.message-menu [role=menuitem]').length",
    ),
    2,
  );
  await evaluate(
    "document.querySelector('.message-menu [data-command=rewind]').click()",
  );
  await until("!document.querySelector('.message-menu')");
  await until(
    "document.querySelector('#messages').innerText.includes('recovered response')===false && document.querySelector('#stop-button').hidden===true",
  );
  assert(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('draft A')",
    ),
    "the rewound timeline keeps everything up to the target message",
  );
  assert(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('retry after network recovery')===false",
    ),
    "the rewound timeline drops what came after the target message",
  );
  await openMenu("#messages [data-entry-id]");
  await until("!!document.querySelector('.message-menu')");
  await evaluate(
    "document.querySelector('.message-menu [data-command=fork]').click()",
  );
  await until(
    "document.querySelector('#session-title').textContent.includes('分支')",
  );
  assert(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('draft A')",
    ),
    "the fork keeps the context up to its fork point",
  );
  await evaluate(
    `document.querySelector('[data-session-id="${first}"]').click()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent A' && document.querySelector('#stop-button').hidden===true",
  );
  // 会话栏右键：创建分支 / 退回分支 / 打开分支树。
  const sessionMenu = (id) =>
    evaluate(`(() => {
      const row = document.querySelector('[data-session-id="${id}"]');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 90, clientY: 120 }));
    })()`);
  await sessionMenu(first);
  await until("!!document.querySelector('.session-menu')");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.session-menu [role=menuitem]').length",
    ),
    3,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.session-menu [data-command=rewind]').disabled",
    ),
    false,
    "the host session has a native transcript, so rewind stays available",
  );
  const sessionRows = await evaluate(
    "document.querySelectorAll('#sessions [data-session-id]').length",
  );
  await evaluate(
    "document.querySelector('.session-menu [data-command=fork]').click()",
  );
  await until(
    `document.querySelectorAll('#sessions [data-session-id]').length===${sessionRows + 1}`,
  );
  await until(
    "document.querySelector('#session-title').textContent.includes('分支')",
  );
  const branchId = await evaluate(
    "document.querySelector('#sessions .session.active').dataset.sessionId",
  );
  assert.notEqual(branchId, String(first), "creating a branch switches to it");
  await sessionMenu(branchId);
  await until("!!document.querySelector('.session-menu')");
  assert.equal(
    await evaluate(
      "document.querySelector('.session-menu [data-command=rewind]').disabled",
    ),
    true,
    "a branch without a native transcript cannot be rewound",
  );
  assert(
    await evaluate(
      "document.querySelector('.session-menu [data-command=rewind]').title.includes('原生')",
    ),
    "the disabled rewind explains why it is unavailable",
  );
  await evaluate(
    "document.querySelector('.session-menu [data-command=tree]').click()",
  );
  await until("document.querySelector('#view-extensions').hidden===false");
  await evaluate("document.querySelector('[data-view=workspace]').click()");
  await until("document.querySelector('#view-workspace').hidden===false");
  await sessionMenu(first);
  await until("!!document.querySelector('.session-menu')");
  await evaluate(
    "document.querySelector('.session-menu [data-command=rewind]').click()",
  );
  await until("!document.querySelector('.session-menu')");
  await evaluate(
    `document.querySelector('[data-session-id="${first}"]').click()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent A'",
  );
  await until(
    "document.querySelector('#messages').innerText.includes('retry after network recovery')===false",
  );
  assert(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('draft A')",
    ),
    "the sidebar rewind keeps the earlier turns",
  );
  // SVG 轮次面板仍须保留历史路径；展示属性改变不能让旧回归跳过历史与动作归属。
  const treeRows = "#view-extensions [data-node-id]";
  await sessionMenu(first);
  await until("!!document.querySelector('.session-menu')");
  await evaluate(
    "document.querySelector('.session-menu [data-command=tree]').click()",
  );
  await until("!!document.querySelector('[data-branch-tree]')");
  // 容器先于异步读模型挂载，不能把骨架帧当作最终 SVG 结果。
  await until(`document.querySelectorAll('${treeRows}').length>=3`, {
    timeoutMs: 15000,
  });
  assert.equal(
    await evaluate(
      "!!document.querySelector('[data-branch-tree] svg [data-round-node]')",
    ),
    true,
    "分支树使用真实 SVG 轮次节点",
  );
  assert(
    await evaluate(
      `[...document.querySelectorAll('${treeRows}')].some((row)=>row.classList.contains('is-active'))`,
    ),
    "the tree marks the active path",
  );
  assert(
    await evaluate(
      `[...document.querySelectorAll('${treeRows}')].some((row)=>row.dataset.active==='false' && row.getAttribute('aria-label').includes('retry after network recovery'))`,
    ),
    "SVG 仍显示已放弃的恢复提问轮次",
  );
  assert.equal(
    await evaluate(
      `document.querySelectorAll('${treeRows}[data-current=true]').length`,
    ),
    1,
    "树恰有一个当前位置",
  );
  assert(
    await evaluate(
      `document.querySelector('${treeRows}[data-current=true] .branch-round-number')?.textContent.includes('当前位置')`,
    ),
    "当前位置轮次携带可见标记",
  );
  const toggle = "#view-extensions [data-toggle-node]:not(:disabled)";
  const rowsBefore = await evaluate(
    `document.querySelectorAll('${treeRows}').length`,
  );
  await evaluate(
    `document.querySelector('${toggle}').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
  );
  const rowsCollapsed = await evaluate(
    `document.querySelectorAll('${treeRows}').length`,
  );
  assert(rowsCollapsed < rowsBefore, "collapsing hides the subtree");
  await evaluate(
    "document.querySelector('#view-extensions [data-branch-refresh]').click()",
  );
  await until(
    `document.querySelectorAll('${treeRows}').length===${rowsCollapsed}`,
  );
  assert.equal(
    await evaluate(`document.querySelectorAll('${treeRows}').length`),
    rowsCollapsed,
    "a refresh keeps the collapsed state",
  );
  await evaluate(
    `document.querySelector('${toggle}').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
  );
  await until(
    `document.querySelectorAll('${treeRows}').length===${rowsBefore}`,
  );
  // 面板自己的滚动位置在刷新后保持（不依赖工作台套件的通用假设）。
  const scrollProof = JSON.parse(
    await evaluate(`(() => {
      const detail = document.querySelector('#view-extensions .extension-page-detail');
      const canScroll = detail.scrollHeight > detail.clientHeight + 40;
      if (canScroll) detail.scrollTop = 40;
      return JSON.stringify({ canScroll, scrollTop: detail.scrollTop });
    })()`),
  );
  await evaluate(
    "document.querySelector('#view-extensions [data-branch-refresh]').click()",
  );
  await until(`document.querySelectorAll('${treeRows}').length>=1`);
  const scrollAfter = await evaluate(
    "document.querySelector('#view-extensions .extension-page-detail').scrollTop",
  );
  assert(
    !scrollProof.canScroll || scrollAfter >= 40,
    `a tree refresh keeps the panel scroll position (${scrollProof.scrollTop} → ${scrollAfter})`,
  );
  const sessionsBefore = await evaluate(
    "document.querySelectorAll('#sessions [data-session-id]').length",
  );
  await evaluate(
    "[...document.querySelectorAll('#view-extensions [data-branch-action=fork]')].find((button)=>!button.disabled).click()",
  );
  await until(
    `document.querySelectorAll('#sessions [data-session-id]').length===${sessionsBefore + 1}`,
  );
  await until(
    "document.querySelector('#session-title').textContent.includes('分支')",
  );
  await evaluate("document.querySelector('[data-view=workspace]').click()");
  await until("document.querySelector('#view-workspace').hidden===false");
  await evaluate(
    `document.querySelector('[data-session-id="${first}"]').click()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent A'",
  );
  await sessionMenu(first);
  await until("!!document.querySelector('.session-menu')");
  await evaluate(
    "document.querySelector('.session-menu [data-command=tree]').click()",
  );
  await until("!!document.querySelector('[data-branch-tree]')");
  const rowsBeforeRewind = await evaluate(
    `document.querySelectorAll('${treeRows}').length`,
  );
  const rewindRound = await evaluate(`(() => {
    const node=document.querySelector('${treeRows}[data-current=false]');
    const id=node.dataset.roundNode;
    node.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    return id;
  })()`);
  assert.equal(
    await evaluate(
      "!!document.querySelector('#view-extensions [data-round-node][aria-selected=true] [data-branch-action=fork]')",
    ),
    false,
    "历史轮次不能直接创建分支",
  );
  await evaluate(
    "document.querySelector('#view-extensions [data-round-node][aria-selected=true] [data-branch-action=rewind]').click()",
  );
  await until(
    `document.querySelector('${treeRows}[data-current=true]')?.dataset.roundNode===${JSON.stringify(rewindRound)}`,
  );
  assert.equal(
    await evaluate(`document.querySelectorAll('${treeRows}').length`),
    rowsBeforeRewind,
    "退回只移动当前位置，不删除历史轮次",
  );
  assert(
    await evaluate(
      `[...document.querySelectorAll('${treeRows}')].some((row)=>row.dataset.active==='false')`,
    ),
    "the tree still distinguishes the abandoned path after a rewind from a node",
  );
  // 任务与子代理面板：空态、等待、两步确认取消与切 Agent 跟随（都用真实的在跑任务观察）。
  const taskRows = "#view-extensions [data-task-id]";
  const toolRow = "[data-task-panel] [data-tool-name=bash]";
  await evaluate(
    `document.querySelector('[data-extension-key="desktop:task-panel"]').click()`,
  );
  await until("!!document.querySelector('[data-task-panel]')");
  await until("!!document.querySelector('.task-panel-empty')");
  assert(
    await evaluate("!!document.querySelector('.task-panel-empty')"),
    "an idle agent shows the task panel's empty state",
  );
  const bashCall = (id, command) =>
    fauxAssistantMessage(
      [{ type: "toolCall", id, name: "bash", arguments: { command } }],
      { stopReason: "toolUse" },
    );

  // 等待：面板上的等待按钮触发 wait，返回时回答已经提交、面板回到空态。
  faux.setResponses([
    bashCall("call-bash-wait", "sleep 4"),
    fauxAssistantMessage("等待后的回答"),
  ]);
  await evaluate(
    "document.querySelector('#prompt').value='等一个任务';document.querySelector('#composer').requestSubmit()",
  );
  await until(`!!document.querySelector('${toolRow}')`, { timeoutMs: 20000 });
  const waitButton = await evaluate(
    "document.querySelector('#view-extensions [data-task-action^=wait]')?.dataset.taskAction ?? ''",
  );
  assert(waitButton.startsWith("wait:"), "the task row offers a wait action");
  await evaluate(
    `document.querySelector('[data-task-action="${waitButton}"]').click()`,
  );
  await until(
    "document.querySelector('#messages').innerText.includes('等待后的回答') && document.querySelector('#stop-button').hidden===true",
    { timeoutMs: 20000 },
  );
  await until("!!document.querySelector('.task-panel-empty')", {
    timeoutMs: 20000,
  });

  // 取消：第一步只进入待确认状态，第二步才发出命令，随后任务图清空。
  faux.setResponses([bashCall("call-bash-cancel", "sleep 6")]);
  await evaluate(
    "document.querySelector('#prompt').value='跑一个长命令';document.querySelector('#composer').requestSubmit()",
  );
  await until(`!!document.querySelector('${toolRow}')`, { timeoutMs: 20000 });
  assert(
    await evaluate(`document.querySelectorAll('${taskRows}').length>=1`),
    "the running tool shows up as a live task row",
  );
  const cancelButton = await evaluate(
    "document.querySelector('#view-extensions [data-task-action^=cancel]')?.dataset.taskAction ?? ''",
  );
  assert(
    cancelButton.startsWith("cancel:"),
    "the task row offers a cancel action",
  );
  await evaluate(
    `document.querySelector('[data-task-action="${cancelButton}"]').click()`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-task-action="${cancelButton}"]').dataset.armed`,
    ),
    "true",
    "the first click only arms the cancel",
  );
  assert(
    await evaluate(`document.querySelectorAll('${taskRows}').length>=1`),
    "an armed cancel does not touch the task yet",
  );
  await evaluate(
    `document.querySelector('[data-task-action="${cancelButton}"]').click()`,
  );
  await until("document.querySelector('#stop-button').hidden===true", {
    timeoutMs: 20000,
  });
  await until("!!document.querySelector('.task-panel-empty')", {
    timeoutMs: 20000,
  });
  assert.equal(
    await evaluate(`document.querySelectorAll('${taskRows}').length`),
    0,
    "cancelling the tool task drains the panel",
  );

  // 真实后台任务：面板显示后台标记，顶部「取消后台任务」两步确认后把它终结。
  faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "call-anchor",
          name: "background_work",
          arguments: {},
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("后台已派生"),
  ]);
  await evaluate(
    "document.querySelector('#prompt').value='派生一个后台任务';document.querySelector('#composer').requestSubmit()",
  );
  await until(
    "document.querySelector('#messages').innerText.includes('后台已派生') && document.querySelector('#stop-button').hidden===true",
    { timeoutMs: 20000 },
  );
  await until(
    "!!document.querySelector('#view-extensions [data-task-action=background]')",
    { timeoutMs: 20000 },
  );
  assert(
    await evaluate(
      "!!document.querySelector('#view-extensions [data-task-id] .tag') && [...document.querySelectorAll('#view-extensions [data-task-id] .tag')].some((node)=>node.textContent==='后台')",
    ),
    "the background task is marked in the panel",
  );
  await evaluate(
    "document.querySelector('#view-extensions [data-task-action=background]').click()",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('#view-extensions [data-task-action=background]').dataset.armed",
    ),
    "true",
    "the first click only arms the background cancel",
  );
  assert(
    await evaluate(
      "!!document.querySelector('#view-extensions [data-task-action=background]')",
    ),
    "an armed background cancel does not run yet",
  );
  await evaluate(
    "document.querySelector('#view-extensions [data-task-action=background]').click()",
  );
  await until("!!document.querySelector('.task-panel-empty')", {
    timeoutMs: 20000,
  });
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#view-extensions [data-task-id]').length",
    ),
    0,
    "cancelling the background task drains the task graph",
  );

  // 切换 Agent：工作台切换会话会重置选中页面（既有行为），重新打开面板后要看到
  // Agent B 自己的在跑任务，才算面板真的跟随了当前会话。
  const secondAgent = (await workspace.read()).agents.find(
    (agent) => agent.name === "Agent B",
  ).id;
  await evaluate(
    `document.querySelector('[data-session-id="${secondAgent}"]').click()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent B'",
  );
  faux.setResponses([bashCall("call-bash-b", "sleep 5")]);
  await evaluate(
    "document.querySelector('#prompt').value='B 的任务';document.querySelector('#composer').requestSubmit()",
  );
  await evaluate(
    `document.querySelector('[data-extension-key="desktop:task-panel"]').click()`,
  );
  await until("!!document.querySelector('[data-task-panel]')");
  await until(`!!document.querySelector('${toolRow}')`, { timeoutMs: 20000 });
  assert.equal(
    await evaluate("document.querySelector('.task-panel')?.dataset.taskPanel"),
    String(secondAgent),
    "the panel follows the selected agent",
  );
  await evaluate(
    `document.querySelector('[data-session-id="${first}"]').click()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Agent A'",
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    `Durable Chromium passed: project creation, independent drafts, background streaming, configuration, 320/360/390px; screenshot ${screenshot}`,
  );
} finally {
  driver?.close();
  if (browser && browser.exitCode === null)
    await new Promise((resolve) => {
      browser.once("exit", resolve);
      browser.kill();
    });
  await app?.stop();
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
