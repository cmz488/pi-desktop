/**
 * Percho 通道 → 本 Host HTTP 的处理函数（传输可注入，便于对真实 Host 验证）。
 *
 * 接口：`createHttpHandlers({ get, post })` 返回 `{ [channel]: (args) => Promise }`。
 * 不变量：只实现能追溯到具体路由、且请求／响应形状已**实测**的通道；其余交由支持表报
 *   unsupported。形状不猜——猜错会让界面显示错误数据而没有任何报错。
 * 为什么单独成文件：浏览器里的 `window.pi` 与测试用同一份实现，避免两份漂移。
 */

/** 我们的会话行 → Percho 的 SessionMeta 形状（`/api/sessions` 的 rows[].id 是字符串）。 */
export function toSessionMeta(row) {
  return {
    sessionId: String(row.id ?? row.sessionId ?? ""),
    cwd: row.cwd ?? "",
    ...(row.name ? { name: row.name } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    ...(row.nativeSessionFile ? { sessionFile: row.nativeSessionFile } : {}),
  };
}

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

export function createHttpHandlers({ get, post }) {
  /** 当前会话 id：多条路由以 `?sessionId=` 绑定目标。 */
  const sessionId = async () => {
    const value = await get("/api/state");
    return value?.sessionId ?? value?.agents?.[0]?.id ?? "";
  };
  const withSession = (path, id) =>
    id === "" ? path : `${path}${path.includes("?") ? "&" : "?"}sessionId=${id}`;

  return {
    "session:list": async () => ((await get("/api/sessions"))?.rows ?? []).map(toSessionMeta),
    "session:listAll": async () => ((await get("/api/sessions"))?.rows ?? []).map(toSessionMeta),
    "session:getLoaded": async () => {
      const value = await get("/api/state");
      if (!value?.sessionId) return [];
      return [toSessionMeta({ id: value.sessionId, cwd: value.cwd, name: value.name })];
    },
    "session:getMessages": async () => (await get("/api/state"))?.messages ?? [],
    "session:stats": async () => (await get("/api/state"))?.stats ?? null,
    "session:getContextUsage": async () => (await get("/api/state"))?.usage ?? null,
    // `/api/interactions` 实测返回 { rows: [] }，不是裸数组。
    "session:getPendingInteractions": async () => (await get("/api/interactions"))?.rows ?? [],
    "session:listSlashCommands": async () => (await get("/api/commands"))?.rows ?? [],
    "session:listSlashCommandsForCwd": async () => (await get("/api/commands"))?.rows ?? [],
    "session:create": async (args) =>
      await post("/api/command", {
        command: "create",
        ...(args?.options?.cwd ? { cwd: args.options.cwd } : {}),
        ...(args?.options?.name ? { name: args.options.name } : {}),
      }),
    "session:prompt": async (args) =>
      await post("/api/prompt", {
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
      }),
    "session:abort": async () => await post("/api/abort", {}),
    "session:setModel": async (args) =>
      await post("/api/model", {
        provider: String(args?.provider ?? ""),
        id: String(args?.modelId ?? ""),
        sessionId: await sessionId(),
      }),
    "session:setThinkingLevel": async (args) =>
      await post("/api/thinking", {
        level: String(args?.level ?? "off"),
        sessionId: await sessionId(),
      }),
    "session:compact": async (args) =>
      await post("/api/command", {
        command: "compact",
        ...(args?.customInstructions ? { instructions: args.customInstructions } : {}),
      }),
    "session:fork": async (args) =>
      await post("/api/command", {
        command: "fork",
        ...(args?.ref?.entryId ? { entryId: args.ref.entryId } : {}),
      }),
    "models:list": async () => (await get("/api/state"))?.models ?? [],
    // `/api/providers` 实测返回 { revision, rows: [] }。
    "settings:listProviders": async () => (await get("/api/providers"))?.rows ?? [],
    // `/api/files` 空路径返回目录列表（kind: "directory", entries）。
    "project:listFiles": async () => await get("/api/files"),
    "project:getGitBranch": async () => {
      const body = await get(withSession("/api/git", await sessionId()));
      return body?.branch ?? null;
    },
    "project:listGitBranches": async () => {
      const body = await get(withSession("/api/git", await sessionId()));
      return body?.branches ?? [];
    },
    // `/api/mcp` 实测返回 { pending, revisions, rows, supported }。
    "mcp:configList": async () => (await get("/api/mcp"))?.rows ?? [],

    // ── 包管理 ────────────────────────────────────────────────────────────
    // `/api/package` 的 body 是 { action, ...params }，由 packageManagement 解释。
    "packages:listConfigured": async () => {
      const body = await get("/api/package");
      return body?.rows ?? [];
    },
    "packages:install": async (args) =>
      await post("/api/package", { action: "install", name: String(args?.name ?? "") }),
    "packages:remove": async (args) =>
      await post("/api/package", {
        action: "remove",
        source: String(args?.source ?? ""),
        scope: String(args?.scope ?? "user"),
      }),
    // 目录搜索是 GET `/api/package-catalog?name=`；结果是 HTML，不是结构化列表。
    "packages:searchCatalog": async (args) =>
      await get(`/api/package-catalog?name=${encodeURIComponent(String(args?.query ?? ""))}`),

    // ── MCP ───────────────────────────────────────────────────────────────
    "mcp:configUpsert": async (args) =>
      await post("/api/mcp-action", args ?? {}),
    "mcp:configRemove": async (args) =>
      await post("/api/mcp-action", { ...args, remove: true }),
    "mcp:configReload": async () => await get("/api/mcp"),

    // ── 权限与信任 ────────────────────────────────────────────────────────
    // /api/approval 的 body 是 { mode }；只支持切换审批模式，不支持单次 allow/deny。
    "permission:getConfig": async () => {
      const state = await get("/api/state");
      return { mode: state?.approvalMode ?? "ask-risky" };
    },
    "permission:getMode": async () => (await get("/api/state"))?.approvalMode ?? null,
    "permission:setMode": async (args) =>
      await post("/api/approval", { mode: String(args?.mode ?? "") }),
    "trust:respond": async (args) =>
      await post("/api/project-trust", {
        trusted: args?.answer === 1 || args?.answer === true,
        id: args?.requestId,
      }),
    "extension-dialog:respond": async (args) =>
      await post("/api/interaction-reply", args ?? {}),

    // ── 项目 ──────────────────────────────────────────────────────────────
    "project:ensureTrust": async (args) =>
      await post("/api/project-trust", { trusted: true, id: args?.cwd }),
    "project:validateDirectory": async (args) =>
      await post("/api/workspace/command", {
        command: "validate",
        path: String(args?.path ?? ""),
      }),
    "project:checkoutBranch": async (args) =>
      await post("/api/command", { command: "git", action: "checkout", branch: args?.branch }),

    // ── 设置：provider 与登录 ─────────────────────────────────────────────
    // /api/provider 与 /api/provider-remove 都要 revision（配置版本围栏）。
    "settings:saveApiKey": async (args) => {
      const revision = await providerRevision(get);
      return await post("/api/provider", { ...args, revision });
    },
    "settings:removeCredential": async (args) => {
      const revision = await providerRevision(get);
      return await post("/api/provider-remove", { id: args?.providerId, revision });
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
      return await post("/api/provider", { id: args?.providerId, baseUrl: args?.baseUrl, revision });
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
    "settings:listSubagents": async () => (await get("/api/subagent-history"))?.rows ?? [],
    "uiPlugins:getConfig": async () => await get("/api/plugin-config"),
    "uiPlugins:list": async () => {
      const body = await get("/api/plugin");
      return body?.rows ?? body ?? [];
    },
    "uiPlugins:setEnabled": async (args) =>
      await post("/api/plugin", { id: args?.id, enabled: args?.enabled === true, revision: args?.revision }),
    "uiPlugins:setPluginEnabled": async (args) =>
      await post("/api/plugin", { id: args?.id, enabled: args?.enabled === true, revision: args?.revision }),
    "uiPlugins:readCode": async (args) =>
      await get(`/api/plugin-resources?id=${encodeURIComponent(String(args?.id ?? ""))}`),
    // 以下五个由工作空间数据目录承载：页面刷新后必须读回同一份值。
    "uiState:load": async () => (await get("/api/ui-state"))?.value ?? null,
    "uiState:save": async (args) =>
      (await post("/api/ui-state", { value: args?.value ?? args ?? {} }))?.value ?? null,
    "environmentUi:load": async () =>
      (await get("/api/environment-ui-state"))?.value ?? null,
    "environmentUi:save": async (args) =>
      (await post("/api/environment-ui-state", { value: args?.value ?? args ?? {} }))?.value ?? null,
    "app:getDailyDir": async () => (await get("/api/daily-dir"))?.path ?? "",
    // 跨设备互联：状态含二维码，Percho 的设置页直接渲染。
    "lan:getStatus": async () => (await get("/api/lan"))?.status ?? null,
    "lan:setEnabled": async (args) =>
      (await post("/api/lan", { enabled: args?.enabled === true }))?.status ?? null,
    "lan:setRemoteControl": async (args) =>
      (await post("/api/lan", { remoteControl: args?.remoteControl === true }))?.status ?? null,
  };
}
