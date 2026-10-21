import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { desktopFixture, until } from "./desktop-fixture.mjs";

const prefix = (id) => `/agents/${id}`;

test(
  "工作区创建分支固定 Agent、代际和原生会话，导航保留在原项目",
  { timeout: 90000 },
  async (t) => {
    const f = await desktopFixture({ noExtensions: true });
    t.after(() => f.close());
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const otherCwd = join(f.root, "other-project");
    await mkdir(otherCwd);
    const otherProject = await f.command("project.save", {
      name: "另一个项目",
      cwd: otherCwd,
    });
    const a = await f.command("conversation.create", {
      projectId: project.id,
      name: "来源 A",
    });
    const b = await f.command("conversation.create", {
      projectId: otherProject.id,
      name: "来源 B",
    });
    const state = (actor, id) =>
      f.call(
        `${prefix(actor)}/api/state${id === undefined ? "" : `?sessionId=${id}`}`,
      );
    const turn = async (actor, id, message) => {
      await f.call(`${prefix(actor)}/api/prompt?sessionId=${id}`, {
        sessionId: String(id),
        message,
      });
      return until(
        () => state(actor, id),
        (snapshot) =>
          snapshot.idle &&
          snapshot.messages.some((row) => row.text === `answer: ${message}`),
      );
    };
    const rootA = (await state(a.id)).sessionId;
    const rootB = (await state(b.id)).sessionId;
    assert.equal(
      rootA,
      rootB,
      "不同 worker 可以拥有同号原生会话，目标必须含外层身份",
    );
    const before = await turn(a.id, rootA, "A question");
    await turn(b.id, rootB, "B question");
    const point = (await f.call(`${prefix(a.id)}/api/tree?id=${rootA}`))
      .currentEntryId;
    const pid = (await f.call("/api/workspace?view=index")).agents.find(
      (row) => row.id === a.id,
    ).pid;
    const fork = await f.command("conversation.fork", {
      id: a.id,
      generation: 0,
    });
    assert.notEqual(fork.agentId, a.id);
    const tree = await f.call(
      `${prefix(fork.agentId)}/api/tree?id=${fork.sessionId}`,
    );
    assert.equal(tree.forkOf, null);
    assert.deepEqual(
      (await state(fork.agentId, fork.sessionId)).messages.map(
        (row) => row.text,
      ),
      ["A question", "answer: A question"],
    );
    assert.equal(
      (await state(fork.agentId, fork.sessionId)).stats.tokens.total,
      0,
    );
    assert.deepEqual(
      (await state(a.id, rootA)).messages,
      before.messages,
      "创建的是新会话，原会话没有被改写",
    );
    assert.equal(f.requests.length, 2, "继承当前位置不重放模型");
    const index = await f.call("/api/workspace?view=index");
    const owner = index.agents.find((row) => row.id === a.id);
    assert.equal(owner.projectId, project.id);
    assert.equal(owner.pid, pid, "来源的 worker 不改变");
    assert.equal(owner.branches.length, 0);
    const sibling = index.agents.find((row) => row.id === fork.agentId);
    assert.equal(sibling.projectId, project.id);
    assert.notEqual(sibling.pid, pid);
    assert.equal(sibling.createdFrom.agentId, a.id);
    assert.equal(sibling.createdFrom.conversationId, Number(rootA));
    assert.equal(sibling.createdFrom.entryId, point);
    assert.equal(
      index.agents.find((row) => row.id === b.id).branches.length,
      0,
    );
    assert.equal(
      index.agents.length,
      3,
      "新分支直接增加正常独立会话，不在来源内部增加导航子项",
    );
    assert.equal("nativeSessions" in owner, false);
    assert.equal("nativeSessionPath" in owner, false);
    const nativeName = (
      await f.call(`${prefix(fork.agentId)}/api/sessions`)
    ).rows.find((row) => row.id === fork.sessionId).name;
    assert.equal(sibling.name, nativeName, "同级条目仍使用正常会话名称");
    await turn(fork.agentId, fork.sessionId, "branch question");
    const child = await f.command("conversation.fork", {
      id: fork.agentId,
      generation: 0,
      conversationId: Number(fork.sessionId),
    });
    assert.notEqual(child.agentId, fork.agentId);
    assert.equal(
      (await f.call("/api/workspace?view=index")).agents.find(
        (row) => row.id === child.agentId,
      ).createdFrom.agentId,
      fork.agentId,
    );
    assert.ok(
      (await state(child.agentId, child.sessionId)).messages.some(
        (row) => row.text === "branch question",
      ),
    );
    for (const [patch, status] of [
      [{}, 422],
      [{ generation: 1 }, 409],
      [{ generation: 0, conversationId: -1 }, 422],
      [{ generation: 0, conversationId: 999999 }, 404],
    ]) {
      await assert.rejects(
        f.command("conversation.fork", { id: a.id, ...patch }),
        (error) => error.status === status,
      );
    }
    await assert.rejects(
      f.call(
        "/api/workspace/command",
        { command: "conversation.fork", id: a.id, generation: 0 },
        { headers: { "x-pi-remote-client": "1" } },
      ),
      (error) => error.status === 403,
    );
    const guardedCount = (await f.call("/api/workspace")).agents.length;
    for (const [path, input, extra, status] of [
      [
        `${prefix(a.id)}/api/fork-source`,
        { id: Number(rootA), nativeId: b.id },
        {},
        403,
      ],
      [
        `${prefix(a.id)}/api/command?sessionId=${rootA}`,
        { command: "fork", id: Number(rootA), sessionId: rootA },
        { headers: { "x-pi-remote-client": "1" } },
        403,
      ],
      [
        `${prefix(a.id)}/api/command?sessionId=${Number(rootA) + 1}`,
        { command: "fork", id: Number(rootA), sessionId: rootA },
        {},
        409,
      ],
      [
        `${prefix(a.id)}/api/command?sessionId=${rootA}&generation=1`,
        { command: "fork", id: Number(rootA), sessionId: rootA },
        {},
        409,
      ],
    ])
      await assert.rejects(
        f.call(path, input, extra),
        (error) => error.status === status,
      );
    assert.equal((await f.call("/api/workspace")).agents.length, guardedCount);
    const readOnly = await f.command("conversation.create", {
      name: "只读会话",
    });
    const readOnlyRoot = (await state(readOnly.id)).sessionId;
    await turn(readOnly.id, readOnlyRoot, "read-only source");
    await assert.rejects(
      f.command("conversation.fork", { id: readOnly.id, generation: 0 }),
      (error) => error.status === 403,
    );
    await f.command("agent.stop", { id: b.id });
    await f.command("agent.resume", { id: b.id });
    await assert.rejects(
      f.command("conversation.fork", {
        id: b.id,
        generation: 0,
        conversationId: Number(rootB),
      }),
      (error) => error.status === 409,
    );
    assert.equal(
      (await f.call(`${prefix(b.id)}/api/sessions`)).rows.length,
      1,
      "旧代际请求不能落入新库的同号会话",
    );
    const expected = (await f.call("/api/workspace?view=index")).agents.find(
      (row) => row.id === a.id,
    ).branches;
    await f.command("agent.stop", { id: a.id });
    assert.deepEqual(
      (await f.call("/api/workspace?view=index")).agents.find(
        (row) => row.id === a.id,
      ).branches,
      expected,
      "停止后导航仍保留历史会话入口",
    );
    await assert.rejects(
      f.command("conversation.fork", { id: a.id, generation: 0 }),
      (error) => error.status === 409,
    );
    await f.reopen();
    assert.deepEqual(
      (await f.call("/api/workspace?view=index")).agents.find(
        (row) => row.id === a.id,
      ).branches,
      expected,
      "Host 重启不丢导航，也不启动已停止的 worker",
    );
  },
);

