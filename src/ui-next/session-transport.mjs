import { projectMessage } from "../shared/conversation.mjs";
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
    ...(row.branching === undefined && row.sessionCommands === undefined
      ? {}
      : { branching: row.branching ?? row.sessionCommands }),
    ...(row.archivable === undefined ? {} : { archivable: row.archivable }),
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
  let legacyState;
  let legacyRows;
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
            archivable: row.source !== "pi",
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
                archivable: false,
                sessionFile: `pi-desktop:${row.id}/${branch.id}`,
              }),
            ),
          ];
        });
    }
    legacyState = await get("/api/state");
    if (legacyState.host === "durable") {
      legacyRows = (legacyState.agents ?? []).map((row) =>
        toSessionMeta({ ...row, active: true, archivable: false }),
      );
    } else {
      const history = await get("/api/sessions");
      legacyRows = (history.rows ?? []).map((row) =>
        toSessionMeta({
          ...row,
          cwd: row.cwd ?? legacyState.cwd,
          sessionFile: row.sessionFile ?? row.path,
          modifiedAt: row.modified,
          active:
            row.live === true ||
            String(row.id) === String(legacyState.sessionId),
          branching: false,
          archivable: false,
        }),
      );
      if (
        !legacyRows.some(
          (row) => row.sessionId === String(legacyState.sessionId),
        )
      )
        legacyRows.push(
          toSessionMeta({
            ...legacyState,
            active: true,
            branching: false,
            archivable: false,
          }),
        );
    }
    return legacyRows;
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
    await list();
    if (!legacyRows.some((row) => row.sessionId === String(id)))
      throw new Error("会话不存在");
    if (legacyState.host === "durable") {
      if (!/^\d+$/.test(String(id))) throw new Error("会话 ID 无效");
      return { id: String(id), numeric: Number(id), prefix: "" };
    }
    if (!legacyRows.find((row) => row.sessionId === String(id))?.active)
      throw new Error("请先打开此会话");
    return { id: String(id), queryId: String(id), prefix: "" };
  }
  async function path(route, id) {
    const selected = await target(id);
    const explicit = new URL(route, "http://localhost").searchParams.get(
      "sessionId",
    );
    const expected = selected.queryId ?? selected.numeric;
    if (
      explicit !== null &&
      expected !== undefined &&
      explicit !== String(expected)
    )
      throw new Error("会话参数与目标不一致");
    return (
      selected.prefix +
      route +
      (expected === undefined || explicit !== null
        ? ""
        : `${route.includes("?") ? "&" : "?"}sessionId=${encodeURIComponent(selected.queryId ?? selected.numeric)}`)
    );
  }
  async function state(id) {
    const value = await get(await path("/api/state", id));
    // Widgets are UI state, not transcript entries; combine them only for this view.
    if (value.widgets?.length)
      return {
        ...value,
        messages: [
          ...(value.messages ?? []),
          ...value.widgets.map((row) =>
            row.extensionView ? row : projectMessage(row, row.id),
          ),
        ],
      };
    return value;
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
    if (
      !(await detect()) &&
      legacyState.host !== "durable" &&
      String(legacyState.sessionId) !== row.sessionId
    ) {
      await post("/api/switch-session", { id: row.sessionId });
      await list();
    }
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
      await list();
      if (
        legacyState.host !== "durable" &&
        options.cwd &&
        options.cwd !== legacyState.cwd
      )
        throw new HostApiUnsupported(
          "session:create",
          "兼容模式的工作目录由 Pi TUI／SDK 拥有，请在原宿主更改",
        );
      const created =
        legacyState.host === "durable"
          ? await post("/api/command", { command: "create", ...options })
          : await post("/api/new-session", {});
      id = String(
        created.sessionId ?? created.id ?? (await get("/api/state")).sessionId,
      );
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
    select(id) {
      lastSession = id ?? undefined;
    },
    detect,
    list,
    async forCwd(cwd, { required = true } = {}) {
      const rows = await list();
      const eligible = (row) =>
        (row.active ||
          catalog?.agents.some(
            (agent) =>
              agent.id === row.sessionId.split("/")[0] && agent.desired,
          )) &&
        (!cwd || row.cwd === cwd);
      const row =
        rows.find((row) => eligible(row) && row.sessionId === lastSession) ??
        rows.find(eligible);
      if (!row && required) throw new Error("请先在此项目创建或打开会话");
      return row?.sessionId;
    },
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
      const selected = await target(id);
      if (
        /^\/api\/git(?:\?|$)/.test(route) &&
        !new URL(route, "http://localhost").searchParams.has("sessionId")
      ) {
        const current = await state(selected.id);
        route += `${route.includes("?") ? "&" : "?"}sessionId=${encodeURIComponent(current.sessionId)}`;
      }
      return get(await path(route, selected.id));
    },
    async post(route, input, id) {
      const selected = await target(id);
      if (route === "/api/git") {
        const current = await state(selected.id);
        input = { sessionId: String(current.sessionId), ...input };
      }
      return post(await path(route, selected.id), input);
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
              permissionMode:
                value.active?.approvalMode === "yolo"
                  ? "fullAccess"
                  : "default",
              streaming: value.idle === false,
              compacting: value.activity?.kind === "compacting",
            };
          }),
      );
    },
    async close(id) {
      if (await detect()) {
        const owner = String(id).split("/")[0];
        const current = (await get("/api/workspace")).agents.find(
          (row) => row.id === owner,
        );
        if (!current || current.archived || current.status !== "running")
          return { closed: true };
      } else {
        await list();
        if (legacyState.host !== "durable")
          return {
            closed:
              String(legacyState.sessionId) !== String(id) ||
              legacyState.idle !== false,
          };
      }
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
      if (current.host !== "durable")
        return this.post("/api/prompt", { message: `/name ${name}` }, id);
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
