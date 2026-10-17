import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import QRCode from "qrcode";
import { openDurableModels } from "../src/agent/durable-models.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
const exec = promisify(execFile);
async function until(read, predicate) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Durable feature did not settle");
}
async function fixture(
  t,
  {
    startup = false,
    commands = false,
    readOnly = false,
    goal = false,
    audit = false,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pi-reused-features-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent"),
    directory = join(root, "data");
  await mkdir(cwd);
  await mkdir(agentDir);
  const plugins = ["rpiv-ask-user-question"].map((name) =>
    fileURLToPath(
      new URL(
        `../../../agent/npm/node_modules/@juicesharp/${name}/index.ts`,
        import.meta.url,
      ),
    ),
  );
  if (goal) {
    plugins.push(
      fileURLToPath(
        new URL(
          "../../../agent/npm/node_modules/pi-goal-x/extensions/goal.ts",
          import.meta.url,
        ),
      ),
    );
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "pi-goal-x-settings.json"),
      JSON.stringify({
        disabled: !audit,
        maxAutonomousRuns: 3,
        disableTasks: true,
        disableContracts: true,
        goalsRoot: join(cwd, ".pi", "goals"),
      }),
    );
  }
  if (commands) {
    const extension = join(root, "commands.ts");
    await writeFile(
      extension,
      'export default function(pi) {pi.registerCommand("fixture-notice", {handler: async (_args,ctx) => {ctx.ui.notify("Native command handled");}});}',
    );
    plugins.push(extension);
    await mkdir(join(agentDir, "prompts"));
    await writeFile(
      join(agentDir, "prompts", "fixture-template.md"),
      "Template resource instruction.",
    );
    await mkdir(join(agentDir, "skills", "fixture-skill"), { recursive: true });
    await writeFile(
      join(agentDir, "skills", "fixture-skill", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: A local fixture skill\n---\nSkill resource instruction.\n",
    );
  }
  if (startup) {
    const extension = join(root, "startup.ts");
    await writeFile(
      extension,
      'export default function(pi) {pi.on("session_start", async (_e,ctx) => {await ctx.ui.input("Startup value");});}',
    );
    plugins.push(extension);
  }
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: plugins,
      cacheWarming: "off",
      defaultTools: [
        "read",
        "write",
        "edit",
        "bash",
        "codemode",
        "tool_search",
        "ask_user_question",
      ],
      defaultProvider: "reuse-fixture",
      defaultModel: "local",
      customUntouched: { keep: true },
    }),
  );
  const providers = await openDurableModels({ agentDir, directory });
  const faux = fauxProvider({
    provider: "reuse-fixture",
    models: [{ id: "local", reasoning: true, input: ["text", "image"] }],
    tokensPerSecond: 10000,
  });
  providers.models.setProvider(faux.provider);
  const app = await startDurableDesk({
    cwd,
    agentDir,
    directory,
    providers,
    port: 0,
    readOnly,
    catalogFetch: async () =>
      new Response(
        '<main><article data-package-card="true" data-package-name="@fixture/reused" data-package-types="extension skill"><p class="packages-desc">Catalog fixture</p></article></main>',
        { headers: { "content-type": "text/html" } },
      ),
  });
  t.after(async () => {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  });
  let id = (await app.workspace.read()).agents[0].id;
  const origin = new URL(app.url).origin;
  async function call(path, input) {
    const url = new URL(path, origin);
    url.searchParams.set("sessionId", String(id));
    const response = await fetch(
      url,
      input === undefined
        ? {}
        : {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify({ ...input, sessionId: String(id) }),
          },
    );
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  let runIndex = 0;
  async function runTool(name, args, { allowError = false } = {}) {
    const index = ++runIndex;
    faux.setResponses([
      fauxAssistantMessage(
        [{ type: "toolCall", id: `call-${index}`, name, arguments: args }],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(`finished-${index}`),
    ]);
    await call("/api/prompt", {
      message: `step-${index}`,
      requestId: `run-${index}`,
    });
    const state = await until(
      () => call("/api/state"),
      (value) =>
        value.idle &&
        value.messages.some((row) => row.text === `finished-${index}`),
    );
    const result = state.messages.find(
      (row) => row.toolCallId === `call-${index}`,
    );
    if (!allowError) assert(!result?.isError, JSON.stringify(result));
    return state;
  }
  return {
    root,
    cwd,
    agentDir,
    directory,
    providers,
    faux,
    app,
    call,
    runTool,
    get id() {
      return id;
    },
    set id(value) {
      id = value;
    },
  };
}

for (const readOnly of [false, true])
  test(`local screenshot references are readable as images on demand (${readOnly ? "projectless" : "project"})`, async (t) => {
    const f = await fixture(t, { readOnly });
    const directory = join(f.root, "context-files");
    await mkdir(directory);
    const path = join(directory, "image.png");
    const png = await QRCode.toBuffer("local screenshot reference");
    await writeFile(path, png);
    let beforeRead, afterRead;
    f.faux.setResponses([
      (context) => {
        beforeRead = structuredClone(context);
        return fauxAssistantMessage(
          [
            {
              type: "toolCall",
              id: "screenshot-read",
              name: "read",
              arguments: { path },
            },
          ],
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        afterRead = structuredClone(context);
        return fauxAssistantMessage("SCREENSHOT_READ_DONE");
      },
    ]);
    await f.call("/api/prompt", {
      message: "Inspect this screenshot",
      attachments: [{ kind: "reference", path }],
      requestId: "screenshot-reference",
    });
    const state = await until(
      () => f.call("/api/state"),
      (value) =>
        value.idle &&
        value.messages.some((row) => row.text === "SCREENSHOT_READ_DONE"),
    );
    const result = state.messages.find(
      (row) => row.toolCallId === "screenshot-read",
    );
    assert(
      result,
      "The Agent must execute read on the existing screenshot path",
    );
    assert(
      !result.isError,
      `A valid screenshot path must be readable: ${JSON.stringify(result)}`,
    );
    assert(JSON.stringify(beforeRead).includes(path));
    assert(
      !JSON.stringify(beforeRead).includes(png.toString("base64")),
      "Local submission must contain only the reference, not screenshot bytes",
    );
    const image = afterRead.messages
      .find(
        (message) =>
          message.role === "toolResult" &&
          message.toolCallId === "screenshot-read",
      )
      ?.content.find((block) => block.type === "image");
    assert.equal(
      image?.mimeType,
      "image/png",
      "The next model request must receive Pi's image result",
    );
  });

test("native /goal drafting starts a Durable model turn instead of an isolated resource loop", async (t) => {
  const f = await fixture(t, { goal: true });
  await until(
    () => f.call("/api/state"),
    (state) =>
      !state.initializing &&
      state.commands.some((command) => command.name === "goal"),
  );
  f.faux.setResponses([fauxAssistantMessage("GOAL_DRAFT_RESPONSE")]);
  await f.call("/api/prompt", {
    message: "/goal",
    requestId: "goal-draft",
  });
  const state = await f.app.workspace.read(f.id);
  assert(
    state.active.messages.some((message) => message.role === "user"),
    "A native Goal command must submit its draft prompt to the selected Durable Agent",
  );
  await until(
    () => f.call("/api/state"),
    (state) =>
      state.messages.some((message) => message.text === "GOAL_DRAFT_RESPONSE"),
  );
  assert(
    (await f.call("/api/state")).messages.some(
      (message) => message.extensionView?.status === "起草中",
    ),
  );
  await f.call("/api/prompt", {
    message: "/goal-cancel",
    requestId: "goal-cancel",
  });
  assert(
    !(await f.call("/api/state")).messages.some(
      (message) => message.extensionView?.status === "起草中",
    ),
  );
});

test("native Goal work exposes its live dashboard and automatically continues through Durable to completion", async (t) => {
  const f = await fixture(t, { goal: true });
  let release;
  const firstRequest = new Promise((resolve) => {
    release = resolve;
  });
  f.faux.setResponses([
    async () => {
      await firstRequest;
      return fauxAssistantMessage("GOAL_STEP_ONE");
    },
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "goal-finish",
          name: "update_goal",
          arguments: { status: "complete" },
        },
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  await f.call("/api/prompt", {
    message: "/goal-direct Create an isolated fixture report.",
    requestId: "goal-direct",
  });
  try {
    const started = await until(
      () => f.call("/api/state"),
      (state) => state.messages.some((message) => message.id === "widget:goal"),
    );
    assert(
      started.messages.some(
        (message) =>
          message.id === "widget:goal" &&
          message.extensionView?.adapterId === "pi-goal-x",
      ),
      "A goal created by a command needs a dashboard even without a get_goal tool call",
    );
  } finally {
    release();
  }
  const done = await until(
    () => f.call("/api/state"),
    (state) =>
      state.idle &&
      state.messages.some((message) => message.toolCallId === "goal-finish"),
  );
  assert(
    done.messages.some(
      (message) => message.toolCallId === "goal-finish" && !message.isError,
    ),
  );
  assert(
    done.messages.some((message) => message.extensionView?.status === "已完成"),
  );
});

test("a native Goal completion auditor uses its own Pi Agent while the resource Session cannot run chat", async (t) => {
  const f = await fixture(t, { goal: true, audit: true });
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "goal-audit-finish",
          name: "update_goal",
          arguments: { status: "complete" },
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      "Independent fixture verification passed.\n<approved/>",
    ),
  ]);
  await f.call("/api/prompt", {
    message: "/goal-direct Verify this isolated fixture goal.",
    requestId: "goal-audit",
  });
  const done = await until(
    () => f.call("/api/state"),
    (state) =>
      state.idle &&
      state.messages.some(
        (message) => message.toolCallId === "goal-audit-finish",
      ),
  );
  const result = done.messages.find(
    (message) => message.toolCallId === "goal-audit-finish",
  );
  assert(!result.isError, result.text);
  assert.equal(result.extensionView?.status, "已完成", result.text);
});

