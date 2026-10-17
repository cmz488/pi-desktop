import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitRepository } from "../src/git/git-manager.mjs";
import { randomBytes } from "node:crypto";

test("Git review remains readable with large unrelated untracked files and limits only the selected write bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(join(root, "large.bin"), Buffer.alloc(17 * 1024 * 1024));
  await writeFile(join(root, "code.ts"), "const value: number = 1;\n");
  const repo = await getGitRepository(root);
  const view = await repo.read();
  assert.equal(view.files.length, 2);
  assert.deepEqual(
    view.files.find((file) => file.path === "code.ts").stats.unstaged,
    { added: 1, removed: 0 },
  );
  assert.equal(
    view.files.find((file) => file.path === "large.bin").stats,
    undefined,
  );
  assert.equal(
    (await repo.read({ action: "diff", path: "large.bin" })).output,
    "文件大于 512 KiB；不显示预览",
  );
  assert(
    (await repo.read({ action: "diff", path: "code.ts" })).output.includes(
      "const value",
    ),
  );
  let plan = await repo.prepare({ action: "stage", paths: ["code.ts"] }, "A");
  await writeFile(join(root, "code.ts"), "const value: number = 2;\n");
  await assert.rejects(repo.confirm(plan.token, "A"), (e) => e.status === 409);
  plan = await repo.prepare({ action: "stage", paths: ["code.ts"] }, "A");
  await repo.confirm(plan.token, "A");
  await assert.rejects(
    repo.prepare({ action: "stage", paths: ["large.bin"] }, "A"),
    (e) => e.status === 422,
  );
  assert.equal(
    execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "code.ts",
  );
  const staged = await repo.read();
  assert.deepEqual(
    staged.files.find((file) => file.path === "code.ts").stats.staged,
    { added: 1, removed: 0 },
  );
  await writeFile(join(root, "code.ts"), "const value: number = 3;\n// next\n");
  const changed = await repo.read();
  assert.notEqual(changed.revision, staged.revision);
  assert.deepEqual(
    changed.files.find((file) => file.path === "code.ts").stats.unstaged,
    { added: 2, removed: 1 },
  );
  // A large tracked binary patch must not be generated just to list changes.
  await writeFile(join(root, "large.bin"), randomBytes(17 * 1024 * 1024));
  execFileSync("git", ["add", "--", "large.bin"], { cwd: root });
  const binary = await repo.read();
  assert.deepEqual(
    binary.files.find((file) => file.path === "large.bin").stats.staged,
    { added: null, removed: null },
  );
});

test("Git staging accepts a bulk selection and refuses more paths than one confirmation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-bulk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "bulk@example.invalid"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Bulk"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  for (const name of ["a.txt", "b.txt", "c.txt"])
    await writeFile(join(root, name), `${name}\n`);
  const repo = await getGitRepository(root);
  const view = await repo.read();
  assert.deepEqual(
    view.files.map((file) => file.path),
    ["a.txt", "b.txt", "c.txt"],
  );
  const plan = await repo.prepare(
    { action: "stage", paths: ["a.txt", "c.txt"] },
    "target",
  );
  assert.deepEqual(plan.request.paths, ["a.txt", "c.txt"]);
  await repo.confirm(plan.token, "target");
  assert.equal(
    execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .join(","),
    "a.txt,c.txt",
  );
  await assert.rejects(
    repo.prepare(
      {
        action: "stage",
        paths: Array.from({ length: 101 }, (_, index) => `file${index}.txt`),
      },
      "target",
    ),
    (e) => e.status === 422,
  );
});

test("Git previews use raw blob ids, so large modified binaries neither overflow nor need patches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-raw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "raw@example.invalid"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Raw"], { cwd: root });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  await writeFile(join(root, "big.bin"), randomBytes(5 * 1024 * 1024));
  execFileSync("git", ["add", "--", "big.bin"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "binary"], { cwd: root });
  await writeFile(join(root, "big.bin"), randomBytes(5 * 1024 * 1024));
  const repo = await getGitRepository(root);
  const before = await repo.read();
  assert.deepEqual(
    before.files.find((file) => file.path === "big.bin").stats.unstaged,
    { added: null, removed: null },
  );
  // 5 MiB of binary diff used to exceed the 4 MiB output buffer here.
  const plan = await repo.prepare({ action: "stage", paths: ["big.bin"] }, "A");
  await repo.confirm(plan.token, "A");
  const staged = await repo.read();
  assert.deepEqual(
    staged.files.find((file) => file.path === "big.bin").stats.staged,
    { added: null, removed: null },
  );
  assert.notEqual(staged.revision, before.revision);
});
