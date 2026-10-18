import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPiSessions,
  reconcilePiSessions,
} from "../src/control-plane/pi-sessions.mjs";
import { createSessionFamilies } from "../src/control-plane/session-families.mjs";
import {
  nativeBranchIdentity,
  readNativeTranscriptFamily,
} from "../src/session/native-transcript-family.mjs";
import { nativeSessionDirectory } from "../src/session/pi-session-storage.mjs";
import { loadPiSessionManager } from "../src/agent/pi-sdk.mjs";

const catalog = () => ({
  projects: [{ id: "project", cwd: "/project" }],
  agents: [
    {
      id: "desktop",
      projectId: "project",
      source: "desktop",
      name: "来源",
      nativeSessionId: "root-native",
    },
  ],
});
const branch = {
  id: "pi-file-identity",
  cwd: "/project",
  name: "分支",
  nativeSessionId: "branch-native",
  messageCount: 1,
};

test("发现已登记的原生分支时保留同一个 Desktop Agent，不添加 Pi 只读替身", () => {
  const data = catalog();
  data.agents[0].nativeSessions = [
    { id: 10, path: "/pi/branch.jsonl", nativeSessionId: "branch-native" },
  ];
  reconcilePiSessions(data, [branch]);
  assert.equal(data.agents.length, 1);
  assert.equal(data.agents[0].name, "来源");
  assert.equal(data.agents[0].source, "desktop");
});

test("原生归属标记覆盖清单发布前的窗口，同时保存分支文件的归属", () => {
  const data = catalog();
  reconcilePiSessions(data, [
    {
      ...branch,
      desktopOwner: "desktop",
      conversationId: 10,
      nativeSessionPath: "/pi/branch.jsonl",
    },
  ]);
  assert.equal(data.agents.length, 1);
  assert.deepEqual(data.agents[0].nativeSessions, [
    { id: 10, path: "/pi/branch.jsonl", nativeSessionId: "branch-native" },
  ]);
  assert.equal(data.agents[0].name, "来源");
});

test("真实原生文件的标记补齐未发布的清单，但拒绝旧 generation 与伪造身份", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-family-claim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  await mkdir(cwd);
  const directory = await nativeSessionDirectory(cwd, agentDir);
  const { SessionManager } = await loadPiSessionManager();
  const owner = "desktop:1";
  for (const [id, markerOwner, nativeId] of [
    [10, owner, nativeBranchIdentity(owner, 10)],
    [11, "desktop:0", nativeBranchIdentity("desktop:0", 11)],
    [12, owner, "forged-native-identity"],
  ]) {
    const manager = SessionManager.inMemory(cwd, { id: nativeId });
    manager.appendCustomEntry("pi-desktop-family", {
      owner: markerOwner,
      conversationId: id,
    });
    manager.appendMessage({
      role: "user",
      content: `branch ${id}`,
      timestamp: Date.now(),
    });
    await writeFile(
      join(directory, `${id}.jsonl`),
      [manager.getHeader(), ...manager.getEntries()]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
  }
  const sessions = createPiSessions(agentDir);
  t.after(() => sessions.close());
  const data = catalog();
  data.agents[0].generation = 1;
  const families = createSessionFamilies({ store: {}, directory: root });
  assert.equal(
    await readNativeTranscriptFamily(root),
    null,
    "确实没有已发布的清单",
  );
  const found = await families.claim(await sessions.scan(true), sessions, data);
  assert.equal(found.length, 3);
  const claimed = found.find(
    (row) => row.nativeSessionId === nativeBranchIdentity(owner, 10),
  );
  assert.equal(claimed.desktopOwner, "desktop");
  assert.equal(claimed.conversationId, 10);
  assert.ok(claimed.nativeSessionPath);
  assert.equal(found.filter((row) => row.desktopOwner).length, 1);
  reconcilePiSessions(data, found);
  assert.equal(
    data.agents.length,
    3,
    "只有匹配当前宿主和原生身份的记录被收归会话族",
  );
});

test("清单读取拒绝重复归属、非法路径和不支持的版本", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-family-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const member = {
    id: 2,
    path: join(directory, "root.jsonl"),
    nativeSessionId: "native",
  };
  const value = { version: 1, root: 2, members: [member] };
  const path = join(directory, "native-sessions.json");
  await writeFile(path, JSON.stringify(value));
  assert.deepEqual(await readNativeTranscriptFamily(directory), value);
  for (const invalid of [
    { ...value, version: 2 },
    { ...value, root: 3 },
    { ...value, members: [member, { ...member, id: 3 }] },
    {
      ...value,
      members: [
        member,
        { ...member, path: join(directory, "other"), nativeSessionId: "other" },
      ],
    },
    { ...value, members: [{ ...member, path: "relative.jsonl" }] },
    { ...value, members: [{ ...member, id: -1 }] },
    { ...value, members: [{ ...member, nativeSessionId: "bad\0id" }] },
  ]) {
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(
      readNativeTranscriptFamily(directory),
      (error) => error.status === 409,
    );
  }
});
