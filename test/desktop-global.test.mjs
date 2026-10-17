import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import {
  readPersonality,
  writePersonality,
  personalityPath,
} from "../src/resources/personality.mjs";
import { desktopFixture, until } from "./desktop-fixture.mjs";

const remoteCall = (url, path, { cookie, input } = {}) =>
  new Promise((resolve, reject) => {
    const req = request(
      new URL(path, url),
      {
        method: input === undefined ? "GET" : "POST",
        headers: {
          Host: "pi-phone.test.ts.net:8443",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(input !== undefined
            ? {
                Origin: "https://pi-phone.test.ts.net:8443",
                "Content-Type": "application/json",
              }
            : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (v) => (text += v));
        res.on("end", () => {
          let data;
          try {
            data = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, data, text });
        });
      },
    );
    req.on("error", reject);
    req.end(input === undefined ? undefined : JSON.stringify(input));
  });

test("AGENTS.md editor fences external edits and rejects symlinks, invalid identities and oversized text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-personality-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "AGENTS.md"),
    before = await readPersonality(path);
  const saved = await writePersonality(path, {
    content: "人格\n<script>plain text</script>",
    revision: before.revision,
  });
  assert.equal(saved.content, await readFile(path, "utf8"));
  await writeFile(path, "external");
  await assert.rejects(
    writePersonality(path, { content: "overwrite", revision: saved.revision }),
    (error) => error.status === 409,
  );
  await assert.rejects(
    writePersonality(path, {
      content: "x".repeat(128 * 1024 + 1),
      revision: before.revision,
    }),
    (error) => error.status === 422,
  );
  const link = join(root, "link.md");
  await symlink(path, link);
  await assert.rejects(
    writePersonality(link, {
      content: "overwrite",
      revision: (await readPersonality(path)).revision,
    }),
    (error) => error.status === 422,
  );
  assert.equal(await readFile(path, "utf8"), "external");
  assert.throws(
    () => personalityPath(root, "../../escape"),
    (error) => error.status === 422,
  );
});

test(
  "global and selected AGENTS.md personalities reach projectless Pi requests and apply on reload and restart",
  { timeout: 45000 },
  async (t) => {
    const f = await desktopFixture({ defaultConversation: true });
    t.after(() => f.close());
    const catalog = await until(
      () => f.call("/api/workspace"),
      (v) =>
        v.agents.some((a) => a.projectId === null && a.status === "running"),
    );
    const agent = catalog.agents.find((a) => a.projectId === null),
      prefix = `/agents/${agent.id}`;
    const before = await f.call(prefix + "/api/personality");
    const saved = await f.call(prefix + "/api/personality", {
      content: "GLOBAL_PERSONALITY_1",
      revision: before.revision,
    });
    assert.deepEqual(saved.reloadRequired, []);
    const profile = await f.command("prompt.save", {
      name: "Reviewer",
      instructions: "SELECTED_PERSONALITY",
    });
    const metadata = (await f.call("/api/workspace")).promptProfiles.find(
      (row) => row.id === profile.id,
    );
    assert.equal(await readFile(metadata.file, "utf8"), "SELECTED_PERSONALITY");
    assert.equal(
      JSON.parse(await readFile(join(f.directory, "workspace.json"), "utf8"))
        .promptProfiles[0].instructions,
      undefined,
    );
    await f.command("agent.prompt", {
      id: agent.id,
      promptProfileId: profile.id,
    });
    const send = async (message) => {
      await f.call(prefix + "/api/prompt", { message, requestId: message });
      await until(
        () => f.call(prefix + "/api/state"),
        (v) =>
          v.idle && v.messages.some((row) => row.text === `answer: ${message}`),
      );
    };
    await send("first persona");
    assert.match(JSON.stringify(f.requests.at(-1)), /GLOBAL_PERSONALITY_1/);
    assert.match(JSON.stringify(f.requests.at(-1)), /SELECTED_PERSONALITY/);
    await f.call("/api/personality", {
      content: "GLOBAL_PERSONALITY_2",
      revision: saved.revision,
    });
    await f.command("prompt.save", {
      id: profile.id,
      name: "Reviewer",
      instructions: "EDITED_PERSONALITY",
      fileRevision: metadata.fileRevision,
    });
    await send("second persona");
    const latest = JSON.stringify(f.requests.at(-1));
    assert.match(latest, /GLOBAL_PERSONALITY_2/);
    assert.match(latest, /EDITED_PERSONALITY/);
    assert(!latest.includes("GLOBAL_PERSONALITY_1"));
    assert(!latest.includes("SELECTED_PERSONALITY"));
    await f.command("agent.restart", { id: agent.id });
    await send("restarted persona");
    assert.match(JSON.stringify(f.requests.at(-1)), /EDITED_PERSONALITY/);
    await assert.rejects(
      f.command("agent.save", { injections: { instructions: "OLD_OVERRIDE" } }),
      (error) => error.status === 422,
    );
  },
);