test(
  "工作区分支沿用原生忙碌快照，不中止源回合",
  { timeout: 60000 },
  async (t) => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const f = await desktopFixture({
      noExtensions: true,
      beforeModelResponse: () => held,
    });
    t.after(async () => {
      release();
      await f.close();
    });
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: "忙碌来源",
    });
    const root = (await f.call(`${prefix(actor.id)}/api/state`)).sessionId;
    await f.call(`${prefix(actor.id)}/api/prompt?sessionId=${root}`, {
      sessionId: root,
      message: "pending question",
    });
    await until(
      () => f.call(`${prefix(actor.id)}/api/state?sessionId=${root}`),
      (snapshot) => !snapshot.idle && f.requests.length === 1,
    );
    const fork = await f.command("conversation.fork", {
      id: actor.id,
      generation: 0,
      conversationId: Number(root),
    });
    assert.deepEqual(
      (
        await f.call(
          `${prefix(fork.agentId)}/api/state?sessionId=${fork.sessionId}`,
        )
      ).messages.map((row) => row.text),
      ["pending question"],
    );
    assert.equal(
      (await f.call(`${prefix(actor.id)}/api/state?sessionId=${root}`)).idle,
      false,
    );
    assert.equal(f.requests.length, 1);
    release();
    await until(
      () => f.call(`${prefix(actor.id)}/api/state?sessionId=${root}`),
      (snapshot) =>
        snapshot.idle &&
        snapshot.messages.some(
          (row) => row.text === "answer: pending question",
        ),
    );
  },
);

test(
  "无响应 worker 的分支请求有界，超时后不阻塞宿主管理",
  { timeout: 30000 },
  async (t) => {
    const f = await desktopFixture({ noExtensions: true });
    let pid;
    t.after(async () => {
      if (pid) {
        try {
          process.kill(pid, "SIGCONT");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      await f.close();
    });
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: "无响应来源",
    });
    pid = (await f.call("/api/workspace?view=index")).agents.find(
      (row) => row.id === actor.id,
    ).pid;
    process.kill(pid, "SIGSTOP");
    const origin = new URL(f.app.url).origin;
    const response = await fetch(origin + "/api/workspace/command", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        command: "conversation.fork",
        id: actor.id,
        generation: 0,
      }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /超时.*刷新/);
    const created = await f.command("prompt.save", {
      name: "超时后仍可管理",
      instructions: "temporary fixture",
    });
    assert.ok(created.id);
  },
);
