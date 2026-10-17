import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDirectoryPicker } from "../src/desktop/directory-picker.mjs";
import { desktopFixture } from "./desktop-fixture.mjs";

test("system directory selection uses fixed arguments, validates the directory and treats cancellation as no selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-folder-picker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const picker = createDirectoryPicker({
    platform: "linux",
    execute: async (...args) => {
      calls.push(args);
      return { stdout: root + "\n" };
    },
  });
  assert.equal(await picker.pick(), root);
  assert.equal(calls[0][0], "zenity");
  assert(calls[0][1].includes("--directory"));
  assert.equal(
    await createDirectoryPicker({
      execute: async () => {
        throw { code: 1 };
      },
    }).pick(),
    null,
  );
  await assert.rejects(
    createDirectoryPicker({
      execute: async () => ({ stdout: "relative-folder" }),
    }).pick(),
    (error) => error.status === 422,
  );
  const fallback = createDirectoryPicker({
    platform: "linux",
    execute: async (cmd) => {
      if (cmd === "zenity") throw { code: "ENOENT" };
      assert.equal(cmd, "kdialog");
      return { stdout: root };
    },
  });
  assert.equal(await fallback.pick(), root);
});

test("only one folder dialog can run; host shutdown aborts it", async () => {
  let aborted = false;
  const picker = createDirectoryPicker({
    execute: (_cmd, _args, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }),
      ),
  });
  const pending = picker.pick();
  await assert.rejects(picker.pick(), (error) => error.status === 409);
  picker.close();
  await assert.rejects(pending);
  assert(aborted);
});

test("file selection uses multiple-file arguments and preserves path spaces; cancellation returns no files", async () => {
  const picker = createDirectoryPicker({
    platform: "linux",
    execute: async (_command, args) => {
      assert(args.includes("--multiple"));
      assert(!args.includes("--directory"));
      return { stdout: "/tmp/first file.pdf\n/tmp/ second.txt \n" };
    },
  });
  assert.deepEqual(await picker.pickFiles(), [
    "/tmp/first file.pdf",
    "/tmp/ second.txt ",
  ]);
  assert.deepEqual(
    await createDirectoryPicker({
      execute: async () => {
        throw { code: 1 };
      },
    }).pickFiles(),
    [],
  );
});

test("local web directory endpoint opens the injected system picker and rejects cross-site calls", async (t) => {
  let count = 0;
  const f = await desktopFixture({
    directoryPicker: {
      async pick() {
        count++;
        return count === 1 ? null : f.other;
      },
    },
  });
  t.after(() => f.close());
  const before = (await f.call("/api/workspace")).projects.length;
  assert.equal((await f.call("/api/workspace/directory", {})).path, null);
  assert.equal((await f.call("/api/workspace")).projects.length, before);
  const selected = await f.call("/api/workspace/directory", {});
  const project = await f.command("project.save", { cwd: selected.path });
  assert.equal(
    (await f.call("/api/workspace")).projects.find(
      (row) => row.id === project.id,
    ).cwd,
    f.other,
  );
  const origin = new URL(f.app.url).origin;
  const response = await fetch(origin + "/api/workspace/directory", {
    method: "POST",
    headers: {
      Origin: "https://other.invalid",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.status, 403);
  assert.equal(count, 2);
});
