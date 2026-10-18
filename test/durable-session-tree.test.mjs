import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";
import { startDurableDesk } from "../src/server/durable-server.mjs";
import {
  nativeSessionDirectory,
  readNativeRecord,
} from "../src/session/pi-session-storage.mjs";

/* 会话树退回与分叉：分叉产生独立会话与独立用量；退回保留 transcript 并把模型上下文重建到
 * 该点。两者都必须写回 Pi JSONL 的会话树，使 parent id 与 active entry 与 Desktop 一致。 */

const messageText = (entry) => {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.map((part) => part.text ?? "").join("")
    : "";
};

test(
  "the session tree forks an entry and rewinds in place, keeping Pi JSONL consistent",
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-session-tree-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const models = createModels(),
      faux = fauxProvider({ tokensPerSecond: 10000 });
    models.setProvider(faux.provider);
    const answers = ["第一轮回答", "第二轮回答", "第三轮回答", "第四轮回答"];
    faux.setResponses(answers.map((answer) => fauxAssistantMessage(answer)));
    const workspace = await openAgentWorkspace({
      storage: new MemoryStorage(),
      models,
    });
    const created = await workspace.execute("create", {
      cwd,
      name: "会话树",
      model: { provider: faux.provider.id, modelId: faux.models[0].id },
    });
    const agentId = created.id;
    const app = await startDurableDesk({
      workspace,
      port: 0,
      agentDir,
      directory: join(agentDir, "desktop"),
      cwd,
      // 本用例只验证会话树与原生 JSONL，不装配 Pi 资源宿主。
      resources: false,
      nativeSessionOwner: "owner:session-tree",
    });
    t.after(() => app.stop());
    const origin = new URL(app.url).origin;
    const call = async (path, input) => {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok)
        throw new Error(`${path} ${response.status} ${text.slice(0, 400)}`);
      return data;
    };
    const state = async (id) => {
      const response = await fetch(`${origin}/api/state?id=${id}`, {
        headers: { Origin: origin },
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(
          `/api/state?id=${id} ${response.status} ${text.slice(0, 300)}`,
        );
      return text ? JSON.parse(text) : {};
    };
    const statsOf = (value, label) => {
      assert.ok(
        value.stats,
        `${label} reports stats: ${JSON.stringify(value).slice(0, 300)}`,
      );
      return value.stats.tokens.total;
    };
    const turn = async (message, answer) => {
      await call("/api/prompt", { message, sessionId: String(agentId) });
      for (let index = 0; index < 400; index++) {
        const current = await state(agentId);
        if (current.idle && current.messages.some((row) => row.text === answer))
          return current;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timeout waiting for ${answer}`);
    };

    await turn("第一轮", answers[0]);
    await turn("第二轮", answers[1]);
    const third = await turn("第三轮", answers[2]);
    const firstEntry = third.messages.find((row) => row.text === "第一轮");
    const target = third.messages.find((row) => row.text === "第二轮");
    assert.equal(typeof firstEntry?.entryId, "number");
    assert.equal(typeof target?.entryId, "number");
    const transcriptBefore = (await workspace.transcript(agentId)).entries
      .length;

    // 分叉：从第一轮分支出的会话拥有该点之前的上下文与独立用量。
    const forked = await call("/api/command", {
      command: "fork",
      id: agentId,
      entryId: firstEntry.entryId,
    });
    assert.equal(forked.sessionId, String(forked.id));
    const forkedState = await state(forked.id);
    assert.ok(
      forkedState.messages.some((row) => row.text === "第一轮"),
      "the fork keeps the context up to its fork point",
    );
    assert.ok(
      !forkedState.messages.some((row) => row.text === answers[1]),
      "the fork does not inherit later turns",
    );
    assert.equal(
      statsOf(forkedState, "the fork"),
      0,
      "the fork starts with its own (empty) usage",
    );
    const source = await state(agentId);
    assert.ok(
      statsOf(source, "the source") > 0,
      "the source keeps its own usage",
    );
    assert.ok(
      source.messages.some((row) => row.text === answers[2]),
      "forking does not disturb the source conversation",
    );

    // 退回：上下文重建到第二轮，第三轮只剩在存储与 JSONL 里。
    const rewound = await call("/api/command", {
      command: "rewind",
      id: agentId,
      entryId: target.entryId,
    });
    assert.equal(rewound.rewindTo, target.entryId);
    const afterRewind = await state(agentId);
    assert.ok(
      afterRewind.messages.some((row) => row.text === "第二轮"),
      "the rewound context keeps everything up to the target",
    );
    assert.ok(
      !afterRewind.messages.some(
        (row) => row.text === "第三轮" || row.text === answers[2],
      ),
      "the abandoned turn leaves the model context",
    );
    const entriesAfterRewind = (await workspace.transcript(agentId)).entries;
    assert.ok(
      entriesAfterRewind.length > transcriptBefore,
      "the transcript keeps the abandoned entries and adds the rewind marker",
    );
    assert.ok(
      entriesAfterRewind.some(
        (entry) =>
          entry.kind === "desk.rewind" &&
          entry.data?.rewindTo === target.entryId,
      ),
      "the rewind marker records its target",
    );
    for (const entry of entriesAfterRewind)
      assert.ok(
        entry.kind !== "desk.rewind" ||
          !entry.model?.some((message) => message.text === answers[2]),
        "the abandoned answer is not replayed into the new context",
      );

    // 退回后每条消息仍指向它原本的 entry：从消息触发的操作不会落到退回标记上。
    const rewoundFirst = afterRewind.messages.find(
      (row) => row.text === "第一轮",
    );
    assert.equal(
      rewoundFirst?.entryId,
      firstEntry.entryId,
      "a replayed message keeps its original entry id",
    );
    assert.notEqual(
      rewoundFirst?.entryId,
      rewound.entryId,
      "replayed messages do not collapse onto the rewind marker",
    );
    const fromFirst = await call("/api/command", {
      command: "fork",
      id: agentId,
      entryId: rewoundFirst.entryId,
    });
    const fromFirstState = await state(fromFirst.id);
    assert.ok(
      fromFirstState.messages.some((row) => row.text === "第一轮"),
      "the fork from a replayed message keeps the earlier context",
    );
    assert.ok(
      !fromFirstState.messages.some((row) => row.text === "第二轮"),
      "the fork from a replayed message stops at that message",
    );

    // 退回后继续：新回合从该点继续，只提交一份回答。
    const fourth = await turn("第四轮", answers[3]);
    assert.equal(
      fourth.messages.filter((row) => row.text === answers[3]).length,
      1,
      "the resumed turn commits one answer",
    );

    // Pi JSONL：leaf 回到退回点，被放弃的分支留在文件里但不在活跃分支上。
    const directory = await nativeSessionDirectory(cwd, agentDir);
    const sessionFiles = (await readdir(directory)).filter((name) =>
      name.endsWith(".jsonl"),
    );
    assert.equal(
      sessionFiles.length,
      1,
      "the rewind rewrites the same session file instead of creating another",
    );
    const metadata = JSON.parse(
      await readFile(join(agentDir, "desktop", "native-session.json"), "utf8"),
    );
    assert.equal(
      metadata.path,
      join(directory, sessionFiles[0]),
      "the host keeps writing the session file it opened",
    );
    const record = await readNativeRecord(
      join(directory, sessionFiles[0]),
      agentDir,
    );
    const nativeEntries = record.entries.filter(
      (entry) => typeof entry.id === "string" && entry.type !== "session",
    );
    const rewindMarker = nativeEntries.find(
      (entry) => entry.customType === "pi-desktop-rewind",
    );
    assert.ok(rewindMarker, "the native tree records the rewind");
    assert.equal(
      rewindMarker.data.rewindTo,
      target.entryId,
      "the native marker points at the same Durable entry",
    );
    const chain = new Set();
    let cursor = nativeEntries.at(-1);
    while (cursor) {
      chain.add(cursor.id);
      cursor = nativeEntries.find((entry) => entry.id === cursor.parentId);
    }
    assert.ok(
      chain.has(rewindMarker.data.native),
      "the active native branch runs through the rewound entry",
    );
    assert.ok(
      nativeEntries.some(
        (entry) => entry.parentId === rewindMarker.data.native,
      ),
      "the new turn is a child of the rewound entry",
    );
    const abandoned = nativeEntries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "user" &&
        messageText(entry) === "第三轮",
    );
    assert.ok(abandoned, "the abandoned turn stays in the file");
    assert.ok(
      !chain.has(abandoned.id),
      "the abandoned turn is off the active native branch",
    );

    // 分支树读模型：Durable 侧的会话 id 与分叉来源、原生 parent 链与 leaf、分支点与被放弃路径。
    const treeCall = async (id) => {
      const response = await fetch(`${origin}/api/tree?id=${id}`, {
        headers: { Origin: origin },
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const tree = await treeCall(agentId);
    assert.equal(tree.supported, true);
    assert.equal(tree.sessionId, String(agentId));
    assert.equal(tree.forkOf, null, "the source session is not a branch");
    assert.ok(tree.native, "the source session exposes its native chain");
    assert.equal(tree.native.leafId, tree.leaf);
    const leafNode = tree.native.nodes.find((row) => row.leaf);
    assert.ok(leafNode?.active, "the leaf sits on the active path");
    assert.ok(
      tree.native.nodes.some((row) => row.branchPoint),
      "the rewind leaves a branch point",
    );
    const rewindNode = tree.native.nodes.find(
      (row) => row.customType === "pi-desktop-rewind",
    );
    assert.ok(rewindNode?.active, "the rewind marker is on the active branch");
    assert.ok(
      tree.native.nodes.some((row) => !row.active && row.type === "message"),
      "the abandoned path stays in the tree but off the active path",
    );
    assert.equal(
      tree.rewinds.at(-1)?.rewindTo,
      target.entryId,
      "the tree reports the rewind target",
    );
    assert.deepEqual(
      tree.branches.map((row) => row.id).sort(),
      [String(forked.id), String(fromFirst.id)].sort(),
      "every fork shows up as a Durable session",
    );
    assert.deepEqual(
      tree.branches.find((row) => row.id === String(forked.id)).forkOf,
      { conversationId: agentId, entryId: firstEntry.entryId },
      "a branch records where it forked from",
    );
    const branchTree = await treeCall(forked.id);
    assert.deepEqual(
      branchTree.forkOf,
      { conversationId: agentId, entryId: firstEntry.entryId },
      "the branch itself reports the same origin",
    );
    assert.equal(
      branchTree.native,
      null,
      "a session without a bound native transcript reports no native tree",
    );
  },
);
