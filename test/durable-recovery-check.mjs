import { fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

/* Two interrupt scenarios share one control run:
 *   generation interrupt — the owner dies while the answer streams, so the
 *     resumed owner must finish exactly that generation: the committed
 *     tool-call entry is not requested again, and usage matches the control.
 *   tool interrupt — the owner dies with both tool calls in flight, so the
 *     replay-safe tool reruns, the unsafe effect never repeats and surfaces as
 *     an explicit error.
 * Both must report the takeover through the recovery field of read(). */

const worker = fileURLToPath(
  new URL("./durable-recovery-worker.mjs", import.meta.url),
);
const roots = [];
const children = new Set();
const LEASE_MS = 10500; // a killed owner's lease must expire; nothing removes it

async function fixture(label) {
  const root = await mkdtemp(join(tmpdir(), `pi-durable-${label}-`));
  const cwd = join(root, "project");
  await mkdir(cwd);
  roots.push(root);
  return { root, cwd };
}

function spawn(mode, directory, cwd) {
  const child = fork(worker, [mode, directory, cwd], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const received = new Map();
  const waiters = [];
  const settle = () => {
    for (const waiter of [...waiters]) {
      const message = received.get(waiter.kind);
      if (message === undefined) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  };
  child.on("message", (message) => {
    received.set(message.kind, message);
    settle();
  });
  child.on("exit", (code) => {
    if (code !== 0)
      for (const waiter of waiters.splice(0))
        waiter.reject(new Error(`Worker ${mode} exit ${code}\n${log}`));
  });
  return {
    child,
    next(kind, timeout = 30000) {
      if (received.has(kind)) return Promise.resolve(received.get(kind));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(
            waiters.findIndex((row) => row.timer === timer),
            1,
          );
          reject(new Error(`Timeout waiting for ${kind} (${mode})\n${log}`));
        }, timeout);
        waiters.push({ kind, resolve, reject, timer });
      });
    },
  };
}

const exitOf = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("exit", resolve);
  });

const killer = async (child) => {
  child.kill("SIGKILL");
  await exitOf(child);
  await new Promise((resolve) => setTimeout(resolve, LEASE_MS));
};

const tokens = (summary) => summary.usage?.tokens ?? 0;

