import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";
import { openNativeTranscriptFamily } from "../src/session/native-transcript-family.mjs";

// 必须在同一个进程里检查锁；worker 退出时的自动清理会掩盖漏关的转录。
test("转录族关闭时某一分支失败也会释放全部写锁", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-family-close-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const models = createModels(),
    faux = fauxProvider();
  models.setProvider(faux.provider);
  const workspace = await openAgentWorkspace({
    storage: new MemoryStorage(),
    models,
  });
  let family,
    closed = false;
  t.after(async () => {
    try {
      if (family && !closed) await family.close();
    } finally {
      for (const member of family?.metadata.family.members ?? [])
        if (await lockfile.check(member.path, { realpath: false }))
          await lockfile.unlock(member.path, { realpath: false });
      await workspace.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  const source = await workspace.execute("create", {
    name: "来源",
    cwd,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
  });
  faux.setResponses([fauxAssistantMessage("answer")]);
  await workspace.execute("send", {
    id: source.id,
    message: "question",
    requestId: "family-close",
  });
  let state;
  const deadline = Date.now() + 10000;
  do {
    state = await workspace.read(source.id);
    if (
      state.active.idle &&
      state.active.messages.some((row) => row.text === "answer")
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.ok(state.active.messages.some((row) => row.text === "answer"));
  const point = state.active.messages.find(
    (row) => row.text === "question",
  ).entryId;
  const b = await workspace.execute("fork", { id: source.id, entryId: point });
  await workspace.execute("fork", { id: source.id, entryId: point });
  family = await openNativeTranscriptFamily({
    workspace,
    agents: (await workspace.read()).agents,
    agentDir: join(root, "agent"),
    directory: join(root, "host"),
    owner: `${randomUUID()}:0`,
    branches: true,
  });
  assert.equal(family.metadata.family.members.length, 3);
  for (const member of family.metadata.family.members)
    assert.equal(await lockfile.check(member.path, { realpath: false }), true);
  await appendFile(family.get(b.id).metadata.path, "{}\n");
  await workspace.execute("configure", {
    id: b.id,
    name: "需要写出但文件已冲突",
  });
  await assert.rejects(family.close(), (error) => error.status === 409);
  closed = true;
  for (const member of family.metadata.family.members)
    assert.equal(
      await lockfile.check(member.path, { realpath: false }),
      false,
      "一个分支冲突不应留下另一个 writer",
    );
  await assert.rejects(family.sync(), (error) => error.status === 409);
});
