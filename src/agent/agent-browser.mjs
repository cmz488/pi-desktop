import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import nativeBrowser from "pi-agent-browser-native/dist/extensions/agent-browser/index.js";
import { DeskError } from "../config/config-store.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(
  new URL(
    "../../node_modules/agent-browser/bin/agent-browser.js",
    import.meta.url,
  ),
);
const commands = new Set([
  "open",
  "snapshot",
  "get",
  "click",
  "fill",
  "type",
  "press",
  "key",
  "scroll",
  "back",
  "forward",
  "reload",
  "tab",
  "wait",
  "find",
  "is",
  "check",
  "uncheck",
  "select",
  "hover",
  "focus",
  "screenshot",
  "cookies",
  "errors",
  "console",
  "dialog",
  "eval",
  "upload",
  "download",
  "close",
]);
const readCommands = new Set([
  "open",
  "snapshot",
  "get",
  "is",
  "tab",
  "back",
  "forward",
  "reload",
  "scroll",
  "close",
]);
const transportFlag =
  /^--(?:session(?:-name)?|namespace|config|cdp|auto-connect|profile|provider|engine|executable-path|args|ignore-https-errors|ca-cert|no-ca-cert|headed|init-script|extension|proxy(?:-bypass)?|enable|all|allow-file-access|headers|user-agent|state|restore(?:-save|-check-url|-check-text|-check-fn)?|device|pin-tab|no-pin-tab|idle-timeout|webgpu|download-path|action-policy|confirm-actions|confirm-interactive)(?:=|$)/;
export function browserAddress(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new DeskError(422, "浏览器只支持不含凭据的 HTTP／HTTPS 地址");
  return url.href;
}
export function validateBrowserArgs(args, readOnly = false) {
  if (Array.isArray(args) && args[0] === "--session" && args[1] === "desktop")
    args = args.slice(2);
  if (
    !Array.isArray(args) ||
    !args.length ||
    args.length > 128 ||
    args.some(
      (v) =>
        typeof v !== "string" ||
        v.length > 16000 ||
        transportFlag.test(v) ||
        /^-p$/.test(v),
    ) ||
    !commands.has(args[0])
  )
    throw new DeskError(
      422,
      "请使用当前 Desktop 浏览器的网页操作，不能替换会话、连接、内核或证书设置。",
    );
  if (
    readOnly &&
    (!readCommands.has(args[0]) ||
      (args[0] === "tab" &&
        !["list", "new", "close"].includes(args[1]) &&
        !/^(?:t\d+|[A-Fa-f0-9]{32})$/.test(args[1] ?? "")))
  )
    throw new DeskError(
      403,
      "无项目浏览器仅允许打开、读取和浏览页面，请在项目会话中执行网页修改。",
    );
  if (args[0] === "open") browserAddress(args[1]);
  if (args[0] === "tab" && args[1] === "new" && args[2])
    browserAddress(args[2]);
  if (
    readOnly &&
    args[0] === "get" &&
    ![
      "url",
      "title",
      "text",
      "html",
      "value",
      "count",
      "attr",
      "box",
      "styles",
    ].includes(args[1])
  )
    throw new DeskError(403, "此浏览器读取不在无项目权限范围内。");
  return args;
}

