import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeNpmFixture } from "./package-fixture.mjs";

// A real PTY is required: piping Pi stdin/stdout selects print mode, not TUI.
const root = await mkdtemp(join(tmpdir(), "pi-desk-tui-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
await writeFile(join(root, ".gitignore"), "*\n!git-fixture.txt\n");
await writeFile(join(root, "git-fixture.txt"), "Git fixture");
const marker = join(root, "desktop.json");
const electron = join(root, "electron-fixture.mjs");
const realDesktop = process.env.PI_WEB_REAL_DESKTOP === "1";
const desktopScript = realDesktop
  ? `import {spawn} from 'node:child_process';
const child=spawn('xvfb-run',['-a','/usr/bin/electron43','--remote-debugging-port=0','--disable-gpu','--ozone-platform=x11',...process.argv.slice(2)],{env:{...process.env,HOME:${JSON.stringify(root)},XDG_CONFIG_HOME:${JSON.stringify(join(root, "config"))},PI_DESK_URL:'http://127.0.0.1:1/'},stdio:'ignore'});
child.on('exit',code=>process.exit(code??1));
child.on('error',()=>process.exit(1));
process.on('SIGTERM',()=>child.kill('SIGTERM'));
`
  : "setInterval(()=>{},1000);\n";
await writeFile(
  electron,
  `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));\n${desktopScript}`,
);
await chmod(electron, 0o700);
await writeFile(
  join(root, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions",
        apiKey: "fixture",
        models: [
          {
            id: "tui-first",
            name: "TUI First",
            reasoning: true,
            contextWindow: 16000,
            maxTokens: 1000,
          },
          {
            id: "tui-second",
            name: "TUI Second",
            reasoning: true,
            contextWindow: 16000,
            maxTokens: 1000,
          },
        ],
      },
    },
  }),
);
const npmFixture = await createNativeNpmFixture(root);
await writeFile(
  join(root, "settings.json"),
  JSON.stringify({
    ...npmFixture.settings,
    defaultProvider: "fixture",
    defaultModel: "tui-first",
    quietStartup: true,
    cacheWarming: "off",
  }),
);
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const args = [
  "pi",
  "--no-extensions",
  "-e",
  fileURLToPath(new URL("../index.ts", import.meta.url)),
];
const child = spawn(
  "script",
  [
    "-q",
    "-f",
    "-c",
    `stty cols 110 rows 35; exec ${args.map(quote).join(" ")}`,
    "/dev/null",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
      PI_CODING_AGENT_DIR: root,
      PI_DESK_HOST: "127.0.0.1",
      PI_DESK_PORT: "0",
      PI_DESK_TLS_CERT: "",
      PI_DESK_TLS_KEY: "",
      PI_DESK_ELECTRON: electron,
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const exited = new Promise((resolve) => child.once("exit", resolve));
let output = "",
  backendPid,
  desktopPid;
child.stdout.on("data", (data) => {
  output += data.toString();
});
child.stderr.on("data", (data) => {
  output += data.toString();
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (predicate) => {
  for (let i = 0; i < 150; i++) {
    if (await predicate()) return;
    await pause(40);
  }
  console.error(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(-2000));
  throw new Error("Real TUI condition timed out");
};
const send = (text) => child.stdin.write(text + "\r");
let origin, desktopSocket;
let desktopEvaluate;
try {
  await wait(() => output.includes("tui-first") && output.includes("\x1b]0;"));
  send("/desk");
  let record;
  await wait(async () => {
    try {
      record = JSON.parse(await readFile(marker, "utf8"));
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return false;
    }
  });
  desktopPid = record.pid;
  origin = new URL(record.args.at(-1)).origin;
  const state = async () => (await fetch(origin + "/api/state")).json();
  const post = async (path, body) =>
    fetch(origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const initial = await state();
  backendPid = initial.backend.pid;
  assert.equal(initial.host, "tui");
  assert.notEqual(backendPid, desktopPid, "Desktop is not the agent process");
  const backend = initial.backend.id,
    epoch = initial.epoch;
  assert.equal(initial.marketplaceOfficial, true);
  assert.equal(initial.packageManagement, true);
  assert.equal(initial.packageUpdates, true);
  let inventory = await (await fetch(origin + "/api/plugins")).json();
  const installed = inventory.rows.find(
    (row) => row.source === npmFixture.source,
  );
  assert.equal(installed.installedVersion, "1.0.0");
  const checked = await post("/api/package-updates", {
    sessionId: initial.sessionId,
  });
  assert.equal(checked.status, 200);
  inventory = await checked.json();
  assert.equal(
    inventory.rows.find((row) => row.source === npmFixture.source)
      .updateAvailable,
    true,
  );
  const updated = await post("/api/package", {
    sessionId: initial.sessionId,
    action: "update",
    scope: "global",
    source: npmFixture.source,
    revision: installed.revision,
    inventoryKey: inventory.inventoryKey,
  });
  assert.equal(updated.status, 200, await updated.text());
  assert.equal(
    JSON.parse(await readFile(join(npmFixture.root, "package.json"), "utf8"))
      .version,
    "2.0.0",
  );
  assert.equal((await state()).backend.id, backend);
  assert.equal(
    (await state()).messages.filter((message) => message.role === "user")
      .length,
    0,
    "Native package commands must not enter model context",
  );
  const gitOutputStart = output.length;
  send("/git status");
  await wait(() => output.slice(gitOutputStart).includes("git-fixture.txt"));
  if (realDesktop) {
    let page;
    await wait(async () => {
      try {
        const active = await readFile(
          join(root, "config", "pi-desk", "DevToolsActivePort"),
          "utf8",
        );
        const pages = await (
          await fetch(`http://127.0.0.1:${active.split("\n")[0]}/json/list`)
        ).json();
        page = pages.find(
          (page) => page.type === "page" && page.url.startsWith(origin),
        );
        return !!page;
      } catch (error) {
        if (error.code && error.code !== "ENOENT") throw error;
        return false;
      }
    });
    desktopSocket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) =>
      desktopSocket.addEventListener("open", resolve, { once: true }),
    );
    let serial = 0;
    const pending = new Map();
    desktopSocket.addEventListener("message", (event) => {
      const result = JSON.parse(event.data);
      if (!result.id) return;
      const item = pending.get(result.id);
      pending.delete(result.id);
      result.error
        ? item.reject(new Error(result.error.message))
        : item.resolve(result.result);
    });
    desktopEvaluate = (expression) =>
      new Promise((resolve, reject) => {
        pending.set(++serial, {
          resolve: (result) =>
            result.exceptionDetails
              ? reject(new Error("Desktop evaluation failed"))
              : resolve(result.result.value),
          reject,
        });
        desktopSocket.send(
          JSON.stringify({
            id: serial,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        );
      });
    await wait(
      async () =>
        await desktopEvaluate(
          `document.querySelector('#connection-status')?.textContent==='Pi 已连接'`,
        ),
    );
    assert.equal(
      await desktopEvaluate(`location.origin`),
      origin,
      "Explicit URL must override an inherited PI_DESK_URL",
    );
    await desktopEvaluate(
      `document.querySelector('[data-action="hide-right-sidebar"]').click()`,
    );
    assert.equal(
      await desktopEvaluate(
        `document.querySelector('#workspace-right').checkVisibility()`,
      ),
      false,
    );
    await desktopEvaluate(
      `document.querySelector('[data-action="workspace-tools"]').click()`,
    );
    assert.equal(
      await desktopEvaluate(
        `document.querySelector('#workspace-right').checkVisibility()`,
      ),
      true,
    );
    await desktopEvaluate(
      `document.querySelector('[data-view="plugins"]').click()`,
    );
    await wait(
      async () =>
        await desktopEvaluate(
          `document.querySelector('#plugin-grid').textContent.includes('已安装 v2.0.0')`,
        ),
    );
    await wait(
      async () =>
        await desktopEvaluate(
          `!document.querySelector('[data-action="check-package-updates"]').disabled`,
        ),
    );
    await desktopEvaluate(`document.querySelector('.settings-back').click()`);
    await desktopEvaluate(
      `document.querySelector('[data-action="git-review"]').click()`,
    );
    await wait(
      async () =>
        await desktopEvaluate(
          `!document.querySelector("#git-review-pane").hidden && document.querySelector("#git-files").textContent.includes("git-fixture.txt")`,
        ),
    );
    await desktopEvaluate(
      `document.querySelector('[data-action="close-right-view"]').click();(()=>{const data=new DataTransfer();data.items.add(new File(["Desktop pasted context"],"desktop-clipboard.txt",{type:"text/plain"}));document.querySelector("#prompt").dispatchEvent(new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true}));})()`,
    );
    await wait(
      async () =>
        await desktopEvaluate(
          `document.querySelector('[data-context-preview]:not([disabled])')?.textContent.includes("desktop-clipboard.txt")`,
        ),
    );
    await desktopEvaluate(
      `document.querySelector('[data-context-remove]').click()`,
    );
  }
  const outputBefore = output.length;
  assert.equal(
    (await post("/api/model", { provider: "fixture", id: "tui-second" }))
      .status,
    200,
  );
  assert.equal((await state()).model.id, "tui-second");
  await wait(() => output.slice(outputBefore).includes("tui-second"));
  if (realDesktop)
    await wait(
      async () =>
        await desktopEvaluate(
          `document.querySelector('.model-button')?.textContent.includes('TUI Second')`,
        ),
    );
  assert.equal((await post("/api/thinking", { level: "high" })).status, 200);
  await wait(() => output.slice(outputBefore).includes("high"));
  send("/name Named in real TUI");
  await wait(async () => (await state()).name === "Named in real TUI");
  const session = (await state()).sessionId;
  send("/new");
  await wait(async () => (await state()).sessionId !== session);
  assert.equal((await state()).backend.id, backend);
  assert.equal((await state()).epoch, epoch);
  send("/reload");
  await wait(() => output.includes("Reloaded") || output.includes("reloaded"));
  assert.equal((await state()).backend.id, backend);
  assert.equal((await state()).epoch, epoch);
  assert.equal(
    (await post("/api/prompt", { message: "/name Named from phone" })).status,
    200,
  );
  await wait(async () => (await state()).name === "Named from phone");
  if (realDesktop) {
    await wait(
      async () =>
        await desktopEvaluate(
          `document.querySelector('#session-title')?.textContent==='Named from phone'`,
        ),
    );
    assert.equal(
      await desktopEvaluate(
        `!!document.querySelector('#attach-context') && !document.querySelector('#attach-context').disabled && !!document.querySelector('#ask-user')`,
      ),
      true,
    );
    assert.equal(
      await desktopEvaluate(
        `fetch('/api/state').then(response=>response.json()).then(state=>state.backend.id)`,
      ),
      backend,
    );
    desktopSocket.close();
    desktopSocket = undefined;
  }
  process.kill(desktopPid, "SIGTERM");
  desktopPid = undefined;
  assert.equal((await state()).backend.id, backend);
  child.stdin.write("\x04");
  await Promise.race([
    exited,
    pause(6000).then(() => {
      throw new Error("Native TUI did not shut down on Ctrl-D");
    }),
  ]);
  await assert.rejects(
    fetch(origin + "/api/state"),
    "Exiting TUI must close the backend transport",
  );
  backendPid = undefined;
  console.log(
    `Real TUI${realDesktop ? " + Electron 43 (Xvfb)" : " + Desktop launch fixture"} passed: /desk launches a frontend, remote model/thinking render in native footer, /name and /new synchronize, /reload preserves one backend/port/epoch, closing frontend leaves Agent alive, exiting TUI stops the service.`,
  );
} finally {
  desktopSocket?.close();
  for (const pid of [desktopPid, backendPid])
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGTERM");
  await exited;
  await rm(root, { recursive: true, force: true });
}
