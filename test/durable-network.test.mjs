import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
test("Desktop model requests use the configured Pi HTTP proxy and produce an agent answer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-durable-network-"));
  const sockets = new Set();
  const model = createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({
          id: "local",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "proxy answer" },
              finish_reason: null,
            },
          ],
        }) +
        "\n\ndata: " +
        JSON.stringify({
          id: "local",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  let tunnels = 0;
  const proxy = createServer((_req, res) => res.end("proxy"));
  proxy.on("connect", (req, socket, head) => {
    tunnels++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const target = connect(model.address().port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
    sockets.add(target);
    target.on("close", () => sockets.delete(target));
    target.on("error", () => socket.destroy());
    socket.on("error", () => target.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections();
    model.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => model.close(resolve)),
    ]);
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    join(root, "settings.json"),
    JSON.stringify({
      httpProxy: `http://127.0.0.1:${proxy.address().port}`,
      defaultProvider: "proxy-fixture",
      defaultModel: "fixture",
    }),
  );
  await writeFile(
    join(root, "models.json"),
    JSON.stringify({
      providers: {
        "proxy-fixture": {
          api: "openai-completions",
          baseUrl: "http://pi-desktop-provider.invalid/v1",
          apiKey: "local-test-only",
          models: [{ id: "fixture" }],
        },
      },
    }),
  );
  const env = { ...process.env, NODE_USE_ENV_PROXY: "0" };
  for (const name of Object.keys(env))
    if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(name)) delete env[name];
  env.NO_PROXY = "localhost,127.0.0.1,::1";
  const electron = process.env.PI_DESK_NETWORK_ELECTRON;
  const args = ["test/durable-network-worker.mjs", root];
  const result = await exec(
    electron ? "xvfb-run" : process.execPath,
    electron
      ? [
          "-a",
          electron,
          "--no-sandbox",
          "--disable-gpu",
          "--ozone-platform=x11",
          ...args,
        ]
      : args,
    { env, timeout: 15000 },
  );
  const state = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert(
    state.answers.some((answer) => answer.text === "proxy answer"),
    JSON.stringify({ tunnels, state }),
  );
  assert(tunnels > 0);
});