// One Chromium session per Desktop worker. Native Pi tooling and human input
// address this exact upstream session; no CDP/socket credentials enter the UI.
export async function createAgentBrowser({
  directory,
  cwd = directory,
  readOnly = false,
  run = execute,
  executablePath = process.env.PI_DESK_CHROMIUM,
  onChange = () => {},
} = {}) {
  const sockets = await mkdtemp(join(tmpdir(), "piab-"));
  const config = join(sockets, "browser.json");
  const profile = join(directory, "browser-profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  if (!executablePath && process.platform === "linux") {
    for (const path of [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
    ]) {
      try {
        await access(path);
        executablePath = path;
        break;
      } catch {}
    }
  }
  await writeFile(
    config,
    JSON.stringify({
      engine: "chrome",
      ignoreHttpsErrors: false,
      profile,
      ...(executablePath ? { executablePath } : {}),
      args: "--disable-dev-shm-usage",
      idleTimeout: "0",
    }),
    { mode: 0o600 },
  );
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("AGENT_BROWSER_"),
      ),
    ),
    AGENT_BROWSER_CONFIG: config,
    AGENT_BROWSER_SOCKET_DIR: sockets,
    PI_AGENT_BROWSER_SOCKET_DIR: sockets,
    AGENT_BROWSER_SESSION: "desktop",
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
    AGENT_BROWSER_DEFAULT_TIMEOUT: "25000",
    // Encode enough pixels for a 2x sidebar viewport without cropping wide or
    // tall windows; the panel scales the frame back to its displayed size.
    AGENT_BROWSER_STREAM_QUALITY: "82",
    AGENT_BROWSER_STREAM_MAX_WIDTH: "3200",
    AGENT_BROWSER_STREAM_MAX_HEIGHT: "2400",
    PATH:
      dirname(
        fileURLToPath(
          new URL("../../node_modules/.bin/agent-browser", import.meta.url),
        ),
      ) +
      delimiter +
      process.env.PATH,
  };
  let started = false,
    closing = false,
    pending,
    stream,
    frame,
    revision = 0,
    state = { engine: "chromium", connected: false, tabs: [] },
    queue = Promise.resolve();
  const bound = new Map();
  const controller = new AbortController();
  function bindEnvironment() {
    for (const [key, value] of Object.entries(env)) {
      if (
        key !== "PATH" &&
        !key.startsWith("AGENT_BROWSER_") &&
        key !== "PI_AGENT_BROWSER_SOCKET_DIR"
      )
        continue;
      if (!bound.has(key)) bound.set(key, process.env[key]);
      process.env[key] = value;
    }
    // Clear launch overrides inherited by this worker; our fixed config owns them.
    for (const key of Object.keys(process.env))
      if (key.startsWith("AGENT_BROWSER_") && !(key in env)) {
        if (!bound.has(key)) bound.set(key, process.env[key]);
        delete process.env[key];
      }
  }
  const call = async (args, signal) => {
    if (closing && args[0] !== "close")
      throw new DeskError(409, "Agent 浏览器已关闭");
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    let result;
    try {
      result = JSON.parse(
        (
          await run(
            process.execPath,
            [cli, "--session", "desktop", "--json", ...args],
            {
              env,
              cwd,
              signal: args[0] === "close" ? undefined : combined,
              timeout: 30000,
              maxBuffer: 2 * 1024 * 1024,
            },
          )
        ).stdout,
      );
    } catch (error) {
      if (combined.aborted) throw combined.reason;
      try {
        result = JSON.parse(error.stdout);
      } catch {}
      if (typeof result?.success !== "boolean")
        throw new DeskError(
          503,
          "Chromium 操作失败，请检查 agent-browser 与 Chromium 安装后重试。",
        );
    }
    if (!result.success)
      throw new DeskError(
        503,
        /ERR_CERT|certificate|证书/i.test(String(result.error))
          ? "网站 TLS 证书校验失败，未绕过验证。"
          : "Chromium 未完成网页操作，请重试。",
      );
    return result.data;
  };
  function changed() {
    revision++;
    onChange();
  }
  async function sync() {
    if (!started || closing) return state;
    const data = await call(["tab", "list"]);
    const title = await call(["get", "title"])
      .then((value) => value.title)
      .catch(() => undefined);
    state = {
      engine: "chromium",
      connected: true,
      tabs: (data.tabs ?? []).map((tab) => ({
        id: String(tab.targetId ?? tab.index),
        title: tab.active && title ? title : (tab.title ?? "网页"),
        url: tab.url ?? "",
        active: !!tab.active,
        index: tab.index,
      })),
    };
    changed();
    return state;
  }
  async function connectStream() {
    const data = await call(["stream", "status"]);
    if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535)
      throw new DeskError(503, "Chromium 实时画面尚未就绪");
    stream?.close();
    const ws = new WebSocket(`ws://127.0.0.1:${data.port}/?maxFps=3`);
    stream = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new DeskError(504, "Chromium 画面连接超时"));
      }, 8000);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new DeskError(503, "Chromium 画面连接失败"));
        },
        { once: true },
      );
    });
    ws.addEventListener("message", (event) => {
      if (
        stream !== ws ||
        closing ||
        typeof event.data !== "string" ||
        event.data.length > 9 * 1024 * 1024
      )
        return;
      try {
        const value = JSON.parse(event.data);
        if (value.type === "frame" && typeof value.data === "string") {
          const bytes = Buffer.from(value.data, "base64");
          if (
            bytes.length > 6 * 1024 * 1024 ||
            bytes[0] !== 0xff ||
            bytes[1] !== 0xd8
          )
            return;
          frame = {
            bytes,
            id: ++revision,
            width: value.metadata.deviceWidth,
            height: value.metadata.deviceHeight,
          };
        } else if (value.type === "url") {
          void serial(sync).catch(() => {});
        }
      } catch {}
    });
    ws.addEventListener("close", () => {
      if (stream === ws && !closing) {
        stream = undefined;
        state.connected = false;
        changed();
      }
    });
  }
  async function ensure(signal) {
    if (closing) throw new DeskError(409, "Agent 浏览器已关闭");
    if (pending) return pending;
    if (started && stream?.readyState === WebSocket.OPEN) return;
    pending = (async () => {
      if (!started) {
        await call(["open", "about:blank"], signal);
        started = true;
      }
      await connectStream();
      await sync();
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  }
  function serial(run) {
    const task = queue.then(run);
    queue = task.catch(() => {});
    return task;
  }
  return {
    read: () => ({ ...state, revision }),
    frame: () => frame,
    factory(pi) {
      bindEnvironment();
      nativeBrowser(
        new Proxy(pi, {
          get(target, key) {
            if (key !== "registerTool") return Reflect.get(target, key);
            return (tool) => {
              if (tool.name !== "agent_browser") return;
              pi.registerTool({
                ...tool,
                description:
                  tool.description +
                  "\nThis tool controls the Chromium browser shown in this Desktop Agent's right sidebar. Do not select a different session or CDP connection.",
                annotations: {
                  ...tool.annotations,
                  readOnlyHint: readOnly,
                  destructiveHint: !readOnly,
                },
                async execute(id, params, signal, update, context) {
                  if (
                    Object.keys(params).some(
                      (key) =>
                        ![
                          "args",
                          "stdin",
                          "timeoutMs",
                          "outputPath",
                          "sessionMode",
                        ].includes(key),
                    )
                  )
                    throw new DeskError(
                      422,
                      "Desktop 浏览器使用 args 网页命令。",
                    );
                  if (readOnly && params.outputPath)
                    throw new DeskError(403, "无项目浏览器不能写入输出文件。");
                  const args = validateBrowserArgs(params.args, readOnly);
                  if (params.sessionMode && params.sessionMode !== "auto")
                    throw new DeskError(
                      422,
                      "Desktop 使用当前共享浏览器会话。",
                    );
                  return serial(async () => {
                    bindEnvironment();
                    await ensure(signal);
                    const result = await tool.execute(
                      id,
                      {
                        ...params,
                        args: ["--session", "desktop", ...args],
                      },
                      signal,
                      update,
                      context,
                    );
                    if (args[0] === "close") {
                      started = false;
                      stream?.close();
                      stream = undefined;
                      frame = undefined;
                      state = {
                        engine: "chromium",
                        connected: false,
                        tabs: [],
                      };
                      changed();
                    } else await sync();
                    return result;
                  });
                },
              });
            };
          },
        }),
      );
      pi.on("before_agent_start", (event) => {
        if (event.systemPromptOptions?.sections)
          event.systemPromptOptions.sections.agent_browser =
            "Use agent_browser to operate the Chromium page shared with this Desktop Agent's right sidebar. Call args: [open, URL], then [snapshot, -i] before using element refs; use get for page reads and click/fill/press for interactions. Only the direct agent_browser surface is available here. The browser connection, session, engine and TLS policy are owned by Desktop; keep sessionMode auto and do not set launch flags or attach other browsers." +
            (readOnly
              ? " This projectless session permits page navigation and reads only, and cannot submit forms or write files."
              : " Tool execution uses the existing Pi approval policy.");
      });
    },
    execute(input) {
      return serial(async () => {
        await ensure();
        if (
          ["navigate", "back", "forward", "reload", "input"].includes(
            input.action,
          ) &&
          input.id
        ) {
          const tab = state.tabs.find((tab) => tab.id === input.id);
          if (!tab) throw new DeskError(404, "浏览器标签页不存在");
          if (!tab.active) await call(["tab", input.id]);
        }
        let args;
        switch (input.action) {
          case "navigate":
            args = ["open", browserAddress(input.url)];
            break;
          case "new":
            args = [
              "tab",
              "new",
              browserAddress(input.url ?? "https://pi.dev/"),
            ];
            break;
          case "select":
          case "close-tab":
            if (!state.tabs.some((tab) => tab.id === input.id))
              throw new DeskError(404, "浏览器标签页不存在");
            args =
              input.action === "select"
                ? ["tab", input.id]
                : ["tab", "close", input.id];
            break;
          case "back":
          case "forward":
          case "reload":
            args = [input.action];
            break;
          case "resize":
            if (
              !Number.isInteger(input.width) ||
              !Number.isInteger(input.height) ||
              input.width < 320 ||
              input.width > 1600 ||
              input.height < 240 ||
              input.height > 1200
            )
              throw new DeskError(422, "浏览器视口尺寸无效");
            args = [
              "set",
              "viewport",
              String(input.width * 2),
              String(input.height * 2),
            ];
            break;
          case "input":
            if (
              stream?.readyState !== WebSocket.OPEN ||
              !Array.isArray(input.events) ||
              input.events.length > 128
            )
              throw new DeskError(422, "浏览器输入无效");
            for (const event of input.events) {
              if (
                !["input_mouse", "input_keyboard"].includes(event?.type) ||
                JSON.stringify(event).length > 16000
              )
                throw new DeskError(422, "浏览器输入无效");
              const allowed =
                event.type === "input_mouse"
                  ? [
                      "mousePressed",
                      "mouseReleased",
                      "mouseMoved",
                      "mouseWheel",
                    ]
                  : ["keyDown", "keyUp", "char"];
              if (!allowed.includes(event.eventType))
                throw new DeskError(422, "浏览器输入无效");
              if (
                event.type === "input_mouse" &&
                (!Number.isFinite(event.x) ||
                  !Number.isFinite(event.y) ||
                  event.x < 0 ||
                  event.y < 0 ||
                  event.x > 4096 ||
                  event.y > 4096)
              )
                throw new DeskError(422, "浏览器坐标无效");
            }
            for (const event of input.events) {
              // 0.38.1 emits null CDP fields when optional keyboard strings are
              // omitted. Keep those fields explicit until the upstream fix ships.
              const normalized =
                event.type === "input_keyboard"
                  ? {
                      key: "",
                      code: "",
                      text: "",
                      modifiers: 0,
                      windowsVirtualKeyCode: 0,
                      ...event,
                    }
                  : { clickCount: 1, ...event };
              stream.send(JSON.stringify(normalized));
            }
            return this.read();
          default:
            throw new DeskError(422, "浏览器操作不支持");
        }
        await call(args);
        return sync();
      });
    },
    async close() {
      if (closing) return;
      closing = true;
      controller.abort();
      stream?.close();
      await pending?.catch(() => {});
      await queue;
      if (started) await call(["close"]).catch(() => {});
      for (const [key, value] of bound) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(sockets, { recursive: true, force: true });
    },
  };
}
