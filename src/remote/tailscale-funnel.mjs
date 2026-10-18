import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { requestPublicHttps } from "./tailscale-network.mjs";
import {
  createTailscaleRuntime,
  directNetworkEnvironment,
} from "./tailscale-runtime.mjs";
import { DeskError } from "../config/config-store.mjs";

const exec = promisify(execFile);
const setupUrl = "https://tailscale.com/docs/features/tailscale-funnel";
const permissionError = (output) =>
  /access denied|permission denied|operator|requires root|sudo tailscale/i.test(
    output ?? "",
  );
const permissionMessage =
  "Tailscale 权限不足。请在电脑执行 sudo tailscale set --operator=$USER，允许当前用户管理连接，然后重试。";
function checkHealth(status) {
  // DERP warnings describe Tailscale's preferred relay, which can be briefly
  // unreachable while the daemon retries other regions. Funnel readiness is
  // decided by the strict HTTPS probe of the actual public gateway below.
  if (
    (status.Health ?? []).some((value) =>
      /intercepted connection|could not establish an encrypted connection|certificate.*(?:self.signed|expired|invalid|unknown)/i.test(
        value,
      ),
    )
  )
    throw new DeskError(
      503,
      "Tailscale 中继的 TLS／证书连接被网络拦截，公网隧道无法使用。请让电脑换到允许直接访问 Tailscale 的网络后重试。",
    );
}

