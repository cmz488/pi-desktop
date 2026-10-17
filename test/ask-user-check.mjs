// Real installed rpiv tool, isolated SDK + native PTY, local model only.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startWeb } from "../src/server/web.mjs";
import { until } from "./concurrent-fixture.mjs";
const tool =
  process.env.PI_DESK_ASK_PLUGIN ??
  fileURLToPath(
    new URL(
      "../../../agent/npm/node_modules/@juicesharp/rpiv-ask-user-question/index.ts",
      import.meta.url,
    ),
  );
await access(tool);
const root = await mkdtemp(join(tmpdir(), "pi-real-ask-"));
const agentDir = join(root, "agent");
await mkdir(agentDir);
const questions = [
  {
    header: "Choice",
    question: "Choose a route?",
    options: [
      { label: "One", description: "First", preview: "**Preview**" },
      { label: "Two", description: "Second" },
    ],
  },
  {
    header: "Multi",
    question: "Which items?",
    multiSelect: true,
    options: [
      { label: "A", description: "First" },
      { label: "B", description: "Second" },
    ],
  },
];
const endpoint = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  const user = body.messages
    .filter((message) => message.role === "user")
    .at(-1);
  const label = JSON.stringify(user.content).replace(/\W/g, "");
  const id = `ask-${label}`;
  const returned = body.messages.some(
    (message) => message.role === "tool" && message.tool_call_id === id,
  );
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = returned
    ? { role: "assistant", content: "Questionnaire finished" }
    : {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id,
            type: "function",
            function: {
              name: "ask_user_question",
              arguments: JSON.stringify({ questions }),
            },
          },
        ],
      };
  response.end(
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason: returned ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`,
        api: "openai-completions",
        apiKey: "fixture",
        models: [{ id: "fixture", contextWindow: 16000, maxTokens: 1000 }],
      },
    },
  }),
);
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "fixture",
    extensions: [tool],
    quietStartup: true,
    cacheWarming: "off",
  }),
);
let app, child;
const post = async (origin, path, input) => {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return data;
};
const jobs = async (origin) =>
  (await (await fetch(origin + "/api/interactions")).json()).rows;
const pending = async (origin) =>
  (await jobs(origin)).find((job) => job.status === "running" && job.prompt);
try {
  app = await startWeb({ cwd: root, agentDir, port: 0 });
  await app.ready;
  const origin = new URL(app.url).origin;
  await post(origin, "/api/prompt", { message: "Ask SDK" });
  await until(async () => !!(await pending(origin)), 15000);
  let job = await pending(origin);
  assert.equal(job.prompt.ask.mode, "select");
  assert.equal(job.prompt.ask.options[0].preview, "**Preview**");
  await post(origin, "/api/interaction-reply", {
    id: job.id,
    promptId: job.prompt.id,
    value: job.prompt.options[1].id,
  });
  await until(
    async () => (await pending(origin))?.prompt.ask?.mode === "multi",
  );
  job = await pending(origin);
  await post(origin, "/api/interaction-reply", {
    id: job.id,
    promptId: job.prompt.id,
    value: "1,2",
  });
  await until(() => app.runtime.session.isIdle);
  const recorded = app.runtime.session.messages.find(
    (message) =>
      message.role === "toolResult" && message.toolName === "ask_user_question",
  );
  assert.equal(recorded.details.answers[0].answer, "Two");
  assert.deepEqual(recorded.details.answers[1].selected, ["A", "B"]);
  await app.stop();
  app = undefined;
  // Native process uses its own empty history, not the SDK's JSONL writer.
  const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const args = [
    "pi",
    "--no-extensions",
    "-e",
    fileURLToPath(new URL("../index.ts", import.meta.url)),
    "-e",
    tool,
  ];
  child = spawn(
    "script",
    [
      "-q",
      "-f",
      "-c",
      `stty cols 110 rows 35; exec ${args.map(quote).join(" ")}`,
      "/dev/null",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        SHELL: "/bin/bash",
        TERM: "xterm-256color",
        PI_CODING_AGENT_DIR: agentDir,
        PI_DESK_HOST: "127.0.0.1",
        PI_DESK_PORT: "0",
        PI_DESK_TLS_CERT: "",
        PI_DESK_TLS_KEY: "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const send = (text) => child.stdin.write(text + "\r");
  await until(
    () => output.includes("fixture") && output.includes("\x1b]0;"),
    15000,
  );
  send("/desk web");
  await until(() => /http:\/\/127\.0\.0\.1:\d+\//.test(output));
  const nativeOrigin = output
    .match(/http:\/\/127\.0\.0\.1:\d+\//)[0]
    .replace(/\/$/, "");
  send("Ask Remote");
  await until(async () => !!(await pending(nativeOrigin)), 15000);
  job = await pending(nativeOrigin);
  assert.equal(job.prompt.type, "questionnaire");
  await post(nativeOrigin, "/api/interaction-reply", {
    id: job.id,
    promptId: job.prompt.id,
    value: JSON.stringify([
      { selected: [], custom: "Literal remote" },
      { selected: [1] },
    ]),
  });
  await until(async () => {
    const state = await (await fetch(nativeOrigin + "/api/state")).json();
    return (
      state.idle &&
      state.messages.some(
        (message) =>
          message.toolName === "ask_user_question" &&
          message.text.includes("Literal remote"),
      )
    );
  });
  send("Ask Cancel");
  await until(async () => !!(await pending(nativeOrigin)), 15000);
  job = await pending(nativeOrigin);
  child.stdin.write("\x1b");
  await until(
    async () =>
      !(await jobs(nativeOrigin)).some((row) => row.status === "running"),
  );
  const stale = await fetch(nativeOrigin + "/api/interaction-reply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: job.id, promptId: job.prompt.id, value: "[]" }),
  });
  assert.equal(stale.status, 409);
  console.log(
    "Real rpiv Ask User passed: SDK select/multi, native TUI remote answer, native Escape and stale reply rejection.",
  );
} finally {
  await app?.stop();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.write("\x03\x03");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  }
  await new Promise((resolve) => {
    endpoint.close(resolve);
    endpoint.closeAllConnections();
  });
  await rm(root, { recursive: true, force: true });
}
