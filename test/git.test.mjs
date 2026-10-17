import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitRepository, parseGitCommand } from "../src/git/git-manager.mjs";
import { createDeskBridge } from "../src/server/bridge.mjs";
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "a file.txt"), "one\n");
  return { root, repo: await getGitRepository(root) };
}
test("Git confirms once, preserves files when unstaging unborn HEAD, and detects same-status edits", async (t) => {
  const { root, repo } = await fixture(t);
  assert.deepEqual(parseGitCommand("stage a file.txt"), {
    action: "stage",
    paths: ["a file.txt"],
  });
  assert.throws(() => parseGitCommand("reset --hard"));
  let plan = await repo.prepare(
    { action: "stage", paths: ["a file.txt"] },
    "A",
  );
  await repo.confirm(plan.token, "A");
  await assert.rejects(repo.confirm(plan.token, "A"), (e) => e.status === 409);
  plan = await repo.prepare({ action: "unstage", paths: ["a file.txt"] }, "A");
  await repo.confirm(plan.token, "A");
  assert.equal(await readFile(join(root, "a file.txt"), "utf8"), "one\n");
  plan = await repo.prepare({ action: "stage", paths: ["a file.txt"] }, "A");
  await writeFile(join(root, "a file.txt"), "two\n");
  await assert.rejects(repo.confirm(plan.token, "A"), (e) => e.status === 409);
  for (const path of ["../escape", "/tmp/escape", ":(glob)*"])
    await assert.rejects(repo.prepare({ action: "stage", paths: [path] }, "A"));
  plan = await repo.prepare({ action: "stage", paths: ["a file.txt"] }, "A");
  await repo.confirm(plan.token, "A");
  plan = await repo.prepare({ action: "commit", message: "initial" }, "A");
  await repo.confirm(plan.token, "A");
  await writeFile(join(root, "a file.txt"), "three\n");
  plan = await repo.prepare({ action: "stage", paths: ["a file.txt"] }, "A");
  await writeFile(join(root, "a file.txt"), "four\n");
  await assert.rejects(repo.confirm(plan.token, "A"), (e) => e.status === 409);
  plan = await repo.prepare({ action: "stage", paths: ["a file.txt"] }, "A");
  await assert.rejects(repo.confirm(plan.token, "B"), (e) => e.status === 409);
});
test("Git fetch/pull/push use local bare remote, reject dirty switch and divergent pull", async (t) => {
  const { root, repo } = await fixture(t),
    remote = await mkdtemp(join(tmpdir(), "pi-git-bare-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(root, "add", "--", "a file.txt");
  git(root, "commit", "-qm", "initial");
  git(root, "init", "--bare", "-q", remote);
  git(root, "remote", "add", "origin", remote);
  for (const action of ["push", "fetch", "pull"]) {
    const plan = await repo.prepare({ action, remote: "origin" }, "A");
    await repo.confirm(plan.token, "A");
  }
  assert.equal(
    git(remote, "rev-parse", "main").trim(),
    git(root, "rev-parse", "HEAD").trim(),
  );
  git(
    remote,
    "update-ref",
    "refs/heads/different",
    git(root, "rev-parse", "HEAD").trim(),
  );
  git(root, "config", "branch.main.remote", "origin");
  git(root, "config", "branch.main.merge", "refs/heads/different");
  for (const action of ["pull", "push"]) {
    const tracking = await repo.prepare({ action }, "A");
    assert.equal(tracking.request.targetRef, "refs/heads/different");
    await repo.confirm(tracking.token, "A");
  }
  git(root, "config", "branch.main.merge", "refs/heads/main");
  git(root, "branch", "other");
  const clone = await mkdtemp(join(tmpdir(), "pi-git-clone-"));
  t.after(() => rm(clone, { recursive: true, force: true }));
  git(clone, "clone", "-q", "-b", "main", remote, ".");
  git(clone, "config", "user.name", "Fixture");
  git(clone, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(clone, "a file.txt"), "remote change");
  git(clone, "add", ".");
  git(clone, "commit", "-qm", "remote");
  git(clone, "push", "-q", "origin", "main");
  await writeFile(join(root, "a file.txt"), "local change");
  git(root, "add", ".");
  git(root, "commit", "-qm", "local");
  const head = git(root, "rev-parse", "HEAD");
  const pull = await repo.prepare({ action: "pull", remote: "origin" }, "A");
  await assert.rejects(repo.confirm(pull.token, "A"), (e) => e.status === 422);
  assert.equal(git(root, "rev-parse", "HEAD"), head);
  let plan = await repo.prepare({ action: "switch", branch: "other" }, "A");
  await repo.confirm(plan.token, "A");
  await writeFile(join(root, "a file.txt"), "dirty");
  await assert.rejects(
    repo.prepare({ action: "switch", branch: "main" }, "A"),
    (e) => e.status === 409,
  );
  await assert.rejects(
    repo.prepare({ action: "pull" }, "A"),
    (e) => e.status === 409,
  );
  await assert.rejects(
    repo.prepare({ action: "fetch", remote: "https://example.invalid" }, "A"),
    (e) => e.status === 422,
  );
});
test("Git HTTP requires explicit session, project trust, idle writers and a one-use preview; slash never goes to model", async (t) => {
  const { root } = await fixture(t);
  let idle = true,
    trusted = true,
    id = "A",
    prompts = 0;
  const bridge = createDeskBridge({
    agentDir: root,
    port: 0,
    host: "127.0.0.1",
    snapshot: () => ({ sessionId: id, cwd: root, idle, model: null }),
    canWrite: () => idle,
    canEditShared: () => idle,
    projectTrusted: () => trusted,
    prompt: () => {
      prompts++;
    },
    capabilities: {
      prompt: true,
      canWrite: true,
      canEditShared: true,
      projectTrusted: true,
    },
  });
  t.after(() => bridge.stop());
  const url = (await bridge.start()).replace(/\/$/, "");
  const post = (body) =>
    fetch(url + "/api/git", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post({ action: "stage", paths: ["a file.txt"] })).status,
    409,
  );
  trusted = false;
  assert.equal(
    (await post({ sessionId: "A", action: "stage", paths: ["a file.txt"] }))
      .status,
    403,
  );
  assert.equal((await fetch(url + "/api/git?sessionId=A")).status, 403);
  assert.equal(
    (await (await fetch(url + "/api/state")).json()).gitWritable,
    false,
  );
  trusted = true;
  idle = false;
  assert.equal(
    (await (await fetch(url + "/api/state")).json()).gitWritable,
    false,
  );
  assert.equal(
    (await post({ sessionId: "A", action: "stage", paths: ["a file.txt"] }))
      .status,
    409,
  );
  idle = true;
  assert.equal(
    (await (await fetch(url + "/api/state")).json()).gitWritable,
    true,
  );
  const plan = await (
    await post({ sessionId: "A", action: "stage", paths: ["a file.txt"] })
  ).json();
  id = "B";
  assert.equal((await post({ sessionId: "A", token: plan.token })).status, 409);
  id = "A";
  assert.equal((await post({ sessionId: "A", token: plan.token })).status, 200);
  const response = await fetch(url + "/api/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "/git status", sessionId: "A" }),
  });
  assert.equal(response.status, 422);
  assert.equal(prompts, 0);
  assert.equal((await fetch(url + "/git-command.mjs")).status, 200);
});
