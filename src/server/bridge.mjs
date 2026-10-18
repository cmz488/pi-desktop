import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { randomUUID, createHash } from "node:crypto";
import {
  createLspDiagnostics,
  supportsLspFile,
  MAX_LSP_FILE_BYTES,
} from "../workspace/lsp-diagnostics.mjs";
import { readFile } from "node:fs/promises";
import { readWorkspaceFile } from "../workspace/workspace-files.mjs";
import { join } from "node:path";
import { publicAssets, createStaticAssetHandler } from "./web-assets.mjs";
import { sendJson as json, openEventStream } from "./http-transfer.mjs";
import { chatSnapshot } from "../shared/lazy-data.mjs";
import QRCode from "qrcode";
import { lanAddresses } from "../remote/lan.mjs";
import { createRemoteAccess } from "../remote/remote-access.mjs";
import {
  DeskError,
  readDocument,
  mutateDocument,
  patchProvider,
} from "../config/config-store.mjs";
import {
  settingsGroups,
  settingsProjection,
  patchSettings,
} from "../resources/pi-settings.mjs";
import {
  discoverPluginConfig,
  pluginConfigDocument,
  savePluginConfig,
} from "../resources/plugin-config.mjs";

import {
  mcpProjection,
  patchMcp,
  validMcpName,
} from "../resources/mcp-config.mjs";
import {
  prepareAttachments,
  referenceFiles,
  ATTACHMENT_BODY_LIMIT,
} from "./context-attachments.mjs";
import { getGitRepository, isGitBusy } from "../git/git-manager.mjs";
import { createPackageCatalog } from "../resources/package-catalog.mjs";
import { createPackageManagement } from "../resources/package-management.mjs";
import { createDirectoryPicker } from "../desktop/directory-picker.mjs";
import { createHostInterface } from "./host-interface.mjs";
const BODY_LIMIT = 96 * 1024;
const EVENT_LIMIT = 2000;
const REPLAY_BYTE_LIMIT = 8 * 1024 * 1024;
const loopback = (address) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(address);
const assets = publicAssets("chat");

async function body(request, limit = BODY_LIMIT) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new DeskError(413, "请求内容过大");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new DeskError(400, "请求不是有效 JSON 对象");
  }
}