test("native /goal proposals wait for explicit Desktop confirmation before work starts", async (t) => {
  const f = await fixture(t, { goal: true });
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "proposal",
          name: "propose_goal_draft",
          arguments: { objective: "Generate a verified fixture report." },
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "confirmed-finish",
          name: "update_goal",
          arguments: { status: "complete" },
        },
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  await f.call("/api/prompt", {
    message: "/goal Generate a verified fixture report.",
    requestId: "guided-goal",
  });
  for (const [label, choice] of [
    ["Completion auditor", "Disabled"],
    ["Confirm Goal Draft", "1. Confirm"],
  ]) {
    const interaction = await until(
      () => f.call("/api/interactions"),
      (value) =>
        value.rows.some(
          (row) =>
            row.status === "running" && row.prompt?.message.includes(label),
        ),
    ).then((value) =>
      value.rows.find(
        (row) =>
          row.status === "running" && row.prompt?.message.includes(label),
      ),
    );
    assert(
      (await f.call("/api/state")).messages.some(
        (message) => message.extensionView?.status === "起草中",
      ),
    );
    const option = interaction.prompt.options.find((option) =>
      option.label.startsWith(choice),
    );
    assert(option, JSON.stringify(interaction.prompt));
    await f.call("/api/interaction-reply", {
      id: interaction.id,
      promptId: interaction.prompt.id,
      value: option.id,
    });
  }
  const done = await until(
    () => f.call("/api/state"),
    (state) =>
      state.idle &&
      state.messages.some(
        (message) => message.toolCallId === "confirmed-finish",
      ),
  );
  assert(
    done.messages.some((message) => message.extensionView?.status === "已完成"),
  );
  assert(
    !done.messages.some(
      (message) => message.extensionView?.status === "起草中",
    ),
  );
});