// The foreground CLI owns an ephemeral Serve config. Never reset a user's
// existing configuration or leave a persistent --bg Funnel behind.
export function createTailscaleFunnel({
  binary = process.env.PI_DESK_TAILSCALE || "tailscale",
  startupTimeout = 120000,
  requestPublic = requestPublicHttps,
  healthInterval = 30000,
  verificationTimeout = 600000,
  verificationRetryDelay = 2000,
  directory,
  runtime = createTailscaleRuntime({ binary, directory }),
} = {}) {
  return {
    prepare: async (signal) => {
      const status = await runtime.prepare(signal);
      checkHealth(status);
      return status;
    },
    runtimeState: () => runtime.read(),
    onRuntimeChange: (listener) => runtime.subscribe(listener),
    close: () => runtime.close(),
    async verify(url, { signal, expected }) {
      let last;
      const deadline = Date.now() + verificationTimeout;
      // Funnel public DNS can take ten minutes to propagate. Keep the owned
      // tunnel alive while retrying network failures; invalid TLS and a wrong
      // gateway fail immediately, and no QR is published during this wait.
      do {
        signal.throwIfAborted();
        try {
          await new Promise((resolve, reject) => {
            const req = requestPublic(
              new URL("/_pi/health", url),
              { signal },
              (res) => {
                let size = 0,
                  body = "";
                res.on("error", reject);
                res.on("data", (chunk) => {
                  size += chunk.length;
                  if (size > 1024)
                    req.destroy(new Error("unexpected health response"));
                  else body += chunk.toString();
                });
                res.on("end", () => {
                  try {
                    if (
                      res.statusCode !== 200 ||
                      JSON.parse(body).instance !== expected
                    )
                      throw new Error("public gateway mismatch");
                    resolve();
                  } catch (error) {
                    reject(error);
                  }
                });
              },
            );
            const timer = setTimeout(
              () =>
                req.destroy(
                  Object.assign(new Error("public gateway timeout"), {
                    code: "ETIMEDOUT",
                  }),
                ),
              Math.max(1, Math.min(10000, deadline - Date.now())),
            );
            req.once("close", () => clearTimeout(timer));
            req.once("error", reject);
            req.end();
          });
          return;
        } catch (error) {
          last = error;
          signal.throwIfAborted();
          if (
            ![
              "ENOTFOUND",
              "EAI_AGAIN",
              "ECONNRESET",
              "ETIMEDOUT",
              "ECONNREFUSED",
            ].includes(error.code) ||
            Date.now() >= deadline
          )
            break;
          await delay(
            Math.min(verificationRetryDelay, deadline - Date.now()),
            undefined,
            { signal },
          );
        }
      } while (Date.now() < deadline);
      throw new DeskError(
        503,
        `公网扫码入口验证失败（${last?.code ?? "连接失败"}）。请检查电脑 DNS 解析及到 Tailscale Funnel 的直连网络；暂不显示二维码。`,
      );
    },
    async start({ target, signal, onApproval, onExit }) {
      let status, config;
      const prefix = await runtime.connect(signal, onApproval);
      try {
        status = JSON.parse(
          (
            await exec(binary, [...prefix, "status", "--json"], {
              signal,
              timeout: 8000,
              maxBuffer: 1024 * 1024,
              env: directNetworkEnvironment(),
            })
          ).stdout,
        );
        config = JSON.parse(
          (
            await exec(binary, [...prefix, "serve", "status", "--json"], {
              signal,
              timeout: 8000,
              maxBuffer: 1024 * 1024,
              env: directNetworkEnvironment(),
            })
          ).stdout || "{}",
        );
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new DeskError(
          503,
          error.code === "ENOENT"
            ? "请先在电脑安装并登录 Tailscale，再开启远程连接。"
            : permissionError(error.stderr)
              ? permissionMessage
              : "无法连接 Tailscale。请先在电脑启动 tailscaled 并登录，再重试。",
        );
      }
      if (status.BackendState !== "Running")
        throw new DeskError(
          503,
          "请先在电脑登录 Tailscale，并保持连接，再重试。",
        );
      checkHealth(status);
      const name = status.Self?.DNSName?.replace(/\.$/, "");
      if (!/^[a-z0-9.-]+\.ts\.net$/i.test(name ?? ""))
        throw new DeskError(503, "请在 Tailscale 中开启 MagicDNS 和 HTTPS。");
      const occupied = new Set();
      function collect(value) {
        for (const port of Object.keys(value?.TCP ?? {}))
          occupied.add(Number(port));
        for (const child of Object.values(value?.Foreground ?? {}))
          collect(child);
      }
      collect(config);
      const port = [8443, 10000, 443].find((value) => !occupied.has(value));
      if (!port)
        throw new DeskError(
          409,
          "Tailscale 的 Funnel 端口均已被使用，请先释放一个端口。",
        );
      signal.throwIfAborted();
      const child = spawn(
        binary,
        [...prefix, "funnel", "--yes", `--https=${port}`, target],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: directNetworkEnvironment(),
        },
      );
      let stopped = false,
        output = "",
        ready = false;
      let monitor,
        checking = false;
      const exited = new Promise((resolve) => child.once("close", resolve));
      const close = async () => {
        if (stopped) return exited;
        stopped = true;
        clearInterval(monitor);
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 2000);
        force.unref();
        await exited;
        clearTimeout(force);
      };
      const abort = () => {
        void close();
      };
      signal.addEventListener("abort", abort, { once: true });
      const expected = new URL(
        `https://${name}${port === 443 ? "" : `:${port}`}/`,
      );
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new DeskError(
                  504,
                  "Tailscale 尚未完成连接。请完成 HTTPS／Funnel 授权后重试。",
                ),
              ),
            startupTimeout,
          );
          const finish = (error) => {
            clearTimeout(timer);
            error ? reject(error) : resolve();
          };
          child.once("error", () =>
            finish(new DeskError(503, "无法启动 Tailscale Funnel。")),
          );
          child.once("close", () => {
            clearInterval(monitor);
            signal.removeEventListener("abort", abort);
            if (!ready)
              finish(
                signal.aborted
                  ? signal.reason
                  : new DeskError(
                      503,
                      permissionError(output)
                        ? permissionMessage
                        : "Tailscale Funnel 启动失败，请检查登录、HTTPS 和 Funnel 权限。",
                    ),
              );
            else if (!stopped) onExit?.();
          });
          const receive = (chunk) => {
            output = (output + chunk.toString()).slice(-16384);
            for (const match of output.matchAll(/https:\/\/[^\s<>"']+/g)) {
              let url;
              try {
                url = new URL(match[0]);
              } catch {
                continue;
              }
              if (
                ["login.tailscale.com", "console.tailscale.com"].includes(
                  url.hostname,
                )
              )
                onApproval?.(url.href);
              if (
                url.origin === expected.origin &&
                url.pathname === "/" &&
                /Available on the internet:/i.test(output) &&
                !ready
              ) {
                ready = true;
                finish();
              }
            }
          };
          child.stdout.on("data", receive);
          child.stderr.on("data", receive);
          if (signal.aborted) {
            abort();
            finish(signal.reason);
          }
        });
        signal.throwIfAborted();
        monitor = setInterval(async () => {
          if (checking || stopped || signal.aborted) return;
          checking = true;
          try {
            const current = JSON.parse(
              (
                await exec(binary, [...prefix, "status", "--json"], {
                  signal,
                  timeout: 8000,
                  maxBuffer: 1024 * 1024,
                  env: directNetworkEnvironment(),
                })
              ).stdout,
            );
            checkHealth(current);
            if (current.BackendState !== "Running")
              throw new DeskError(503, "Tailscale 已断开，请完成连接后重试。");
          } catch (error) {
            if (!signal.aborted && !stopped) {
              onExit?.(error);
              await close();
            }
          } finally {
            checking = false;
          }
        }, healthInterval);
        monitor.unref();
        return { url: expected.href, close };
      } catch (error) {
        await close();
        throw error;
      }
    },
    setupUrl,
  };
}
