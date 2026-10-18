import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, readFile, writeFile, unlink } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { join } from "node:path";
import { readNativeTranscriptFamily } from "../src/session/native-transcript-family.mjs";
import { desktopFixture, until } from "./desktop-fixture.mjs";

async function fixture(t, options = {}) {
  const f = await desktopFixture({ noExtensions: true, ...options });
  t.after(() => f.close());
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const created = await f.command("conversation.create", {
    projectId: project.id,
    name: "分支来源",
  });
  const prefix = `/agents/${created.id}`;
  const state = (id) =>
    f.call(`${prefix}/api/state${id === undefined ? "" : `?sessionId=${id}`}`);
  const command = (id, input) =>
    f.call(`${prefix}/api/command?sessionId=${id}`, {
      id: Number(id),
      sessionId: String(id),
      ...input,
    });
  const source = (await state()).sessionId;
  const turn = async (id, message) => {
    await f.call(`${prefix}/api/prompt?sessionId=${id}`, {
      message,
      sessionId: String(id),
    });
    return until(
      () => state(id),
      (value) =>
        value.idle &&
        value.messages.some((row) => row.text === `answer: ${message}`),
    );
  };
  return { f, agent: created.id, prefix, source, state, command, turn };
}

test(
  "默认 Host 的分支是同一 worker 内的独立 Durable 会话，且各有原生转录",
  { timeout: 60000 },
  async (t) => {
    const { f, agent, prefix, source, state, command, turn } = await fixture(t);
    const before = await turn(source, "source question");
    const point = before.messages.find((row) => row.text === "source question");
    const pid = (await f.call("/api/workspace")).agents.find(
      (row) => row.id === agent,
    ).pid;
    const forked = await command(source, {
      command: "fork",
      entryId: point.entryId,
    });
    assert.notEqual(forked.sessionId, source);
    const branch = await state(forked.sessionId);
    assert.equal(branch.stats.tokens.total, 0);
    assert.deepEqual(
      branch.messages
        .filter((row) => row.role === "user")
        .map((row) => row.text),
      ["source question"],
    );
    const unchanged = await state(source);
    assert.deepEqual(unchanged.messages, before.messages);
    assert.deepEqual(unchanged.stats, before.stats);
    const sessions = (await f.call(`${prefix}/api/sessions`)).rows;
    assert.ok(
      sessions.some((row) => String(row.id) === forked.sessionId && row.native),
    );
    const tree = await f.call(`${prefix}/api/tree?id=${forked.sessionId}`);
    assert.ok(tree.native, "新分支也可以继续使用原生树与退回");
    assert.deepEqual(tree.forkOf, {
      conversationId: Number(source),
      entryId: point.entryId,
    });
    const after = await f.call("/api/workspace");
    assert.equal(
      after.agents.find((row) => row.id === agent).pid,
      pid,
      "没有启动第二个 writer",
    );
    await assert.rejects(
      command(forked.sessionId, {
        command: "create",
        cwd: f.cwd,
        name: "非法新建",
      }),
      (error) => error.status === 409,
    );
  },
);

