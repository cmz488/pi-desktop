import { HostApiUnsupported } from "./host-api.mjs";

export async function referencedMessage(sessions, args, role) {
  const state = await sessions.state(args.sessionId);
  if (!state.sessionCommands)
    throw new HostApiUnsupported(
      "session:branch",
      "当前兼容宿主未提供分支写入，请使用 Pi 原生会话命令",
    );
  const ref = args.ref ?? {};
  const matches = (state.messages ?? []).filter(
    (row) =>
      row.role === role &&
      row.entryId !== undefined &&
      (ref.entryId !== undefined
        ? String(row.entryId) === String(ref.entryId)
        : ref.text !== undefined &&
          (row.text === ref.text || row.presentation?.original === ref.text) &&
          (ref.timestamp === undefined ||
            Number(row.eventKey ?? row.timestamp) === ref.timestamp)),
  );
  const ids = new Set(matches.map((row) => Number(row.entryId)));
  if (ids.size !== 1 || !Number.isSafeInteger([...ids][0]))
    throw new Error("消息位置不明确，请等待历史同步后重试");
  return matches.at(-1);
}

export async function exportSession(sessions, args) {
  const snapshot = await sessions.get("/api/session-export", args.sessionId);
  const jsonl =
    [snapshot.header, ...snapshot.entries]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
  if (args.format === "jsonl") return jsonl;
  if (args.format !== "html") throw new Error("导出格式无效");
  const escaped = jsonl.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pi 会话原生记录</title></head><body><h1>Pi 会话原生记录</h1><pre>${escaped}</pre></body></html>`;
}

/** Translate existing Host inventories, without creating a second configuration store. */
export function slashCommandViews(rows) {
  return rows.map((row) => ({
    ...row,
    source: row.source === "prompt" ? "template" : row.source,
    supported: true,
  }));
}

export function providerViews(inventory) {
  const rows = new Map((inventory.rows ?? []).map((row) => [row.id, row]));
  return [
    ...new Map(
      [...(inventory.catalog ?? []), ...rows.values()].map((row) => [
        row.id,
        row,
      ]),
    ).values(),
  ].map((entry) => {
    const row = rows.get(entry.id) ?? entry;
    return {
      ...row,
      name: row.name ?? row.id,
      custom: row.custom === true,
      configured: row.keyConfigured === true,
      ...(row.auth?.oauth ? { oauth: {} } : {}),
      apiKeyLogin: row.auth?.apiKey === true,
      models: row.models ?? [],
    };
  });
}

export function mcpView(inventory) {
  const view = (row) => ({
    name: row.name,
    source: row.scope === "project" ? "project" : "user",
    transport: row.config.url
      ? { kind: "url", url: row.config.url }
      : row.config.command
        ? {
            kind: "stdio",
            command: row.config.command,
            args: row.config.args ?? [],
          }
        : { kind: "unknown" },
    description: row.config.description,
    enabled: row.enabled,
    exposureRaw: row.config.exposure,
    exposure: row.config.exposure ?? "codemode",
    toolExposure: row.config.toolExposure,
    tools: row.tools ?? [],
  });
  return {
    global: (inventory.rows ?? [])
      .filter((row) => row.scope !== "project")
      .map(view),
    project: (inventory.rows ?? [])
      .filter((row) => row.scope === "project")
      .map(view),
    errors: [],
    projectTrusted: !(inventory.rows ?? []).some(
      (row) => row.scope === "project" && !row.trusted,
    ),
    globalPath: "用户 mcp.json",
    projectPath: "项目 .pi/mcp.json",
    ...(inventory.pending
      ? {
          notice: {
            level: "info",
            message: "配置已保存；请在设置的扩展分类中重载资源后生效。",
          },
        }
      : {}),
  };
}

/** A directory remains navigable; recursion only follows the user's current @ query. */
export async function projectFiles(get, path = "") {
  const value = await get(`/api/files?path=${encodeURIComponent(path)}`);
  if (value.kind !== "directory") throw new Error("文件补全目标不是目录");
  const prefix = path ? `${path.replace(/\/$/, "")}/` : "";
  return value.entries.map(
    (row) => `${prefix}${row.name}${row.directory ? "/" : ""}`,
  );
}

/** Native auth is a job, not a synchronous successful HTTP submission. */
export function createProviderLogins({ sessions, emit = () => {} }) {
  const jobs = new Map();
  async function start(args, key) {
    if (jobs.has(args.loginId)) throw new Error("登录已开始");
    const target = await sessions.target();
    const inventory = await sessions.get("/api/providers", target.id);
    const provider = [
      ...(inventory.rows ?? []),
      ...(inventory.catalog ?? []),
    ].find((row) => row.id === args.providerId);
    if (!provider) throw new Error("提供商不存在");
    const type =
      key === undefined && provider.auth?.oauth ? "oauth" : "api_key";
    const created = await sessions.post(
      "/api/auth-start",
      { provider: args.providerId, type },
      target.id,
    );
    const job = {
      id: created.id,
      sessionId: target.id,
      seen: new Set(),
      promptId: null,
    };
    jobs.set(args.loginId, job);
    try {
      for (;;) {
        const current = (
          await sessions.get("/api/interactions", target.id)
        ).rows.find((row) => row.id === job.id);
        if (!current) throw new Error("登录交互不存在");
        for (const event of current.events ?? []) {
          const identity = JSON.stringify(event);
          if (job.seen.has(identity)) continue;
          job.seen.add(identity);
          emit("onProviderLoginEvent", {
            loginId: args.loginId,
            kind: "event",
            event,
          });
        }
        if (current.status !== "running")
          return {
            ok: current.status === "complete",
            cancelled: current.status === "cancelled",
            ...(current.error ? { error: current.error } : {}),
          };
        if (current.prompt && current.prompt.id !== job.promptId) {
          job.promptId = current.prompt.id;
          if (key !== undefined) {
            if (!["secret", "text"].includes(current.prompt.type)) {
              await sessions.post(
                "/api/interaction-reply",
                { id: job.id, cancel: true },
                target.id,
              );
              throw new Error("此提供商需要交互登录，请使用登录按钮");
            }
            await sessions.post(
              "/api/interaction-reply",
              { id: job.id, promptId: current.prompt.id, value: key },
              target.id,
            );
            key = undefined;
          } else
            emit("onProviderLoginEvent", {
              loginId: args.loginId,
              kind: "prompt",
              promptId: current.prompt.id,
              prompt: current.prompt,
            });
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      jobs.delete(args.loginId);
    }
  }
  return {
    start,
    owns(sessionId, jobId) {
      return [...jobs.values()].some(
        (job) => job.sessionId === sessionId && job.id === jobId,
      );
    },
    async respond(args) {
      const job = jobs.get(args.loginId);
      if (!job) throw new Error("登录已结束");
      return sessions.post(
        "/api/interaction-reply",
        { id: job.id, promptId: args.promptId, value: args.value },
        job.sessionId,
      );
    },
    async cancel(args) {
      const job = jobs.get(args.loginId);
      if (!job) throw new Error("登录已结束");
      return sessions.post(
        "/api/interaction-reply",
        { id: job.id, cancel: true },
        job.sessionId,
      );
    },
  };
}

export { composerInput } from "../shared/composer-input.mjs";

export async function checkoutBranch(sessions, args, confirm) {
  const id = await sessions.forCwd(args.cwd);
  const preview = await sessions.post(
    "/api/git",
    { action: "switch", branch: args.branch },
    id,
  );
  if (!preview.token) throw new Error("Git 未提供确认令牌");
  if (!(await confirm(preview))) return;
  return sessions.post("/api/git", { token: preview.token }, id);
}