test("stopping Goal work pauses continuation and explicit /goal-resume starts a fresh run", async (t) => {
  const f = await fixture(t, { goal: true });
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.faux.setResponses([
    async (_context, options) => {
      entered();
      await new Promise((resolve) => {
        release = resolve;
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", resolve, { once: true });
      });
      return fauxAssistantMessage("INTERRUPTED_GOAL_RESPONSE");
    },
  ]);
  try {
    await f.call("/api/prompt", {
      message: "/goal-direct Test explicit stopping and resumption.",
      requestId: "stop-goal",
    });
    await started;
    await f.call("/api/abort", {});
    const paused = await until(
      () => f.call("/api/state"),
      (state) =>
        state.idle &&
        state.messages.some(
          (message) =>
            message.id === "widget:goal" &&
            /paused|暂停/i.test(JSON.stringify(message.extensionView)),
        ),
    );
    assert(paused.idle);
    const calls = f.faux.state.callCount;
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(
      f.faux.state.callCount,
      calls,
      "A user stop must not auto-restart the goal",
    );
    f.faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "resumed-finish",
            name: "update_goal",
            arguments: { status: "complete" },
          },
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    await f.call("/api/prompt", {
      message: "/goal-resume",
      requestId: "resume-goal",
    });
    const done = await until(
      () => f.call("/api/state"),
      (state) =>
        state.idle &&
        state.messages.some(
          (message) => message.toolCallId === "resumed-finish",
        ),
    );
    assert(
      done.messages.some(
        (message) => message.extensionView?.status === "已完成",
      ),
    );
  } finally {
    release?.();
  }
});

