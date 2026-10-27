import { HostApiUnsupported } from "./host-api.mjs";

const WORKER_READY_TIMEOUT_MS = 15000;

const timestamp = (value) => {
  const parsed =
    typeof value === "string" ? Date.parse(value) : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function toSessionMeta(row) {
  return {
    sessionId: String(row.sessionId ?? row.id),
    sessionFile:
      row.sessionFile ??
      row.nativeSessionPath ??
      row.nativeSessionFile ??
      `pi-desktop:${row.sessionId ?? row.id}`,
    cwd: row.cwd ?? "",
    name: row.name,
    active: row.active ?? row.status === "running",
    readOnly: row.readOnly === true,
    model: row.model
      ? {
          provider: row.model.provider,
          modelId: row.model.modelId ?? row.model.id,
        }
      : null,
    thinkingLevel: row.thinkingLevel ?? null,
    messageCount: row.messageCount ?? 0,
    createdAt: timestamp(row.createdAt),
    modifiedAt: timestamp(row.modifiedAt ?? row.updatedAt ?? row.createdAt),
  };
}

/** 将界面的不透明会话身份解析为拥有它的 Host/worker；不依赖「当前默认会话」。 */
export function createSessionTransport({ get, post }) {
  const composerWrites = new Map();
  let mode;
  let catalog;
  let lastSession;
  const detect = () =>
    (mode ??= get("/api/workspace").then(
      () => true,
      (error) => {
        if (error.status !== 404) throw error;
        return false;
      },
    ));
  async function list() {
    if (await detect()) {
      catalog = await get("/api/workspace");
      return catalog.agents
        .filter((row) => !row.archived)
        .flatMap((row) => {
          const cwd =
            catalog.projects.find((p) => p.id === row.projectId)?.cwd ??
            row.cwd ??
            "";
          const root = toSessionMeta({
            ...row,
            cwd,
            readOnly: row.source === "pi",
            sessionId: row.id,
          });
          return [
            root,
            ...(row.branches ?? []).map((branch) =>
              toSessionMeta({
                ...row,
                ...branch,
                cwd,
                sessionId: `${row.id}/${branch.id}`,
                sessionFile: `pi-desktop:${row.id}/${branch.id}`,
              }),
            ),
          ];
        });
    }
    const state = await get("/api/state");
    return (state.agents ?? []).map((row) =>
      toSessionMeta({ ...row, active: true }),
    );
  }
  async function target(id) {
    if (!id) {
      id =
        lastSession ??
        (await list()).find((row) => row.active)?.sessionId ??
        (await list())[0]?.sessionId;
      if (!id) throw new Error("请先创建或打开会话");
    }
    if (await detect()) {
      const [owner, branch] = String(id).split("/");
      if (!catalog?.agents.some((row) => row.id === owner)) await list();
      let agent = catalog.agents.find((row) => row.id === owner);
      if (!agent) throw new Error("会话不存在");
      // Host 先返回页面，再恢复 desired workers；只等已明确请求启动的进程，不隐式启动历史。
      const deadline = Date.now() + WORKER_READY_TIMEOUT_MS;
      while (agent.desired && ["stopped", "starting"].includes(agent.status)) {
        if (Date.now() >= deadline)
          throw new Error("Agent 启动超时，请检查本机配置");
        await new Promise((resolve) => setTimeout(resolve, 100));
        await list();
        agent = catalog.agents.find((row) => row.id === owner);
        if (!agent) throw new Error("会话已移除");
      }
      return {
        id: String(id),
        owner,
        numeric: branch === undefined ? undefined : Number(branch),
        prefix: `/agents/${owner}`,
      };
    }
    if (!/^\d+$/.test(String(id))) throw new Error("会话 ID 无效");
    return { id: String(id), numeric: Number(id), prefix: "" };
  }
  async function path(route, id) {
    const selected = await target(id);
    return (
      selected.prefix +
      route +
      (selected.numeric === undefined
        ? ""
        : `${route.includes("?") ? "&" : "?"}sessionId=${selected.numeric}`)
    );
  }
  async function state(id) {
    return get(await path("/api/state", id));
  }
  async function describe(id) {
    const selected = await target(id);
    const value = await state(selected.id);
    const known = (await list()).find((row) => row.sessionId === selected.id);
    return toSessionMeta({
      ...known,
      ...value,
      id: selected.id,
      sessionId: selected.id,
      active: true,
      sessionFile: known?.sessionFile,
    });
  }
  async function command(command, args) {
    const selected = await target(args.sessionId);
    const current = await state(selected.id);
    return post(await path("/api/command", selected.id), {
      ...args,
      command,
      instructions: args.customInstructions,
      id: Number(current.sessionId),
      sessionId: String(current.sessionId),
    });
  }
  async function open(filePath) {
    const rows = await list();
    const row = rows.find(
      (row) => row.sessionFile === filePath || row.sessionId === filePath,
    );
    if (!row) throw new Error("会话文件不在当前工作空间中");
    const selected = await target(row.sessionId);
    if (selected.owner && !row.readOnly && !row.active) {
      await post("/api/workspace/command", {
        command: "agent.start",
        id: selected.owner,
      });
      await list();
    }
    lastSession = selected.id;
    return describe(selected.id);
  }
  async function create(options = {}) {
    let id;
    if (await detect()) {
      await list();
      let projectId = null;
      if (options.cwd && options.cwd !== (await get("/api/daily-dir")).path) {
        let project = catalog.projects.find((row) => row.cwd === options.cwd);
        project ??= await post("/api/workspace/command", {
          command: "project.save",
          cwd: options.cwd,
        });
        projectId = project.id;
      }
      const created = await post("/api/workspace/command", {
        command: "conversation.create",
        projectId,
      });
      id = created.id;
      await list();
    } else {
      const created = await post("/api/command", {
        command: "create",
        ...options,
      });
      id = String(created.sessionId ?? created.id);
    }
    lastSession = id;
    if (options.provider && options.modelId)
      await post(await path("/api/model", id), {
        provider: options.provider,
        id: options.modelId,
      });
    if (options.thinkingLevel)
      await post(await path("/api/thinking", id), {
        level: options.thinkingLevel,
      });
    return describe(id);
  }
  return {
    detect,
    list,
    target,
    path,
    state,
    describe,
    open,
    create,
    command,
    mirrorComposer(id, text) {
      const writing = (composerWrites.get(id) ?? Promise.resolve())
        .catch(() => {})
        .then(() => this.post("/api/composer", { text }, id));
      composerWrites.set(id, writing);
      return writing;
    },
    async flushComposer(id) {
      await composerWrites.get(id);
    },
    async get(route, id) {
      return get(await path(route, id));
    },
    async post(route, input, id) {
      return post(await path(route, id), input);
    },
    async loaded() {
      const rows = await list();
      return Promise.all(
        rows
          .filter((row) => row.active)
          .map(async (meta) => {
            const value = await state(meta.sessionId);
            return {
              meta: {
                ...meta,
                model: value.model
                  ? { provider: value.model.provider, modelId: value.model.id }
                  : null,
                thinkingLevel: value.thinkingLevel,
              },
              sequence: 0,
              followUpQueue: [],
              permissionMode: "default",
              streaming: value.idle === false,
              compacting: false,
            };
          }),
      );
    },
    async close(id) {
      // 关闭 GUI tab 不停止独立 Agent；GC 同样只释放前端的历史和订阅。
      return { closed: (await state(id)).idle !== false };
    },
    async rename(id, name) {
      const selected = await target(id);
      if (selected.owner && selected.numeric === undefined)
        return post("/api/workspace/command", {
          command: "agent.rename",
          id: selected.owner,
          name,
        });
      const current = await state(id);
      return command("configure", {
        sessionId: id,
        revision:
          current.agentRevision ??
          (await this.get("/api/agent", id)).active.revision,
        name,
      });
    },
    async archive(id) {
      const selected = await target(id);
      if (!selected.owner || selected.numeric !== undefined)
        throw new HostApiUnsupported(
          "session:delete",
          "当前宿主只提供独立 Agent 的归档，不提供族内分支删除",
        );
      const current = await state(id);
      if (
        current.idle === false ||
        current.agents?.some((row) => row.idle === false)
      )
        throw new Error("正在运行的会话不能归档");
      await post("/api/workspace/command", {
        command: "agent.stop",
        id: selected.owner,
      });
      return post("/api/workspace/command", {
        command: "agent.archive",
        id: selected.owner,
      });
    },
  };
}
