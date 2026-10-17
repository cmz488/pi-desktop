import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  desktopAddress,
  launchDesktop,
} from "../src/desktop/desktop-launcher.mjs";
import { desktopMain } from "../launch-desktop.mjs";
import { deskOptions } from "../desk.mjs";

test("Desktop connects only to an explicit loopback backend URL, never credentials or remote hosts", () => {
  for (const url of [
    "http://127.0.0.1:4318/",
    "https://localhost:4318/",
    "http://[::1]:4318/",
  ])
    assert.equal(desktopAddress(url), url);
  for (const url of [
    "https://example.com/",
    "http://127.0.0.1.evil/",
    "http://user:secret@localhost/",
    "file:///tmp/index.html",
    "javascript:alert(1)",
  ])
    assert.throws(() => desktopAddress(url));
});

test("the default npm CLI opens Desktop and preserves the requested host port", async () => {
  let launched;
  const child = new EventEmitter();
  child.kill = () => {};
  const processTarget = new EventEmitter();
  await desktopMain(["--port", "4567", "--cwd", "/tmp/pi-project"], {
    launch: async (address, options) => {
      launched = { address, options };
      return child;
    },
    processTarget,
  });
  assert.equal(launched.address, undefined);
  assert.equal(launched.options.detached, false);
  assert.deepEqual(launched.options.options, {
    extensionPaths: [],
    port: "4567",
    cwd: "/tmp/pi-project",
  });
  assert.equal(processTarget.listenerCount("SIGINT"), 1);
  child.emit("exit", 0);
  assert.equal(processTarget.listenerCount("SIGINT"), 0);
  assert.equal(processTarget.exitCode, 0);
  assert.equal(deskOptions(["--port", "4578"]).port, "4578");
});

test("the npm bin symlink invokes the desktop CLI entry point", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desk-bin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "pi-desktop");
  await symlink(
    fileURLToPath(new URL("../launch-desktop.mjs", import.meta.url)),
    bin,
  );
  const result = spawnSync(process.execPath, [bin, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pi-desktop \[--cwd PATH\]/);
});

test("Desktop launcher detaches frontend IO, passes only desktop entry and URL, and surfaces missing executables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-desk-launch-"));
  const previous = process.env.PI_DESK_ELECTRON;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_DESK_ELECTRON;
    else process.env.PI_DESK_ELECTRON = previous;
    await rm(root, { recursive: true, force: true });
  });
  const binary = join(root, "electron-fixture.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}\nsetTimeout(()=>process.exit(0),30);\n`,
  );
  await chmod(binary, 0o700);
  process.env.PI_DESK_ELECTRON = binary;
  const child = await launchDesktop("http://127.0.0.1:4318/");
  assert.equal(child.stdin, null);
  assert.equal(child.stdout, null);
  assert.equal(child.stderr, null);
  assert.equal(child.spawnargs.length, 3);
  assert(child.spawnargs[1].endsWith("/desktop.mjs"));
  assert.equal(child.spawnargs[2], "http://127.0.0.1:4318/");
  await new Promise((resolve) => child.once("exit", resolve));
  process.env.PI_DESK_ELECTRON = join(root, "missing-electron");
  await assert.rejects(launchDesktop("http://127.0.0.1:4318/"));
});