test("native resource commands, templates and skills retain their behavior behind the resource interface", async (t) => {
  const f = await fixture(t, { commands: true });
  await until(
    () => f.call("/api/state"),
    (value) =>
      !value.initializing &&
      value.commands.some((row) => row.name === "fixture-notice"),
  );
  const before = (await f.app.workspace.read(f.id)).active.messages.length;
  await f.call("/api/prompt", {
    message: "/fixture-notice",
    requestId: "native-command",
  });
  assert.equal(
    (await f.app.workspace.read(f.id)).active.messages.length,
    before,
  );
  for (const [message, content, answer] of [
    ["/fixture-template", "Template resource instruction.", "template served"],
    [
      "/skill:fixture-skill extra context",
      "Skill resource instruction.",
      "skill served",
    ],
  ]) {
    f.faux.setResponses([fauxAssistantMessage(answer)]);
    await f.call("/api/prompt", { message, requestId: answer });
    const state = await until(
      () => f.call("/api/state"),
      (value) =>
        value.idle && value.messages.some((row) => row.text === answer),
    );
    assert(
      state.messages.some(
        (row) => row.role === "user" && row.text.includes(content),
      ),
    );
  }
});

test("reused Desktop modules support nested tools, attachments, native settings and SQLite restore", async (t) => {
  const f = await fixture(t);
  let state = await f.call("/api/state");
  assert.equal(state.host, "durable");
  assert(state.tools.includes("ask_user_question"));
  assert(state.tools.includes("codemode"));
  assert((await (await fetch(f.app.url)).text()).includes("prototype.js"));
  assert.equal((await f.call("/api/package-catalog")).source, "pi.dev");
  assert((await f.call("/api/plugins")).rows.some((row) => row.name === "mcp"));
  const settings = await f.call("/api/settings?scope=global");
  await f.call("/api/settings", {
    scope: "global",
    revision: settings.revision,
    patch: { "compaction.reserveTokens": 2048, defaultThinkingLevel: "low" },
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8"))
      .customUntouched,
    { keep: true },
  );
  const descriptor = await f.call("/api/agent");
  await f.call("/api/command", {
    command: "configure",
    id: f.id,
    revision: descriptor.active.revision,
    shellEnv: { REUSED_ENV: "provided-by-desktop" },
  });
  state = await f.runTool("codemode", {
    code: `text(await tools.bash({command: 'printf %s "$REUSED_ENV"'}));`,
  });
  assert(
    state.messages.some(
      (row) =>
        row.role === "toolResult" && row.text.includes("provided-by-desktop"),
    ),
    JSON.stringify(state.messages.filter((row) => row.role === "toolResult")),
  );
  f.faux.setResponses([fauxAssistantMessage("attachment received")]);
  await f.call("/api/prompt", {
    message: "review file",
    requestId: "attachment",
    attachments: [
      {
        name: "context.txt",
        type: "text/plain",
        data: Buffer.from("attached code").toString("base64"),
      },
    ],
  });
  state = await until(
    () => f.call("/api/state"),
    (value) =>
      value.idle &&
      value.messages.some((row) => row.text === "attachment received"),
  );
  const attachmentRow = state.messages
    .filter((row) => row.role === "user")
    .at(-1);
  const cachedPath = /\/tmp\/pi-desk-context-cache\/[^\s"'\\]+/.exec(
    attachmentRow?.text ?? "",
  )?.[0];
  assert(cachedPath, attachmentRow?.text);
  assert.equal(await readFile(cachedPath, "utf8"), "attached code");
  assert(!attachmentRow.text.includes("attached code"));
  const remote = await f.call("/api/remote");
  assert(remote.qr.startsWith("data:image/png;base64,"));
  await f.app.stop();
  const reopened = await startDurableDesk({
    cwd: f.cwd,
    agentDir: f.agentDir,
    directory: f.directory,
    providers: f.providers,
    port: 0,
  });
  try {
    const restored = await (
      await fetch(new URL(`/api/state?sessionId=${f.id}`, reopened.url))
    ).json();
    assert.equal(restored.active.id, f.id);
    assert.equal(restored.sessionId, String(f.id));
    const restoredRow = restored.messages
      .filter((row) => row.role === "user")
      .at(-1);
    const restoredPath = /\/tmp\/pi-desk-context-cache\/[^\s"'\\]+/.exec(
      restoredRow?.text ?? "",
    )?.[0];
    assert(restoredPath, restoredRow?.text);
    assert.equal(await readFile(restoredPath, "utf8"), "attached code");
  } finally {
    await reopened.stop();
  }
});

test("actual Ask User replies and stdio MCP calls run as Durable tools in the reused Desktop", async (t) => {
  const f = await fixture(t);
  const questions = [
    {
      header: "Choice",
      question: "Select a route",
      options: [
        { label: "First", description: "One" },
        { label: "Second", description: "Two" },
      ],
    },
  ];
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "ask",
          name: "ask_user_question",
          arguments: { questions },
        },
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("answered"),
  ]);
  await f.call("/api/approval", { mode: "ask-risky" });
  await f.call("/api/prompt", { message: "ask me", requestId: "ask" });
  const job = await until(
    () => f.call("/api/interactions"),
    (value) => value.rows.some((row) => row.prompt?.ask),
  ).then((value) => value.rows.find((row) => row.prompt?.ask));
  assert(
    !(await f.call("/api/interactions")).rows.some((row) =>
      row.label?.includes("允许 ask_user_question"),
    ),
    "Routine user questions should not be gated by destructive-operation confirmation",
  );
  assert.equal(job.prompt.ask.question, questions[0].question);
  await f.call("/api/interaction-reply", {
    id: job.id,
    promptId: job.prompt.id,
    value: job.prompt.options[0].id,
  });
  await until(
    () => f.call("/api/state"),
    (value) =>
      value.idle && value.messages.some((row) => row.text === "answered"),
  );
  await f.call("/api/approval", { mode: "yolo" });
  const server = join(f.cwd, "mcp-fixture.mjs");
  await writeFile(
    server,
    `import {createInterface} from 'node:readline'; createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'local',version:'1'}};if(r.method==='tools/list')result={tools:[{name:'echo',description:'Fixture',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};if(r.method==='tools/call')result={content:[{type:'text',text:r.params.arguments.text}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`,
  );
  const inventory = await f.call("/api/mcp");
  await f.call("/api/mcp", {
    action: "save",
    name: "local-fixture",
    scope: "global",
    revision: inventory.revisions.global,
    config: {
      command: process.execPath,
      args: [server],
      exposure: "direct",
      env: { PRIVATE_FIXTURE: "secret-value" },
    },
  });
  await f.call("/api/reload", {});
  const loaded = await until(
    () => f.call("/api/mcp"),
    (value) => value.rows.some((row) => row.tools.length),
  );
  assert(!JSON.stringify(loaded).includes("secret-value"));
  const tool = loaded.rows[0].tools[0].name;
  const state = await f.runTool(tool, { text: "Durable owns native MCP" });
  assert(
    state.messages.some(
      (row) =>
        row.role === "toolResult" &&
        row.text.includes("Durable owns native MCP"),
    ),
  );
  await f.call("/api/approval", { mode: "ask-risky" });
  const passedMcp = await f.runTool(tool, { text: "MCP passed in ask-risky" });
  assert(
    passedMcp.messages.some(
      (row) =>
        row.role === "toolResult" &&
        row.text.includes("MCP passed in ask-risky"),
    ),
    "Unmarked routine MCP operations should pass under high-risk confirmation",
  );
  await f.call("/api/approval", { mode: "yolo" });
  const latest = await f.call("/api/mcp");
  await f.call("/api/mcp", {
    action: "save",
    name: "deferred-fixture",
    scope: "global",
    revision: latest.revisions.global,
    config: { command: process.execPath, args: [server], exposure: "deferred" },
  });
  await f.call("/api/reload", {});
  await until(
    () => f.call("/api/mcp"),
    (value) =>
      value.rows.some(
        (row) => row.name === "deferred-fixture" && row.tools.length,
      ),
  );
  const searched = await f.runTool("tool_search", {
    query: "Fixture",
    limit: 5,
  });
  assert(searched.tools.includes("mcp__deferred_fixture__echo"));
  await f.runTool("mcp__deferred_fixture__echo", {
    text: "discovered by real Tool Search",
  });
});

