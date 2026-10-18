import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { piSdk, loadEmbeddedPiSdk } from "../src/agent/pi-sdk.mjs";

await loadEmbeddedPiSdk();
import {
  installedPackageVersion,
  checkNativePackageUpdates,
  runNativePackageAction,
} from "../src/resources/native-packages.mjs";
import { createNativeNpmFixture } from "./package-fixture.mjs";
const { SettingsManager, DefaultPackageManager } = piSdk;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-native-packages-"));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  await mkdir(agentDir);
  await mkdir(cwd);
  const npm = await createNativeNpmFixture(agentDir, { projectDir: cwd });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ ...npm.settings, preserved: { enabled: true } }),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const make = () => {
    const settings = SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    });
    return {
      settings,
      manager: new DefaultPackageManager({
        cwd,
        agentDir,
        settingsManager: settings,
      }),
    };
  };
  return { ...npm, cwd, agentDir, make };
}

test("native package version reads are bounded and corruption is reported rather than treated as latest", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await installedPackageVersion(f.root), {
    installedVersion: "1.0.0",
  });
  assert.deepEqual(await installedPackageVersion(null), {
    installedVersion: null,
  });
  await writeFile(join(f.root, "package.json"), "broken");
  assert((await installedPackageVersion(f.root)).versionError);
  await writeFile(join(f.root, "package.json"), "x".repeat(512 * 1024 + 1));
  assert((await installedPackageVersion(f.root)).versionError);
});

test("actual public Pi manager checks and reconciles npm while retaining native settings and filters", async (t) => {
  const f = await fixture(t);
  const { manager, settings } = f.make();
  assert.equal(manager.getInstalledPath(f.source, "user"), f.root);
  assert.deepEqual(await checkNativePackageUpdates(manager), {
    supported: true,
    rows: [{ source: f.source, scope: "global", type: "npm" }],
  });
  assert.equal(
    (await installedPackageVersion(f.root)).installedVersion,
    "1.0.0",
  );
  await runNativePackageAction(manager, settings, {
    action: "update",
    source: f.source,
    scope: "global",
  });
  assert.equal(
    (await installedPackageVersion(f.root)).installedVersion,
    "2.0.0",
  );
  assert.deepEqual(await checkNativePackageUpdates(manager), {
    supported: true,
    rows: [],
  });
  const data = JSON.parse(
    await readFile(join(f.agentDir, "settings.json"), "utf8"),
  );
  assert.deepEqual(data.preserved, { enabled: true });
  assert.deepEqual(data.packages, [f.source]);
  const commands = (await readFile(f.log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(commands.some((args) => args[0] === "view"));
  assert(commands.some((args) => args[0] === "install"));
});

test("pinned versions and project override follow the real native update checker, not a UI semver engine", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.agentDir, "settings.json"),
    JSON.stringify({ ...f.settings, packages: [f.source + "@1.0.0"] }),
  );
  assert.deepEqual(
    (await checkNativePackageUpdates(f.make().manager)).rows,
    [],
  );
  await writeFile(
    join(f.agentDir, "settings.json"),
    JSON.stringify(f.settings),
  );
  await mkdir(join(f.cwd, ".pi"));
  await writeFile(
    join(f.cwd, ".pi", "settings.json"),
    JSON.stringify({ packages: [f.source] }),
  );
  const { manager } = f.make();
  await manager.install(f.source, { local: true });
  const projectPath = manager.getInstalledPath(f.source, "project");
  assert(projectPath, "Only Pi determines the installed project location");
  await writeFile(
    join(projectPath, "package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  assert.deepEqual((await checkNativePackageUpdates(manager)).rows, [
    { source: f.source, scope: "project", type: "npm" },
  ]);
});

test("old managers report an unsupported checker and persistence errors remain errors", async () => {
  assert.deepEqual(await checkNativePackageUpdates({}), {
    supported: false,
    rows: [],
  });
  const calls = [];
  const manager = { installAndPersist: async (...args) => calls.push(args) };
  await assert.rejects(
    runNativePackageAction(
      manager,
      {
        flush: async () => {},
        drainErrors: () => [
          { scope: "project", error: new Error("permission denied") },
        ],
      },
      { action: "install", source: "./fixture", scope: "project" },
    ),
    { status: 500 },
  );
  assert.deepEqual(calls, [["./fixture", { local: true }]]);
});

test("desktop全量更新 uses the actual native manager, updates user packages and preserves project declarations and settings", async (t) => {
  const f = await fixture(t);
  const { createDesktopGlobal } = await import(
    "../src/resources/desktop-global.mjs"
  );
  await mkdir(join(f.cwd, ".pi"), { recursive: true });
  await writeFile(
    join(f.cwd, ".pi", "settings.json"),
    JSON.stringify({ packages: ["npm:project-only@1.0.0"] }),
  );
  const global = createDesktopGlobal({
    agentDir: f.agentDir,
    directory: join(f.cwd, "desktop"),
    supervisor: { shared: (run) => run({ reload: async () => [] }) },
  });
  const preview = await global.updates();
  assert.equal(preview.versions[0].installedVersion, "1.0.0");
  await global.update(preview);
  assert.equal(
    (await installedPackageVersion(f.root)).installedVersion,
    "2.0.0",
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8"))
      .preserved,
    { enabled: true },
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(f.cwd, ".pi", "settings.json"), "utf8"))
      .packages,
    ["npm:project-only@1.0.0"],
  );
  assert.notEqual((await global.updates()).inventoryKey, preview.inventoryKey);
});
