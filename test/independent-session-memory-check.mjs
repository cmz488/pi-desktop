import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopFixture, until } from "./desktop-fixture.mjs";

// 架构成本与同拓扑优化分开：一份 60 轮来源，再增加一个正常生命周期的继承 worker。
const REPEATS = 3;
const HISTORY_TURNS = 60;
const HISTORY_UNITS = 512;
const ANSWER_WORDS = 128;
const output = process.argv[2];
assert.ok(output, "请提供临时证据目录");
await mkdir(output, { recursive: true });
const runs = [];
for (let run = 0; run < REPEATS; run++) {
  const f = await desktopFixture({
    extensionPaths: [
      fileURLToPath(new URL("./memory-metrics-fixture.mjs", import.meta.url)),
    ],
    modelReply: async (input) => {
      const last = input.messages.at(-1);
      if (
        last?.role === "user" &&
        typeof last.content === "string" &&
        last.content.startsWith("ARCH_MEMORY_")
      )
        return {
          toolCalls: [
            {
              id: last.content,
              type: "function",
              function: { name: "fixture_process_memory", arguments: "{}" },
            },
          ],
        };
      return { text: "ARCH_ANSWER " + "data ".repeat(ANSWER_WORDS) };
    },
  });
  try {
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const source = await f.command("conversation.create", {
      projectId: project.id,
      name: "Architecture source",
      approvalMode: "yolo",
    });
    const sourcePrefix = `/agents/${source.id}`;
    const sourceId = (await f.call(`${sourcePrefix}/api/state`)).sessionId;
    const state = (prefix, id) => f.call(`${prefix}/api/state?sessionId=${id}`);
    async function send(prefix, id, message) {
      await f.call(`${prefix}/api/prompt?sessionId=${id}`, {
        sessionId: String(id),
        message,
      });
      return until(
        () => state(prefix, id),
        (value) =>
          value.idle &&
          value.messages.some(
            (row) => row.role === "user" && row.text === message,
          ) &&
          value.messages.at(-1)?.role === "assistant",
      );
    }
    async function memory(prefix, id, phase) {
      const key = `ARCH_MEMORY_${run}_${phase}`;
      const value = await send(prefix, id, key);
      const result = value.messages.find(
        (row) => row.role === "toolResult" && row.toolCallId === key,
      );
      assert.ok(result, "必须匹配本次实际工具回执，不能读继承记录中的旧 PID");
      return JSON.parse(result.text);
    }
    for (let turn = 0; turn < HISTORY_TURNS; turn++)
      await send(
        sourcePrefix,
        sourceId,
        `ARCH_HISTORY_${turn} ` + "x".repeat(HISTORY_UNITS),
      );
    const before = await memory(sourcePrefix, sourceId, "before");
    const created = await f.command("conversation.fork", {
      id: source.id,
      generation: 0,
      conversationId: Number(sourceId),
    });
    const inherited = await memory(
      `/agents/${created.agentId}`,
      created.sessionId,
      "inherited",
    );
    const sourceAfter = await memory(sourcePrefix, sourceId, "sourceAfter");
    assert.notEqual(before.pid, inherited.pid);
    assert.equal(before.pid, sourceAfter.pid);
    assert.equal(
      (await f.call("/api/workspace")).agents.filter(
        (row) => row.status === "running",
      ).length,
      2,
    );
    const row = {
      run: run + 1,
      historyTurns: HISTORY_TURNS,
      workersBefore: 1,
      workersAfter: 2,
      before,
      inherited,
      sourceAfter,
      modelRequests: f.requests.length,
    };
    runs.push(row);
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(
        {
          fixture: "independent-worker-architecture-cost-v1",
          node: process.version,
          runs,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      JSON.stringify({
        run: row.run,
        additionalWorker: {
          pid: inherited.pid,
          rss: inherited.rss,
          heap: inherited.heapUsed,
          afterGc: inherited.afterGc,
        },
        modelRequests: row.modelRequests,
      }),
    );
  } finally {
    await f.close();
  }
}
