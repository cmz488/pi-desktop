import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const scratch = await mkdtemp(join(tmpdir(), "pi-desk-runtime-"));
const desktopRecord = join(scratch, "desktop.json");
const fakeElectron = join(scratch, "electron-fixture.mjs");
await writeFile(
  fakeElectron,
  `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(desktopRecord)}, JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));\nsetInterval(()=>{},1000);\n`,
);
await chmod(fakeElectron, 0o700);
await writeFile(join(scratch, "README.md"), "shared native workspace");
let modelRequests = 0;
const endpoint = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  modelRequests++;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "first", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  if (!input.messages.some((message) => message.role === "tool")) {
    send({
      role: "assistant",
      reasoning_content: "Read the shared workspace.",
    });
    send({
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "shared-read",
          type: "function",
          function: {
            name: "read",
            arguments: JSON.stringify({ path: "README.md" }),
          },
        },
      ],
    });
    send({}, "tool_calls");
  } else {
    send({ role: "assistant", content: "Shared answer from Pi-Agent." });
    send({}, "stop");
  }
  response.write(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "first", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(scratch, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-only",
        models: [
          {
            id: "first",
            name: "First",
            reasoning: true,
            contextWindow: 16000,
            maxTokens: 1000,
          },
          {
            id: "second",
            name: "Second",
            reasoning: true,
            contextWindow: 16000,
            maxTokens: 1000,
          },
        ],
      },
    },
  }),
);
await writeFile(
  join(scratch, "settings.json"),
  JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "first",
    cacheWarming: "off",
  }),
);
let desktopPid;
const processPi = spawn(
  "pi",
  [
    "--mode",
    "rpc",
    "--no-extensions",
    "-e",
    fileURLToPath(new URL("../index.ts", import.meta.url)),
  ],
  {
    cwd: scratch,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: scratch,
      PI_DESK_HOST: "127.0.0.1",
      PI_DESK_PORT: "0",
      PI_DESK_TLS_CERT: "",
      PI_DESK_TLS_KEY: "",
      PI_DESK_ELECTRON: fakeElectron,
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const records = [],
  listeners = new Set();
let buffer = "",
  diagnostics = "";
processPi.stderr.on("data", (data) => {
  diagnostics += data.toString();
});
processPi.stdout.on("data", (data) => {
  buffer += data.toString();
  let end;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    records.push(record);
    for (const listener of listeners) listener(record);
  }
});
const wait = (predicate) =>
  new Promise((resolve, reject) => {
    const found = records.find(predicate);
    if (found) {
      resolve(found);
      return;
    }
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(
        new Error(
          `Pi RPC 未按时响应${diagnostics ? "，请检查本机运行环境" : ""}`,
        ),
      );
    }, 20000);
    const listener = (record) => {
      if (!predicate(record)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(record);
    };
    listeners.add(listener);
  });
