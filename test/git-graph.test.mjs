import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitRepository } from "../src/git/git-manager.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-git-graph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-qb", "main");
  git("config", "user.name", "Graph Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("config", "core.hooksPath", join(root, "no-hooks"));
  await writeFile(join(root, "base.txt"), "base");
  git("add", "--", "base.txt");
  git("commit", "-qm", "base");
  return { root, git, repo: await getGitRepository(root) };
}
test("Git graph uses real parents, authors and HEAD while keeping lanes continuous over pages", async (t) => {
  const { root, git, repo } = await fixture(t);
  for (let i = 0; i < 34; i++)
    git("commit", "--allow-empty", "-qm", "linear " + i);
  const first = await repo.read({ action: "log", page: 1 }),
    second = await repo.read({ action: "log", page: 2 });
  assert.equal(first.commits[0].parentIds[0], git("rev-parse", "HEAD^"));
  assert.equal(first.commits[0].author, "Graph Fixture");
  assert.equal(first.graph.rows[0].kind, "head");
  assert.deepEqual(second.graph.rows[0].input, first.graph.rows.at(-1).output);
  assert.deepEqual(second.graph.rows.at(-1).output, []);
  assert(
    first.commits[0].references.some(
      (ref) => ref.type === "branch" && ref.name === "main",
    ),
  );
  await writeFile(join(root, "base.txt"), "changed");
  assert.equal(
    (await repo.read({ action: "log" })).historyRevision,
    first.historyRevision,
    "Working-tree edits must not move graph reference identity",
  );
});
test("Git graph discards moving references and identifies detached HEAD without inventing a branch", async (t) => {
  const { git, repo } = await fixture(t);
  const run = repo.run.bind(repo);
  let changed = false;
  repo.run = async (...args) => {
    if (!changed && args[0][0] === "log") {
      changed = true;
      git("commit", "--allow-empty", "-qm", "concurrent");
    }
    return run(...args);
  };
  await assert.rejects(
    repo.read({ action: "log" }),
    (e) => e.status === 409 && e.message.includes("引用"),
  );
  repo.run = run;
  git("checkout", "--detach", "-q", "HEAD");
  const result = await repo.read({ action: "log" });
  assert(
    result.commits[0].references.some(
      (ref) => ref.type === "head" && ref.name === "HEAD",
    ),
  );
  assert.equal(result.graph.rows[0].node.color, 0);
});
test("Git graph separates merges, converges ancestors, peels annotated tags and supports explicit all-ref scope", async (t) => {
  const { git, repo } = await fixture(t);
  git("checkout", "-qb", "topic");
  git("commit", "--allow-empty", "-qm", "topic");
  git("checkout", "-q", "main");
  git("commit", "--allow-empty", "-qm", "main");
  git("merge", "--no-ff", "--no-edit", "topic");
  git("tag", "-a", "-m", "annotation", "graph-tag");
  const merged = await repo.read({ action: "log" });
  assert.equal(merged.commits[0].parentIds.length, 2);
  assert.equal(
    merged.graph.rows[0].edges.filter((edge) => edge.kind === "parent").length,
    2,
  );
  assert(merged.graph.width > 24);
  assert.equal(
    merged.graph.rows.at(-1).edges.filter((edge) => edge.kind === "incoming")
      .length,
    2,
  );
  assert(
    merged.commits[0].references.some(
      (ref) => ref.name === "graph-tag" && ref.type === "tag",
    ),
  );
  git("checkout", "-qb", "unmerged");
  git("commit", "--allow-empty", "-qm", "unmerged side");
  git("checkout", "-q", "main");
  assert(
    !(await repo.read({ action: "log" })).commits.some(
      (commit) => commit.subject === "unmerged side",
    ),
  );
  assert(
    (await repo.read({ action: "log", scope: "all" })).commits.some(
      (commit) => commit.subject === "unmerged side",
    ),
  );
  await assert.rejects(
    repo.read({ action: "log", scope: "--all --output=unsafe" }),
    (e) => e.status === 422,
  );
});
