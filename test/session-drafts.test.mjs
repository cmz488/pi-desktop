import test from "node:test";
import assert from "node:assert/strict";
import { createSessionDrafts } from "../src/shared/session-drafts.mjs";

test("local file indexes do not consume upload memory and different paths have different retry identities", () => {
  let sequence = 0;
  const drafts = createSessionDrafts({ requestId: () => String(++sequence) });
  drafts.select("a");
  drafts.addFile("a", {
    id: "ref",
    kind: "reference",
    name: "file.bin",
    path: "/one/file.bin",
    size: 1024 ** 3,
  });
  const first = drafts.capture({ text: "review", durable: true });
  assert.equal(drafts.totalBytes(), 0);
  drafts.updateFile("a", { ...first.files[0], path: "/two/file.bin" });
  const second = drafts.capture({ text: "review", durable: true });
  assert.notEqual(first.retry.requestId, second.retry.requestId);
});

test("a late submission preserves the selected conversation and newer text/files", () => {
  const drafts = createSessionDrafts();
  drafts.select("a");
  drafts.edit("first");
  drafts.addFile("a", { id: "one", size: 2, data: "old" });
  const sent = drafts.capture({ mode: "steer" });
  drafts.edit("second");
  drafts.addFile("a", { id: "two", size: 3 });
  drafts.select("b");
  drafts.edit("other agent");
  drafts.complete(sent);
  assert.equal(drafts.read().text, "other agent");
  assert.equal(drafts.select("a").text, "second");
  assert.deepEqual(
    drafts.read().files.map((file) => file.id),
    ["two"],
  );
  assert.equal(drafts.totalBytes(), 3);
});

test("retries reuse submission identity while changed content gets a new identity", () => {
  let sequence = 0;
  const drafts = createSessionDrafts({
    requestId: () => `request-${++sequence}`,
  });
  drafts.select("a");
  const first = drafts.capture({ text: "hello", mode: "steer", durable: true });
  assert.equal(
    drafts.capture({ durable: true, mode: "steer" }).retry.requestId,
    first.retry.requestId,
  );
  const changed = drafts.capture({ text: "new", mode: "steer", durable: true });
  assert.notEqual(changed.retry.requestId, first.retry.requestId);
  drafts.complete(first);
  assert.equal(
    drafts.capture({ durable: true, mode: "steer" }).retry.requestId,
    changed.retry.requestId,
  );
  drafts.complete(changed);
  assert.equal(drafts.read().text, "");
  assert.notEqual(
    drafts.capture({ text: "new", mode: "steer", durable: true }).retry
      .requestId,
    changed.retry.requestId,
  );
});

test("file completion keeps its owner and cannot restore a removed attachment", () => {
  const drafts = createSessionDrafts();
  drafts.select("a");
  drafts.addFile("a", { id: "file", size: 4, status: "reading" });
  drafts.select("b");
  drafts.updateFile("a", {
    id: "file",
    size: 4,
    status: "ready",
    data: "done",
  });
  assert.equal(drafts.read().files.length, 0);
  assert.equal(drafts.read("a").files[0].data, "done");
  drafts.removeFile("a", "file");
  drafts.updateFile("a", { id: "file", size: 4, status: "ready" });
  assert.equal(drafts.read("a").files.length, 0);
});
