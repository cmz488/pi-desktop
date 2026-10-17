import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function concurrentFixture({ reasoning = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-concurrent-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(root, "README.md"), "concurrent real read fixture");
  const gates = new Map();
  const entered = new Set();
  const closed = new Set();
  for (const label of ["A", "B", "C"]) {
    let release;
    const promise = new Promise((resolve) => (release = resolve));
    gates.set(label, { promise, release });
  }
  const endpoint = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const user = body.messages.find(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes("TASK "),
    );
    const label =
      JSON.stringify(user?.content ?? "").match(/TASK ([ABC])/)?.[1] ?? "C";
    const returned = body.messages.some((message) => message.role === "tool");
    response.on("close", () => closed.add(label));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ id: `fixture-${label}`, object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    if (!returned) {
      send({ role: "assistant", content: `partial-${label}` });
      entered.add(label);
      await gates.get(label).promise;
      if (!response.destroyed) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `read-${label}`,
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: "README.md" }),
              },
            },
          ],
        });
        send({}, "tool_calls");
      }
    } else {
      send({ role: "assistant", content: `completed-${label}` });
      send({}, "stop");
    }
    if (!response.destroyed) response.end("data: [DONE]\n\n");
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
          models: [
            {
              id: "fixture",
              input: ["text", "image"],
              reasoning,
              contextWindow: 16000,
              maxTokens: 1000,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "fixture",
      quietStartup: true,
      cacheWarming: "off",
    }),
  );
  return {
    root,
    agentDir,
    entered,
    closed,
    release: (label) => gates.get(label).release(),
    async stop() {
      for (const gate of gates.values()) gate.release();
      await new Promise((resolve) => {
        endpoint.close(resolve);
        endpoint.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function until(predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Concurrent session condition timed out");
}
