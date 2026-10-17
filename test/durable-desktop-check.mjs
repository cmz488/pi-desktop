import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { browserDriver, pause } from "./durable-browser-driver.mjs";
const root = await mkdtemp(join(tmpdir(), "pi-durable-electron-"));
let electron,
  driver,
  log = "";
try {
  const agentDir = join(root, "agent"),
    directory = join(root, "data"),
    cwd = join(root, "project"),
    profile = join(root, "config", "pi-desk");
  await mkdir(agentDir);
  await mkdir(cwd);
  const options = { agentDir, directory, singleProcess: true };
  electron = spawn(
    "xvfb-run",
    [
      "-a",
      "/usr/bin/electron43",
      "--no-sandbox",
      "--disable-gpu",
      "--ozone-platform=x11",
      "--remote-debugging-port=0",
      fileURLToPath(new URL("../src/desktop/desktop.mjs", import.meta.url)),
      "--managed",
      JSON.stringify(options),
    ],
    {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, "config"),
        PI_DESK_URL: "http://127.0.0.1:1/",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  electron.stdout.on("data", (chunk) => (log += chunk));
  electron.stderr.on("data", (chunk) => (log += chunk));
  driver = await browserDriver(profile);
  const { evaluate, until } = driver;
  await until(
    "document.querySelector('#connection-status')?.textContent==='Pi 已连接'",
  );
  assert.equal(
    await evaluate("typeof window.piDesk.pickDirectory"),
    "function",
  );
  assert(
    await evaluate("location.origin!=='http://127.0.0.1:1'"),
    "managed mode must ignore stale PI_DESK_URL",
  );
  await evaluate(
    `document.querySelector('[data-action="new-session"]').click()`,
  );
  await until(
    "document.querySelector('#dialog').open && !!document.querySelector('[name=agentName]')",
  );
  await evaluate(
    `const form=document.querySelector('#dialog-form');form.elements.agentCwd.value=${JSON.stringify(cwd)};form.elements.agentName.value='Electron owned';form.requestSubmit()`,
  );
  await until(
    "document.querySelector('#session-title').textContent==='Electron owned'",
  );
  const origin = await evaluate("location.origin");
  assert((await readFile(join(directory, "agents.sqlite"))).length > 0);
  assert.deepEqual(driver.errors, []);
  await evaluate("window.close()");
  driver.close();
  driver = undefined;
  for (let index = 0; index < 100; index++) {
    try {
      await fetch(origin + "/api/state");
      await pause(50);
    } catch {
      break;
    }
  }
  await assert.rejects(fetch(origin + "/api/state"));
  const { startDurableDesk } = await import("../src/server/durable-server.mjs");
  const reopened = await startDurableDesk(options);
  try {
    assert(
      (await reopened.workspace.read()).agents.some(
        (row) => row.name === "Electron owned",
      ),
    );
  } finally {
    await reopened.stop();
  }
  console.log(
    "Durable Electron 43 + Xvfb passed: owned Harness, isolated preload, persistent agent, graceful window close and reopen.",
  );
} catch (error) {
  throw new Error(error.message + "\n" + log, { cause: error });
} finally {
  driver?.close();
  electron?.kill();
  await rm(root, { recursive: true, force: true });
}
