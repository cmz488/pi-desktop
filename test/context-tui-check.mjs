import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { concurrentFixture, until } from "./concurrent-fixture.mjs";
const model = await concurrentFixture();
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
    cwd: model.root,
    env: {
      ...process.env,
      SHELL: "/bin/bash",
      TERM: "xterm-256color",
      PI_CODING_AGENT_DIR: model.agentDir,
      PI_DESK_HOST: "127.0.0.1",
      PI_DESK_PORT: "0",
      PI_DESK_TLS_CERT: "",
      PI_DESK_TLS_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const exited = new Promise((resolve) => child.once("exit", resolve));
let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));
try {
  await until(
    () => output.includes("fixture") && output.includes("\x1b]0;"),
    15000,
  );
  child.stdin.write("/desk web\r");
  await until(() => /http:\/\/127\.0\.0\.1:\d+\//.test(output));
  const origin = output
    .match(/http:\/\/127\.0\.0\.1:\d+\//)[0]
    .replace(/\/$/, "");
  const state = async () => await (await fetch(origin + "/api/state")).json();
  const before = await state();
  assert(before.model.input.includes("image"));
  model.release("C");
  const response = await fetch(origin + "/api/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "TASK C",
      sessionId: before.sessionId,
      attachments: [
        {
          name: "native.md",
          data: Buffer.from("Native context fixture").toString("base64"),
          type: "text/markdown",
        },
        {
          name: "native.png",
          data: (await QRCode.toBuffer("native context fixture")).toString(
            "base64",
          ),
          type: "image/png",
        },
      ],
    }),
  });
  assert.equal(response.status, 200, await response.text());
  await until(async () => {
    const current = await state();
    return (
      current.idle &&
      current.messages.some((message) => message.text === "completed-C")
    );
  });
  const after = await state();
  assert.equal(after.backend.id, before.backend.id);
  const entries = (await readFile(after.stats.sessionFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const user = entries.find((entry) => entry.message?.role === "user").message;
  assert(
    user.content.some(
      (block) =>
        block.type === "text" && block.text.includes("Native context fixture"),
    ),
  );
  assert(
    user.content.some(
      (block) => block.type === "image" && block.mimeType === "image/png",
    ),
  );
  console.log(
    "Native TUI context passed: text + image delivered through public sendUserMessage and persisted in the same session.",
  );
} finally {
  if (child.exitCode === null) {
    child.stdin.write("\x03\x03");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  }
  await model.stop();
}
