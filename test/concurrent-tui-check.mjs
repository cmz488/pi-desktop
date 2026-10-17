import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { concurrentFixture, until } from "./concurrent-fixture.mjs";
const model = await concurrentFixture({ reasoning: true });
// Real registration path: SDK children must exclude this host package, not recurse.
const settingsPath = join(model.agentDir, "settings.json");
await writeFile(
  settingsPath,
  JSON.stringify({
    ...JSON.parse(await readFile(settingsPath, "utf8")),
    packages: [fileURLToPath(new URL("../", import.meta.url))],
  }),
);
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const nativeFixture = join(model.root, "native-resume-fixture.ts");
await writeFile(
  nativeFixture,
  `import {SessionManager} from '@earendil-works/pi-coding-agent';
export default function(pi){pi.registerCommand('fixture-native-resume',{handler:async(id,ctx)=>{const row=(await SessionManager.list(ctx.cwd,ctx.sessionManager.getSessionDir())).find(row=>row.id===id);if(!row)throw new Error('fixture history missing');const result=await ctx.switchSession(row.path);ctx.ui.notify(result.cancelled?'managed-writer-guard-pass':'managed-writer-guard-fail','info');}});}`,
);
const args = [
  "pi",
  "--no-extensions",
  "-e",
  fileURLToPath(new URL("../index.ts", import.meta.url)),
  "-e",
  nativeFixture,
];
const child = spawn(
  "script",
  [
    "-q",
    "-f",
    "-c",
    `stty cols 110 rows 35; exec ${args.map(quote).join(" ")}`,
    "/dev/null",
  ],
  {
    cwd: model.root,
    env: {
      ...process.env,
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
      PI_CODING_AGENT_DIR: model.agentDir,
      PI_DESK_HOST: "127.0.0.1",
      PI_DESK_PORT: "0",
      PI_DESK_TLS_CERT: "",
      PI_DESK_TLS_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const exited = new Promise((resolve) => child.once("exit", resolve));
let output = "";
child.stdout.on("data", (data) => (output += data));
child.stderr.on("data", (data) => (output += data));
const send = (text) => child.stdin.write(text + "\r");
try {
  await until(() => output.includes("fixture") && output.includes("\x1b]0;"));
  send("/sessions help");
  await until(() => output.includes("原生 /new"));
  send("/desk web");
  await until(() => /http:\/\/127\.0\.0\.1:\d+\//.test(output));
  const origin = output
    .match(/http:\/\/127\.0\.0\.1:\d+\//)[0]
    .replace(/\/$/, "");
  const state = async () => (await fetch(origin + "/api/state")).json();
  const post = async (path, body = {}) => {
    const response = await fetch(origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json();
    assert.equal(response.status, 200, JSON.stringify(json));
    return json;
  };
  const initial = await state();
  send("TASK A");
  await until(() => model.entered.has("A"));
  assert.equal((await state()).thinkingEditable, true);
  await post("/api/thinking", { level: "low", sessionId: initial.sessionId });
  assert.equal((await state()).thinkingLevel, "low");
  assert.equal((await state()).idle, false);
  assert.equal(model.closed.has("A"), false);
  send("/sessions new");
  await until(
    async () =>
      (await state()).sessionId !== initial.sessionId &&
      !(await state()).initializing,
  );
  const second = await state();
  assert.notEqual(second.sessionId, initial.sessionId);
  assert.equal(second.thinkingLevel, "low");
  assert.equal(second.backend.pid, initial.backend.pid);
  assert.equal(second.backend.id, initial.backend.id);
  assert.equal(second.epoch, initial.epoch);
  await until(
    () => output.includes("Pi Sessions") && output.includes(second.sessionId),
  );
  send("TASK B");
  await until(() => model.entered.has("B"));
  await post("/api/thinking", { level: "high", sessionId: second.sessionId });
  assert.equal((await state()).thinkingLevel, "high");
  assert.equal((await state()).idle, false);
  assert.equal(model.closed.has("B"), false);
  const rows = await (await fetch(origin + "/api/sessions")).json();
  assert(rows.rows.filter((row) => row.running).length === 2);
  send(`/use ${initial.sessionId.slice(0, 18)}`);
  await until(async () => (await state()).sessionId === initial.sessionId);
  assert.equal((await state()).thinkingLevel, "low");
  assert(
    (await (await fetch(origin + "/api/sessions")).json()).rows.find(
      (row) => row.id === second.sessionId,
    ).running,
  );
  child.stdin.write("\t");
  await until(async () => (await state()).sessionId === second.sessionId);
  model.release("A");
  await until(async () => {
    const list = await (await fetch(origin + "/api/sessions")).json();
    return !list.rows.find((row) => row.id === initial.sessionId).running;
  });
  const showingB = await state();
  assert.equal(showingB.sessionId, second.sessionId);
  assert(!showingB.messages.some((row) => row.text.includes("completed-A")));
  // Esc returns to the native slot without cancelling B. Ctrl-D then exits Pi.
  child.stdin.write("\x1b");
  await until(async () => (await state()).sessionId === initial.sessionId);
  assert(
    (await (await fetch(origin + "/api/sessions")).json()).rows.find(
      (row) => row.id === second.sessionId,
    ).running,
  );
  send(`/fixture-native-resume ${second.sessionId}`);
  await until(() => output.includes("managed-writer-guard-pass"));
  assert.equal((await state()).sessionId, initial.sessionId);
  assert(
    (await (await fetch(origin + "/api/sessions")).json()).rows.find(
      (row) => row.id === second.sessionId,
    ).running,
  );
  const pickerStart = output.length;
  send("/sessions");
  await until(() => output.slice(pickerStart).includes("选择会话"));
  send(second.sessionId);
  await until(async () => (await state()).sessionId === second.sessionId);
  const gitHelpStart = output.length;
  send("/git help");
  await until(() => output.slice(gitHelpStart).includes("写操作需要确认"));
  assert(
    !(await state()).messages.some(
      (row) => row.role === "user" && row.text.startsWith("/git"),
    ),
  );
  assert.equal(model.closed.has("B"), false);
  child.stdin.write("\x1b");
  await until(async () => (await state()).sessionId === initial.sessionId);
  child.stdin.write("\x04");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TUI quit timed out")), 8000),
    ),
  ]);
  await assert.rejects(fetch(origin + "/api/state"));
  console.log(
    "Real PTY passed: registered host package does not recurse into SDK children, /sessions searchable picker and managed /git help never enter model prompts, /sessions help/new and /use ID prefix work, native/SDK thinking changes while streaming without abort or cross-session leaks, native A continues while terminal input runs B, Tab/Web share focus and backend, background A completes independently, Esc does not stop B, TUI quit drains slots.",
  );
} catch (error) {
  console.error(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(-1800));
  throw error;
} finally {
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  await exited;
  await model.stop();
}