export function createDeskBridge(input) {
  const host = createHostInterface(input);
  const { transport, state, sessions, resources, models, prompt, hooks } = host;
  const filePicker = transport.filePicker ?? createDirectoryPicker();
  const serveAsset = createStaticAssetHandler(assets, {
    transform: (body, type) =>
      type === "text/html"
        ? Buffer.from(
            body
              .toString("utf8")
              .replace(
                'name="pi-desk-mode" content="demo"',
                'name="pi-desk-mode" content="live"',
              ),
          )
        : body,
  });
  let server, listenUrl;
  const remoteAccess = createRemoteAccess({
    targetUrl: () => listenUrl,
    funnel: transport.funnel,
    directory: transport.agentDir
      ? join(transport.agentDir, "desktop", "tailscale")
      : undefined,
    onChange: () => publish("remote_changed", {}),
  });
  let analysis = createLspDiagnostics();
  let catalog = createPackageCatalog({ fetchPage: transport.catalogFetch });
  const localAddresses = () => transport.lanAddresses?.() ?? lanAddresses();
  const epoch = randomUUID();
  let historyBytes = 0;
  let seq = 0,
    pending = false;
  const history = [],
    clients = new Set(),
    changedPlugins = new Set();
  const listenHost = transport.host ?? process.env.PI_DESK_HOST ?? "0.0.0.0";
  const port = Number(transport.port ?? process.env.PI_DESK_PORT ?? 4318);
  const certPath = transport.certPath ?? process.env.PI_DESK_TLS_CERT;
  const keyPath = transport.keyPath ?? process.env.PI_DESK_TLS_KEY;
  const secure = Boolean(certPath && keyPath);
  const settingsPath = join(transport.agentDir, "settings.json");
  const modelsPath =
    transport.modelsPath ?? join(transport.agentDir, "models.json");
  function scopedSettings(scope) {
    if (!["global", "project"].includes(scope))
      throw new DeskError(422, "配置范围无效");
    if (scope === "project") {
      const cwd = host.snapshot().cwd;
      if (!cwd) throw new DeskError(422, "工作区尚未就绪");
      return join(cwd, ".pi", "settings.json");
    }
    return settingsPath;
  }
  async function settings(scope) {
    const document = await readDocument(scopedSettings(scope));
    const global = await readDocument(settingsPath);
    return {
      scope,
      file: scopedSettings(scope),
      revision: document.revision,
      groups: settingsGroups,
      values: settingsProjection(document.data),
      inherited: settingsProjection(global.data),
      effective: host.capabilities.settings
        ? settingsProjection(state.effectiveSettings())
        : null,
      trusted: host.capabilities.projectTrusted ? trustedNow() : true,
      pending,
    };
  }
  function mcpPath(scope) {
    return scopedSettings(scope).replace(/settings\.json$/, "mcp.json");
  }
  async function skills() {
    const rows = host.capabilities.skills ? await resources.skills() : [];
    const documents = new Map();
    for (const scope of ["global", "project"])
      documents.set(scope, await readDocument(scopedSettings(scope)));
    return {
      pending,
      supported: host.capabilities.skills,
      rows: rows.map((row) => ({
        ...row,
        revision: documents.get(row.scope).revision,
      })),
    };
  }
  async function mcpInventory() {
    const rows = [],
      revisions = {},
      configured = new Set();
    const project = await readDocument(mcpPath("project"));
    const trusted = host.capabilities.projectTrusted ? trustedNow() : true;
    for (const scope of ["global", "project"]) {
      const document =
        scope === "project" ? project : await readDocument(mcpPath("global"));
      revisions[scope] = document.revision;
      for (const [name, config] of Object.entries(
        document.data.mcpServers ?? {},
      )) {
        if (!config || typeof config !== "object") continue;
        configured.add(name);
        rows.push({
          name,
          scope,
          revision: document.revision,
          config: mcpProjection(config),
          enabled: config.enabled !== false,
          overridden:
            scope === "global" &&
            trusted &&
            Object.hasOwn(project.data.mcpServers ?? {}, name),
          trusted: scope !== "project" || trusted,
        });
      }
    }
    for (const server of host.capabilities.mcp
      ? (resources.mcpRegistered() ?? [])
      : []) {
      if (!configured.has(server.name))
        rows.push({
          name: server.name,
          scope: "extension",
          config: mcpProjection(server.config),
          enabled: server.config.enabled !== false,
          trusted: true,
        });
    }
    const tools = host.capabilities.mcp ? (resources.mcpTools() ?? []) : [];
    return {
      pending,
      revisions,
      rows: rows.map((row) => ({
        ...row,
        tools: tools.filter((tool) =>
          tool.name.startsWith(`mcp__${row.name.replaceAll("-", "_")}__`),
        ),
      })),
      supported: host.capabilities.mcp,
    };
  }
  // Keep the original npm-only endpoint for already-open older frontends.
  // New clients use /api/package-catalog and never label this as pi.dev data.
  async function marketplace(query) {
    const url = new URL("https://registry.npmjs.org/-/v1/search");
    url.searchParams.set("text", `keywords:pi-package ${query.slice(0, 120)}`);
    url.searchParams.set("size", "36");
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    } catch {
      throw new DeskError(502, "无法连接 npm 插件市场，请稍后重试");
    }
    if (!response.ok) throw new DeskError(502, "插件市场暂时不可用");
    const result = await response.json();
    return {
      source: "npm · pi-package",
      rows: (result.objects ?? [])
        .filter((item) => item.package.keywords?.includes("pi-package"))
        .map(({ package: item }) => ({
          name: item.name,
          version: item.version,
          description: item.description ?? "",
          source: `npm:${item.name}@${item.version}`,
          url:
            item.links?.npm ??
            `https://www.npmjs.com/package/${encodeURIComponent(item.name)}`,
        })),
    };
  }
  function publish(kind, data) {
    const event = { seq: ++seq, epoch, kind, data };
    const wire = JSON.stringify(event),
      bytes = Buffer.byteLength(wire);
    history.push({ seq: event.seq, wire, bytes });
    historyBytes += bytes;
    while (
      history.length > 1 &&
      (history.length > EVENT_LIMIT || historyBytes > REPLAY_BYTE_LIMIT)
    )
      historyBytes -= history.shift().bytes;
    for (const response of clients) {
      if (response.writableLength > 1024 * 1024) {
        response.end();
        clients.delete(response);
        continue;
      }
      response.write(`id: ${seq}\ndata: ${wire}\n\n`);
    }
  }
  const canWriteNow = () =>
    host.capabilities.canWrite ? state.canWrite() : false;
  const canEditNow = () =>
    host.capabilities.canEditShared ? state.canEditShared() : canWriteNow();
  const trustedNow = () =>
    host.capabilities.projectTrusted ? state.projectTrusted() : false;
  const editable = () => {
    if (!canEditNow())
      throw new DeskError(409, "有会话运行中，请在任务完成后修改共享配置");
  };
  const packageManagement = createPackageManagement({
    agentDir: transport.agentDir,
    snapshot: host.snapshot,
    capabilities: {
      packageUpdates: host.capabilities.packageUpdates,
      packageAction: host.capabilities.packageManagement,
      packageRoot: host.capabilities.packageRoot,
      projectTrusted: host.capabilities.projectTrusted,
    },
    writable: canEditNow,
    trusted: trustedNow,
    packageRoot: host.capabilities.packageRoot
      ? resources.packageRoot
      : undefined,
    packageUpdates: host.capabilities.packageUpdates
      ? resources.packageUpdates
      : undefined,
    packageAction: host.capabilities.packageManagement
      ? resources.packageAction
      : undefined,
    hasChanged: (id) => changedPlugins.has(id),
    pending: () => pending,
    onWrite: () => {
      pending = true;
    },
  });
  const plugins = () => packageManagement.read();
  async function pluginAdapter(id) {
    const row = (await plugins()).rows.find((item) => item.id === id);
    const adapter =
      row &&
      (await discoverPluginConfig(
        row,
        transport.agentDir,
        host.capabilities.packageRoot
          ? resources.packageRoot(row.source, row.scope)
          : undefined,
      ));
    if (!adapter) throw new DeskError(422, "插件未声明 Web 配置表单");
    return { row, adapter };
  }
  async function providers() {
    if (host.capabilities.providerInventory) return models.inventory();
    const document = await readDocument(modelsPath);
    const state = host.snapshot();
    const catalog = host.capabilities.providerCatalog ? models.catalog() : [];
    const ids = new Set([
      ...Object.keys(document.data.providers ?? {}),
      ...catalog.map((row) => row.id),
      ...state.models.map((model) => model.provider),
    ]);
    const rows = [...ids]
      .filter((id) => {
        const native = catalog.find((row) => row.id === id);
        return (
          Object.hasOwn(document.data.providers ?? {}, id) ||
          (native
            ? [
                "stored",
                "runtime",
                "models_json_key",
                "models_json_command",
              ].includes(native.authSource)
            : state.models.some((model) => model.provider === id))
        );
      })
      .map((id) => {
        const config = document.data.providers?.[id] ?? {},
          native = catalog.find((row) => row.id === id);
        let baseUrl = "";
        try {
          const url = new URL(config.baseUrl ?? native?.baseUrl);
          if (!url.username && !url.password && !url.search && !url.hash)
            baseUrl = url.href;
        } catch {}
        return {
          id,
          name: native?.name ?? id,
          baseUrl,
          api:
            config.api ??
            native?.models?.[0]?.api ??
            state.models.find((model) => model.provider === id)?.api ??
            "openai-completions",
          keyConfigured:
            Boolean(config.apiKey) ||
            Boolean(native?.configured) ||
            state.models.some((model) => model.provider === id),
          editable: true,
          custom: Boolean(document.data.providers?.[id]),
          auth: { apiKey: !!native?.apiKey, oauth: !!native?.oauth },
          models: (native?.models?.length
            ? native.models
            : (config.models ??
              state.models.filter((model) => model.provider === id))
          ).map((model) => ({
            id: model.id,
            name: model.name ?? model.id,
            available: state.models.some(
              (item) => item.provider === id && item.id === model.id,
            ),
          })),
        };
      });
    return {
      revision: document.revision,
      rows,
      catalog: catalog.map((row) => ({
        id: row.id,
        name: row.name,
        auth: { apiKey: !!row.apiKey, oauth: !!row.oauth },
      })),
    };
  }
  async function route(request, response) {
    const url = new URL(request.url, "http://localhost");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; ${transport.embeddedUI ? "frame-src 'self' http: https:;" : ""} frame-ancestors ${transport.embeddedUI ? "'self'" : "'none'"}; base-uri 'none'; form-action 'self'`,
    );
    if (await serveAsset(request, response, url.pathname)) return;
    if (host.capabilities.route && (await hooks.route(request, response, url)))
      return;
    if (url.pathname === "/api/files" && request.method === "GET") {
      const snapshot = host.snapshot();
      if (snapshot.capabilities?.readOnly && !snapshot.capabilities?.files)
        throw new DeskError(403, "无项目会话请通过文件选择器打开预览");
      json(
        response,
        200,
        await readWorkspaceFile(
          snapshot.cwd,
          url.searchParams.get("path") ?? "",
        ),
      );
      return;
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      const settings = (await readDocument(settingsPath)).data;
      const snapshot = host.snapshot();
      const limit = Number(url.searchParams.get("historyLimit") ?? 50);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
        throw new DeskError(422, "消息分页大小无效");
      const visible =
        url.searchParams.get("view") === "chat"
          ? chatSnapshot(snapshot, limit, (row) =>
              createHash("sha256")
                .update(JSON.stringify(row))
                .digest("base64url"),
            )
          : snapshot;
      json(response, 200, {
        ...visible,
        capabilities: {
          ...(visible.capabilities ?? {}),
          remote: request.headers["x-pi-remote-client"] === "1",
          sessions:
            visible.capabilities?.sessions ?? host.capabilities.sessions,
          reload: visible.capabilities?.reload ?? host.capabilities.reload,
          auth: visible.capabilities?.auth ?? host.capabilities.auth,
          skills: visible.capabilities?.skills ?? host.capabilities.skills,
          mcp: visible.capabilities?.mcp ?? host.capabilities.mcp,
          interactions:
            visible.capabilities?.interactions ??
            host.capabilities.interactions,
          ...(visible.capabilities?.attachments
            ? {
                attachments: {
                  ...visible.capabilities.attachments,
                  defaultMode: localManagement(request)
                    ? "reference"
                    : "upload",
                },
              }
            : {}),
          btw: Boolean(
            host.capabilities.btw &&
              visible.commands?.some(
                (command) =>
                  command.name === "btw" && command.source === "extension",
              ),
          ),
        },
        gitManagement: true,
        gitAnalysis: true,
        gitReview: true,
        gitExtended: true,
        gitGraph: true,
        marketplaceOfficial: true,
        packageManagement: host.capabilities.packageManagement,
        packageUpdates: host.capabilities.packageUpdates,
        // A native context may be absent during /new or /reload handoff.
        // Capabilities gate the accessors; lifecycle readiness stays here.
        gitWritable: Boolean(
          host.capabilities.projectTrusted &&
            canEditNow() &&
            trustedNow() &&
            !isGitBusy(snapshot.cwd),
        ),
        defaults: {
          provider: settings.defaultProvider,
          id: settings.defaultModel,
        },
        epoch,
        seq,
        secure,
        pending,
        connection: connectionInfo(),
      });
      return;
    }
    if (url.pathname === "/api/message-detail" && request.method === "GET") {
      const row = host
        .snapshot()
        .messages?.find(
          (row) => String(row.id) === url.searchParams.get("messageId"),
        );
      if (!row) throw new DeskError(404, "消息不存在，请刷新会话");
      json(response, 200, row);
      return;
    }
    if (url.pathname === "/api/commands" && request.method === "GET") {
      json(response, 200, { rows: host.snapshot().commands ?? [] });
      return;
    }
    if (url.pathname === "/api/remote" && !host.capabilities.remote)
      throw new DeskError(404, "当前 Desktop 宿主未启用远程连接");
    if (url.pathname === "/api/remote" && request.method === "GET") {
      json(
        response,
        200,
        await connectionDetails(
          url.searchParams.get("address"),
          localManagement(request),
        ),
      );
      return;
    }
    if (url.pathname === "/api/remote" && request.method === "POST") {
      if (!localManagement(request))
        throw new DeskError(403, "请在电脑管理远程连接");
      const origin = `${secure ? "https" : "http"}://${request.headers.host}`;
      if (
        request.headers.origin !== origin ||
        !/^application\/json(?:;|$)/i.test(
          request.headers["content-type"] ?? "",
        )
      )
        throw new DeskError(403, "远程管理需要本机同源 JSON 请求");
      const input = await body(request);
      await remoteAccess.execute(input.action);
      json(response, 200, await connectionDetails(undefined, true));
      return;
    }
    if (url.pathname === "/api/events" && request.method === "GET") {
      const after = Number(
        request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0,
      );
      if (!Number.isSafeInteger(after) || after < 0)
        throw new DeskError(400, "事件序号无效");
      const stream = openEventStream(request, response);
      if (!stream) return;
      stream.write(": connected\n\n");
      request.socket.setTimeout(0);
      request.socket.setNoDelay(true);
      clients.add(stream);
      if (
        url.searchParams.get("epoch") !== epoch ||
        after > seq ||
        (history.length && after < history[0].seq - 1)
      )
        stream.write(
          `data: ${JSON.stringify({ kind: "resync_required", epoch, seq })}\n\n`,
        );
      else
        for (const event of history)
          if (event.seq > after)
            stream.write(`id: ${event.seq}\ndata: ${event.wire}\n\n`);
      const heartbeat = setInterval(() => {
        stream.write(": heartbeat\n\n");
      }, 10000);
      response.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(stream);
      });
      return;
    }
    if (url.pathname === "/api/settings" && request.method === "GET") {
      json(
        response,
        200,
        await settings(url.searchParams.get("scope") ?? "global"),
      );
      return;
    }
    if (url.pathname === "/api/marketplace" && request.method === "GET") {
      json(response, 200, await marketplace(url.searchParams.get("q") ?? ""));
      return;
    }
    if (url.pathname === "/api/package-catalog" && request.method === "GET") {
      const refresh = url.searchParams.get("refresh") ?? "0";
      if (!["0", "1"].includes(refresh))
        throw new DeskError(422, "目录刷新参数无效");
      json(
        response,
        200,
        await catalog.list({
          q: url.searchParams.get("q") ?? "",
          type: url.searchParams.get("type") ?? "",
          sort: url.searchParams.get("sort") ?? "downloads",
          page: Number(url.searchParams.get("page") ?? "1"),
          refresh: refresh === "1",
        }),
      );
      return;
    }
    if (url.pathname === "/api/package-details" && request.method === "GET") {
      json(response, 200, await catalog.details(url.searchParams.get("name")));
      return;
    }
    if (url.pathname === "/api/sessions" && request.method === "GET") {
      json(response, 200, {
        rows: host.capabilities.sessions ? await sessions.list() : [],
        supported: host.capabilities.sessions,
      });
      return;
    }
    if (url.pathname === "/api/revision" && request.method === "GET") {
      /* A polling client asks this first; a host that cannot answer cheaply
       * reports unsupported and the client keeps its previous behaviour. */
      const value = host.capabilities.revision
        ? await state.revision()
        : undefined;
      json(
        response,
        200,
        value ? { supported: true, ...value, seq } : { supported: false, seq },
      );
      return;
    }
    if (url.pathname === "/api/interactions" && request.method === "GET") {
      json(response, 200, {
        rows: host.capabilities.interactions
          ? (resources.interactions.list() ?? [])
          : [],
      });
      return;
    }
    if (url.pathname === "/api/skills" && request.method === "GET") {
      json(response, 200, await skills());
      return;
    }
    if (url.pathname === "/api/mcp" && request.method === "GET") {
      json(response, 200, await mcpInventory());
      return;
    }
    if (url.pathname === "/api/plugins" && request.method === "GET") {
      json(response, 200, await plugins());
      return;
    }
    if (url.pathname === "/api/plugin-config" && request.method === "GET") {
      const { adapter } = await pluginAdapter(url.searchParams.get("id"));
      json(response, 200, await pluginConfigDocument(adapter));
      return;
    }
    if (url.pathname === "/api/plugin-resources" && request.method === "GET") {
      const row = (await plugins()).rows.find(
        (item) => item.id === url.searchParams.get("id"),
      );
      if (row?.type !== "package")
        throw new DeskError(422, "此资源不是 pi package");
      const document = await readDocument(scopedSettings(row.scope)),
        entry = document.data.packages[Number(row.id.split(":").at(-1))];
      json(response, 200, {
        revision: document.revision,
        scope: row.scope,
        source: row.source,
        values:
          typeof entry === "string"
            ? {}
            : Object.fromEntries(
                ["autoload", "extensions", "skills", "prompts", "themes"]
                  .filter((key) => Object.hasOwn(entry, key))
                  .map((key) => [key, entry[key]]),
              ),
      });
      return;
    }
    if (url.pathname === "/api/providers" && request.method === "GET") {
      const inventory = await providers();
      json(
        response,
        200,
        url.searchParams.get("view") === "picker"
          ? {
              rows: inventory.rows.map((row) => ({
                id: row.id,
                name: row.name,
                models: row.models.map((model) => ({
                  id: model.id,
                  name: model.name,
                  available: model.available,
                })),
              })),
            }
          : inventory,
      );
      return;
    }
    if (url.pathname === "/api/git" && request.method === "GET") {
      if (!trustedNow())
        throw new DeskError(
          403,
          "请先在 Pi 信任项目，再打开 Git（仓库过滤器可能执行程序）",
        );
      const target = host.target({
        sessionId: url.searchParams.get("sessionId") ?? "",
      });
      target.assertInput();
      const repo = await getGitRepository(target.cwd);
      const result = await repo.read({
        action: url.searchParams.get("action") ?? "status",
        path: url.searchParams.get("path") || undefined,
        staged: url.searchParams.get("staged") === "true",
        ref: url.searchParams.get("ref") || undefined,
        scope: url.searchParams.get("scope") || "current",
        page: url.searchParams.has("page")
          ? Number(url.searchParams.get("page"))
          : undefined,
      });
      target.assert();
      json(response, 200, result);
      return;
    }
    if (request.method !== "POST") throw new DeskError(404, "接口不存在");
    const input = await body(
      request,
      url.pathname === "/api/prompt" ? ATTACHMENT_BODY_LIMIT : BODY_LIMIT,
    );
    const requestTarget = host.target(input);
    requestTarget.assertInput({ cwd: false });
    if (url.pathname === "/api/context/files") {
      if (
        !localManagement(request) ||
        request.headers.origin !==
          `${secure ? "https" : "http"}://${request.headers.host}`
      )
        throw new DeskError(403, "本地文件引用只能由本机页面选择");
      const cancel = () => {
        if (!response.writableEnded) filePicker.close?.();
      };
      response.once("close", cancel);
      try {
        const paths =
          input.paths === undefined
            ? await filePicker.pickFiles()
            : input.paths;
        const files = await referenceFiles(paths);
        requestTarget.assertInput();
        json(response, 200, { files });
      } finally {
        response.removeListener("close", cancel);
      }
      return;
    }
    if (url.pathname === "/api/btw") {
      if (!host.capabilities.btw)
        throw new DeskError(404, "当前 Desktop 宿主未启用 /btw 适配");
      const initial = host.snapshot();
      if (
        !initial.capabilities?.btw &&
        !initial.commands?.some(
          (command) => command.name === "btw" && command.source === "extension",
        )
      )
        throw new DeskError(404, "未检测到已启用的 pi-btw 扩展");
      const result = await prompt.btw(input);
      if (input.sessionId !== undefined)
        requestTarget.assert({
          cwd: false,
          message: "Pi 会话已变化，请重新打开侧问答",
        });
      json(response, 200, result);
      return;
    }
    if (url.pathname === "/api/git-analysis") {
      const runner = analysis;
      const assertAnalysis = () => {
        requestTarget.assertInput({
          ready: true,
          message: "当前会话已变化，请重新分析",
        });
        if (!trustedNow())
          throw new DeskError(403, "请先信任项目再运行本地语言服务器");
      };
      assertAnalysis();
      if (typeof input.path !== "string" || input.path.length > 4096)
        throw new DeskError(422, "请选择当前变更列表中的文件");
      if (!supportsLspFile(input.path))
        throw new DeskError(422, "本轮仅支持 JS/TS 与 JSON 的 LSP 诊断");
      const repo = await getGitRepository(requestTarget.cwd);
      const view = await repo.read();
      if (!view.files.some((file) => file.path === input.path))
        throw new DeskError(422, "文件不在当前变更列表");
      const bytes = await repo.fileBytes(
        join(repo.root, input.path),
        MAX_LSP_FILE_BYTES,
      );
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new DeskError(422, "LSP 只分析 UTF-8 文本文件");
      }
      if (text.includes("\0")) throw new DeskError(422, "LSP 不分析二进制文件");
      assertAnalysis();
      const revision = createHash("sha256").update(bytes).digest("hex");
      const result = await runner.analyze({
        root: repo.root,
        path: input.path,
        text,
      });
      assertAnalysis();
      if (
        createHash("sha256")
          .update(
            await repo.fileBytes(
              join(repo.root, input.path),
              MAX_LSP_FILE_BYTES,
            ),
          )
          .digest("hex") !== revision
      )
        throw new DeskError(409, "文件在分析中已变化，请重新分析");
      assertAnalysis();
      json(response, 200, {
        ...result,
        path: input.path,
        revision,
        scope: "worktree",
        sessionId: requestTarget.sessionId,
      });
      return;
    }
    if (url.pathname === "/api/git") {
      const target = requestTarget;
      const guard = () => {
        target.assertInput({ requireSession: true });
        if (!trustedNow())
          throw new DeskError(403, "请先在 Pi 信任项目，再执行 Git 写操作");
        if (!canEditNow())
          throw new DeskError(409, "请等所有会话任务和配置操作结束后写入 Git");
      };
      guard();
      const repo = await getGitRepository(target.cwd),
        binding = `${target.sessionId}:${target.cwd}`;
      guard();
      const result = input.token
        ? await repo.confirm(input.token, binding, guard)
        : await repo.prepare(input, binding);
      if (!input.token) guard();
      else if (host.capabilities.gitChanged) state.gitChanged();
      publish("state_changed", {});
      json(response, 200, {
        ...result,
        sessionId: target.sessionId,
        root: repo.root,
      });
      return;
    }
    let sessionCommand,
      deferredConfiguration = false;
    if (url.pathname === "/api/prompt") {
      if (!host.capabilities.prompt)
        throw new DeskError(501, "当前 Desktop 宿主未提供消息提交");
      if (
        typeof input.message !== "string" ||
        (!input.message.trim() && !input.attachments?.length) ||
        input.message.length > 50000
      )
        throw new DeskError(422, "消息长度无效");

      if (/^\/git(?:\s|$)/.test(input.message.trim()))
        throw new DeskError(
          422,
          "请通过 Git 面板预览与确认；/git 不会发送给模型",
        );
      requestTarget.assert({ cwd: false });
      if (isGitBusy(requestTarget.cwd))
        throw new DeskError(409, "Git 写操作正在运行，请完成后再发送消息");
      if (input.attachments?.length && input.message.trim().startsWith("/"))
        throw new DeskError(422, "附件只能随普通消息提交；请先执行命令");
      const context = await prepareAttachments(input.attachments, {
        allowReferences:
          localManagement(request) &&
          request.headers.origin ===
            `${secure ? "https" : "http"}://${request.headers.host}`,
        modelInput: host.snapshot().model?.input,
        blockImages: host.capabilities.settings
          ? state.effectiveSettings()?.images?.blockImages
          : undefined,
        autoResize: host.capabilities.settings
          ? state.effectiveSettings()?.images?.autoResize
          : undefined,
      });
      // Image decoding awaits a worker. Reject focus changes during that wait,
      // including legacy clients that omitted an explicit target.
      const latest = requestTarget.assertInput({ cwd: false });
      if (isGitBusy(latest.cwd))
        throw new DeskError(409, "Git 写操作正在运行，请完成后再发送消息");
      context.sessionId = requestTarget.sessionId;
      const match = input.message.trim().match(/^\/sessions(?:\s+([\s\S]*))?$/);
      if (match && host.capabilities.sessionCommand)
        sessionCommand = await sessions.command(match[1] ?? "");
      else {
        const args = input.attachments?.length
          ? [input.message || "请根据所附上下文继续。", input.mode, context]
          : [input.message, input.mode];
        if (input.requestId !== undefined) {
          if (args.length === 2) args.push(undefined);
          args.push(input.requestId);
        }
        await prompt.submit(...args);
      }
    } else if (url.pathname === "/api/abort") {
      if (!host.capabilities.abort)
        throw new DeskError(501, "当前 Desktop 宿主未提供中止");
      await prompt.abort();
    } else if (url.pathname === "/api/model") {
      if (!host.capabilities.model)
        throw new DeskError(501, "当前 Desktop 宿主未提供模型切换");
      deferredConfiguration = !canWriteNow();
      if (
        deferredConfiguration &&
        (!host.capabilities.canDeferConfiguration ||
          !state.canDeferConfiguration())
      )
        throw new DeskError(409, "请等待当前任务完成后切换模型");
      await models.set(input.provider, input.id, {
        defer: deferredConfiguration,
      });
    } else if (url.pathname === "/api/thinking") {
      const canSet = host.capabilities.canSetThinking
        ? state.canSetThinking()
        : canWriteNow();
      deferredConfiguration = !canSet;
      if (
        deferredConfiguration &&
        (!host.capabilities.canDeferConfiguration ||
          !state.canDeferConfiguration())
      )
        throw new DeskError(409, "当前宿主暂不可调整思考等级，请稍后重试");
      if (
        !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          input.level,
        )
      )
        throw new DeskError(422, "思考强度无效");
      const levels = host.snapshot().thinkingLevels;
      if (Array.isArray(levels) && !levels.includes(input.level))
        throw new DeskError(422, "当前模型不支持这个思考等级");
      if (!host.capabilities.thinking)
        throw new DeskError(501, "请通过 pi web 管理思考强度");
      await models.setThinking(input.level, {
        defer: deferredConfiguration,
      });
    } else if (
      url.pathname === "/api/new-session" ||
      url.pathname === "/api/switch-session"
    ) {
      if (
        !(host.capabilities.canManageSessions
          ? state.canManageSessions()
          : canWriteNow())
      )
        throw new DeskError(409, "任务运行中");
      if (!host.capabilities.newSession || !host.capabilities.switchSession)
        throw new DeskError(501, "请通过 pi web 管理会话");
      const result =
        url.pathname === "/api/new-session"
          ? await sessions.create(input)
          : await sessions.switch(input.id);
      if (result?.cancelled) throw new DeskError(409, "扩展取消了会话切换");
      if (result?.sessionId) {
        publish("state_changed", {});
        json(response, 200, { ok: true, sessionId: result.sessionId });
        return;
      }
    } else if (url.pathname === "/api/project-trust") {
      editable();
      if (!host.capabilities.trustProject)
        throw new DeskError(501, "请通过 pi web 管理项目信任");
      await resources.trustProject(input.trusted);
    } else if (url.pathname === "/api/skill") {
      editable();
      const row = (await skills()).rows.find((row) => row.id === input.id);
      if (!row || typeof input.enabled !== "boolean")
        throw new DeskError(422, "技能或启停参数无效");
      await mutateDocument(
        scopedSettings(row.scope),
        input.revision,
        (data) => {
          let target = data;
          if (row.packageSource) {
            const index = (data.packages ?? []).findIndex(
              (entry) =>
                (typeof entry === "string" ? entry : entry.source) ===
                row.packageSource,
            );
            if (index < 0) throw new DeskError(409, "技能所属包已变化");
            const entry = data.packages[index];
            target = data.packages[index] =
              typeof entry === "string" ? { source: entry } : { ...entry };
          }
          const patterns = (target.skills ?? []).filter(
            (value) =>
              value !== `-${row.pattern}` && value !== `+${row.pattern}`,
          );
          patterns.push(`${input.enabled ? "+" : "-"}${row.pattern}`);
          target.skills = patterns;
          return data;
        },
      );
      if (host.capabilities.settingsChanged) await state.settingsChanged();
      pending = true;
    } else if (url.pathname === "/api/mcp") {
      editable();
      if (!host.capabilities.mcp)
        throw new DeskError(501, "请通过 pi web 管理原生 MCP");
      // Same namespace collision rules apply across both scopes.
      const inventory = await mcpInventory();
      if (!validMcpName(input.name))
        throw new DeskError(422, "MCP 服务名称无效");
      if (
        input.action !== "remove" &&
        inventory.rows.some(
          (row) =>
            row.name !== input.name &&
            row.name.replaceAll("-", "_") === input.name.replaceAll("-", "_"),
        )
      )
        throw new DeskError(422, "MCP 命名空间与已有服务冲突");
      await mutateDocument(mcpPath(input.scope), input.revision, (data) =>
        patchMcp(data, input),
      );
      pending = true;
    } else if (url.pathname === "/api/mcp-action") {
      editable();
      if (!host.capabilities.mcp)
        throw new DeskError(501, "请通过 pi web 管理原生 MCP");
      const id = await resources.mcpAction(input);
      json(response, 200, { id });
      return;
    } else if (url.pathname === "/api/settings") {
      if (!host.capabilities.canSaveSettings)
        throw new DeskError(501, "当前 Desktop 宿主不支持共享配置写入");
      await mutateDocument(
        scopedSettings(input.scope),
        input.revision,
        (data) => patchSettings(data, input),
      );
      if (host.capabilities.settingsChanged) await state.settingsChanged();
      pending = true;
    } else if (url.pathname === "/api/reload") {
      editable();
      if (!host.capabilities.reload)
        throw new DeskError(501, "请通过 pi web 重载扩展");
      await resources.reload();
      pending = false;
      changedPlugins.clear();
    } else if (url.pathname === "/api/package-updates") {
      const inventory = await packageManagement.execute("check", input);
      publish("state_changed", {});
      json(response, 200, inventory);
      return;
    } else if (url.pathname === "/api/package") {
      await packageManagement.execute(input.action, input);
    } else if (url.pathname === "/api/auth-start") {
      editable();
      if (!host.capabilities.auth)
        throw new DeskError(501, "请通过 pi web 管理提供商认证");
      const id = await models.authStart(input);
      json(response, 200, { id });
      return;
    } else if (url.pathname === "/api/auth-logout") {
      editable();
      if (!host.capabilities.authLogout)
        throw new DeskError(501, "请通过 pi web 管理提供商认证");
      await models.authLogout(input.provider);
    } else if (url.pathname === "/api/interaction-reply") {
      if (!host.capabilities.interactions)
        throw new DeskError(404, "交互不存在");
      resources.interactions.reply(input);
    } else if (url.pathname === "/api/provider-remove") {
      editable();
      if (host.capabilities.providerRemove) {
        await models.remove(input);
        publish("state_changed", {});
        json(response, 200, { ok: true });
        return;
      }
      await mutateDocument(modelsPath, input.revision, (data) => {
        if (!Object.hasOwn(data.providers ?? {}, input.id))
          throw new DeskError(404, "自定义服务不存在");
        delete data.providers[input.id];
        return data;
      });
      await models.refresh();
    } else if (url.pathname === "/api/plugin") {
      editable();
      const inventory = await plugins();
      const row = inventory.rows.find((item) => item.id === input.id);
      if (row && row.revision !== input.revision)
        throw new DeskError(409, "插件列表已变化，请刷新");
      if (!row || typeof input.enabled !== "boolean")
        throw new DeskError(422, "插件不存在或启停参数无效");
      await mutateDocument(
        scopedSettings(row.scope),
        input.revision,
        (data) => {
          if (row.type === "package") {
            const index = Number(row.id.split(":").at(-1));
            const entry = data.packages[index];
            // An enable action removes our explicit empty extension filter. Other resource filters survive.
            const updated =
              typeof entry === "string" ? { source: entry } : { ...entry };
            if (updated.extensions?.length)
              throw new DeskError(
                422,
                "此包已有资源过滤，请打开资源过滤配置调整启用的扩展",
              );
            if (input.enabled) delete updated.extensions;
            else updated.extensions = [];
            data.packages[index] = updated;
          } else {
            const marker = `-${row.source}`;
            data.extensions = (data.extensions ?? []).filter(
              (value) => value !== marker,
            );
            if (!input.enabled) data.extensions.push(marker);
          }
          return data;
        },
      );
      if (host.capabilities.settingsChanged) await state.settingsChanged();
      pending = true;
      changedPlugins.add(row.id);
    } else if (url.pathname === "/api/plugin-resources") {
      editable();
      const row = (await plugins()).rows.find((item) => item.id === input.id);
      if (row?.type !== "package")
        throw new DeskError(422, "此资源不是 pi package");
      if (
        !input.patch ||
        Array.isArray(input.patch) ||
        Object.entries(input.patch).some(
          ([key, value]) =>
            !["autoload", "extensions", "skills", "prompts", "themes"].includes(
              key,
            ) ||
            (value !== null &&
              (key === "autoload"
                ? typeof value !== "boolean"
                : !Array.isArray(value) ||
                  value.some(
                    (item) => typeof item !== "string" || item.length > 4096,
                  ))),
        )
      )
        throw new DeskError(422, "资源过滤格式无效");
      await mutateDocument(
        scopedSettings(row.scope),
        input.revision,
        (data) => {
          const index = Number(row.id.split(":").at(-1)),
            entry = data.packages[index];
          const next =
            typeof entry === "string" ? { source: entry } : { ...entry };
          for (const [key, value] of Object.entries(input.patch)) {
            if (value === null) delete next[key];
            else next[key] = value;
          }
          data.packages[index] = next;
          return data;
        },
      );
      pending = true;
      changedPlugins.add(row.id);
    } else if (url.pathname === "/api/plugin-config") {
      editable();
      const { row, adapter } = await pluginAdapter(input.id);
      await savePluginConfig(adapter, input);
      pending = true;
      changedPlugins.add(row.id);
    } else if (url.pathname === "/api/provider") {
      editable();
      if (host.capabilities.providerSave) {
        await models.save(input);
        publish("state_changed", {});
        json(response, 200, { ok: true });
        return;
      }
      await mutateDocument(modelsPath, input.revision, (data) => {
        const native = host.capabilities.providerCatalog
          ? models.catalog().find((row) => row.id === input.id)
          : undefined;
        return patchProvider(data, input, {
          allowEmptyModels: !!native,
          additionalApi: native?.models?.[0]?.api,
        });
      });
      await models.refresh();
    } else if (url.pathname === "/api/refresh-models") {
      editable();
      await models.refresh();
    } else if (url.pathname === "/api/default-model") {
      editable();
      if (
        !host
          .snapshot()
          .models.some(
            (model) =>
              model.provider === input.provider && model.id === input.id,
          )
      )
        throw new DeskError(422, "模型不可用");
      const document = await readDocument(settingsPath);
      await mutateDocument(settingsPath, document.revision, (data) => ({
        ...data,
        defaultProvider: input.provider,
        defaultModel: input.id,
      }));
      if (host.capabilities.settingsChanged) await state.settingsChanged();
    } else throw new DeskError(404, "接口不存在");
    publish("state_changed", {});
    json(response, 200, {
      ok: true,
      pending,
      ...(deferredConfiguration ? { deferred: true } : {}),
      ...(sessionCommand ? { sessionCommand } : {}),
    });
  }
  function handler(request, response) {
    Promise.resolve()
      .then(() =>
        // Remote publication is process-wide and must remain accessible while
        // an agent is initializing or waiting for an extension dialog.
        request.method === "POST" &&
        new URL(request.url, "http://localhost").pathname === "/api/remote"
          ? route(request, response)
          : host.capabilities.requestContext
            ? host.require("requestContext")(request, response, () =>
                route(request, response),
              )
            : route(request, response),
      )
      .catch((error) => {
        if (!response.headersSent)
          json(response, error instanceof DeskError ? error.status : 500, {
            error:
              error instanceof DeskError
                ? error.message
                : "操作失败，请检查本机配置或连接",
          });
        else response.end();
      });
  }
  function localManagement(request) {
    try {
      const hostname = new URL(`http://${request.headers.host}`).hostname;
      return (
        loopback(request.socket.remoteAddress) &&
        request.headers["x-pi-remote-client"] !== "1" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(hostname)
      );
    } catch {
      return false;
    }
  }
  function connectionInfo() {
    const port = server.address().port;
    const lan = !loopback(listenHost);
    const addresses = lan ? localAddresses() : [];
    const urls = addresses.map(
      (address) => `${secure ? "https" : "http"}://${address}:${port}/`,
    );
    return { localUrl: listenUrl, url: urls[0] ?? listenUrl, urls, port, lan };
  }
  async function connectionDetails(address, management = true) {
    const info = connectionInfo();
    // Address selection chooses an advertised URL, without creating a listener or a credential.
    const tunnel = management ? remoteAccess.read() : undefined;
    let url =
      address && info.urls.includes(address)
        ? address
        : (tunnel?.scanUrl ?? info.url);
    if (tunnel?.scanUrl && url === tunnel.scanUrl) {
      const selected = host.snapshot();
      if (
        selected.host === "durable" &&
        /^\d+$/.test(selected.sessionId ?? "")
      ) {
        const destination = new URL(url);
        destination.searchParams.set("agent", selected.sessionId);
        url = destination.href;
      }
    }
    return {
      ...info,
      ...(tunnel ? { tunnel } : {}),
      url,
      qr: await QRCode.toDataURL(url, {
        width: 280,
        margin: 4,
        errorCorrectionLevel: "M",
      }),
    };
  }
  async function start() {
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("PI_DESK_PORT 无效");
    if (
      !["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"].includes(listenHost)
    )
      throw new Error(
        "请使用 127.0.0.1 / ::1 本机监听，或 0.0.0.0 / :: 远程监听",
      );
    if (!server) {
      server = secure
        ? httpsServer(
            { cert: await readFile(certPath), key: await readFile(keyPath) },
            handler,
          )
        : httpServer(handler);
      server.requestTimeout = 30000;
      let attemptedPort = port;
      for (let attempt = 0; ; attempt++) {
        try {
          await new Promise((resolve, reject) => {
            const listening = () => {
              server.off("error", failed);
              resolve();
            };
            const failed = (error) => {
              server.off("listening", listening);
              reject(error);
            };
            server.once("error", failed);
            server.once("listening", listening);
            server.listen(attemptedPort, listenHost);
          });
          break;
        } catch (error) {
          if (
            !transport.autoPort ||
            error.code !== "EADDRINUSE" ||
            attempt >= 9 ||
            attemptedPort >= 65535
          )
            throw error;
          attemptedPort++;
        }
      }
      const actualPort = server.address().port;
      listenUrl = `${secure ? "https" : "http"}://${["::1", "::"].includes(listenHost) ? "[::1]" : "127.0.0.1"}:${actualPort}/`;
    }
    return listenUrl;
  }
  async function stop() {
    filePicker.close?.();
    await Promise.all([remoteAccess.close(), analysis.stop(), catalog.stop()]);
    analysis = createLspDiagnostics();
    catalog = createPackageCatalog({ fetchPage: transport.catalogFetch });
    const finishing = Promise.all([...clients].map((stream) => stream.end()));
    clients.clear();
    let deadline;
    try {
      // Finish gzip trailers before force-closing sockets, while bounding slow peers.
      await Promise.race([
        finishing,
        new Promise((resolve) => {
          deadline = setTimeout(resolve, 500);
          deadline.unref();
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    if (server) {
      const current = server;
      server = undefined;
      await new Promise((resolve) => {
        current.close(resolve);
        current.closeAllConnections();
      });
    }
  }
  return {
    start,
    stop,
    publish,
    connectionDetails,
    get connectedClients() {
      return clients.size;
    },
  };
}
