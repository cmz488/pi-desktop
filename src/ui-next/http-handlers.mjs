import { createSessionTransport, toSessionMeta } from "./session-transport.mjs";
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

/**
 * @param {object} io
 * @param {(path: string) => Promise<any>} io.get
 * @param {(path: string, body: unknown) => Promise<any>} io.post
 */
/** `/api/providers` 返回的 revision 是配置文档版本，写 provider 时必须回传。 */
async function providerRevision(get) {
  const body = await get("/api/providers");
  return body?.revision;
}

export function createHttpHandlers({
  get: rawGet,
  post: rawPost,
  sessions = createSessionTransport({ get: rawGet, post: rawPost }),
}) {
  const get = (path) => sessions.get(path);
  const post = (path, input) => sessions.post(path, input);
  return {
    "session:list": async (args) =>
      (await sessions.list()).filter(
        (row) => !args?.cwd || row.cwd === args.cwd,
      ),
    "session:listAll": () => sessions.list(),
    "session:getLoaded": () => sessions.loaded(),
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
              (await sessions.get("/api/interactions", row.sessionId)).rows,
              row.sessionId,
            ),
          ),
        )
      ).flat();
      return { revision: 0, permissions: [], dialogs, trust: [] };
    },
    "session:listSlashCommands": async (args) =>
      (await sessions.get("/api/commands", args.sessionId)).rows ?? [],
    "session:listSlashCommandsForCwd": async () =>
      (await get("/api/commands")).rows ?? [],
    "session:create": (args) => sessions.create(args.options),
    "session:prompt": async (args) => {
      await sessions.flushComposer(args.sessionId);
      return sessions.post(
        "/api/prompt",
        {
          message: String(args?.text ?? ""),
          ...(Array.isArray(args?.images) && args.images.length
            ? {
                attachments: args.images.map((image, index) => ({
                  name: `paste-${index}`,
                  type: image.mimeType,
                  data: image.data,
                })),
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
    "session:compact": (args) => sessions.command("compact", args),
    "session:fork": async (args) => {
      const selected = await sessions.target(args.sessionId);
      const result = await sessions.command("fork", {
        ...args,
        entryId:
          args.ref?.entryId === undefined
            ? undefined
            : Number(args.ref.entryId),
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
      const [state, providers] = await Promise.all([
        get("/api/state"),
        get("/api/providers"),
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
    "settings:listProviders": async () =>
      (await get("/api/providers"))?.rows ?? [],
    // `/api/files` 空路径返回目录列表（kind: "directory", entries）。
    "project:listFiles": async () => await get("/api/files"),
    "project:getGitBranch": async () => {
      const body = await get("/api/git");
      return body?.branch ?? null;
    },
    "project:listGitBranches": async () => {
      const body = await get("/api/git");
      return { current: body?.branch ?? null, branches: body?.branches ?? [] };
    },
    // `/api/mcp` 实测返回 { pending, revisions, rows, supported }。
    "mcp:configList": async () => (await get("/api/mcp"))?.rows ?? [],

    // ── 包管理 ────────────────────────────────────────────────────────────
    // `/api/package` 的 body 是 { action, ...params }，由 packageManagement 解释。
    "packages:install": async (args) =>
      await post("/api/package", {
        action: "install",
        name: String(args?.name ?? ""),
      }),
    "packages:remove": async (args) =>
      await post("/api/package", {
        action: "remove",
        source: String(args?.source ?? ""),
        scope: String(args?.scope ?? "user"),
      }),
    // 目录搜索是 GET `/api/package-catalog?name=`；结果是 HTML，不是结构化列表。
    "packages:searchCatalog": async (args) =>
      await get(
        `/api/package-catalog?name=${encodeURIComponent(String(args?.query ?? ""))}`,
      ),

    // ── MCP ───────────────────────────────────────────────────────────────
    "mcp:configUpsert": async (args) =>
      await post("/api/mcp-action", args ?? {}),
    "mcp:configRemove": async (args) =>
      await post("/api/mcp-action", { ...args, remove: true }),
    "mcp:configReload": async () => await get("/api/mcp"),

    // ── 权限与信任 ────────────────────────────────────────────────────────
    // /api/approval 的 body 是 { mode }；审批模式在 /api/agent 的 active.approvalMode 上。
    "permission:getConfig": async () => ({ enabled: true }),
    "permission:getMode": async (args) =>
      (await sessions.get("/api/agent", args.sessionId)).active
        ?.approvalMode === "yolo"
        ? "fullAccess"
        : "default",
    "permission:setMode": async (args) => {
      if (!["default", "fullAccess"].includes(args.mode))
        throw new Error("权限模式无效");
      return sessions.post(
        "/api/approval",
        { mode: args.mode === "fullAccess" ? "yolo" : "ask-risky" },
        args.sessionId,
      );
    },
    "trust:respond": async (args) =>
      await post("/api/project-trust", {
        trusted: args?.answer === 1 || args?.answer === true,
        id: args?.requestId,
      }),
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
    "project:ensureTrust": async (args) =>
      await post("/api/project-trust", { trusted: true, id: args?.cwd }),
    "project:validateDirectory": async (args) =>
      await post("/api/workspace/command", {
        command: "validate",
        path: String(args?.path ?? ""),
      }),
    "project:checkoutBranch": async (args) =>
      await post("/api/command", {
        command: "git",
        action: "checkout",
        branch: args?.branch,
      }),

    // ── 设置：provider 与登录 ─────────────────────────────────────────────
    // /api/provider 与 /api/provider-remove 都要 revision（配置版本围栏）。
    "settings:saveApiKey": async (args) => {
      const revision = await providerRevision(get);
      return await post("/api/provider", { ...args, revision });
    },
    "settings:removeCredential": async (args) => {
      const revision = await providerRevision(get);
      return await post("/api/provider-remove", {
        id: args?.providerId,
        revision,
      });
    },
    "settings:addCustomProvider": async (args) => {
      const revision = await providerRevision(get);
      return await post("/api/provider", { ...args?.input, revision });
    },
    "settings:updateCustomProvider": async (args) => {
      const revision = await providerRevision(get);
      return await post("/api/provider", { ...args?.input, revision });
    },
    "settings:removeCustomProvider": async (args) => {
      const revision = await providerRevision(get);
      return await post("/api/provider-remove", { id: args?.id, revision });
    },
    "settings:setProviderBaseUrl": async (args) => {
      const revision = await providerRevision(get);
      return await post("/api/provider", {
        id: args?.providerId,
        baseUrl: args?.baseUrl,
        revision,
      });
    },
    // 刷新模型目录（可能联网），由宿主决定时机。
    "settings:testProvider": async (args) =>
      await post("/api/refresh-models", { provider: args?.providerId }),
    "settings:loginStart": async (args) =>
      await post("/api/auth-start", { provider: args?.providerId }),
    "settings:loginCancel": async () => await post("/api/auth-logout", {}),
    "settings:loginRespond": async (args) =>
      await post("/api/interaction-reply", args ?? {}),

    // ── 资源清单（插件／技能） ────────────────────────────────────────────
    "settings:listSubagents": async () =>
      (await get("/api/subagent-history"))?.rows ?? [],
    "uiPlugins:getConfig": async () => await get("/api/plugin-config"),
    // 读取端是 /api/plugins（复数）；/api/plugin（单数）只做启停写入。
    "uiPlugins:list": async () => {
      const body = await get("/api/plugins");
      return body?.rows ?? body ?? [];
    },
    "uiPlugins:setEnabled": async (args) =>
      await post("/api/plugin", {
        id: args?.id,
        enabled: args?.enabled === true,
        revision: args?.revision,
      }),
    "uiPlugins:setPluginEnabled": async (args) =>
      await post("/api/plugin", {
        id: args?.id,
        enabled: args?.enabled === true,
        revision: args?.revision,
      }),
    "uiPlugins:readCode": async (args) =>
      await get(
        `/api/plugin-resources?id=${encodeURIComponent(String(args?.id ?? ""))}`,
      ),
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
