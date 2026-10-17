import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkspaceFile } from "../src/workspace/workspace-files.mjs";
import { panelAddress } from "../src/ui/shared/workspace-panels.js";
import {
  normalizeSidebarView,
  orderSessions,
  workspaceParents,
} from "../src/shared/sidebar-view.mjs";
import { desktopFixture } from "./desktop-fixture.mjs";

test("project previews are bounded reads and reject traversal, outside symlinks and unsupported bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-workspace-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(
    join(cwd, "code.txt"),
    '<script>alert("fixture")</script>\n中文',
  );
  await writeFile(join(root, "outside.txt"), "outside");
  await symlink(join(root, "outside.txt"), join(cwd, "escape.txt"));
  await writeFile(join(cwd, "binary"), Buffer.from([0, 255, 120]));
  await writeFile(join(cwd, "large.txt"), Buffer.alloc(512 * 1024 + 1));
  const directory = await readWorkspaceFile(cwd);
  assert.equal(directory.kind, "directory");
  const text = await readWorkspaceFile(cwd, "code.txt");
  assert.equal(text.kind, "text");
  assert(text.text.includes("<script>"));
  await assert.rejects(
    readWorkspaceFile(cwd, "../outside.txt"),
    (error) => error.status === 403,
  );
  await assert.rejects(
    readWorkspaceFile(cwd, "escape.txt"),
    (error) => error.status === 403,
  );
  assert.equal((await readWorkspaceFile(cwd, "binary")).kind, "unsupported");
  assert.equal((await readWorkspaceFile(cwd, "large.txt")).kind, "unsupported");
});

test("DSH view preferences combine grouping, pin order and all three archive modes", () => {
  assert.equal(
    normalizeSidebarView({ groupBy: "invalid" }).groupBy,
    "workspace",
  );
  assert.equal(normalizeSidebarView({ archived: "show" }).archived, "show");
  assert.equal(normalizeSidebarView({ archived: "only" }).archived, "only");
  const projects = [
    { id: "root", cwd: "/work" },
    { id: "child", cwd: "/work/app" },
    { id: "other", cwd: "/workspace" },
  ];
  assert.equal(workspaceParents(projects).get("child"), "root");
  assert.equal(workspaceParents(projects).get("other"), undefined);
  const rows = [
    { id: "a", updatedAt: "2026-10-11" },
    { id: "b", updatedAt: "2026-10-12" },
    { id: "p", pinned: true },
  ];
  assert.deepEqual(
    orderSessions(rows, normalizeSidebarView()).map((row) => row.id),
    ["p", "b", "a"],
  );
  assert.deepEqual(
    orderSessions(
      rows,
      normalizeSidebarView({ orderBy: "manual", manual: ["a", "b"] }),
    ).map((row) => row.id),
    ["p", "a", "b"],
  );
});

test("browser addresses accept URLs and searches without enabling executable or credential schemes", () => {
  assert.equal(
    panelAddress("localhost:1234/file"),
    "http://localhost:1234/file",
  );
  assert.equal(panelAddress("pi.dev"), "https://pi.dev/");
  assert(
    panelAddress("pi agent docs").startsWith("https://duckduckgo.com/?q="),
  );
  for (const value of [
    "file:///tmp/file",
    "javascript:alert(1)",
    "https://user:secret@example.com",
  ])
    assert.throws(() => panelAddress(value));
});

test("file HTTP reads bind to the selected project worker and projectless browsing stays explicit", async (t) => {
  const f = await desktopFixture();
  t.after(() => f.close());
  await writeFile(join(f.cwd, "panel.txt"), "PROJECT_A_FILE");
  await writeFile(join(f.other, "panel.txt"), "PROJECT_B_FILE");
  const project = (await f.call("/api/workspace")).projects[0];
  const agent = await f.command("conversation.create", {
    projectId: project.id,
  });
  const preview = await f.call(`/agents/${agent.id}/api/files?path=panel.txt`);
  assert.equal(preview.text, "PROJECT_A_FILE");
  await assert.rejects(
    f.call(`/agents/${agent.id}/api/files?path=..%2Fother%2Fpanel.txt`),
    (error) => error.status === 403,
  );
  const loose = await f.command("conversation.create", { projectId: null });
  await assert.rejects(
    f.call(`/agents/${loose.id}/api/files`),
    (error) => error.status === 403,
  );
});