const command = async (type, extra = {}) => {
  const id = crypto.randomUUID();
  processPi.stdin.write(`${JSON.stringify({ type, id, ...extra })}\n`);
  return wait((record) => record.type === "response" && record.id === id);
};
try {
  const commands = await command("get_commands");
  assert(commands.success);
  assert(
    commands.data.commands.some((item) => item.name === "desk"),
    "未加载 desk 扩展命令",
  );
  const started = await command("prompt", { message: "/desk" });
  assert(started.success);
  const notice = await wait(
    (record) =>
      record.type === "extension_ui_request" &&
      record.method === "notify" &&
      record.message?.includes("http"),
  );
  const address = new URL(notice.message.match(/https?:\/\/[^\s]+/)[0]);
  assert.equal(address.hash, "");
  const response = await fetch(`${address.origin}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert(state.sessionId);
  assert(state.version);
  assert.equal(state.cwd, scratch);
  assert(!("role" in state));
  for (let i = 0; i < 100; i++) {
    try {
      const desktop = JSON.parse(await readFile(desktopRecord, "utf8"));
      desktopPid = desktop.pid;
      assert.equal(desktop.args.at(-1), address.href);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert(
    desktopPid,
    "/desk must launch a Desktop frontend, not only print a URL",
  );
  assert.equal(state.host, "tui");
  assert.equal(state.backend.pid, processPi.pid);
  const getState = async () =>
    (await fetch(`${address.origin}/api/state`)).json();
  const post = async (path, data) =>
    fetch(address.origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const waitState = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      const value = await getState();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Shared backend state did not converge");
  };
  assert(
    (await command("set_model", { provider: "fixture", modelId: "second" }))
      .success,
  );
  await waitState((value) => value.model.id === "second");
  assert.equal(
    (await post("/api/model", { provider: "fixture", id: "first" })).status,
    200,
  );
  assert.equal((await command("get_state")).data.model.id, "first");
  assert((await command("set_thinking_level", { level: "high" })).success);
  await waitState((value) => value.thinkingLevel === "high");
  assert.equal((await post("/api/thinking", { level: "low" })).status, 200);
  assert.equal((await command("get_state")).data.thinkingLevel, "low");
  assert(
    (await command("set_session_name", { name: "Shared native session" }))
      .success,
  );
  await waitState((value) => value.name === "Shared native session");
  const streamAbort = new AbortController();
  const stream = await fetch(
    `${address.origin}/api/events?epoch=${state.epoch}&after=${state.seq}`,
    { signal: streamAbort.signal },
  );
  const reader = stream.body.getReader();
  await reader.read();
  const originalBackend = state.backend.id;
  const originalEpoch = state.epoch;
  assert.equal(
    (await post("/api/prompt", { message: "Read README.md from phone" }))
      .status,
    200,
  );
  const completed = await waitState(
    (value) =>
      value.idle &&
      value.messages.some((message) =>
        message.text.includes("Shared answer from Pi-Agent."),
      ),
  );
  assert(
    completed.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.text.includes("shared native workspace"),
    ),
  );
  assert(
    completed.activeCalls.some(
      (call) => call.name === "read" && call.status === "complete",
    ),
  );
  assert(modelRequests >= 2);
  assert.deepEqual(completed.stats, (await command("get_session_stats")).data);
  const savedSession = (await command("get_state")).data;
  assert(savedSession.sessionFile);
  assert((await command("new_session")).success);
  const nativeNew = (await command("get_state")).data;
  const afterNative = await waitState(
    (value) => value.sessionId === nativeNew.sessionId,
  );
  assert.equal(
    afterNative.epoch,
    originalEpoch,
    "Native session replacement must not replace the event server",
  );
  assert.equal(afterNative.backend.id, originalBackend);
  assert.equal((await post("/api/new-session", {})).status, 200);
  const afterWeb = await getState();
  assert.notEqual(afterWeb.sessionId, afterNative.sessionId);
  assert.equal(
    (await command("get_state")).data.sessionId,
    afterNative.sessionId,
    "Managed new must not replace the native RPC slot",
  );
  assert.equal(afterWeb.epoch, originalEpoch);
  streamAbort.abort();
  assert.equal(
    (await post("/api/prompt", { message: "/name Named from phone" })).status,
    200,
  );
  await waitState((value) => value.name === "Named from phone");
  assert.notEqual(
    (await command("get_state")).data.sessionName,
    "Named from phone",
    "Naming a managed slot must not rename the original native slot",
  );
  assert.equal(
    (await post("/api/switch-session", { id: savedSession.sessionId })).status,
    200,
  );
  assert.equal(
    (await command("get_state")).data.sessionId,
    afterNative.sessionId,
    "Historical recovery opens a managed writer, not a destructive native replacement",
  );
  assert.equal((await getState()).sessionId, savedSession.sessionId);
  assert.equal((await post("/api/reload", {})).status, 200);
  const afterReload = await getState();
  assert.equal(afterReload.backend.id, originalBackend);
  assert.equal(afterReload.epoch, originalEpoch);
  const nativeThinking = (await command("get_state")).data.thinkingLevel;
  assert.equal((await post("/api/thinking", { level: "medium" })).status, 200);
  assert.equal((await getState()).thinkingLevel, "medium");
  assert.equal(
    (await command("get_state")).data.thinkingLevel,
    nativeThinking,
    "Managed thinking settings are per slot",
  );
  assert.equal(
    (await post("/api/switch-session", { id: afterNative.sessionId })).status,
    200,
  );
  assert.equal((await post("/api/thinking", { level: "high" })).status, 200);
  assert.equal((await command("get_state")).data.thinkingLevel, "high");
  assert.equal(
    (await post("/api/switch-session", { id: savedSession.sessionId })).status,
    200,
  );
  process.kill(desktopPid, "SIGTERM");
  desktopPid = undefined;
  assert.equal(
    (await getState()).sessionId,
    savedSession.sessionId,
    "Closing a frontend cannot dispose Pi-Agent",
  );
  const stopped = await command("prompt", { message: "/desk stop" });
  assert(stopped.success);
  console.log(
    `Pi ${state.version}：Desktop 启动夹具、原生/Web 双向模型与思考、真实工具流、原生替换与托管创建/恢复/切换/reload 保留同一后端与连接，托管名称和思考不污染原生 slot、前端关闭不停止 Agent 均通过；仅调用本地模型夹具。`,
  );
} finally {
  if (desktopPid) {
    try {
      process.kill(desktopPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  processPi.stdin.end();
  const exited = new Promise((resolve) => processPi.once("exit", resolve));
  const timeout = setTimeout(() => processPi.kill("SIGTERM"), 3000);
  await exited;
  clearTimeout(timeout);
  await new Promise((resolve) => {
    endpoint.close(resolve);
    endpoint.closeAllConnections();
  });
  await rm(scratch, { recursive: true, force: true });
}
