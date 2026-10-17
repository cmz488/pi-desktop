import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { publicAssets } from "../src/server/web-assets.mjs";
import { assetFile } from "../src/server/asset-manifest.mjs";
import { browserDriver } from "./durable-browser-driver.mjs";
import { projectMessage } from "../src/shared/conversation.mjs";
import { chatSnapshot } from "../src/shared/lazy-data.mjs";

// Exercise the actual renderer in an isolated page, without touching a desktop
// process or loading any real sessions, credentials or providers.
const source = await readFile(
  new URL("../src/ui/chat/chat.js", import.meta.url),
  "utf8",
);
const renderer = source.slice(
  source.indexOf("const disclosures = new Map();"),
  source.indexOf("function renderSessions()"),
);
const utilities = source.slice(
  source.indexOf("const $ = (selector)"),
  source.indexOf("const live ="),
);
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/prototype.css"></head><body><div style="display:flex;gap:12px;align-items:flex-start"><div id="messages" style="width:420px;height:600px;overflow:auto"></div><aside id="extension-rail" hidden><div id="extension-rail-list"></div></aside></div><script type="module">
import { renderMarkdown } from '/markdown.mjs';
import { projectConversationTimeline } from '/lazy-data.mjs';
import { extensionAdapterRegistry } from '/extension-adapters.mjs';
${utilities}
let state = {sessionId:'fixture',idle:true}, messageRows=[], streaming, activeInteraction;
const activeCalls=new Map(), piLogo='PI', icon=()=>'<svg></svg>', toast=(message)=>{throw new Error(message)};
let loaded=[], messageDetails=new Map();
async function loadMessageDetails(ids) {
  loaded.push(...ids);
  messageRows=messageRows.map(row=>ids.includes(String(row.id)) ? messageDetails.has(String(row.id)) ? {...row,...messageDetails.get(String(row.id)),lazy:false} : {...row,lazy:false,blocks:row.blocks?.map(block=>({...block,text:block.type==='thinking'?block.text+' DETAIL_END':block.text})),text:row.role==='toolResult'?'RESULT_DETAIL_END':row.text} : row);
  renderMessages(messageRows);
}
${renderer}
window.conversationFixture={
  render(rows,nextState={},enter=false) {state={sessionId:'fixture',idle:true,...nextState};messageDetails=new Map(nextState.messageDetails??[]);activeInteraction=nextState.interaction;activeCalls.clear();for(const call of nextState.activeCalls??[])activeCalls.set(call.id,call);renderMessages(rows,{enter});},
  stream(message) {state.streamingMessage=message;state.phase='thinking';state.idle=false;renderLiveConversation();},
  loading() {state={sessionId:'fixture',idle:false,initializing:true};renderMessages([]);},
  get loaded(){return loaded;}
};
</script></body></html>`;
const assets = publicAssets("chat");

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }
    const asset = assets.get(path);
    if (!asset) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": asset[1] });
    res.end(await readFile(assetFile(asset[0])));
  } catch (error) {
    res.writeHead(500);
    res.end(error.message);
  }
});
const root = await mkdtemp(join(tmpdir(), "pi-timeline-browser-"));
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
  await call("Page.navigate", {
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  await until("!!window.conversationFixture");
  await evaluate(`conversationFixture.render([
    {role:'user',id:'durable-user',text:'question'}
  ],{idle:false,phase:'thinking',streamingMessage:{id:'partial',role:'assistant',blocks:[{type:'thinking',text:'Durable live thought'}]}})`);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.conversation-activity').length",
    ),
    0,
    "A Durable partial thought must animate its fold without a second status line",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.context-activity[data-running=true] .activity-progress').length",
    ),
    1,
    "The current Durable thinking fold must show flowing highlights",
  );
  const durableOffset = await evaluate(
    "Number(document.querySelector('.context-activity .activity-progress').dataset.animationElapsed)",
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  await evaluate(
    `conversationFixture.stream({id:'partial',role:'assistant',blocks:[{type:'thinking',text:'Durable thought update'}]})`,
  );
  await until(
    "document.querySelector('.thinking-detail')?.textContent.includes('Durable thought update')",
  );
  assert(
    (await evaluate(
      "Number(document.querySelector('.context-activity .activity-progress').dataset.animationElapsed)",
    )) >
      durableOffset + 150,
    "Durable streaming redraws must preserve the highlight animation phase",
  );
  await evaluate(`conversationFixture.stream({id:'partial',role:'assistant',blocks:[
    {type:'thinking',text:'completed reasoning'},
    {type:'text',text:'Interim output'},
    {type:'thinking',text:'current reasoning'}
  ]})`);
  await until("document.querySelectorAll('.context-activity').length===2");
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.context-activity .activity-progress').length",
    ),
    1,
    "Only the last activity in a Durable partial message may animate",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.context-activity').dataset.running",
    ),
    "false",
    "An earlier fold in the same streaming message must stop animating",
  );
  await evaluate(`conversationFixture.render([
    {role:'user',id:'durable-user',text:'question'},
    {role:'assistant',id:'durable-complete',blocks:[{type:'thinking',text:'completed reasoning'}]}
  ],{idle:true,phase:'thinking'})`);
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.activity-progress, .conversation-activity').length",
    ),
    0,
    "Completing a Durable thought removes its live highlight and status",
  );
  const rows = [
    { role: "user", id: "u", text: "question" },
    {
      role: "assistant",
      id: "a",
      lazy: true,
      blocks: [{ type: "thinking", text: "first thought" }],
    },
    {
      role: "assistant",
      id: "b",
      blocks: [
        { type: "thinking", text: "second thought" },
        { type: "text", text: "Intermediate progress" },
        {
          type: "toolCall",
          id: "call",
          name: "read",
          arguments: '{"path":"README.md"}',
        },
        { type: "thinking", text: "tool follow-up" },
      ],
    },
    {
      role: "toolResult",
      id: "r",
      toolCallId: "call",
      lazy: true,
      text: "result preview",
    },
    {
      role: "assistant",
      id: "c",
      blocks: [{ type: "text", text: "Final output" }],
    },
  ];
  await evaluate(`conversationFixture.render(${JSON.stringify(rows)})`);
  assert.deepEqual(
    await evaluate(
      "[...document.querySelector('.assistant-turn .message-body').children].slice(1).map(node=>node.querySelector('.context-activity')?'activity':'text')",
    ),
    ["activity", "text", "activity", "text"],
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.thinking-detail').length"),
    2,
  );
  assert(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('Intermediate progress') && document.querySelector('#messages').innerText.includes('Final output')",
    ),
  );
  assert(
    await evaluate(
      "[...document.querySelectorAll('.thinking-detail, .tool-details')].every(node=>!node.checkVisibility())",
    ),
  );
  assert.equal(
    await evaluate("document.querySelectorAll('details[open]').length"),
    0,
  );
  assert(
    await evaluate(
      "[...document.querySelectorAll('.context-activity > summary')].every(node=>!node.textContent.includes('次工具调用')&&!node.textContent.includes('已记录'))",
    ),
    "Folded activity summaries should omit tool counts and recorded-state filler",
  );
  assert(
    await evaluate(
      "!document.querySelector('.process-entry').querySelector('details')",
    ),
  );
  const height = await evaluate(
    "document.querySelector('.context-activity > summary').getBoundingClientRect().height",
  );
  assert(height <= 32, `activity summary wrapped: ${height}`);
  await evaluate(
    "document.querySelector('.context-activity > summary').click()",
  );
  await until(
    "document.querySelector('.context-activity[open] .thinking-detail').innerText.includes('DETAIL_END')",
  );
  assert(
    await evaluate(
      "document.querySelector('.context-activity[open]').innerText.includes('second thought')",
    ),
  );
  assert.deepEqual(await evaluate("conversationFixture.loaded"), ["a"]);
  await evaluate(
    "document.querySelectorAll('.context-activity > summary')[1].click()",
  );
  await until("conversationFixture.loaded.includes('r')");
  await evaluate("document.querySelector('.tool-card > summary').click()");
  await until(
    "document.querySelector('.tool-card[open]').innerText.includes('RESULT_DETAIL_END')",
  );
  assert(
    await evaluate(
      "document.querySelector('.tool-card[open]').innerText.includes('README.md')",
    ),
  );

  await evaluate(
    `conversationFixture.render([{role:'user',id:'live-user',text:'live question'},{role:'assistant',id:'persisted',blocks:[{type:'thinking',text:'persisted thought'}]}]);conversationFixture.stream({id:'streaming',role:'assistant',blocks:[{type:'thinking',text:'live thought'}]})`,
  );
  await until(
    "document.querySelector('.thinking-detail')?.textContent.includes('live thought')",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.context-activity').length"),
    1,
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.thinking-detail').length"),
    1,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.conversation-activity').length",
    ),
    0,
  );
  await evaluate(
    "document.querySelector('.context-activity').open=true;conversationFixture.stream({id:'streaming',role:'assistant',blocks:[{type:'thinking',text:'updated live thought'}]})",
  );
  await until(
    "document.querySelector('.context-activity[open]')?.innerText.includes('updated live thought')",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.thinking-detail').length"),
    1,
  );
  assert(
    await evaluate(
      "document.querySelector('.thinking-detail').textContent.includes('persisted thought')",
    ),
  );
  await evaluate(
    "conversationFixture.stream({id:'streaming',role:'assistant',blocks:[{type:'thinking',text:'completed live thought'},{type:'text',text:'Streamed output'}]})",
  );
  await until(
    "document.querySelector('#messages').innerText.includes('Streamed output')",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.context-activity').length"),
    1,
  );
  await evaluate(
    "conversationFixture.render([{role:'user',id:'u',text:'question'},{role:'assistant',id:'a',blocks:[{type:'thinking',text:'previous thought'}]}],{idle:false,phase:'thinking'})",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.context-activity').length"),
    1,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.conversation-activity').length",
    ),
    0,
  );
  assert(
    await evaluate(
      "document.querySelector('.context-activity').dataset.running==='true'",
    ),
  );
  assert(
    await evaluate(
      "document.querySelector('.context-activity .activity-progress')?.getAttribute('aria-label')==='思考中' && !document.querySelector('.context-activity .activity-spinner') && getComputedStyle(document.querySelector('.activity-progress > span')).animationName==='activity-highlight' && !document.querySelector('.context-activity > summary').textContent.includes('Pi 正在')",
    ),
    "Running folded context should show only the concise thinking label with sequential highlighting",
  );
  const firstAnimationOffset = await evaluate(
    "Number(document.querySelector('.context-activity .activity-progress').dataset.animationElapsed)",
  );
  await new Promise((resolve) => setTimeout(resolve, 220));
  await evaluate(
    "conversationFixture.stream({id:'streaming',role:'assistant',blocks:[{type:'thinking',text:'still thinking'}]})",
  );
  await until(
    "document.querySelector('.context-activity .thinking-detail')?.textContent.includes('still thinking')",
  );
  const nextAnimationOffset = await evaluate(
    "Number(document.querySelector('.context-activity .activity-progress').dataset.animationElapsed)",
  );
  assert(
    nextAnimationOffset > firstAnimationOffset + 150,
    `Activity animation restarted on update: ${firstAnimationOffset} -> ${nextAnimationOffset}`,
  );
  assert(
    await evaluate(
      "parseFloat(getComputedStyle(document.querySelector('.activity-progress > span')).animationDelay)<0",
    ),
    "Rerendered activity text should retain its elapsed animation phase",
  );
  const thinkingRows = [
    { role: "user", id: "multi-thought-user", text: "explain" },
    {
      role: "assistant",
      id: "multi-thought-assistant",
      blocks: [
        { type: "thinking", text: "earlier thought" },
        { type: "text", text: "A short response between thoughts." },
        { type: "thinking", text: "latest persisted thought" },
      ],
    },
  ];
  await evaluate(
    `conversationFixture.render(${JSON.stringify(thinkingRows)},{idle:false,phase:'thinking'})`,
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.context-activity').length"),
    2,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.context-activity .activity-progress').length",
    ),
    1,
    "Only the fold containing the current streaming thought should animate",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.context-activity')[0].querySelector('.activity-progress')",
    ),
    null,
    "An earlier thinking fold must remain static",
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.context-activity')[1].querySelector('.activity-progress')?.getAttribute('aria-label')",
    ),
    "思考中",
  );
  await evaluate(
    `conversationFixture.render(${JSON.stringify(thinkingRows)},{idle:true,phase:'thinking'})`,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.context-activity .activity-progress').length",
    ),
    0,
    "Idle thinking folds must not keep animating from a stale thinking phase",
  );
  await evaluate(`conversationFixture.render([
    {role:'user',id:'bash-user',text:'run script'},
    {role:'assistant',id:'bash-assistant',blocks:[{type:'toolCall',id:'running-bash',name:'bash',arguments:JSON.stringify({command:'python3 scripts/rebuild_index.py --verbose --check-all'})}]}
  ],{idle:false,activeCalls:[{id:'running-bash',name:'bash',status:'running',arguments:JSON.stringify({command:'python3 scripts/rebuild_index.py --verbose --check-all'})}]})`);
  const commandLabel = await evaluate(
    "document.querySelector('.context-activity .activity-progress')?.getAttribute('aria-label')",
  );
  assert(
    commandLabel.startsWith("python3 scripts/rebuild_index.py") &&
      commandLabel.length <= 48,
    `Running commands should show only a short command preview: ${commandLabel}`,
  );
  assert(
    await evaluate(
      "![...document.querySelector('.context-activity > summary').textContent.matchAll(/次工具调用|已记录|正在处理|Pi 正在/g)].length",
    ),
    "Running command summaries should not include redundant status labels",
  );
  await evaluate(`conversationFixture.render([
    {role:'user',id:'mixed-user',text:'run scripts'},
    {role:'assistant',id:'mixed-tools',blocks:[
      {type:'toolCall',id:'failed-call',name:'bash',arguments:JSON.stringify({command:'python3 scripts/old_check.py'})},
      {type:'toolCall',id:'current-call',name:'bash',arguments:JSON.stringify({command:'python3 scripts/current_task.py --verify'})}
    ]},
    {role:'toolResult',id:'failed-result',toolCallId:'failed-call',toolName:'bash',isError:true,text:'old tool failed'}
  ],{idle:false,phase:'output',activeCalls:[
    {id:'failed-call',name:'bash',status:'error',isError:true},
    {id:'current-call',name:'bash',status:'running',arguments:JSON.stringify({command:'python3 scripts/current_task.py --verify'})}
  ]})`);
  assert.equal(
    await evaluate(
      "document.querySelector('.context-activity .activity-progress')?.getAttribute('aria-label')",
    ),
    "python3 scripts/current_task.py --verify",
    "The fold should summarize the active command even if an earlier tool failed",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.context-activity').classList.contains('error')",
    ),
    false,
    "An individual failed tool must not fail its grouped activity row",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.tool-card.error').length"),
    1,
    "The failed tool keeps its own error status",
  );
  await evaluate(`conversationFixture.render([
    {role:'user',id:'waiting-user',text:'continue'},
    {role:'assistant',id:'waiting-assistant',blocks:[{type:'thinking',text:'waiting for confirmation'}]}
  ],{idle:false,phase:'output',operation:'等待用户确认…'})`);
  assert.equal(
    await evaluate(
      "document.querySelector('.context-activity .activity-progress')?.getAttribute('aria-label')",
    ),
    "等待中",
    "The fold should use the Pi Agent wait state when no tool is running",
  );
  await evaluate(`conversationFixture.render([
    {role:'user',id:'interaction-user',text:'answer'},
    {role:'assistant',id:'interaction-assistant',blocks:[{type:'thinking',text:'waiting for a reply'}]}
  ],{idle:false,phase:'output',interaction:{status:'running'}})`);
  assert.equal(
    await evaluate(
      "document.querySelector('.context-activity .activity-progress')?.getAttribute('aria-label')",
    ),
    "等待回复",
  );
  await evaluate(
    "conversationFixture.render([],{idle:false,phase:'output',operation:'Pi 正在处理'})",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.context-activity .activity-progress')?.getAttribute('aria-label')",
    ),
    "生成中",
  );
  assert(
    await evaluate(
      "!document.querySelector('.conversation-activity') && document.querySelectorAll('.context-activity').length===1 && !document.querySelector('.context-activity > summary').textContent.includes('Pi 正在')",
    ),
    "Processing without message blocks must use one folded activity, never a standalone status line",
  );
  await evaluate(
    `conversationFixture.render([{role:'assistant',id:'failure',blocks:[{type:'toolCall',id:'failed',name:'bash'}]},{role:'toolResult',id:'failure-result',toolCallId:'failed',isError:true,text:'tool failed'},{role:'assistant',id:'error',stopReason:'error',error:'provider unavailable',blocks:[]}])`,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.context-activity').classList.contains('error')",
    ),
    false,
    "A prior tool error does not turn the whole fold into an error",
  );
  assert(
    await evaluate(
      "document.querySelector('.tool-card.error .tool-outcome').textContent==='执行失败'",
    ),
    "The failed tool still shows its own failure label",
  );
  assert(
    await evaluate(
      "document.querySelector('[role=alert]').innerText.includes('provider unavailable')",
    ),
  );
  assert.equal(
    await evaluate(
      "document.querySelector('[role=alert]').closest('.context-activity')",
    ),
    null,
    "model request errors remain outside the foldable activity row",
  );
  assert(
    await evaluate(
      "(()=>{const color=getComputedStyle(document.querySelector('.model-request-error-label')).color.match(/\\d+/g).map(Number);return getComputedStyle(document.querySelector('.model-request-error')).display==='flex' && document.querySelector('.model-request-error').getBoundingClientRect().height<=32 && getComputedStyle(document.querySelector('.model-request-error-detail')).color===getComputedStyle(document.querySelector('.model-request-error-label')).color && color[0]>color[1] && color[0]>color[2]})()",
    ),
    "model request errors should use a compact red one-line treatment",
  );
  await evaluate(`conversationFixture.render([
    {role:'user',id:'old-user',text:'old question'},
    {role:'assistant',id:'old-assistant',blocks:[{type:'toolCall',id:'old-call',name:'read'}]},
    {role:'toolResult',id:'old-result',toolCallId:'old-call',text:'old result'},
    {role:'user',id:'new-user',text:'new question'},
    {role:'assistant',id:'new-assistant',blocks:[{type:'thinking',text:'current thought'}]}
  ],{activeCalls:[{id:'old-call',name:'read',status:'complete'}]});
  conversationFixture.stream({id:'streaming',role:'assistant',blocks:[{type:'thinking',text:'new live thought'}]})`);
  await until(
    "document.querySelector('#messages').textContent.includes('new live thought')",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.tool-card').length"),
    1,
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.assistant-turn').length"),
    2,
  );
  const fullGoal = projectMessage(
    {
      role: "toolResult",
      toolName: "get_goal",
      toolCallId: "goal-call",
      content: [{ type: "text", text: "goal result" }],
      details: {
        version: 3,
        goal: {
          objective: "Keep the current goal visible",
          status: "active",
          taskList: {
            tasks: [
              { id: "task", title: "TASK_DETAIL_END", status: "pending" },
            ],
          },
        },
      },
    },
    "goal-result",
  );
  const lazyGoal = chatSnapshot({ messages: [fullGoal] }).messages[0];
  const goalRows = [
    { role: "user", id: "goal-user", text: "start goal" },
    {
      role: "assistant",
      id: "goal-assistant",
      blocks: [
        { type: "toolCall", id: "goal-call", name: "get_goal" },
        { type: "text", text: "Earlier response remains" },
      ],
    },
    lazyGoal,
    { role: "user", id: "next-user", text: "next turn" },
    {
      role: "assistant",
      id: "next-assistant",
      blocks: [{ type: "thinking", text: "current thought" }],
    },
  ];
  await evaluate(
    `conversationFixture.render(${JSON.stringify(goalRows)},${JSON.stringify({ idle: false, phase: "thinking", messageDetails: [["goal-result", fullGoal]] })})`,
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.extension-state').length"),
    1,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.tool-card .extension-card').length",
    ),
    0,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.context-activity .activity-progress').length",
    ),
    1,
  );
  await evaluate("document.querySelector('.extension-state summary').click()");
  await until(
    "document.querySelector('.extension-state details[open]')?.innerText.includes('TASK_DETAIL_END')",
  );
  await evaluate(
    "conversationFixture.stream({id:'streaming',role:'assistant',blocks:[{type:'thinking',text:'GOAL_STREAM_UPDATE'}]})",
  );
  await until(
    "document.querySelector('#messages').textContent.includes('GOAL_STREAM_UPDATE')",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.extension-state').length"),
    1,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.extension-state details[open]').length",
    ),
    1,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('.context-activity .activity-progress').length",
    ),
    1,
  );
  assert(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('Earlier response remains')",
    ),
  );
  // Extension cards live on the rail, not in the transcript; the rail keeps the
  // same lazy-detail and disclosure behavior exercised above.
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#messages > .extension-state, #messages > [data-extension-card]').length",
    ),
    0,
  );
  assert.equal(
    await evaluate(
      "document.querySelectorAll('#extension-rail-list .extension-state').length",
    ),
    1,
  );
  assert(await evaluate("!document.querySelector('#extension-rail').hidden"));
  // A session switch shows a structural loading state, never the empty hero.
  await evaluate("conversationFixture.loading()");
  assert(
    await evaluate(
      "!!document.querySelector('#messages .conversation-loading') && !document.querySelector('.empty-conversation')",
    ),
    "Loading a conversation must render the skeleton instead of the demo/empty interface",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.conversation-loading-label').textContent",
    ),
    "正在载入会话…",
  );
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await evaluate("conversationFixture.loading()");
  assert.equal(
    await evaluate(
      "getComputedStyle(document.querySelector('.skeleton-row')).opacity",
    ),
    "1",
    "Reduced motion must still show the loading placeholder",
  );
  await call("Emulation.setEmulatedMedia", { features: [] });
  await evaluate(
    "conversationFixture.render([{role:'user',id:'after-load',text:'after load'}],{})",
  );
  assert(
    await evaluate(
      "!document.querySelector('.conversation-loading') && document.querySelector('#messages').innerText.includes('after load')",
    ),
  );
  // A real session switch staggers the visible rows in once.
  await evaluate(
    "conversationFixture.render([{role:'user',id:'enter-user',text:'switch question'},{role:'assistant',id:'enter-reply',text:'switch answer'}],{},true)",
  );
  assert(
    await evaluate(
      "document.querySelectorAll('.message.is-switch-enter').length===2",
    ),
    "A switched-to session must animate its rows in, staggered",
  );
  await evaluate(
    "conversationFixture.render([{role:'custom',id:'fallback',text:'EXTENSION_FALLBACK',extensionView:{adapterId:'missing',version:1}}],{sessionId:'another-agent'})",
  );
  assert.equal(
    await evaluate("document.querySelectorAll('.extension-state').length"),
    0,
  );
  assert(
    await evaluate(
      "document.querySelector('#messages').innerText.includes('EXTENSION_FALLBACK')",
    ),
  );
  assert.deepEqual(driver.errors, []);
  console.log(
    "Conversation timeline browser checks passed: chronology, folding, lazy details, live updates, extension rail placement, loading skeleton, disclosure recovery and fallback.",
  );
} catch (error) {
  console.error("Isolated browser errors:", driver?.errors);

  throw error;
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
