import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDesktopHost } from "../src/control-plane/server.mjs";

export async function until(read, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Desktop did not settle: ${JSON.stringify(value)}`);
}
export async function desktopFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-mvp-"));
  const agentDir = join(root, "agent"),
    directory = join(root, "data"),
    cwd = join(root, "project"),
    other = join(root, "other");
  await Promise.all([agentDir, cwd, other].map((path) => mkdir(path)));
  const requests = [];
  const model = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(input);
    await options.beforeModelResponse?.(input);
    // 只在本地 provider 边界编排工具回合，实际模型准入、工具执行与恢复仍走原生 SDK。
    const reply = await options.modelReply?.(input);
    if (reply?.error) {
      response.writeHead(reply.error.status, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({ error: { message: reply.error.message } }));
      return;
    }
    const text = reply?.text ?? `answer: ${input.messages.at(-1).content}`;
    const chunk = (delta, finish_reason) =>
      `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 1200, completion_tokens: 32, total_tokens: 1232, prompt_tokens_details: { cached_tokens: 900 } } } : {}) })}\n\n`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (reply?.stream) {
      for await (const text of reply.stream)
        response.write(chunk({ role: "assistant", content: text }, null));
      response.end(chunk({}, "stop") + "data: [DONE]\n\n");
      return;
    }
    response.end(
      chunk(
        {
          role: "assistant",
          ...(reply?.toolCalls?.length
            ? {
                tool_calls: reply.toolCalls.map((call, index) => ({
                  index,
                  ...call,
                })),
              }
            : { content: text }),
        },
        null,
      ) +
        chunk({}, reply?.toolCalls?.length ? "tool_calls" : "stop") +
        "data: [DONE]\n\n",
    );
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "desktop-fixture",
      defaultModel: "local",
      cacheWarming: "off",
      retry: { enabled: false },
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "desktop-fixture": {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
          apiKey: "test-only",
          models: [{ id: "local", contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    }),
  );
  await mkdir(join(cwd, "skills", "fixture-skill"), { recursive: true });
  await writeFile(
    join(cwd, "skills", "fixture-skill", "SKILL.md"),
    "---\nname: fixture-skill\ndescription: Injected skill fixture\n---\nSkill fixture instructions.\n",
  );
  await mkdir(join(cwd, "prompts"));
  await writeFile(
    join(cwd, "prompts", "fixture-template.md"),
    "Template fixture: $1",
  );
  await writeFile(
    join(cwd, "extension.mjs"),
    `export default function (pi) { pi.registerTool({ name: "fixture_marker", label: "Fixture", description: "Injected extension tool", parameters: {type: "object", properties: {}}, execute: async () => ({content: [{type: "text", text: "injected"}], details: {}}) }); }`,
  );
  let app = await startDesktopHost({
    cwd,
    agentDir,
    directory,
    defaultConversation: false,
    ...options,
  });
  const call = async (path, input, extra = {}) => {
    const origin = new URL(app.url).origin;
    const response = await fetch(
      origin + path,
      input === undefined
        ? extra
        : {
            method: "POST",
            headers: {
              Origin: origin,
              "Content-Type": "application/json",
              ...extra.headers,
            },
            body: JSON.stringify(input),
          },
    );
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  const command = (command, input = {}) =>
    call("/api/workspace/command", { command, ...input });
  return {
    root,
    cwd,
    other,
    agentDir,
    directory,
    requests,
    call,
    command,
    get app() {
      return app;
    },
    async reopen() {
      await app.stop();
      app = await startDesktopHost({
        agentDir,
        directory,
        defaultConversation: false,
        ...options,
      });
    },
    async close() {
      await app.stop();
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
