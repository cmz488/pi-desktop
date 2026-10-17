import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { DeskError } from "../config/config-store.mjs";
const exec = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function directNetworkEnvironment(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !/^(?:http|https|all)_proxy$/i.test(name),
    ),
  );
}
const missingDaemon = (error) =>
  /failed to connect to local tailscaled|connection refused|no such file.*socket|doesn't appear to be running/i.test(
    error.stderr ?? "",
  );

// Reuse a system daemon if available. Otherwise own a rootless userspace
// daemon with its own socket/state; never change system routing or use sudo.
export function createTailscaleRuntime({
  directory = join(homedir(), ".pi", "agent", "desktop", "tailscale"),
  binary = process.env.PI_DESK_TAILSCALE || "tailscale",
  daemonBinary = process.env.PI_DESK_TAILSCALED || "tailscaled",
  env = process.env,
  retryDelay = 1500,
  preferSystem = true,
} = {}) {
  let child,
    exited,
    pending,
    closed = false,
    prefix = [],
    owned = !preferSystem,
    phase = "off",
    backendState = "",
    error = "",
    timer,
    retries = 0,
    loginChild,
    loginExited;
  const listeners = new Set();
  const childEnvironment = directNetworkEnvironment(env);
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const read = () => ({ phase, backendState, error, managed: owned });
  const status = (args = prefix, signal, timeout = 8000) =>
    exec(binary, [...args, "status", "--json"], {
      signal,
      timeout,
      maxBuffer: 1024 * 1024,
      env: childEnvironment,
    }).then((result) => JSON.parse(result.stdout));
  async function launch(signal) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    if (closed) throw new DeskError(409, "Tailscale 已关闭");
    signal?.throwIfAborted();
    prefix = [`--socket=${join(directory, "tailscaled.sock")}`];
    owned = true;
    phase = "starting";
    error = "";
    notify();
    child = spawn(
      daemonBinary,
      [
        "--tun=userspace-networking",
        `--statedir=${directory}`,
        `--state=${join(directory, "tailscaled.state")}`,
        `--socket=${join(directory, "tailscaled.sock")}`,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        env: childEnvironment,
      },
    );
    const current = child;
    let failed = false;
    exited = new Promise((resolve) => current.once("close", resolve));
    current.on("error", () => {
      failed = true;
      phase = "error";
      error = "无法启动 tailscaled，请确认电脑已安装 Tailscale。";
      notify();
    });
    current.stderr.on("data", () => {}); // Do not log daemon credentials or login URLs.
    current.once("close", () => {
      if (child !== current) return;
      child = undefined;
      if (closed) return;
      if (failed) {
        phase = "error";
        notify();
        return;
      }
      phase = "restarting";
      notify();
      if (retries++ < 3) {
        timer = setTimeout(() => {
          pending = launch()
            .catch((cause) => {
              phase = "error";
              error = cause.message;
              notify();
            })
            .finally(() => {
              pending = undefined;
            });
        }, retryDelay * retries);
        timer.unref();
      } else {
        phase = "error";
        error = "Tailscale 多次退出，请检查安装和网络后重新开启。";
        notify();
      }
    });
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (closed) throw new DeskError(409, "Tailscale 已关闭");
      if (failed || !child)
        throw new DeskError(503, error || "Tailscale 启动失败");
      try {
        const value = await status(prefix, signal, 2000);
        backendState = value.BackendState;
        phase = "running";
        notify();
        return value;
      } catch (cause) {
        if (signal?.aborted) throw signal.reason;
      }
      await pause(100);
    }
    throw new DeskError(504, "Tailscale 启动超时，请检查安装后重试。");
  }
  async function prepare(signal) {
    if (closed) throw new DeskError(409, "Tailscale 已关闭");
    if (pending) {
      await pending;
      if (phase === "error") throw new DeskError(503, error);
      return status(prefix, signal);
    }
    clearTimeout(timer);
    pending = (async () => {
      if (!owned) {
        try {
          const value = await status([], signal);
          prefix = [];
          backendState = value.BackendState;
          phase = "running";
          notify();
          return value;
        } catch (cause) {
          if (signal?.aborted) throw signal.reason;
          if (!missingDaemon(cause))
            throw new DeskError(
              503,
              cause.code === "ENOENT"
                ? "请先安装并登录 Tailscale。"
                : "无法访问系统 Tailscale，请检查权限。",
            );
        }
      }
      if (child) {
        const value = await status(prefix, signal);
        backendState = value.BackendState;
        phase = "running";
        notify();
        return value;
      }
      retries = 0;
      return launch(signal);
    })()
      .catch((cause) => {
        phase = "error";
        error = cause.message;
        notify();
        throw cause;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  async function connect(signal, onApproval) {
    const value = await prepare(signal);
    if (value.BackendState === "Running") return prefix;
    phase = "login";
    notify();
    await new Promise((resolve, reject) => {
      const login = spawn(
        binary,
        [...prefix, "up", "--json", "--timeout=120s"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: childEnvironment,
        },
      );
      loginChild = login;
      loginExited = new Promise((resolve) => login.once("close", resolve));
      let output = "",
        settled = false;
      const finish = (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        cause ? reject(cause) : resolve();
      };
      const abort = () => {
        login.kill("SIGTERM");
        finish(signal.reason);
      };
      const timeout = setTimeout(() => {
        login.kill("SIGTERM");
        finish(new DeskError(504, "请完成 Tailscale 登录后重试。"));
      }, 125000);
      timeout.unref();
      signal.addEventListener("abort", abort, { once: true });
      const receive = (chunk) => {
        output = (output + chunk.toString()).slice(-16000);
        for (const match of output.matchAll(/https:\/\/[^\s<>"']+/g)) {
          try {
            const url = new URL(match[0]);
            if (
              ["login.tailscale.com", "console.tailscale.com"].includes(
                url.hostname,
              )
            )
              onApproval?.(url.href);
          } catch {}
        }
      };
      login.stdout.on("data", receive);
      login.stderr.on("data", receive);
      login.once("error", () =>
        finish(new DeskError(503, "无法启动 Tailscale 登录。")),
      );
      login.once("close", (code) => {
        const cause =
          code === 0
            ? undefined
            : new DeskError(
                503,
                "Tailscale 登录未完成，请通过页面中的登录入口授权后重试。",
              );
        if (cause)
          cause.useManaged =
            !owned &&
            /access denied|permission denied|operator|requires root/i.test(
              output,
            );
        finish(cause);
      });
      if (signal.aborted) abort();
    }).catch(async (cause) => {
      if (cause.useManaged && !closed && !signal.aborted) {
        owned = true;
        await launch(signal);
        await connect(signal, onApproval);
        return;
      }
      throw cause;
    });
    const current = await status(prefix, signal);
    if (current.BackendState !== "Running")
      throw new DeskError(503, "Tailscale 尚未连接，请完成登录后重试。");
    backendState = "Running";
    phase = "running";
    notify();
    return prefix;
  }
  return {
    read,
    prepare,
    connect,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      if (loginChild) {
        const process = loginChild;
        process.kill("SIGTERM");
        const force = setTimeout(() => process.kill("SIGKILL"), 2000);
        force.unref();
        await loginExited;
        clearTimeout(force);
        loginChild = undefined;
      }
      const current = child;
      if (current) {
        current.kill("SIGTERM");
        const force = setTimeout(() => current.kill("SIGKILL"), 2000);
        force.unref();
        await exited;
        clearTimeout(force);
      }
      await pending?.catch(() => {});
      phase = "off";
      notify();
    },
  };
}
