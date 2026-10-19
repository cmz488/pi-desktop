import { createServer, request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { openDesktopStore } from "./store.mjs";
import { createSupervisor } from "./supervisor.mjs";
import { DeskError } from "../config/config-store.mjs";
import {
  createStaticAssetHandler,
  publicAssets,
} from "../server/web-assets.mjs";
import QRCode from "qrcode";
import { createDirectoryPicker } from "../desktop/directory-picker.mjs";
import { createRemoteAccess } from "../remote/remote-access.mjs";
import { createDesktopGlobal } from "../resources/desktop-global.mjs";
import { sendJson } from "../server/http-transfer.mjs";
import { workspaceIndex } from "../shared/lazy-data.mjs";

/**
 * Desktop Host HTTP：连接生命周期主管、公共资产、全局配置与原生任务聚合。
 *
 * 接口：startDesktopHost(options) 返回服务；调用者契约见
 *   docs/architecture/interfaces/lifecycle.md 与 host-tasks.md。
 * 不变量：Host 不运行模型或另存任务状态；远程路由继续按原有白名单裁剪；管理请求
 *   断连只释放观察，不隐式中止 worker 工作；静态资源只来自统一清单。
 * 错误：HTTP 保留 DeskError 的中文状态与语义，已断开的观察不再写响应。
 */
const assets = publicAssets("workspace");

const remoteWorkspaceCommands = new Set([
  "conversation.create",
  "agent.rename",
  "agent.pin",
  "agent.archive",
  "agent.restore",
  "agent.policy",
  "agent.prompt",
  "agent.resume",
  "agent.start",
  "agent.stop",
  "agent.restart",
]);

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new DeskError(413, "配置内容过大");
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error();
    return input;
  } catch {
    throw new DeskError(400, "请求不是有效 JSON 对象");
  }
}
// Host 管理只拥有连接观察；断连必须释放上游请求，不能把它解释为任务中止。
async function observeRequest(request, response, run) {
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  request.once("aborted", disconnect);
  response.once("close", disconnect);
  try {
    if (request.aborted || response.destroyed) disconnect();
    const result = await run(controller.signal);
    if (!response.destroyed) sendJson(response, 200, result);
  } catch (error) {
    if (!response.destroyed) throw error;
  } finally {
    request.off("aborted", disconnect);
    response.off("close", disconnect);
  }
}
const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);
function headers(source) {
  const blocked = new Set([
    ...hopHeaders,
    ...String(source.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((row) => row.trim()),
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !blocked.has(key)),
  );
}
// Stream the existing Pi UI and SSE without buffering transcripts or tool output.
function proxy(request, response, target, path, onAccepted) {
  const url = new URL(target);
  const incoming = new URL(`http://localhost${path}`);
  url.pathname = incoming.pathname;
  url.search = incoming.search;
  const forwarded = headers(request.headers);
  delete forwarded.cookie;
  forwarded.host = url.host;
  if (request.headers.origin) forwarded.origin = url.origin;
  delete forwarded.referer;
  const upstream = httpRequest(
    url,
    { method: request.method, headers: forwarded },
    (result) => {
      if (result.statusCode >= 200 && result.statusCode < 300)
        void onAccepted?.().catch(() => {});
      const outgoing = headers(result.headers);
      delete outgoing["set-cookie"];
      response.writeHead(result.statusCode, outgoing);
      result.pipe(response);
      result.on("error", () => response.destroy());
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent)
      sendJson(response, 502, { error: "Agent 连接中断，请重新启动" });
    else response.end();
  });
  response.once("close", () => upstream.destroy());
  request.pipe(upstream);
}

