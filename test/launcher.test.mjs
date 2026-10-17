import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const installer = fileURLToPath(
  new URL("../src/cli/install-launcher.mjs", import.meta.url),
);
test("pi launcher dispatches web, forwards native arguments literally, and removes only its own wrapper", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = join(root, "native-pi");
  await writeFile(
    native,
    "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n",
  );
  await chmod(native, 0o755);
  const dir = join(root, "bin"),
    env = { ...process.env, PI_WEB_BIN_DIR: dir, PI_WEB_NATIVE_PI: native };
  let result = spawnSync(process.execPath, [installer], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const launcher = join(dir, "pi"),
    args = ["--mode", "rpc", "literal; $(do-not-run) `command`"];
  result = spawnSync(launcher, args, { env, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
  result = spawnSync(launcher, ["web", "--help"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert(result.stdout.includes("pi web"));
  assert((await readFile(native, "utf8")).includes("JSON.stringify"));
  result = spawnSync(process.execPath, [installer, "--remove"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  await writeFile(launcher, "foreign command");
  result = spawnSync(process.execPath, [installer], { env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(launcher, "utf8"), "foreign command");
  result = spawnSync(process.execPath, [installer, "--remove"], {
    env,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(launcher, "utf8"), "foreign command");
});
test("npm-run installation skips its injected peer CLI and preserves the native command path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  const injected = join(root, "node_modules", ".bin"),
    native = join(root, "native-bin");
  await mkdir(injected, { recursive: true });
  await mkdir(native);
  for (const [dir, output] of [
    [injected, "peer"],
    [native, "original"],
  ]) {
    const path = join(dir, "pi");
    await writeFile(
      path,
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(output)});`,
    );
    await chmod(path, 0o755);
  }
  const dir = join(root, "launcher"),
    env = {
      ...process.env,
      PI_WEB_BIN_DIR: dir,
      PI_WEB_NATIVE_PI: "",
      npm_lifecycle_event: "install:launcher",
      PATH: `${injected}:${native}:${process.env.PATH}`,
    };
  const installed = spawnSync(process.execPath, [installer], {
    env,
    encoding: "utf8",
  });
  assert.equal(installed.status, 0, installed.stderr);
  const forwarded = spawnSync(join(dir, "pi"), ["--version"], {
    env,
    encoding: "utf8",
  });
  assert.equal(forwarded.status, 0);
  assert.equal(forwarded.stdout.trim(), "original");
});
