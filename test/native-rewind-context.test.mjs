import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNativeTranscript } from "../src/session/pi-session-storage.mjs";

const user = (content) => ({ role: "user", content, timestamp: 1 });
const entry = (id, content) => ({
  id,
  kind: "fixture.message",
  model: [user(content)],
});
const cases = [
  {
    name: "同一 Durable 贡献的多条原生消息",
    entries: [
      { id: 10, kind: "fixture.batch", model: [user("one"), user("two")] },
      entry(12, "end"),
    ],
    texts: ["one", "two", "end"],
    origins: [10, 10, 12],
  },
  {
    name: "Pi 省略的消息不计入原点",
    entries: [
      entry(10, "omit"),
      entry(11, "keep"),
      { id: 12, kind: "fixture.edit", edits: [{ target: 10, action: "omit" }] },
      entry(13, "end"),
    ],
    texts: ["keep", "end"],
    origins: [11, 13],
  },
  {
    name: "Pi 替换内容后仍保留原贡献身份",
    entries: [
      entry(10, "old"),
      {
        id: 11,
        kind: "fixture.edit",
        edits: [{ target: 10, action: "replace", messages: [user("changed")] }],
      },
      entry(12, "end"),
    ],
    texts: ["changed", "end"],
    origins: [10, 12],
  },
  {
    name: "压缩摘要不使后续可见消息的原点错位",
    entries: [
      entry(10, "old"),
      entry(11, "keep"),
      { id: 12, kind: "pi.compaction", head: 11, model: [user("summary")] },
      entry(13, "end"),
    ],
    texts: ["summary", "keep", "end"],
    origins: [11, 13],
  },
  {
    name: "原生 custom 消息保留角色和原点",
    entries: [
      entry(10, "start"),
      {
        id: 11,
        kind: "desk.native-message",
        data: {
          nativeMessage: {
            role: "custom",
            customType: "fixture.card",
            content: "card",
            display: true,
            timestamp: 1,
          },
        },
      },
      entry(12, "end"),
    ],
    texts: ["start", "card", "end"],
    origins: [10, 11, 12],
  },
];

for (const scenario of cases)
  test(scenario.name, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-native-origins-"));
    const cwd = join(root, "project"),
      directory = join(root, "host");
    await mkdir(cwd);
    await mkdir(directory);
    // 仅夹住公开 transcript 输入；导出、Pi 活跃路径、编辑与压缩投影均使用真实实现。
    const workspace = {
      transcript: async () => ({
        active: { id: 2, cwd, name: "原点", thinkingLevel: "off" },
        entries: scenario.entries,
      }),
    };
    let native;
    t.after(async () => {
      try {
        await native?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    native = await openNativeTranscript({
      workspace,
      id: 2,
      cwd,
      directory,
      agentDir: join(root, "agent"),
      owner: "fixture:origins",
    });
    const replay = native.rewindContext(scenario.entries.at(-1).id);
    assert.deepEqual(
      replay.messages.map(
        (message) =>
          message.summary ??
          (typeof message.content === "string"
            ? message.content
            : message.content.map((block) => block.text ?? "").join("")),
      ),
      scenario.texts,
    );
    assert.deepEqual(replay.origins, scenario.origins);
    assert.deepEqual(
      native.rewindMessages(scenario.entries.at(-1).id),
      replay.messages,
      "旧消息读取接口保持兼容",
    );
    if (scenario.name.includes("custom"))
      assert.equal(replay.messages[1].role, "custom");
  });
