import { fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root = await mkdtemp(join(tmpdir(), "pi-durable-crash-"));
const cwd = join(root, "project");
await mkdir(cwd);
const worker = fileURLToPath(
  new URL("./durable-recovery-worker.mjs", import.meta.url),
);
let child;
async function run(mode, kind) {
  child = fork(worker, [mode, root, cwd], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Recovery worker timed out\n${log}`)),
      15000,
    );
    child.on("message", (message) => {
      if (message.kind === kind) {
        clearTimeout(timer);
        resolve(message);
      }
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Worker exit ${code}\n${log}`));
      }
    });
  });
}
try {
  await run("start", "started");
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGKILL");
  });
  // The OS killed the owner, so the library's lease must expire before another
  // writer can take it. Nothing removes a live owner's lock.
  await new Promise((resolve) => setTimeout(resolve, 10500));
  const recovered = await run("resume", "recovered");
  assert.equal(
    (await readFile(join(root, "safe_read.txt"), "utf8")).trim().split("\n")
      .length,
    2,
  );
  assert.equal(
    (await readFile(join(root, "unsafe_effect.txt"), "utf8")).trim().split("\n")
      .length,
    1,
  );
  assert(
    recovered.active.messages.some(
      (row) => row.toolName === "unsafe_effect" && row.isError,
    ),
  );
  assert(
    recovered.active.messages.some((row) => row.text === "Recovered result"),
  );
  if (child.exitCode === null)
    await new Promise((resolve) => child.once("exit", resolve));
  console.log(
    "Durable SIGKILL recovery passed: same SQLite conversations resume; replay-safe tool reruns; interrupted side effect never repeats.",
  );
} finally {
  child?.kill();
  await rm(root, { recursive: true, force: true });
}