test(
  "all extension update delegates one native update with no source and fences every worker during the operation",
  { timeout: 45000 },
  async (t) => {
    let release,
      entered,
      calls = 0;
    const started = new Promise((resolve) => (entered = resolve));
    const f = await desktopFixture({
      defaultConversation: true,
      packageManagerFactory: () => ({
        async update(...args) {
          assert.deepEqual(args, []);
          calls++;
          entered();
          await new Promise((resolve) => (release = resolve));
        },
      }),
    });
    t.after(() => f.close());
    const catalog = await until(
      () => f.call("/api/workspace"),
      (v) => v.agents[0]?.status === "running",
    );
    const prefix = `/agents/${catalog.agents[0].id}`;
    const preview = await f.call(prefix + "/api/packages/update-all");
    assert.equal(preview.command, "pi update --extensions");
    await assert.rejects(
      f.call("/api/packages/update-all", { ...preview, revision: "stale" }),
      (error) => error.status === 409,
    );
    assert.equal(calls, 0);
    const update = f.call(prefix + "/api/packages/update-all", preview);
    await started;
    try {
      await assert.rejects(
        f.call(prefix + "/api/prompt", {
          message: "blocked",
          requestId: "blocked",
        }),
        (error) => error.status === 409,
      );
      await assert.rejects(
        f.command("conversation.create", { name: "blocked" }),
        (error) => error.status === 409,
      );
      await assert.rejects(
        f.call("/api/personality", { content: "blocked", revision: "stale" }),
        (error) => error.status === 409,
      );
    } finally {
      release();
    }
    assert.equal((await update).reloadRequired, true);
    assert.equal(calls, 1);
    await f.call(prefix + "/api/prompt", {
      message: "after update",
      requestId: "after update",
    });
    await until(
      () => f.call(prefix + "/api/state"),
      (v) =>
        v.idle && v.messages.some((row) => row.text === "answer: after update"),
    );
  },
);

test(
  "multi-project scan gateway authenticates the whole desktop and denies both root and worker remote-management endpoints",
  { timeout: 45000 },
  async (t) => {
    let gateway,
      closes = 0;
    const f = await desktopFixture({
      defaultConversation: true,
      remoteFunnel: {
        async start({ target }) {
          gateway = target;
          return {
            url: "https://pi-phone.test.ts.net:8443/",
            close: async () => closes++,
          };
        },
        async verify() {},
      },
    });
    t.after(() => f.close());
    const catalog = await until(
      () => f.call("/api/workspace"),
      (v) => v.agents[0]?.status === "running",
    );
    const id = catalog.agents[0].id;
    await f.call(`/agents/${id}/api/remote`, { action: "start" });
    const info = await until(
      () => f.call(`/api/remote?agent=${id}`),
      (v) => v.tunnel.phase === "ready",
    );
    assert.equal(new URL(info.url).searchParams.get("agent"), id);
    assert.match(info.qr, /^data:image\/png;base64,/);
    assert.equal((await remoteCall(gateway, "/api/workspace")).status, 401);
    const key = new URLSearchParams(new URL(info.url).hash.slice(1)).get(
      "connect",
    );
    const connected = await remoteCall(gateway, "/_pi/connect", {
      input: { key },
    });
    assert.equal(connected.status, 200);
    const cookie = connected.headers["set-cookie"][0].split(";")[0];
    assert.match(
      connected.headers["set-cookie"][0],
      /HttpOnly; Secure; SameSite=Strict/,
    );
    assert.equal(
      (await remoteCall(gateway, "/api/workspace", { cookie })).data.agents[0]
        .id,
      id,
    );
    assert.equal(
      (await remoteCall(gateway, `/agents/${id}/api/state`, { cookie })).status,
      200,
    );
    assert.equal(
      (await f.call(`/agents/${id}/api/state`)).capabilities.agentBrowser,
      true,
      "Chromium remains available in the local Desktop session",
    );
    const phoneState = await remoteCall(gateway, `/agents/${id}/api/state`, {
      cookie,
    });
    assert.equal(phoneState.data.capabilities.agentBrowser, false);
    assert.equal(phoneState.data.capabilities.browserRemoteDisabled, true);
    for (const path of [
      `/agents/${id}/_browser/frame`,
      `/agents/${id}/api/browser`,
    ])
      assert.equal(
        (await remoteCall(gateway, path, { cookie })).status,
        403,
        "remote devices cannot fetch the local Chromium controls or frame",
      );
    for (const path of ["/api/remote", `/agents/${id}/api/remote`]) {
      const read = await remoteCall(gateway, path, { cookie });
      assert.equal(read.data.remoteClient, true);
      assert.equal(read.data.qr, undefined);
      assert.equal(
        (
          await remoteCall(gateway, path, {
            cookie,
            input: { action: "rotate" },
          })
        ).status,
        403,
      );
    }
    await remoteCall(gateway, `/agents/${id}/api/prompt`, {
      cookie,
      input: { message: "phone conversation", requestId: "phone conversation" },
    });
    await until(
      () => f.call(`/agents/${id}/api/state`),
      (v) =>
        v.idle &&
        v.messages.some((row) => row.text === "answer: phone conversation"),
    );
    await f.call("/api/remote", { action: "rotate" });
    assert.equal(
      (await remoteCall(gateway, "/api/workspace", { cookie })).status,
      401,
    );
    assert.equal(
      (await remoteCall(gateway, "/_pi/connect", { input: { key } })).status,
      401,
    );
    await f.call("/api/remote", { action: "stop" });
    assert.equal(closes, 1);
  },
);
