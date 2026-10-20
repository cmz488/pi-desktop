import { fork } from "node:child_process";

/**
 * Agent worker 的父子进程协议与停止语义。
 *
 * 接口：`launchService(entry, options, { timeout })` 在父进程侧启动 worker，返回
 *   `{ child, ready, stop }`；`serviceMain(start)` 在子进程侧接收 start，成功后回
 *   `ready`、失败回 `failed`。字段与错误表见 docs/architecture/interfaces/agent-runtime.md。
 * 不变量：协议消息只有 start／stop／ready／failed；`stop()` 幂等且升级式
 *   （IPC → 8 s SIGTERM → 10 s SIGKILL）；项目目录只在 worker 内切换，避免网络挂载
 *   的 chdir 阻塞 Host 的 fork；子进程 stderr 被丢弃，不进入 API 响应。
 * 错误：启动超时（默认 45 s）或进程提前退出都让 `ready` 拒绝并触发 stop；子进程
 *   启动抛错时先发 `failed`，再以退出码 1 结束。
 */

// Electron 使用自带的 Node 运行时，与 DSH 的 RunAsNode Host 边界一致。
export function launchService(entry, options, { timeout = 45000 } = {}) {
  const child = fork(entry, [], {
    execArgv: [],
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
  // 丢弃 stderr：插件输出与凭据不得进入 API 响应。
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
      // fork 的 cwd 会在 exec 前切换；失联 SSHFS 上的 chdir 甚至会同步卡住父进程。
      // 先建立独立 worker 和 IPC，再访问项目目录，让 Host 仍能服务页面和启动超时。
      if (message.options?.cwd !== undefined)
        process.chdir(message.options.cwd);
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
