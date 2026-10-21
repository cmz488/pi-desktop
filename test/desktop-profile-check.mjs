import assert from "node:assert/strict";
import { mkdir, copyFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopFixture, until } from "./desktop-fixture.mjs";

// 调查夹具与固定前后比较分开，避免把采样器开销混进性能收益。
const HISTORY_TURNS = 60;
const HISTORY_UNITS = 512;
const ANSWER_WORDS = 128;
const output = process.argv[2];
assert.ok(output, "请提供临时证据目录");
await mkdir(output, { recursive: true });
const f = await desktopFixture({
  extensionPaths: [
    fileURLToPath(
      new URL("./performance-profile-fixture.mjs", import.meta.url),
    ),
  ],
  modelReply: async (input) => {
    const last = input.messages.at(-1);
    if (
      last?.role === "user" &&
      ["PROFILE_START", "PROFILE_STOP"].includes(last.content)
    )
      return {
        toolCalls: [
          {
            id: last.content,
            type: "function",
            function: {
              name:
                last.content === "PROFILE_START"
                  ? "fixture_profile_start"
                  : "fixture_profile_stop",
              arguments: "{}",
            },
          },
        ],
      };
    return { text: "PROFILE_ANSWER " + "data ".repeat(ANSWER_WORDS) };
  },
});
try {
  const project = (await f.call("/api/workspace")).projects.find(
    (row) => row.cwd === f.cwd,
  );
  const actor = await f.command("conversation.create", {
    projectId: project.id,
    name: "Profile A",
    approvalMode: "yolo",
  });
  const prefix = `/agents/${actor.id}`;
  const owner = (await f.call(`${prefix}/api/state`)).sessionId;
  const state = () => f.call(`${prefix}/api/state?sessionId=${owner}`);
  async function send(message) {
    await f.call(`${prefix}/api/prompt?sessionId=${owner}`, {
      sessionId: owner,
      message,
    });
    return until(
      state,
      (value) =>
        value.idle &&
        value.messages.some(
          (row) => row.role === "user" && row.text === message,
        ) &&
        value.messages.at(-1)?.role === "assistant",
    );
  }
  await send("PROFILE_WARM");
  await send("PROFILE_START");
  for (let turn = 0; turn < HISTORY_TURNS; turn++)
    await send(`PROFILE_HISTORY_${turn} ` + "x".repeat(HISTORY_UNITS));
  const final = await send("PROFILE_STOP");
  const path = final.messages.find(
    (row) => row.role === "toolResult" && row.toolCallId === "PROFILE_STOP",
  )?.text;
  assert.match(path ?? "", /^\/tmp\/pi-desktop-profile-\d+\.json$/);
  await copyFile(path, join(output, "profile.json"));
  await unlink(path);
  await writeFile(
    join(output, "conditions.json"),
    JSON.stringify(
      {
        historyTurns: HISTORY_TURNS,
        historyUnits: HISTORY_UNITS,
        answerWords: ANSWER_WORDS,
        workers: 1,
        modelRequests: f.requests.length,
        node: process.version,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`公开工具 CPU／分配采样：${join(output, "profile.json")}`);
} finally {
  await f.close();
}
