import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { desktopFixture, until } from "./desktop-fixture.mjs";

async function actorFixture(t) {
  const f = await desktopFixture({ noExtensions: true });
  t.after(() => f.close());
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "Native boundary",
  });
  const prefix = `/agents/${actor.id}`;
  const id = (await f.call(`${prefix}/api/state`)).sessionId;
  return { f, actor, prefix, id };
}
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

test("初始化私有通道拒绝非法或重复原生身份，参数拒绝不毒化来源队列", async (t) => {
  const { f, actor, prefix, id } = await actorFixture(t);
  await f.call(`${prefix}/api/prompt?sessionId=${id}`, {
    sessionId: id,
    message: "SOURCE_IDENTITY_BOUNDARY",
  });
  await until(
    () => f.call(`${prefix}/api/state`),
    (value) => value.idle,
  );
  const metadata = await f.call(
    `/api/workspace/detail?kind=agent&id=${actor.id}`,
  );
  const before = await digest(metadata.nativeSessionPath);
  // 只有夹具扮演拥有此 worker 的宿主；浏览器代理的相同路径必须始终拒绝。
  const origin = new URL(f.app.supervisor.target(actor.id)).origin;
  async function initialize(input) {
    const response = await fetch(`${origin}/api/fork-source?sessionId=${id}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ id: Number(id), ...input }),
    });
    return { status: response.status, body: await response.json() };
  }
  assert.equal(
    (await initialize({ nativeId: "../not-a-native-id" })).status,
    422,
  );
  assert.equal(
    (await initialize({ nativeId: metadata.nativeSessionId })).status,
    409,
  );
  assert.equal(
    (
      await initialize({
        nativeId: metadata.nativeSessionId,
        entryId: 1,
        expectedEntryId: 1,
      })
    ).status,
    422,
  );
  assert.equal(await digest(metadata.nativeSessionPath), before);
  await assert.rejects(
    f.call(`${prefix}/api/fork-source?sessionId=${id}`, {
      id: Number(id),
      nativeId: metadata.nativeSessionId,
    }),
    (error) => error.status === 403,
  );
  const created = await f.command("conversation.fork", {
    id: actor.id,
    generation: 0,
  });
  assert.ok(
    created.agentId && created.agentId !== actor.id,
    "拒绝后的正常继承仍可用",
  );
  assert.equal(await digest(metadata.nativeSessionPath), before);
});

function rawCommand(url, payload, chunked) {
  const bytes = Buffer.from(JSON.stringify(payload, null, 2));
  return new Promise((resolve, reject) => {
    const client = request(
      url,
      {
        method: "POST",
        headers: {
          Origin: url.origin,
          "Content-Type": "application/json",
          ...(chunked ? {} : { "Content-Length": String(bytes.length) }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    client.on("error", reject);
    if (chunked) {
      client.write(bytes.subarray(0, 113));
      client.end(bytes.subarray(113));
    } else client.end(bytes);
  });
}

test("非 fork 命令透传保持 Unicode、chunked 和 768KiB 边界，不误用配置体上限", async (t) => {
  const { f, prefix, id } = await actorFixture(t);
  const OPAQUE_TRANSPORT_UNITS = 300000;
  for (const chunked of [false, true]) {
    const active = (await f.call(`${prefix}/api/agent`)).active;
    const instructions = `UTF8 原样协议\n换行与表情：✓ ${chunked ? "分块" : "定长"}`;
    const response = await rawCommand(
      new URL(`${prefix}/api/command?sessionId=${id}`, f.app.url),
      {
        command: "configure",
        id: Number(id),
        sessionId: id,
        revision: active.revision,
        instructions,
        opaqueTransportFixture: "x".repeat(OPAQUE_TRANSPORT_UNITS),
      },
      chunked,
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      (await f.call(`${prefix}/api/agent`)).active.instructions,
      instructions,
    );
  }
  const active = (await f.call(`${prefix}/api/agent`)).active;
  const OVER_COMMAND_BYTES = 768 * 1024;
  await assert.rejects(
    f.call(`${prefix}/api/command?sessionId=${id}`, {
      command: "configure",
      id: Number(id),
      sessionId: id,
      revision: active.revision,
      opaqueTransportFixture: "x".repeat(OVER_COMMAND_BYTES),
    }),
    (error) => error.status === 413,
  );
  assert.equal(
    (await f.call(`${prefix}/api/agent`)).active.revision,
    active.revision,
  );
  assert.equal(f.requests.length, 0, "传输验证不偷开模型或执行工具");
});