let failed;
try {
  // Baseline: the same run with no interrupt.
  const controlFixture = await fixture("control");
  const controlRun = spawn("control", controlFixture.root, controlFixture.cwd);
  const control = await controlRun.next("control");
  assert.equal(control.answers, 1, "control answers once");
  assert.equal(
    control.assistantEntries,
    2,
    "control has two assistant entries",
  );
  assert.equal(control.callCount, 2, "control makes two provider calls");
  assert.equal(control.recovery, null, "a fresh storage reports no recovery");
  await exitOf(controlRun.child);

  // Scenario 1: interrupt the answer generation.
  const answerFixture = await fixture("answer");
  const answerStart = spawn(
    "start-answer",
    answerFixture.root,
    answerFixture.cwd,
  );
  const streaming = await answerStart.next("started");
  assert.equal(streaming.streaming, true, "the answer generation is streaming");
  assert.equal(streaming.callCount, 2, "both generations were requested");
  assert.equal(
    streaming.recovery,
    null,
    "the first owner has nothing to resume",
  );
  assert.ok(tokens(streaming) > 0, "the committed generation spent tokens");
  await killer(answerStart.child);

  const answerResume = spawn(
    "resume-answer",
    answerFixture.root,
    answerFixture.cwd,
  );
  const opened = await answerResume.next("opened");
  assert.equal(opened.agents, 1, "the conversation survived the crash");
  assert.ok(opened.recovery, "reopening reports the interrupted work");
  assert.ok(opened.recovery.count >= 1, "at least one task was interrupted");
  assert.ok(
    opened.recovery.tasks.some((task) => task.statusAtOpen === "pending"),
    "a task interrupted mid-run reopens as pending",
  );
  assert.ok(
    opened.recovery.outstanding >= 1,
    "the reopened host still has work outstanding",
  );
  assert.ok(
    !Number.isNaN(Date.parse(opened.recovery.resumedAt)),
    "resumedAt is a timestamp",
  );
  const resumed = await answerResume.next("resumed");
  assert.equal(resumed.answers, 1, "the resumed run commits the answer once");
  assert.equal(
    resumed.text.filter((text) => text !== "").length,
    control.assistantEntries,
    "the resumed transcript holds the same content entries as the control",
  );
  assert.equal(
    resumed.text.filter((text) => text.includes("toolCall")).length,
    1,
    "the committed tool-call generation is not requested again",
  );
  assert.equal(
    resumed.callCount,
    1,
    "the resumed owner issues exactly the unfinished generation",
  );
  assert.ok(
    resumed.transcriptEntries >= control.transcriptEntries,
    "the interrupted attempt stays recorded instead of being dropped",
  );
  assert.ok(
    tokens(resumed) > tokens(control),
    "the resumed run accounts both the interrupted attempt and its own",
  );
  assert.equal(resumed.recovery?.outstanding, 0, "recovery drains to zero");
  assert.equal(
    resumed.recovery?.count,
    opened.recovery.count,
    "recovery keeps reporting the tasks it took over",
  );
  await exitOf(answerResume.child);

  // Scenario 2: interrupt both tool calls.
  const toolFixture = await fixture("tools");
  const toolStart = spawn("start-tools", toolFixture.root, toolFixture.cwd);
  const inFlight = await toolStart.next("started");
  assert.equal(inFlight.callCount, 1, "only the tool-call generation ran");
  assert.ok(tokens(inFlight) > 0, "the committed generation spent tokens");
  await killer(toolStart.child);

  const toolResume = spawn("resume-tools", toolFixture.root, toolFixture.cwd);
  const toolOpened = await toolResume.next("opened");
  assert.ok(toolOpened.recovery, "tool recovery is reported too");
  assert.ok(
    toolOpened.recovery.tasks.some((task) => task.statusAtOpen === "pending"),
    "the interrupted tool task reopens as pending",
  );
  const toolRecovered = await toolResume.next("recovered");
  assert.equal(
    toolRecovered.answers,
    1,
    "the tool-interrupted run answers once",
  );
  assert.equal(
    toolRecovered.unsafeError,
    true,
    "the interrupted side effect surfaces as an error instead of rerunning",
  );
  assert.equal(toolRecovered.recovery?.outstanding, 0, "tool recovery drains");
  assert.equal(
    (await readFile(join(toolFixture.root, "safe_read.txt"), "utf8"))
      .trim()
      .split("\n").length,
    2,
    "the replay-safe tool runs again after the crash",
  );
  assert.equal(
    (await readFile(join(toolFixture.root, "unsafe_effect.txt"), "utf8"))
      .trim()
      .split("\n").length,
    1,
    "the interrupted side effect never repeats",
  );
  await exitOf(toolResume.child);

  console.log(
    [
      "Durable SIGKILL recovery passed.",
      `control: ${control.callCount} provider calls, ${control.transcriptEntries} entries, ${tokens(control)} tokens`,
      `generation interrupt: ${streaming.callCount}+${resumed.callCount} calls, ${resumed.transcriptEntries} entries, ${tokens(streaming)}->${tokens(resumed)} tokens, recovery ${opened.recovery.count} task(s) outstanding ${opened.recovery.outstanding}->${resumed.recovery?.outstanding}`,
      `tool interrupt: ${inFlight.callCount}+${toolRecovered.callCount} calls, ${toolRecovered.transcriptEntries} entries, ${tokens(inFlight)}->${tokens(toolRecovered)} tokens, recovery ${toolOpened.recovery.count} task(s) outstanding ${toolOpened.recovery.outstanding}->${toolRecovered.recovery?.outstanding}`,
      "the interrupted round is re-issued; replay-safe tools rerun and unsafe effects never repeat.",
    ].join("\n"),
  );
} catch (error) {
  failed = error;
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const root of roots) await rm(root, { recursive: true, force: true });
}
if (failed) throw failed;
