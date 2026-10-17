import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = await mkdtemp(join(tmpdir(), "pi-desk-discovery-"));
const explicit = process.argv.includes("--with-extension");
const installed = process.argv.includes("--installed-package");
await writeFile(
  join(root, "settings.json"),
  JSON.stringify({
    cacheWarming: "off",
    quietStartup: true,
    ...(installed
      ? { packages: [fileURLToPath(new URL("../", import.meta.url))] }
      : {}),
  }),
);
const args = [
  "--mode",
  "rpc",
  ...(installed ? [] : ["--no-extensions"]),
  ...(explicit
    ? ["-e", fileURLToPath(new URL("../index.ts", import.meta.url))]
    : []),
];
const child = spawn("pi", args, {
  cwd: root,
  env: { ...process.env, PI_CODING_AGENT_DIR: root },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
const result = new Promise((resolve, reject) => {
  child.on("error", reject);
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === "response" && message.command === "get_commands")
          resolve(message);
      } catch {}
    }
  });
});
const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
const exited = new Promise((resolve) => child.once("exit", resolve));
try {
  child.stdin.write(
    JSON.stringify({ id: "check", type: "get_commands" }) + "\n",
  );
  const response = await Promise.race([
    result,
    exited.then(() => {
      throw new Error("Command discovery did not respond");
    }),
  ]);
  assert(response.success);
  const desk = response.data.commands.some(
    (command) => command.name === "desk",
  );
  console.log(
    JSON.stringify({
      explicit_extension: explicit,
      installed_package: installed,
      desk_registered: desk,
      sessions_registered: response.data.commands.some(
        (command) => command.name === "sessions",
      ),
    }),
  );
  assert.equal(
    desk,
    explicit || installed,
    "Only a loaded Pi Desk extension can register /desk",
  );
  assert.equal(
    response.data.commands.some((command) => command.name === "sessions"),
    explicit || installed,
  );
} finally {
  clearTimeout(timer);
  child.kill("SIGTERM");
  await exited;
  await rm(root, { recursive: true, force: true });
}