test("full Git confirmation and provider login use existing Desktop modules with explicit Durable targets", async (t) => {
  const f = await fixture(t);
  await exec("git", ["init", "-q"], { cwd: f.cwd });
  await exec("git", ["config", "user.name", "Fixture"], { cwd: f.cwd });
  await exec("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: f.cwd,
  });
  await writeFile(join(f.cwd, "work.txt"), "changed\n");
  const plan = await f.call("/api/git", {
    action: "stage",
    paths: ["work.txt"],
  });
  await f.call("/api/git", { token: plan.token });
  const commit = await f.call("/api/git", {
    action: "commit",
    message: "Durable fixture commit",
  });
  await f.call("/api/git", { token: commit.token });
  const graph = await f.call("/api/git?action=log");
  assert(JSON.stringify(graph).includes("Durable fixture commit"));
  const started = await f.call("/api/auth-start", {
    provider: "openai",
    type: "api_key",
  });
  const job = await until(
    () => f.call("/api/interactions"),
    (value) => value.rows.find((row) => row.id === started.id)?.prompt,
  ).then((value) => value.rows.find((row) => row.id === started.id));
  await f.call("/api/interaction-reply", {
    id: job.id,
    promptId: job.prompt.id,
    value: "sk-temporary-fixture",
  });
  await until(
    () => f.call("/api/interactions"),
    (value) =>
      value.rows.find((row) => row.id === started.id)?.status === "complete",
  );
  const provider = await f.call("/api/providers");
  assert(provider.rows.some((row) => row.id === "openai"));
  assert(!JSON.stringify(provider).includes("sk-temporary-fixture"));
  assert(
    JSON.parse(await readFile(join(f.directory, "auth.json"), "utf8")).openai,
  );
  await assert.rejects(readFile(join(f.agentDir, "auth.json")), {
    code: "ENOENT",
  });
});

