import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPersonality,
  writePersonality,
  personalityPath,
} from "../src/resources/personality.mjs";
import { desktopFixture, until } from "./desktop-fixture.mjs";


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