export async function startDesktopHost(options = {}) {
  if (options.host && !["127.0.0.1", "localhost"].includes(options.host))
    throw new DeskError(
      422,
      "多进程 Desktop MVP 仅监听本机；请通过设置中的 Tailscale 扫码访问",
    );
  if (options.certPath || options.keyPath)
    throw new DeskError(422, "TLS 请使用单宿主模式");
  const agentDir = resolve(
    options.agentDir ??
      process.env.PI_CODING_AGENT_DIR ??
      join(homedir(), ".pi", "agent"),
  );
  const directory = resolve(
    options.directory ?? join(agentDir, "desktop", "workspace"),
  );
  const store = await openDesktopStore(directory);
  const supervisor = createSupervisor(store, {
    ...options,
    agentDir,
    directory,
  });
  const serve = createStaticAssetHandler(assets);
  const directoryPicker = options.directoryPicker ?? createDirectoryPicker();
  let origin,
    stopped = false,
    stopping,
    sharedBusy = false,
    settingsReloadPending = false,
    settingsReloadTimer,
    settingsReloadDelay = 250;
  const remoteAccess = createRemoteAccess({
    targetUrl: () => origin + "/",
    funnel: options.remoteFunnel,
    directory: join(directory, "tailscale"),
  });
  const global = createDesktopGlobal({
    agentDir,
    directory,
    supervisor,
    packageManagerFactory: options.packageManagerFactory,
  });
  async function globalWrite(run) {
    if (sharedBusy) throw new DeskError(409, "全局配置正在更新，请稍后重试");
    sharedBusy = true;
    try {
      return await run();
    } finally {
      sharedBusy = false;
    }
  }
  function scheduleSettingsReload() {
    settingsReloadPending = true;
    if (settingsReloadTimer || stopped) return Promise.resolve();
    settingsReloadTimer = setTimeout(async () => {
      settingsReloadTimer = undefined;
      if (!settingsReloadPending || stopped) return;
      try {
        const failed = await supervisor.shared(({ reload }) => reload());
        if (failed.length) {
          settingsReloadDelay = Math.min(settingsReloadDelay * 2, 15000);
          scheduleSettingsReload();
        } else {
          settingsReloadPending = false;
          settingsReloadDelay = 250;
        }
      } catch (error) {
        if (error.status === 409) {
          settingsReloadDelay = Math.min(settingsReloadDelay * 2, 15000);
          scheduleSettingsReload();
        } else settingsReloadPending = false;
      }
    }, settingsReloadDelay);
    settingsReloadTimer.unref?.();
    return Promise.resolve();
  }
  async function remoteInfo(agentId) {
    const tunnel = remoteAccess.read();
    let url = tunnel.scanUrl ?? origin + "/";
    if (
      tunnel.scanUrl &&
      (await store.read()).agents.some((row) => row.id === agentId)
    ) {
      const selected = new URL(url);
      selected.searchParams.set("agent", agentId);
      url = selected.href;
    }
    return {
      tunnel,
      url,
      urls: [],
      port: server.address().port,
      lan: false,
      ...(tunnel.scanUrl
        ? {
            qr: await QRCode.toDataURL(url, {
              width: 280,
              margin: 4,
              errorCorrectionLevel: "M",
            }),
          }
        : {}),
    };
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, origin);
      const globalRoute =
        /^\/agents\/([a-f0-9-]{36})(\/api\/(?:remote|personality|packages\/update-all))$/.exec(
          url.pathname,
        );
      if (globalRoute) {
        await supervisor.openTarget(globalRoute[1]);
        url.pathname = globalRoute[2];
      }
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (
        `http://${request.headers.host}` !== origin ||
        (request.headers.origin && request.headers.origin !== origin) ||
        ["cross-site", "same-site"].includes(request.headers["sec-fetch-site"])
      )
        throw new DeskError(403, "跨站请求被拒绝");
      if (
        !["GET", "HEAD"].includes(request.method) &&
        (request.headers.origin !== origin ||
          !/^application\/json(?:;|$)/i.test(
            request.headers["content-type"] ?? "",
          ))
      )
        throw new DeskError(403, "写入需要同源 JSON 请求");
      if (sharedBusy && request.method === "POST")
        throw new DeskError(409, "全局配置正在更新，请稍后重试");
      if (
        url.pathname === "/api/workspace/directory" &&
        request.method === "POST"
      ) {
        await body(request);
        const cancel = () => {
          if (!response.writableEnded) directoryPicker.close?.();
        };
        response.once("close", cancel);
        try {
          sendJson(response, 200, { path: await directoryPicker.pick() });
        } finally {
          response.removeListener("close", cancel);
        }
        return;
      }
      if (url.pathname === "/api/remote") {
        if (request.method === "POST")
          await remoteAccess.execute((await body(request)).action);
        else if (request.method !== "GET")
          throw new DeskError(405, "请求方式不支持");
        sendJson(
          response,
          200,
          await remoteInfo(url.searchParams.get("agent")),
        );
        return;
      }
      if (url.pathname === "/api/personality") {
        if (request.method === "GET")
          sendJson(response, 200, await global.readPersonality());
        else if (request.method === "POST") {
          const input = await body(request);
          sendJson(
            response,
            200,
            await globalWrite(() => global.savePersonality(input)),
          );
        } else throw new DeskError(405, "请求方式不支持");
        return;
      }
      if (url.pathname === "/api/packages/update-all") {
        if (request.method === "GET")
          sendJson(response, 200, await global.updates());
        else if (request.method === "POST") {
          const input = await body(request);
          sendJson(
            response,
            200,
            await globalWrite(() => global.update(input)),
          );
        } else throw new DeskError(405, "请求方式不支持");
        return;
      }
      if (url.pathname === "/api/revision" && request.method === "GET") {
        sendJson(response, 200, {
          supported: true,
          ...(await supervisor.revision()),
        });
        return;
      }
      if (await serve(request, response, url.pathname)) return;
      if (
        url.pathname === "/api/host/tasks/command" &&
        request.method === "POST"
      ) {
        if (request.headers["x-pi-remote-client"] === "1")
          throw new DeskError(403, "远程连接不提供整个 Host 的任务管理");
        const input = await body(request);
        await observeRequest(request, response, (signal) =>
          supervisor.manageTask(input, { signal }),
        );
        return;
      }
      if (url.pathname === "/api/host/tasks" && request.method === "GET") {
        if (request.headers["x-pi-remote-client"] === "1")
          throw new DeskError(403, "远程连接不提供整个 Host 的任务监控");
        await observeRequest(request, response, (signal) =>
          supervisor.monitorTasks({ signal }),
        );
        return;
      }
      if (
        url.pathname === "/api/host/tasks/detail" &&
        request.method === "GET"
      ) {
        if (request.headers["x-pi-remote-client"] === "1")
          throw new DeskError(403, "远程连接不提供整个 Host 的任务详情");
        const input = { agentId: url.searchParams.get("agentId") };
        for (const key of ["generation", "conversationId", "taskId"]) {
          const value = url.searchParams.get(key);
          input[key] =
            value === null || value.trim() === "" ? undefined : Number(value);
        }
        await observeRequest(request, response, (signal) =>
          supervisor.taskDetail(input, { signal }),
        );
        return;
      }
      if (url.pathname === "/api/workspace" && request.method === "GET") {
        const catalog = await supervisor.read();
        sendJson(
          response,
          200,
          url.searchParams.get("view") === "index"
            ? workspaceIndex(catalog)
            : catalog,
        );
        return;
      }
      if (
        url.pathname === "/api/workspace/detail" &&
        request.method === "GET"
      ) {
        const catalog = await supervisor.read();
        const rows = {
          agent: catalog.agents,
          project: catalog.projects,
          prompt: catalog.promptProfiles,
        }[url.searchParams.get("kind")];
        const row = rows?.find((row) => row.id === url.searchParams.get("id"));
        if (!row) throw new DeskError(404, "配置不存在");
        sendJson(response, 200, row);
        return;
      }
      if (
        url.pathname === "/api/workspace/command" &&
        request.method === "POST"
      ) {
        const input = await body(request);
        if (
          request.headers["x-pi-remote-client"] === "1" &&
          !remoteWorkspaceCommands.has(input.command)
        )
          throw new DeskError(
            403,
            "远程连接仅管理会话，不修改项目、Agent 主机配置或共享设置",
          );
        // Remote callers may create a session in their selected project but
        // must not supply an arbitrary host cwd.
        if (
          request.headers["x-pi-remote-client"] === "1" &&
          input.command === "conversation.create"
        )
          delete input.cwd;
        const run = () => supervisor.execute(input.command, input);
        sendJson(
          response,
          200,
          input.command === "prompt.save"
            ? await globalWrite(run)
            : await run(),
        );
        return;
      }
      const route = /^\/agents\/([a-f0-9-]{36})(\/.*)$/.exec(url.pathname);
      if (route) {
        if (route[2].startsWith("//")) throw new DeskError(404, "接口不存在");
        const target = await supervisor.openTarget(route[1]);
        const settingsMutation =
          request.method === "POST" && route[2] === "/api/settings";
        const forward = () =>
          proxy(
            request,
            response,
            target,
            route[2] + url.search,
            request.method === "POST" && route[2] === "/api/prompt"
              ? () => supervisor.noteActivity(route[1])
              : request.method === "POST" && route[2] === "/api/command"
                ? () =>
                    supervisor.noteActivity(route[1], { metadataOnly: true })
                : settingsMutation
                  ? () => scheduleSettingsReload()
                  : undefined,
          );
        const sharedMutation =
          request.method === "POST" &&
          /^\/api\/(?:package|skill|mcp|mcp-action|plugin|plugin-resources|plugin-config|provider|provider-remove|default-model)$/.test(
            route[2],
          );
        if (sharedMutation)
          await globalWrite(() =>
            supervisor.shared(
              () =>
                new Promise((resolve) => {
                  response.once("finish", resolve);
                  response.once("close", resolve);
                  forward();
                }),
            ),
          );
        else if (settingsMutation)
          await globalWrite(
            () =>
              new Promise((resolve) => {
                response.once("finish", resolve);
                response.once("close", resolve);
                forward();
              }),
          );
        else forward();
        return;
      }
      throw new DeskError(404, "接口不存在");
    })().catch((error) => {
      if (!response.headersSent)
        sendJson(response, error.status ?? 500, {
          error: error.status
            ? error.message
            : "Desktop 操作失败，请检查本机配置",
        });
      else response.end();
    });
  });
  async function stop() {
    return (stopping ??= (async () => {
      stopped = true;
      clearTimeout(settingsReloadTimer);
      directoryPicker.close?.();
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await remoteAccess.close();
      await supervisor.close();
      await closed;
      await store.close();
    })());
  }
  try {
    if (options.cwd) {
      const catalog = await store.read();
      if (!catalog.projects.length) await store.project({ cwd: options.cwd });
    }
    const catalog = await store.read();
    if (
      options.defaultConversation !== false &&
      !catalog.agents.some((row) => row.projectId === null && !row.archived)
    ) {
      const created = await store.agent({ name: "新对话", projectId: null });
      await store.update({}, (data) => {
        data.agents.find((row) => row.id === created.id).desired = true;
      });
    }
    if (options.defaultConversation !== false) {
      const home = (await store.read()).agents.find(
        (row) => row.projectId === null && !row.archived,
      );
      if (home && !home.desired)
        await store.update({}, (data) => {
          data.agents.find((row) => row.id === home.id).desired = true;
        });
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(options.port ?? 0), "127.0.0.1", resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    // Return the workspace immediately; the dashboard shows restored workers booting.
    void supervisor.restore().catch(() => {});
    return {
      url: origin + "/",
      supervisor,
      stop,
      get stopped() {
        return stopped;
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
