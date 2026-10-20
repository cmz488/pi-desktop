import { test } from "node:test";
import assert from "node:assert/strict";
import { desktopFixture, until } from "./desktop-fixture.mjs";

test(
  "子代理历史只列原生终态并分页，历史 fork 不继承 owned 记录，远程入口仍拒绝",
  { timeout: 60000 },
  async (t) => {
    const f = await desktopFixture({ noExtensions: true });
    t.after(() => f.close());
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: "原生历史",
    });
    const prefix = `/agents/${actor.id}`;
    const parent = (await f.call(`${prefix}/api/state`)).sessionId;
    await f.call(`${prefix}/api/prompt?sessionId=${parent}`, {
      sessionId: parent,
      message: "history root",
    });
    await until(
      () => f.call(`${prefix}/api/state?sessionId=${parent}`),
      (value) => value.idle,
    );
    const ids = [];
    for (let index = 0; index < 21; index++) {
      const task = await f.call(`${prefix}/api/command?sessionId=${parent}`, {
        command: "subagent.spawn",
        id: Number(parent),
        sessionId: parent,
        prompt: `history-${index}`,
        requestId: `history-${index}`,
      });
      await until(
        () =>
          f.call(
            `${prefix}/api/task-detail?sessionId=${parent}&taskId=${task.taskId}`,
          ),
        (value) => value.task.status === "terminal",
      );
      ids.push(task.taskId);
    }
    const first = await f.call(
      `${prefix}/api/subagent-history?sessionId=${parent}`,
    );
    assert.equal(first.records.length, 20);
    assert.deepEqual(
      first.records.map((row) => row.id),
      ids.slice(1).reverse(),
    );
    assert.ok(
      first.records.every(
        (row) =>
          row.status === "terminal" && row.outcome.status === "completed",
      ),
    );
    const second = await f.call(
      `${prefix}/api/subagent-history?sessionId=${parent}&before=${first.nextBefore}`,
    );
    assert.deepEqual(
      second.records.map((row) => row.id),
      [ids[0]],
    );
    assert.equal(second.nextBefore, null);
    const branch = await f.command("conversation.fork", {
      id: actor.id,
      generation: 0,
    });
    assert.deepEqual(
      (
        await f.call(
          `${prefix}/api/subagent-history?sessionId=${branch.sessionId}`,
        )
      ).records,
      [],
    );
    const remote = await fetch(
      new URL(`${prefix}/api/subagent-history?sessionId=${parent}`, f.app.url),
      { headers: { "x-pi-remote-client": "1" } },
    );
    assert.equal(remote.status, 403);
    await assert.rejects(
      f.call(`${prefix}/api/subagent-history?sessionId=${parent}&before=no-id`),
      (error) => error.status === 422,
    );
    for (const path of [
      `/api/tasks?sessionId=${parent}`,
      `/api/task-detail?sessionId=${parent}&taskId=${ids[0]}`,
      `/api/subagent-history?sessionId=${parent}`,
    ]) {
      await assert.rejects(
        f.call(`${prefix}${path}&generation=1`),
        (error) => error.status === 409,
        "整合面板的旧存储代际不能读取新库同号任务",
      );
      await assert.rejects(
        f.call(`${prefix}${path}&generation=invalid`),
        (error) => error.status === 422,
      );
      await f.call(`${prefix}${path}&generation=0`);
    }
    await assert.rejects(
      f.call(`${prefix}/api/command?sessionId=${parent}&generation=1`, {
        command: "cancel",
        id: Number(parent),
        sessionId: parent,
        taskId: ids[0],
      }),
      (error) => error.status === 409,
      "旧代际管理命令不能转发给当前存储",
    );
    assert.equal(f.requests.length, 22, "历史读取、分页与 fork 不重放模型");
  },
);
