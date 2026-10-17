import { fork } from "node:child_process";

// Electron uses its bundled Node runtime, matching DSH's RunAsNode Host boundary.
export function launchService(entry, options, { timeout = 45000 } = {}) {
  const child = fork(entry, [], {
    execArgv: [],
    cwd: options.cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stopping,
    exited = false;
  const exit = new Promise((resolve) =>
    child.once("close", () => {
      exited = true;
      resolve();
    }),
  );
  // Drain stderr without exposing plugin output or credentials in API responses.
  child.stderr.on("data", () => {});
  async function stop() {
    return (stopping ??= (async () => {
      if (exited) return;
      if (child.connected) child.send({ type: "stop" }, () => {});
      const timer = setTimeout(() => child.kill("SIGTERM"), 8000);
      const force = setTimeout(() => child.kill("SIGKILL"), 10000);
      await exit;
      clearTimeout(timer);
      clearTimeout(force);
    })());
  }
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error("Agent 启动超时")), timeout);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
      void stop();
    };
    child.once("error", fail);
    child.once("exit", (code) =>
      fail(new Error(`Agent 进程退出 (${code ?? "signal"})`)),
    );
    child.on("message", (message) => {
      if (message?.type === "ready") {
        clearTimeout(timer);
        resolve(message);
      }
      if (message?.type === "failed") fail(new Error(message.error));
    });
    child.send({ type: "start", options }, (error) => {
      if (error) fail(error);
    });
  });
  return { child, ready, stop };
}

export function serviceMain(start) {
  let app,
    starting = false,
    closing = false;
  async function stop() {
    if (closing) return;
    closing = true;
    try {
      await app?.stop();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  }
  process.on("message", async (message) => {
    if (message?.type === "stop") return stop();
    if (message?.type !== "start" || starting || closing) return;
    starting = true;
    try {
      app = await start(message.options);
      if (closing) {
        await app.stop();
        return;
      }
      process.send?.({
        type: "ready",
        url: app.url,
        nativeSession: app.nativeSession,
      });
    } catch (error) {
      process.send?.({ type: "failed", error: error.message }, () =>
        process.exit(1),
      );
    }
  });
  process.once("disconnect", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}
