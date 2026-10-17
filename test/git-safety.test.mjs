import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getGitRepository, isGitBusy } from "../src/git/git-manager.mjs";
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-git-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(join(root, "file.txt"), "fixture");
  return { root, repo: await getGitRepository(root) };
}
test("Git confirmation expires and a shared repository write lock excludes other writes", async (t) => {
  const { root, repo } = await setup(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let plan = await repo.prepare({ action: "stage", paths: ["file.txt"] }, "A");
  t.mock.timers.tick(61000);
  await assert.rejects(repo.confirm(plan.token, "A"), (e) => e.status === 409);
  const configPlan = await repo.prepare(
    { action: "stage", paths: ["file.txt"] },
    "A",
  );
  execFileSync("git", ["config", "user.name", "Changed fixture"], {
    cwd: root,
  });
  await assert.rejects(
    repo.confirm(configPlan.token, "A"),
    (e) => e.status === 409,
  );
  plan = await repo.prepare({ action: "stage", paths: ["file.txt"] }, "A");
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const job = repo.confirm(plan.token, "A", () => gate);
  try {
    assert.equal(isGitBusy(root), true);
    await assert.rejects(
      repo.prepare({ action: "stage", paths: ["file.txt"] }, "B"),
      (e) => e.status === 409,
    );
  } finally {
    release();
    await job;
  }
  assert.equal(isGitBusy(root), false);
});
test("Git does not follow untracked links or mutate an in-progress merge; invalid UTF-8 stays non-text", async (t) => {
  const { root, repo } = await setup(t);
  const outside = await mkdtemp(join(tmpdir(), "pi-git-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const secret = join(outside, "file");
  await writeFile(secret, "private fixture");
  await symlink(secret, join(root, "link"));
  assert.equal(
    (await repo.read({ action: "diff", path: "link" })).output,
    "未跟踪的符号链接（不读取目标）",
  );
  await assert.rejects(repo.fileBytes(join(root, "link"), 100));
  await writeFile(join(root, "nontext"), Buffer.from([0xff]));
  assert.equal(
    (await repo.read({ action: "diff", path: "nontext" })).output,
    "非 UTF-8 文件（不显示文本内容）",
  );
  await writeFile(join(root, ".git", "MERGE_HEAD"), "fixture marker");
  await assert.rejects(
    repo.prepare({ action: "stage", paths: ["file.txt"] }, "A"),
    (e) => e.status === 409,
  );
  assert.equal(await readFile(join(root, "file.txt"), "utf8"), "fixture");
});
