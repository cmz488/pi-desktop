import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getGitRepository, parseGitCommand } from "../src/git/git-manager.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-git-ops-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("config", "core.hooksPath", join(root, "no-hooks"));
  await writeFile(join(root, "file.txt"), "base\n");
  git("add", "--", "file.txt");
  git("commit", "-qm", "initial");
  const repo = await getGitRepository(root);
  const apply = async (input) => {
    const plan = await repo.prepare(input, "target");
    return repo.confirm(plan.token, "target");
  };
  return { root, git, repo, apply };
}
test("Git history pages return exact commit IDs and readable commit details", async (t) => {
  const { git, repo } = await fixture(t);
  for (let i = 0; i < 31; i++)
    git("commit", "--allow-empty", "-qm", `history ${i}`);
  const first = await repo.read({ action: "log", page: 1 });
  assert.equal(first.commits.length, 30);
  assert.equal(first.nextPage, 2);
  const second = await repo.read({ action: "log", page: 2 });
  assert.equal(second.commits.length, 2);
  assert.equal(second.nextPage, null);
  const detail = await repo.read({
    action: "show",
    ref: second.commits.at(-1).id,
  });
  assert(detail.output.includes("initial"));
  assert(detail.output.includes("file.txt"));
  await assert.rejects(
    repo.read({ action: "show", ref: "--output=/tmp/unsafe" }),
    (e) => e.status === 422,
  );
  assert.equal(parseGitCommand("log 2").page, 2);
});
test("Git checkout, normal merge, soft/mixed reset and tags preserve selected safe semantics", async (t) => {
  const { root, git, repo, apply } = await fixture(t),
    initial = git("rev-parse", "HEAD");
  await apply(parseGitCommand("checkout -b topic"));
  assert.equal(git("branch", "--show-current"), "topic");
  await writeFile(join(root, "topic.txt"), "topic\n");
  git("add", "--", "topic.txt");
  git("commit", "-qm", "topic change");
  const tip = git("rev-parse", "HEAD");
  await apply(parseGitCommand("checkout main"));
  await writeFile(join(root, "main.txt"), "main\n");
  git("add", "--", "main.txt");
  git("commit", "-qm", "main change");
  await apply(parseGitCommand("merge topic"));
  assert.equal(
    git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length,
    3,
  );
  await apply(parseGitCommand("tag v1"));
  assert((await repo.read({ action: "tags" })).tags.includes("v1"));
  await apply(parseGitCommand("tag -d v1"));
  assert(!(await repo.read()).tags.includes("v1"));
  await apply(parseGitCommand(`checkout --detach ${tip}`));
  assert.equal(git("rev-parse", "HEAD"), tip);
  assert.equal(git("branch", "--show-current"), "");
  await apply(parseGitCommand("checkout main"));
  const before = await readFile(join(root, "topic.txt"), "utf8");
  await apply(parseGitCommand(`reset soft ${initial}`));
  assert.equal(git("rev-parse", "HEAD"), initial);
  assert.equal(await readFile(join(root, "topic.txt"), "utf8"), before);
  assert(git("diff", "--cached", "--name-only").includes("topic.txt"));
  await apply(parseGitCommand(`reset mixed ${initial}`));
  assert.equal(git("diff", "--cached", "--name-only"), "");
  assert.equal(await readFile(join(root, "topic.txt"), "utf8"), before);
  await assert.rejects(
    repo.prepare({ action: "reset", mode: "hard", ref: initial }, "target"),
    (e) => e.status === 422,
  );
  assert.throws(() => parseGitCommand("checkout -- file.txt"));
  assert.throws(() => parseGitCommand("reset hard HEAD"));
});
test("Git refs are state-bound and unsafe modes or rev expressions cannot become argv", async (t) => {
  const { root, git, repo, apply } = await fixture(t);
  const plan = await repo.prepare(
    { action: "tag", operation: "create", name: "bound", ref: "HEAD" },
    "target",
  );
  git("branch", "elsewhere");
  await assert.rejects(
    repo.confirm(plan.token, "target"),
    (e) => e.status === 409,
  );
  assert(!git("tag", "--list").includes("bound"));
  await apply({
    action: "tag",
    operation: "create",
    name: "annotated",
    ref: "HEAD",
    message: "fixture annotation",
  });
  assert.equal(git("cat-file", "-t", "refs/tags/annotated"), "tag");
  assert(
    (await repo.read({ action: "show", ref: "annotated" })).output.includes(
      "initial",
    ),
  );
  for (const input of [
    { action: "tag", operation: "create", name: "--force", ref: "HEAD" },
    { action: "checkout", mode: "restore", ref: "file.txt" },
    { action: "checkout", mode: "create", branch: "--force", ref: "HEAD" },
    { action: "reset", mode: "hard", ref: "HEAD" },
    { action: "merge", ref: "HEAD~1" },
    { action: "merge", ref: "https://example.invalid/repo" },
  ])
    await assert.rejects(
      repo.prepare(input, "target"),
      (e) => e.status === 422,
    );
  await writeFile(join(root, "untracked.txt"), "preserve");
  await assert.rejects(
    repo.prepare(parseGitCommand("checkout elsewhere"), "target"),
    (e) => e.status === 409,
  );
  await assert.rejects(
    repo.read({ action: "log", page: 0 }),
    (e) => e.status === 422,
  );
});
test("Git merge conflicts remain inspectable and allow explicit staging and merge commit only", async (t) => {
  const { root, git, repo, apply } = await fixture(t);
  git("checkout", "-qb", "topic");
  await writeFile(join(root, "file.txt"), "topic\n");
  git("commit", "-qam", "topic");
  git("checkout", "-q", "main");
  await writeFile(join(root, "file.txt"), "main\n");
  git("commit", "-qam", "main");
  const result = await apply(parseGitCommand("merge topic"));
  assert.equal(result.conflict, true);
  const status = await repo.read();
  assert(status.operations.includes("MERGE_HEAD"));
  assert.deepEqual(status.unmerged, ["file.txt"]);
  await assert.rejects(
    repo.prepare(parseGitCommand("reset mixed HEAD"), "target"),
    (e) => e.status === 409,
  );
  await assert.rejects(
    repo.prepare(parseGitCommand("commit unresolved"), "target"),
    (e) => e.status === 409,
  );
  await writeFile(join(root, "file.txt"), "resolved\n");
  await apply(parseGitCommand("stage file.txt"));
  await apply(parseGitCommand("commit resolve merge"));
  assert.equal((await repo.read()).operations.length, 0);
  assert.equal(
    git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length,
    3,
  );
});
