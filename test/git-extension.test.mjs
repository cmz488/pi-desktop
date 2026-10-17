import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import gitExtension from "../src/tui/git.ts";
test("standalone /git registers publicly and confirms before staging without prompting a model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(join(root, "file.txt"), "fixture");
  let command,
    accepted = false,
    confirms = 0;
  const notices = [];
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    gitExtension({
      on() {},
      registerCommand(name, value) {
        assert.equal(name, "git");
        command = value;
      },
    });
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
  const ctx = {
    cwd: root,
    isIdle: () => true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "fixture" },
    ui: {
      notify: (value) => notices.push(value),
      confirm: async () => {
        confirms++;
        return accepted;
      },
    },
  };
  await command.handler("stage file.txt", ctx);
  assert.equal(confirms, 1);
  assert(notices.at(-1).includes("取消"));
  assert(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).startsWith("??"),
  );
  accepted = true;
  await command.handler("stage file.txt", ctx);
  assert(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).startsWith("A "),
  );
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {
    cwd: root,
  });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  execFileSync("git", ["config", "tag.gpgsign", "false"], { cwd: root });
  await command.handler("commit native initial", ctx);
  await command.handler("log", ctx);
  assert(notices.at(-1).includes("native initial"));
  await command.handler("show HEAD", ctx);
  assert(notices.at(-1).includes("file.txt"));
  await command.handler("checkout -b native-feature", ctx);
  assert.equal(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "native-feature",
  );
  await command.handler("merge main", ctx);
  await command.handler("tag native-tag", ctx);
  await command.handler("tags", ctx);
  assert(notices.at(-1).includes("native-tag"));
  await command.handler("tag -d native-tag", ctx);
  await command.handler(
    "tag annotate native-note HEAD Native note with spaces",
    ctx,
  );
  assert.equal(
    execFileSync("git", ["cat-file", "-t", "refs/tags/native-note"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    "tag",
  );
  await command.handler("reset soft HEAD", ctx);
  await command.handler("reset mixed HEAD", ctx);
  await command.handler("checkout main", ctx);
  assert(
    command
      .getArgumentCompletions("reset ")
      .some((item) => item.value === "reset soft "),
  );
  await command.handler("reset --hard", ctx);
  assert(notices.at(-1).includes("写操作需要确认"));
});
