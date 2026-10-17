import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { extname, resolve, join } from "node:path";
import { DeskError } from "../config/config-store.mjs";

export const MAX_LSP_FILE_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 8192;
const ANALYSIS_TIMEOUT_MS = 20_000;
const PUSH_QUIET_MS = 1500;
const TERMINATION_GRACE_MS = 500;
const MAX_DIAGNOSTICS = 200;
const MAX_CONCURRENT_ANALYSES = 2;
const languages = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".jsonc": "jsonc",
};
export const supportsLspFile = (path) =>
  Boolean(languages[extname(path).toLowerCase()]);

// Local, explicitly requested analysis only. Never expose executeCommand,
// workspace/applyEdit or a user-supplied executable/URL.
export function createLspDiagnostics({ spawnProcess = spawn } = {}) {
  const jobs = new Set();
  let stopped = false;
  async function analyze({ root, path, text }) {
    if (stopped) throw new DeskError(409, "LSP 宿主已关闭");
    const languageId = languages[extname(path).toLowerCase()];
    if (!languageId)
      throw new DeskError(422, "本轮仅支持 JS/TS 与 JSON 的 LSP 诊断");
    if (jobs.size >= MAX_CONCURRENT_ANALYSES)
      throw new DeskError(409, "已有 LSP 分析在运行，请完成后重试");
    const json = languageId.startsWith("json");
    const executable = json
      ? "vscode-json-language-server"
      : "typescript-language-server";
    let tsserverPath;
    if (!json) {
      for (const requireFrom of [
        createRequire(pathToFileURL(join(root, "package.json"))),
        createRequire(import.meta.url),
      ]) {
        try {
          tsserverPath = requireFrom.resolve("typescript/lib/tsserver.js");
          break;
        } catch (error) {
          if (error.code !== "MODULE_NOT_FOUND") throw error;
        }
      }
    }
    const child = spawnProcess(executable, ["--stdio"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    let termination;
    let buffer = Buffer.alloc(0),
      serial = 0,
      failed,
      quiet,
      deadline,
      diagnostics = [],
      observed = false;
    const pending = new Map();
    let rejectPush, resolvePush;
    const push = new Promise((resolve, reject) => {
      resolvePush = resolve;
      rejectPush = reject;
    });
    // Initialization/pull servers may never need the push path.
    push.catch(() => {});
    const uri = pathToFileURL(resolve(root, path)).href;
    const send = (value) => {
      if (failed) throw failed;
      const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...value }));
      child.stdin.write(
        Buffer.concat([
          Buffer.from(`Content-Length: ${data.length}\r\n\r\n`),
          data,
        ]),
      );
    };
    const fail = (error) => {
      if (failed) return;
      failed =
        error instanceof DeskError
          ? error
          : new DeskError(
              503,
              `LSP ${executable} 无法运行；请在终端检查已有安装（${error.code ?? "进程/协议错误"}）`,
            );
      for (const waiter of pending.values()) waiter.reject(failed);
      pending.clear();
      rejectPush(failed);
    };
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        try {
          send({ id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    const receive = (message) => {
      if (message.id !== undefined && message.method) {
        const result =
          message.method === "workspace/configuration"
            ? (message.params?.items ?? []).map(() => ({}))
            : message.method === "workspace/applyEdit"
              ? { applied: false, failureReason: "Git 审查是只读分析" }
              : null;
        // Decline all unrecognized server-to-client requests, including schema IO.
        send(
          [
            "workspace/configuration",
            "workspace/applyEdit",
            "client/registerCapability",
            "window/workDoneProgress/create",
          ].includes(message.method)
            ? { id: message.id, result }
            : {
                id: message.id,
                error: { code: -32601, message: "只读客户端不支持此请求" },
              },
        );
      } else if (message.id !== undefined) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error)
          waiter?.reject(
            new DeskError(
              503,
              `语言服务器未能完成诊断请求（${message.error.code}）：${String(
                message.error.message ?? "",
              )
                .replace(/(?:https?|ssh|git):\/\/[^\s]+/gi, "<remote>")
                .replace(/[\x00-\x1f\x7f]/g, " ")
                .slice(0, 1024)}`,
            ),
          );
        else waiter?.resolve(message.result);
      } else if (
        message.method === "textDocument/publishDiagnostics" &&
        message.params?.uri === uri
      ) {
        observed = true;
        diagnostics = Array.isArray(message.params.diagnostics)
          ? message.params.diagnostics
          : [];
        clearTimeout(quiet);
        quiet = setTimeout(() => resolvePush(diagnostics), PUSH_QUIET_MS);
      }
    };
    child.stdout.on("data", (data) => {
      try {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length > MAX_FRAME_BYTES + MAX_HEADER_BYTES)
          throw new DeskError(503, "LSP 响应超过读取额度");
        for (;;) {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) {
            if (buffer.length > MAX_HEADER_BYTES)
              throw new DeskError(503, "LSP 响应头无效");
            break;
          }
          const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(
            buffer.subarray(0, end).toString("ascii"),
          );
          const length = Number(match?.[1]);
          if (!match || length > MAX_FRAME_BYTES || end > MAX_HEADER_BYTES)
            throw new DeskError(503, "LSP 响应帧无效");
          if (buffer.length < end + 4 + length) break;
          const message = JSON.parse(
            buffer.subarray(end + 4, end + 4 + length).toString("utf8"),
          );
          buffer = buffer.subarray(end + 4 + length);
          receive(message);
        }
      } catch (error) {
        fail(error);
      }
    });
    // Drain logs without exposing repository text, environment or credentials.
    child.stderr.on("data", () => {});
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.on("exit", () =>
      fail(new DeskError(503, "语言服务器提前退出，诊断未完成")),
    );
    const signal = (kind) => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const terminate = () => {
      if (termination) return termination;
      fail(new DeskError(409, "LSP 分析已结束"));
      termination = (async () => {
        signal("SIGTERM");
        let timer;
        await Promise.race([
          closed,
          new Promise((resolve) => {
            timer = setTimeout(resolve, TERMINATION_GRACE_MS);
          }),
        ]);
        clearTimeout(timer);
        // Reap remaining Unix children as well, including tsserver.
        signal("SIGKILL");
      })();
      return termination;
    };
    jobs.add(terminate);
    deadline = setTimeout(() => {
      fail(new DeskError(504, "LSP 分析超时，不能视为检查通过"));
      void terminate().catch(() => {});
    }, ANALYSIS_TIMEOUT_MS);
    try {
      const init = await request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        workspaceFolders: [
          { uri: pathToFileURL(root).href, name: "Git review" },
        ],
        capabilities: {
          workspace: { configuration: true, applyEdit: false },
          textDocument: {
            diagnostic: {},
            publishDiagnostics: { versionSupport: true },
          },
        },
        initializationOptions: json
          ? { handledSchemaProtocols: [], provideFormatter: false }
          : {
              disableAutomaticTypingAcquisition: true,
              plugins: [],
              tsserver: tsserverPath ? { path: tsserverPath } : undefined,
            },
      });
      send({ method: "initialized", params: {} });
      if (json)
        send({
          method: "workspace/didChangeConfiguration",
          params: {
            settings: {
              http: { proxyStrictSSL: true },
              json: {
                validate: { enable: true },
                schemas: [],
                format: { enable: false },
              },
            },
          },
        });
      send({
        method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId, version: 1, text } },
      });
      const pull = Boolean(init?.capabilities?.diagnosticProvider);
      if (pull) {
        const result = await request("textDocument/diagnostic", {
          textDocument: { uri },
        });
        if (result?.kind !== "full" || !Array.isArray(result.items))
          throw new DeskError(503, "LSP 未返回完整诊断，不能视为检查通过");
        diagnostics = result.items;
        observed = true;
      } else diagnostics = await push;
      return {
        executable,
        languageId,
        method: pull ? "pull" : "push",
        observed,
        truncated: diagnostics.length > MAX_DIAGNOSTICS,
        diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS).map((item) => ({
          line:
            Number.isInteger(item.range?.start?.line) &&
            item.range.start.line >= 0
              ? item.range.start.line + 1
              : 1,
          column:
            Number.isInteger(item.range?.start?.character) &&
            item.range.start.character >= 0
              ? item.range.start.character + 1
              : 1,
          severity: [1, 2, 3, 4].includes(item.severity) ? item.severity : 3,
          message: String(item.message ?? "")
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
            .slice(0, 8192),
          code:
            typeof item.code === "string" || typeof item.code === "number"
              ? item.code
              : undefined,
          source:
            typeof item.source === "string"
              ? item.source.slice(0, 128)
              : undefined,
        })),
      };
    } finally {
      clearTimeout(deadline);
      clearTimeout(quiet);
      try {
        await terminate();
      } finally {
        jobs.delete(terminate);
      }
    }
  }
  return {
    analyze,
    async stop() {
      stopped = true;
      await Promise.all([...jobs].map((terminate) => terminate()));
      jobs.clear();
    },
  };
}
