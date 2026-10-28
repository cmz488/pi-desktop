import { webCommands } from "../shared/pi-commands.mjs";
import packageInfo from "../../package.json" with { type: "json" };
import { createSessionTransport, toSessionMeta } from "./session-transport.mjs";
import {
  slashCommandViews,
  providerViews,
  mcpView,
  projectFiles,
  composerInput,
  createProviderLogins,
  checkoutBranch,
  referencedMessage,
  exportSession,
} from "./native-contracts.mjs";
import { toSessionMessages } from "./session-projection.mjs";
import { parseDialogRequestId, toDialogs } from "./interactions.mjs";
export { toSessionMeta };

/**
 * Percho 通道 → 本 Host HTTP 的处理函数（传输可注入，便于对真实 Host 验证）。
 *
 * 接口：`createHttpHandlers({ get, post })` 返回 `{ [channel]: (args) => Promise }`。
 * 不变量：只实现能追溯到具体路由、且请求／响应形状已**实测**的通道；其余交由支持表报
 *   unsupported。形状不猜——猜错会让界面显示错误数据而没有任何报错。
 * 为什么单独成文件：浏览器里的 `window.pi` 与测试用同一份实现，避免两份漂移。
 */

/** `/api/providers` 返回的 revision 是配置文档版本，写 provider 时必须回传。 */
async function providerRevision(get) {
  const body = await get("/api/providers");
  return body?.revision;
}

/**
 * @param {object} io
 * @param {(path: string) => Promise<any>} io.get
 * @param {(path: string, body: unknown) => Promise<any>} io.post
 * @param {ReturnType<typeof createSessionTransport>} [io.sessions]
 * @param {(name: string, payload: any) => void} [io.emit]
 * @param {ReturnType<typeof createProviderLogins>} [io.logins]
 * @param {(plan: {request: unknown, warning?: string}) => Promise<boolean>} [io.confirmGit]
 * @param {(cwd: string) => Promise<boolean>} [io.confirmTrust]
 * @param {(value: string) => any | Promise<any>} [io.parseCatalog]
 * @param {any} [io.desktop]
 * @param {(url: string) => void} [io.openExternal]
 */