test(
  "分支运行时宿主不能把根会话的空闲当作整个 worker 空闲",
  { timeout: 60000 },
  async (t) => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    t.after(() => release());
    const { f, agent, prefix, source, state, command, turn } = await fixture(
      t,
      {
        beforeModelResponse: async (input) => {
          if (
            JSON.stringify(input.messages.at(-1).content).includes(
              "family hold",
            )
          )
            await gate;
        },
      },
    );
    const before = await turn(source, "source question");
    const point = before.messages.find((row) => row.text === "source question");
    const branch = (
      await command(source, { command: "fork", entryId: point.entryId })
    ).sessionId;
    await f.call(`${prefix}/api/prompt?sessionId=${branch}`, {
      message: "family hold",
      sessionId: branch,
    });
    await until(
      () => state(branch),
      (value) => !value.idle && f.requests.length === 2,
    );
    assert.equal(
      (await state(source)).idle,
      true,
      "根会话确实空闲，不改变这个既有字段的语义",
    );
    assert.equal((await f.call(`${prefix}/api/agent`)).familyIdle, false);
    const personality = await f.call("/api/personality");
    await assert.rejects(
      f.call("/api/personality", {
        content: "must block",
        revision: personality.revision,
      }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      f.command("agent.rename", { id: agent, name: "must block" }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      f.command("agent.policy", { id: agent, mode: "yolo" }),
      (error) => error.status === 409,
    );
    // 新建一个未被引用的提示词不修改运行配置，保留既有追加语义。
    assert.ok(
      (
        await f.command("prompt.save", {
          name: "append allowed",
          instructions: "test",
        })
      ).id,
    );
    release();
    await until(
      () => state(branch),
      (value) => value.idle,
    );
    assert.equal(
      (
        await f.call("/api/personality", {
          content: "allowed after idle",
          revision: personality.revision,
        })
      ).content,
      "allowed after idle",
    );
  },
);

test(
  "重启与归档恢复保留整个会话族的内容、用量和原生身份",
  { timeout: 60000 },
  async (t) => {
    const { f, agent, prefix, source, state, command, turn } = await fixture(t);
    const first = await turn(source, "source question");
    const point = first.messages.find((row) => row.text === "source question");
    const b = (
      await command(source, { command: "fork", entryId: point.entryId })
    ).sessionId;
    const second = await turn(b, "branch question");
    const branchPoint = second.messages.find(
      (row) => row.text === "branch question",
    );
    const c = (
      await command(b, { command: "fork", entryId: branchPoint.entryId })
    ).sessionId;
    const ids = [source, b, c];
    const snapshots = await Promise.all(ids.map(state));
    const origins = await Promise.all(
      ids.map(
        async (id) => (await f.call(`${prefix}/api/tree?id=${id}`)).forkOf,
      ),
    );
    const familyPath = join(f.directory, "agents", agent);
    const before = await readNativeTranscriptFamily(familyPath);
    assert.equal(before.members.length, 3);
    assert.equal(
      new Set(before.members.map((row) => row.nativeSessionId)).size,
      3,
    );
    await f.reopen();
    await until(
      () => f.call("/api/workspace"),
      (value) =>
        value.agents.find((row) => row.id === agent)?.status === "running",
    );
    assert.deepEqual(
      (await readNativeTranscriptFamily(familyPath)).members,
      before.members,
    );
    for (const [index, id] of ids.entries()) {
      const current = await state(id);
      assert.deepEqual(current.messages, snapshots[index].messages);
      assert.deepEqual(current.stats, snapshots[index].stats);
    }
    for (const [index, id] of ids.entries())
      assert.deepEqual(
        (await f.call(`${prefix}/api/tree?id=${id}`)).forkOf,
        origins[index],
      );
    const catalog = await f.call("/api/workspace");
    assert.equal(
      catalog.agents.length,
      1,
      "分支没有被发现器注册成另一个 Pi Agent",
    );
    await f.command("agent.stop", { id: agent });
    await assert.rejects(
      f.command("agent.resume", { id: agent }),
      (error) => error.status === 409 && error.message.includes("独立分支"),
      "不能用单份 TUI 记录覆盖整个 Durable 会话族",
    );
    await f.command("agent.archive", { id: agent });
    for (const member of before.members)
      await assert.rejects(
        stat(member.path),
        (error) => error.code === "ENOENT",
        "整个会话族的原生文件均已可靠归档后移除",
      );
    await f.reopen();
    await f.command("agent.restore", { id: agent });
    for (const member of before.members)
      assert.ok((await stat(member.path)).isFile());
    await f.command("agent.start", { id: agent });
    assert.deepEqual(
      (await readNativeTranscriptFamily(familyPath)).members,
      before.members,
    );
    for (const [index, id] of ids.entries()) {
      const current = await state(id);
      assert.deepEqual(current.messages, snapshots[index].messages);
      assert.deepEqual(current.stats, snapshots[index].stats);
      assert.deepEqual(
        (await f.call(`${prefix}/api/tree?id=${id}`)).forkOf,
        origins[index],
      );
    }
  },
);

test(
  "整族归档中途失败可在 Host 重启时完成，未完成前不能启动或反向恢复",
  { timeout: 60000 },
  async (t) => {
    let release;
    t.after(async () => {
      if (release) await release();
    });
    const { f, agent, source, state, command, turn } = await fixture(t);
    const before = await turn(source, "source question");
    const point = before.messages.find((row) => row.text === "source question");
    const branch = (
      await command(source, { command: "fork", entryId: point.entryId })
    ).sessionId;
    const original = await state(branch);
    const manifest = await readNativeTranscriptFamily(
      join(f.directory, "agents", agent),
    );
    const child = manifest.members.find((row) => String(row.id) === branch);
    await f.command("agent.stop", { id: agent });
    release = await lockfile.lock(child.path, { realpath: false });
    await assert.rejects(
      f.command("agent.archive", { id: agent }),
      (error) => error.status === 409,
    );
    const pending = (await f.call("/api/workspace")).agents.find(
      (row) => row.id === agent,
    );
    assert.equal(pending.archivePending, true);
    assert.equal(pending.desired, false);
    await assert.rejects(
      f.command("agent.start", { id: agent }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      f.command("agent.restore", { id: agent }),
      (error) => error.status === 409,
    );
    await release();
    release = undefined;
    await f.reopen();
    await until(
      () => f.call("/api/workspace"),
      (value) => {
        const row = value.agents.find((entry) => entry.id === agent);
        return row.archived && !row.archivePending;
      },
    );
    for (const member of manifest.members)
      await assert.rejects(
        stat(member.path),
        (error) => error.code === "ENOENT",
      );
    await f.command("agent.restore", { id: agent });
    await f.command("agent.start", { id: agent });
    assert.deepEqual((await state(branch)).messages, original.messages);
    assert.deepEqual((await state(branch)).stats, original.stats);
  },
);

test(
  "整族恢复不覆盖冲突分支，保存恢复意图后可跨 Host 重启继续",
  { timeout: 60000 },
  async (t) => {
    const { f, agent, source, state, command, turn } = await fixture(t);
    const before = await turn(source, "source question");
    const point = before.messages.find((row) => row.text === "source question");
    const branch = (
      await command(source, { command: "fork", entryId: point.entryId })
    ).sessionId;
    const original = await state(branch);
    const manifest = await readNativeTranscriptFamily(
      join(f.directory, "agents", agent),
    );
    const child = manifest.members.find((row) => String(row.id) === branch);
    await f.command("agent.stop", { id: agent });
    const raw = await readFile(child.path, "utf8");
    await f.command("agent.archive", { id: agent });
    const conflict =
      raw +
      JSON.stringify({
        type: "custom",
        id: "fixture-conflict",
        parentId: null,
        customType: "fixture-conflict",
        data: {},
      }) +
      "\n";
    await writeFile(child.path, conflict);
    await assert.rejects(
      f.command("agent.restore", { id: agent }),
      (error) => error.status === 409,
    );
    assert.equal(
      await readFile(child.path, "utf8"),
      conflict,
      "冲突的原生文件没有被覆盖",
    );
    const pending = (await f.call("/api/workspace")).agents.find(
      (row) => row.id === agent,
    );
    assert.equal(pending.archivePending, true);
    assert.equal(pending.archived, true);
    await assert.rejects(
      f.command("agent.start", { id: agent }),
      (error) => error.status === 409,
    );
    await f.app.stop();
    await unlink(child.path);
    await f.reopen();
    await until(
      () => f.call("/api/workspace"),
      (value) => {
        const row = value.agents.find((entry) => entry.id === agent);
        return !row.archived && !row.archivePending;
      },
    );
    assert.equal(
      await readFile(child.path, "utf8"),
      raw,
      "从 SQLite 恢复的是已备份的完整记录",
    );
    await f.command("agent.start", { id: agent });
    assert.deepEqual((await state(branch)).messages, original.messages);
  },
);

test(
  "首次恢复文件仍被占用时也持久保存整族意图，重启后自动续完",
  { timeout: 60000 },
  async (t) => {
    const { f, agent, source, state, command, turn } = await fixture(t);
    const before = await turn(source, "source question");
    const point = before.messages.find((row) => row.text === "source question");
    const branch = (
      await command(source, { command: "fork", entryId: point.entryId })
    ).sessionId;
    const original = await state(branch);
    const manifest = await readNativeTranscriptFamily(
      join(f.directory, "agents", agent),
    );
    const root = manifest.members.find((row) => row.id === manifest.root);
    await f.command("agent.stop", { id: agent });
    await f.command("agent.archive", { id: agent });
    const release = await lockfile.lock(root.path, { realpath: false });
    try {
      await assert.rejects(
        f.command("agent.restore", { id: agent }),
        (error) => error.status === 409,
      );
      const pending = (await f.call("/api/workspace")).agents.find(
        (row) => row.id === agent,
      );
      assert.equal(pending.archived, true);
      assert.equal(pending.archivePending, true);
      await assert.rejects(
        f.command("agent.archive", { id: agent }),
        (error) => error.status === 409,
        "第一次文件迁移之前失败也不能反向清掉恢复意图",
      );
    } finally {
      await release();
    }
    await f.reopen();
    await until(
      () => f.call("/api/workspace"),
      (value) => {
        const row = value.agents.find((entry) => entry.id === agent);
        return !row.archived && !row.archivePending;
      },
    );
    for (const member of manifest.members)
      assert.ok((await stat(member.path)).isFile());
    await f.command("agent.start", { id: agent });
    assert.deepEqual((await state(branch)).messages, original.messages);
  },
);