test(
  "new agents preserve the provided environment and tool subset across reload and restart, and closing cancels pending Ask User",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const created = await f.call("/api/command", {
      command: "create",
      cwd: f.cwd,
      name: "Read only",
      instructions: "Review files only",
      shellEnv: { ISOLATED: "yes" },
      tools: ["read"],
      extensions: ["coding-tools", "desk-context"],
    });
    f.id = created.id;
    let state = await f.call("/api/agent");
    assert.deepEqual(state.active.tools, ["read"]);
    assert.deepEqual(state.active.environmentKeys, ["ISOLATED"]);
    assert.equal(state.active.instructions, "Review files only");
    await f.call("/api/reload", {});
    state = await f.call("/api/agent");
    assert.deepEqual(state.active.tools, ["read"]);
    const active = state.active;
    await f.call("/api/command", {
      command: "configure",
      id: f.id,
      revision: active.revision,
      tools: ["ask_user_question"],
    });
    f.faux.setResponses([
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "pending",
            name: "ask_user_question",
            arguments: {
              questions: [
                {
                  header: "Pending",
                  question: "Waiting",
                  options: [
                    { label: "A", description: "A" },
                    { label: "B", description: "B" },
                  ],
                },
              ],
            },
          },
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    await f.call("/api/prompt", { message: "wait", requestId: "pending" });
    await until(
      () => f.call("/api/interactions"),
      (value) => value.rows.some((row) => row.prompt?.ask),
    );
    await f.app.stop();
    const reopened = await startDurableDesk({
      cwd: f.cwd,
      agentDir: f.agentDir,
      directory: f.directory,
      providers: f.providers,
      port: 0,
    });
    try {
      const profile = (await reopened.workspace.read(f.id)).active;
      assert.deepEqual(profile.tools, ["ask_user_question"]);
      assert.deepEqual(profile.environmentKeys, ["ISOLATED"]);
    } finally {
      await reopened.stop();
    }
  },
);

