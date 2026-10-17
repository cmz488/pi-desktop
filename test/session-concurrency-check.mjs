import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Acceptance probe: expected to fail until non-destructive concurrent sessions are implemented.
// Run without arguments for the Web path; native-replace demonstrates upstream replacement semantics.
import { startWeb } from "../src/server/web.mjs";
const root = await mkdtemp(join(tmpdir(), "pi-new-session-probe-"));
const agentDir = join(root, "agent");
await mkdir(agentDir);
let entered, release;
const modelEntered = new Promise((resolve) => (entered = resolve));
const finishModel = new Promise((resolve) => (release = resolve));
const endpoint = createServer(async (request, response) => {
  for await (const chunk of request) {
  } // Fixture input is intentionally not logged.
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  send({ role: "assistant", content: "A is still working." });
  entered();
  await finishModel;
  send({ content: "A completed." });
  send({}, "stop");
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-only",
        models: [
          {
            id: "fixture-model",
            reasoning: false,
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
    defaultModel: "fixture-model",
    cacheWarming: "off",
  }),
);
let app;
try {
  app = await startWeb({ cwd: root, agentDir, port: 0, noExtensions: true });
  await app.ready;
  const origin = new URL(app.url).origin;
  const post = (path, body) =>
    fetch(origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post("/api/prompt", { message: "Keep A running" })).status,
    200,
  );
  await modelEntered;
  const old = app.runtime.session;
  const oldId = old.sessionManager.getSessionId();
  assert.equal(old.isIdle, false);
  if (process.argv[2] === "native-replace") {
    await app.runtime.newSession();
    console.log(
      JSON.stringify({
        mode: "native-replace",
        new_session_created:
          app.runtime.session.sessionManager.getSessionId() !== oldId,
        old_still_running: !old.isIdle,
        old_aborted: old.sessionManager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "message" &&
              entry.message.stopReason === "aborted",
          ),
      }),
    );
    assert.equal(
      old.isIdle,
      false,
      "Creating B must not abort/dispose the still-running A",
    );
  } else {
    const result = await post("/api/new-session", {});
    console.log(
      JSON.stringify({
        mode: "web-new",
        new_status: result.status,
        old_id_unchanged:
          app.runtime.session.sessionManager.getSessionId() === oldId,
        old_still_running: !old.isIdle,
      }),
    );
    assert.equal(
      result.status,
      200,
      "A running must not prevent creation of independent B",
    );
    assert.notEqual(app.runtime.session.sessionManager.getSessionId(), oldId);
    assert.equal(old.isIdle, false, "A must continue independently of B");
  }
} finally {
  release();
  await app?.stop();
  await new Promise((resolve) => {
    endpoint.close(resolve);
    endpoint.closeAllConnections();
  });
  await rm(root, { recursive: true, force: true });
}