export function createHttpHandlers({
  get: rawGet,
  post: rawPost,
  sessions = createSessionTransport({ get: rawGet, post: rawPost }),
  emit,
  logins = createProviderLogins({ sessions, emit }),
  confirmGit = async (_plan) => false,
  confirmTrust = async (_cwd) => false,
  parseCatalog = (_value) => {
    throw new Error("包目录 HTML 需要浏览器解析器");
  },
  desktop = globalThis.window?.piDesk,
  openExternal = (url) =>
    globalThis.window?.open(url, "_blank", "noopener,noreferrer"),
}) {
  const get = (path) => sessions.get(path);
  const post = (path, input) => sessions.post(path, input);
  const providerTarget = async () => {
    const { id } = await sessions.target();
    return {
      id,
      get: (path) => sessions.get(path, id),
      post: (path, input) => sessions.post(path, input, id),
    };
  };
  const projectTarget = async (cwd) => {
    const id = await sessions.forCwd(cwd, { required: false });
    if (id)
      return {
        id,
        get: (path) => sessions.get(path, id),
        post: (path, input) => sessions.post(path, input, id),
      };
    if (!(await sessions.detect()))
      throw new Error("请先在此项目创建或打开会话");
    const directory = cwd ?? (await rawGet("/api/daily-dir")).path;
    const route = (path) => {
      const url = new URL(path, "http://localhost");
      const kind = {
        "/api/files": "files",
        "/api/git": "git",
        "/api/mcp": "mcp",
        "/api/project-trust": "trust",
      }[url.pathname];
      if (!kind) throw new Error("目录操作无效");
      return { url, endpoint: `/api/workspace/project-${kind}` };
    };
    return {
      id: null,
      get: (path) => {
        const { url, endpoint } = route(path);
        url.searchParams.set("cwd", directory);
        return rawGet(endpoint + url.search);
      },
      post: (path, input) =>
        rawPost(route(path).endpoint, { ...input, cwd: directory }),
    };
  };
  return {
    "project:pickDirectory": async () =>
      desktop?.pickDirectory
        ? desktop.pickDirectory()
        : (await rawPost("/api/workspace/directory", {})).path,
    "app:openExternal": async (args) => {
      const url = new URL(args.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("只支持无凭据的 HTTP(S) 链接");
      openExternal(url.href);
    },
    "app:getInfo": async () => ({
      name: "Pi Desktop",
      version: packageInfo.version,
      platform: globalThis.navigator?.platform ?? "",
      electron: "",
      chrome: "",
      node: "",
      arch: "",
      repoUrl: "",
    }),
    "session:list": async (args) =>
      (await sessions.list()).filter(
        (row) => !args?.cwd || row.cwd === args.cwd,
      ),
    "session:listAll": () => sessions.list(),
    "session:getLoaded": () => sessions.loaded(),
    "session:getLoadedResources": async (args) => {
      const resources = (await sessions.state(args.sessionId)).loadedResources;
      if (!resources) throw new Error("原生资源尚未加载，请等待 Agent 就绪");
      return resources;
    },
    "session:getMessages": async (args) =>
      toSessionMessages((await sessions.state(args.sessionId)).messages),
    "session:stats": async (args) => {
      const { stats } = await sessions.state(args.sessionId);
      return {
        inputTokens: stats?.tokens?.input ?? 0,
        outputTokens: stats?.tokens?.output ?? 0,
        cost: stats?.cost ?? 0,
      };
    },
    "session:getContextUsage": async (args) =>
      (await sessions.state(args.sessionId)).usage ?? null,
    "session:getPendingInteractions": async () => {
      const active = (await sessions.list()).filter((row) => row.active);
      const dialogs = (
        await Promise.all(
          active.map(async (row) =>
            toDialogs(
              (
                await sessions.get("/api/interactions", row.sessionId)
              ).rows.filter((job) => !logins.owns(row.sessionId, job.id)),
              row.sessionId,
            ),
          ),
        )
      ).flat();
      return { revision: 0, permissions: [], dialogs, trust: [] };
    },
    "session:listSlashCommands": async (args) =>
      slashCommandViews(
        (await sessions.get("/api/commands", args.sessionId)).rows ?? [],
      ),
    "session:listSlashCommandsForCwd": async (args) => {
      const id = await sessions.forCwd(args?.cwd, { required: false });
      return slashCommandViews(
        id
          ? ((await sessions.get("/api/commands", id)).rows ?? [])
          : webCommands,
      );
    },
    "session:create": (args) => sessions.create(args.options),
    "session:prompt": async (args) => {
      await sessions.flushComposer(args.sessionId);
      return sessions.post(
        "/api/prompt",
        {
          message:
            composerInput(args) ||
            (args.files?.length
              ? `附件：${args.files.map((file) => file.name).join("、")}`
              : ""),
          ...(args.document && composerInput(args) !== args.text
            ? { original: args.text, document: args.document }
            : {}),
          ...((args.images?.length ?? 0) + (args.files?.length ?? 0)
            ? {
                attachments: [
                  ...(args.images ?? []).map((image, index) => ({
                    name: `paste-${index}`,
                    type: image.mimeType,
                    data: image.data,
                  })),
                  ...(args.files ?? []),
                ],
              }
            : {}),
        },
        args.sessionId,
      );
    },
    "session:abort": (args) => sessions.post("/api/abort", {}, args.sessionId),
    "session:setModel": (args) =>
      sessions.post(
        "/api/model",
        {
          provider: args.provider,
          id: args.modelId,
        },
        args.sessionId,
      ),
    "session:setThinkingLevel": (args) =>
      sessions.post("/api/thinking", { level: args.level }, args.sessionId),
    "session:compact": (args) =>
      sessions.post(
        "/api/prompt",
        {
          message: `/compact${args.customInstructions ? ` ${args.customInstructions}` : ""}`,
        },
        args.sessionId,
      ),
    "file:saveDialog": async (args) => {
      if (desktop?.saveFile) return desktop.saveFile(args);
      const link = globalThis.document.createElement("a");
      const url = URL.createObjectURL(
        new Blob([args.content], { type: "text/plain;charset=utf-8" }),
      );
      link.download = args.defaultName;
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return args.defaultName;
    },
    "session:export": (args) => exportSession(sessions, args),
    "session:recall": async (args) => {
      const message = await referencedMessage(sessions, args, "user");
      await sessions.command("rewind", {
        sessionId: args.sessionId,
        entryId: Number(message.entryId),
        before: true,
      });
      return {
        text: message.text,
        images: (message.blocks ?? message.content ?? [])
          .filter((part) => part.type === "image")
          .map(({ data, mimeType }) => ({ data, mimeType })),
      };
    },
    "session:fork": async (args) => {
      const message = await referencedMessage(sessions, args, "assistant");
      const selected = await sessions.target(args.sessionId);
      const result = await sessions.command("fork", {
        ...args,
        entryId: Number(message.entryId),
        generation: selected.owner
          ? ((await rawGet("/api/workspace")).agents.find(
              (row) => row.id === selected.owner,
            )?.generation ?? 0)
          : undefined,
      });
      return sessions.describe(
        result.agentId ?? result.sessionId ?? String(result.id),
      );
    },
    "models:list": async () => {
      const id = await sessions.forCwd(undefined, { required: false });
      if (!id) return [];
      const [state, providers] = await Promise.all([
        sessions.get("/api/state", id),
        sessions.get("/api/providers", id),
      ]);
      const rows = (state.models ?? []).map((row) => {
        const provider = providers.rows.find(
          (item) => item.id === row.provider,
        );
        return {
          provider: row.provider,
          providerName: provider?.name ?? row.provider,
          id: row.id ?? row.modelId,
          label: row.name ?? row.id ?? row.modelId,
          authed:
            provider?.models?.find(
              (item) => item.id === (row.id ?? row.modelId),
            )?.available === true,
          imageInput: row.input?.includes("image") ?? true,
          ...(row.thinkingLevels ? { thinkingLevels: row.thinkingLevels } : {}),
        };
      });
      const current = (row) =>
        row.provider === state.model?.provider && row.id === state.model?.id;
      return rows.sort((a, b) => Number(current(b)) - Number(current(a)));
    },
    // `/api/providers` 实测返回 { revision, rows: [] }。
    "settings:listProviders": async (args) => {
      const id = await sessions.forCwd(undefined, { required: false });
      if (!id) return [];
      if (args?.options?.forceNetwork)
        await sessions.post("/api/refresh-models", {}, id);
      return providerViews(await sessions.get("/api/providers", id));
    },
    "project:listFiles": async (args) => {
      const io = await projectTarget(args.cwd);
      return projectFiles(io.get, args.path ?? "");
    },
    "project:getGitBranch": async (args) => {
      const io = await projectTarget(args.cwd);
      const body = await io.get("/api/git");
      return body?.branch ?? null;
    },
    "project:listGitBranches": async (args) => {
      const io = await projectTarget(args.cwd);
      const body = await io.get("/api/git");
      return { current: body?.branch ?? null, branches: body?.branches ?? [] };
    },
    // `/api/mcp` 实测返回 { pending, revisions, rows, supported }。
    "mcp:configList": async (args) => {
      const io = await projectTarget(args?.cwd);
      return mcpView(await io.get("/api/mcp"));
    },

    // ── 包管理 ────────────────────────────────────────────────────────────
    // `/api/package` 的 body 是 { action, ...params }，由 packageManagement 解释。
    "packages:listConfigured": async () =>
      (await get("/api/plugins")).rows
        .filter((row) => row.type === "package")
        .map((row) => ({
          source: row.source,
          scope: row.scope === "global" ? "user" : "project",
        })),
    "packages:install": async (args) =>
      await post("/api/package", {
        action: "install",
        source: String(
          args?.source ??
            (String(args?.name ?? "").startsWith("npm:")
              ? args.name
              : `npm:${args?.name ?? ""}`),
        ),
        scope: args?.scope === "project" ? "project" : "global",
      }),
    "packages:remove": async (args) =>
      await post("/api/package", {
        action: "remove",
        source: String(args?.source ?? ""),
        scope: args?.scope === "project" ? "project" : "global",
      }),
    // 目录搜索是 GET `/api/package-catalog?name=`；结果是 HTML，不是结构化列表。
    "packages:searchCatalog": async (args) => {
      const value = await get(
        `/api/package-catalog?q=${encodeURIComponent(String(args?.query ?? ""))}&type=${encodeURIComponent(args?.type ?? "")}&page=${args?.page ?? 1}`,
      );
      const parsed = await parseCatalog(value);
      return {
        packages: parsed.rows.map((row) => ({
          ...row,
          installSource: row.source,
          updatedAt: row.published ?? 0,
          downloads: row.downloads ?? 0,
        })),
        total: Number(/\/\s*(\d+)/.exec(parsed.count)[1]),
        page: parsed.page,
        pageSize: 50,
      };
    },

    // ── MCP ───────────────────────────────────────────────────────────────
    "mcp:configUpsert": async (args) => {
      const io = await projectTarget(args.cwd);
      const inventory = await io.get("/api/mcp");
      const scope = args.scope === "project" ? "project" : "global";
      const config = Object.fromEntries(
        ["command", "args", "url", "description", "enabled", "exposure"]
          .filter((key) => args[key] !== undefined)
          .map((key) => [key, args[key]]),
      );
      if (args.url !== undefined)
        Object.assign(config, { command: null, args: null });
      if (args.command !== undefined) config.url = null;
      await io.post("/api/mcp", {
        action: "save",
        scope,
        revision: inventory.revisions[scope],
        name: args.name,
        config,
      });
      return {
        config: mcpView(await io.get("/api/mcp")),
        reload: { reloaded: 0, skipped: [] },
      };
    },
    "mcp:configRemove": async (args) => {
      const io = await projectTarget(args.cwd);
      const inventory = await io.get("/api/mcp");
      const scope = args.scope === "project" ? "project" : "global";
      await io.post("/api/mcp", {
        action: "remove",
        name: args.name,
        scope,
        revision: inventory.revisions[scope],
      });
      return {
        config: mcpView(await io.get("/api/mcp")),
        reload: { reloaded: 0, skipped: [] },
      };
    },
    "mcp:configReload": async (args) => {
      const io = await projectTarget(args?.cwd);
      if (io.id) await sessions.post("/api/reload", {}, io.id);
      return {
        config: mcpView(await io.get("/api/mcp")),
        reload: { reloaded: io.id ? 1 : 0, skipped: [] },
      };
    },

    // ── 权限与信任 ────────────────────────────────────────────────────────
    // /api/approval 的 body 是 { mode }；审批模式在 /api/agent 的 active.approvalMode 上。
    "permission:getConfig": async () => {
      const state = await sessions.state();
      return {
        enabled:
          state.capabilities?.durable === true &&
          state.capabilities?.readOnly !== true,
      };
    },
    "permission:getMode": async (args) => {
      const state = await sessions.state(args.sessionId);
      if (state.host !== "durable") return "default";
      return (await sessions.get("/api/agent", args.sessionId)).active
        ?.approvalMode === "yolo"
        ? "fullAccess"
        : "default";
    },
    "permission:setMode": async (args) => {
      if ((await sessions.state(args.sessionId)).host !== "durable")
        throw new Error("当前会话的权限由原 Pi TUI／SDK 宿主管理");
      if (!["default", "fullAccess"].includes(args.mode))
        throw new Error("权限模式无效");
      const current = (await sessions.get("/api/agent", args.sessionId)).active
        ?.approvalMode;
      return sessions.post(
        "/api/approval",
        {
          mode:
            args.mode === "fullAccess"
              ? "yolo"
              : current === "ask-all"
                ? "ask-all"
                : "ask-risky",
        },
        args.sessionId,
      );
    },
    "extension-dialog:respond": async (args) => {
      const ref = parseDialogRequestId(args.requestId);
      const job = (
        await sessions.get("/api/interactions", ref.sessionId)
      ).rows.find((row) => row.id === ref.id);
      if (!job?.prompt || job.prompt.id !== ref.promptId)
        throw new Error("交互已变化，请重新读取");
      const answer = args.answer;
      let value =
        answer.value ??
        (answer.confirmed === undefined ? "" : answer.confirmed ? "yes" : "no");
      if (job.prompt.type === "select")
        value =
          job.prompt.options.find(
            (row) => row.label === value || row.id === value,
          )?.id ?? value;
      return sessions.post(
        "/api/interaction-reply",
        {
          id: ref.id,
          promptId: ref.promptId,
          ...(answer.cancelled ? { cancel: true } : { value }),
        },
        ref.sessionId,
      );
    },

    // ── 项目 ──────────────────────────────────────────────────────────────
    "project:ensureTrust": async (args) => {
      const io = await projectTarget(args.cwd);
      if (
        io.id
          ? (await sessions.state(io.id)).projectTrusted
          : await io.get("/api/project-trust")
      )
        return true;
      if (!(await confirmTrust(args.cwd))) return false;
      await io.post("/api/project-trust", { trusted: true });
      return true;
    },
    "project:validateDirectory": async (args) =>
      (await rawPost("/api/workspace/validate-directory", { path: args.path }))
        .path,
    "project:checkoutBranch": async (args) =>
      checkoutBranch(sessions, args, confirmGit, await projectTarget(args.cwd)),

    // ── 设置：provider 与登录 ─────────────────────────────────────────────
    // /api/provider 与 /api/provider-remove 都要 revision（配置版本围栏）。
    "settings:saveApiKey": async (args) => {
      const { get, post, id } = await providerTarget();
      const inventory = await get("/api/providers");
      const row = inventory.rows.find((row) => row.id === args.providerId);
      const native = [...inventory.rows, ...(inventory.catalog ?? [])].find(
        (row) => row.id === args.providerId && row.auth?.apiKey,
      );
      if (native) {
        const result = await logins.start(
          { providerId: args.providerId, loginId: `key-${args.providerId}` },
          args.key,
          id,
        );
        if (!result.ok) throw new Error(result.error ?? "凭据未保存");
        return result;
      }
      if (!row) throw new Error("请先添加自定义提供商，或使用原生提供商登录");
      return post("/api/provider", {
        id: row.id,
        baseUrl: row.baseUrl,
        api: row.api,
        apiKey: args.key,
        revision: inventory.revision,
      });
    },
    "settings:removeCredential": async (args) => {
      const { post } = await providerTarget();
      return post("/api/auth-logout", { provider: args.providerId });
    },
    "settings:addCustomProvider": async (args) => {
      const { get, post } = await providerTarget();
      const revision = await providerRevision(get);
      return await post("/api/provider", { ...args?.input, revision });
    },
    "settings:updateCustomProvider": async (args) => {
      const { get, post } = await providerTarget();
      const revision = await providerRevision(get);
      return await post("/api/provider", { ...args?.input, revision });
    },
    "settings:removeCustomProvider": async (args) => {
      const { get, post } = await providerTarget();
      const revision = await providerRevision(get);
      return await post("/api/provider-remove", {
        id: args.providerId,
        revision,
      });
    },
    "settings:setProviderBaseUrl": async (args) => {
      const { get, post, id } = await providerTarget();
      const inventory = await get("/api/providers");
      const row = [...inventory.rows, ...(inventory.catalog ?? [])].find(
        (row) => row.id === args.providerId,
      );
      if (!row) throw new Error("提供商不存在，请刷新目录");
      const builtin =
        inventory.catalog?.find((provider) => provider.id === args.providerId)
          ?.builtin === true;
      await post("/api/provider", {
        id: row.id,
        api: row.api,
        baseUrl: args.baseUrl,
        ...(args.apiKey === undefined || builtin
          ? {}
          : { apiKey: args.apiKey }),
        revision: inventory.revision,
      });
      if (builtin && args.apiKey) {
        const result = await logins.start(
          { providerId: args.providerId, loginId: `key-${args.providerId}` },
          args.apiKey,
          id,
        );
        if (!result.ok) throw new Error(result.error ?? "凭据未保存");
      }
    },
    // 刷新模型目录（可能联网），由宿主决定时机。
    "settings:loginStart": (args) => logins.start(args),
    "settings:loginCancel": (args) => logins.cancel(args),
    "settings:loginRespond": (args) => logins.respond(args),

    // ── 资源清单（插件／技能） ────────────────────────────────────────────
    // ── 会话：Host 级工作空间命令 ────────────────────────────────────────
    // 会话由 Host 的 supervisor 管理（不是 worker 路由）；命令名与参数见
    // src/control-plane/server.mjs 的 remoteWorkspaceCommands 与 supervisor.execute。
    "session:open": (args) => sessions.open(args.filePath),
    "session:close": (args) => sessions.close(args.sessionId),
    "session:delete": (args) => sessions.archive(args.sessionId),
    "session:setName": (args) => sessions.rename(args.sessionId, args.name),

    // 以下五个由工作空间数据目录承载：页面刷新后必须读回同一份值。
    "uiState:load": async () => (await rawGet("/api/ui-state"))?.value ?? null,
    "uiState:save": async (args) =>
      (
        await rawPost("/api/ui-state", {
          value: args?.state ?? args?.value ?? {},
        })
      )?.value ?? null,
    "environmentUi:load": async () =>
      (await rawGet("/api/environment-ui-state"))?.value ?? null,
    "environmentUi:save": async (args) =>
      (
        await rawPost("/api/environment-ui-state", {
          value: args?.state ?? args?.value ?? {},
        })
      )?.value ?? null,
    "app:getDailyDir": async () => (await rawGet("/api/daily-dir"))?.path ?? "",
    // 跨设备互联：状态含二维码，Percho 的设置页直接渲染。
    "lan:getStatus": async () => (await get("/api/lan"))?.status ?? null,
    "lan:setEnabled": async (args) =>
      (await post("/api/lan", { enabled: args?.enabled === true }))?.status ??
      null,
    "lan:setRemoteControl": async (args) =>
      (
        await post("/api/lan", {
          remoteControl: (args?.enabled ?? args?.remoteControl) === true,
        })
      )?.status ?? null,
  };
}