test("startup extension dialogs remain reachable before Durable resource initialization completes", async (t) => {
  const f = await fixture(t, { startup: true });
  const job = await until(
    () => f.call("/api/interactions"),
    (value) =>
      value.rows.some((row) => row.prompt?.message === "Startup value"),
  ).then((value) =>
    value.rows.find((row) => row.prompt?.message === "Startup value"),
  );
  assert.equal((await f.call("/api/state")).initializing, true);
  await f.call("/api/interaction-reply", {
    id: job.id,
    promptId: job.prompt.id,
    value: "Ready",
  });
  await until(
    () => f.call("/api/state"),
    (value) => !value.initializing,
  );
  f.faux.setResponses([fauxAssistantMessage("started after resources")]);
  await f.call("/api/prompt", {
    message: "continue",
    requestId: "startup-ready",
  });
  await until(
    () => f.call("/api/state"),
    (value) =>
      value.idle &&
      value.messages.some((row) => row.text === "started after resources"),
  );
});

test("Pi permissions gate direct and Codemode nested tools, denial has no side effect, YOLO skips requests", async (t) => {
  const f = await fixture(t);
  const file = join(f.cwd, "approval.txt");
  await writeFile(file, "original");
  const reply = async (label, tool) => {
    const row = await until(
      () => f.call("/api/interactions"),
      (value) =>
        value.rows.some((row) => row.prompt && row.label?.includes(tool)),
    ).then((value) =>
      value.rows.find((row) => row.prompt && row.label?.includes(tool)),
    );
    const option = row.prompt.options.find(
      (option) => option.label === (label === "允许本次" ? "确认" : "取消"),
    );
    assert(option, JSON.stringify(row));
    await f.call("/api/interaction-reply", {
      id: row.id,
      promptId: row.prompt.id,
      value: option.id,
    });
  };
  await f.call("/api/approval", { mode: "ask-all" });
  const reading = f.runTool("read", { path: file });
  await reply("允许本次", "read");
  await reading;
  await f.call("/api/approval", { mode: "ask-risky" });
  await f.runTool("read", { path: file }); // read uses native readOnlyHint
  await f.runTool("write", { path: file, content: "ordinary write passed" });
  assert.equal(await readFile(file, "utf8"), "ordinary write passed");
  const nested = f.runTool("codemode", {
    code: `text(await tools.write({path:${JSON.stringify(file)},content:"nested write passed"}));`,
  });
  await nested;
  assert.equal(await readFile(file, "utf8"), "nested write passed");
  const deleting = f.runTool(
    "bash",
    { command: `rm -- ${JSON.stringify(file)}` },
    { allowError: true },
  );
  await reply("拒绝", "bash");
  const denied = await deleting;
  assert(
    denied.messages.some((row) => row.isError && row.text.includes("未批准")),
  );
  assert.equal(await readFile(file, "utf8"), "nested write passed");
  const deletingApproved = f.runTool("bash", {
    command: `rm -- ${JSON.stringify(file)}`,
  });
  await reply("允许本次", "bash");
  await deletingApproved;
  await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
  await f.call("/api/approval", { mode: "yolo" });
  await f.runTool("write", { path: file, content: "approved by policy" });
  assert.equal(await readFile(file, "utf8"), "approved by policy");
  assert.equal(
    (await f.call("/api/interactions")).rows.filter(
      (row) => row.status === "running",
    ).length,
    0,
  );
});

test("ask-all also gates projectless web tools before any HTTP request", async (t) => {
  const f = await fixture(t, { readOnly: true });
  await f.call("/api/approval", { mode: "ask-all" });
  const running = f.runTool(
    "web_fetch",
    { url: "http://127.0.0.1:1/" },
    { allowError: true },
  );
  const consent = await until(
    () => f.call("/api/interactions"),
    (value) =>
      value.rows.some((row) => row.prompt && row.label?.includes("web_fetch")),
  ).then((value) =>
    value.rows.find((row) => row.prompt && row.label?.includes("web_fetch")),
  );
  await f.call("/api/interaction-reply", {
    id: consent.id,
    promptId: consent.prompt.id,
    value: "no",
  });
  const state = await running;
  assert(
    state.messages.some((row) => row.isError && row.text.includes("未批准")),
  );
  assert(!state.tools.includes("write"));
});
