import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createDeskBridge } from "./bridge.mjs";
import { createDesktopBtw } from "../agent/btw-desktop.mjs";
import { sendJson } from "./http-transfer.mjs";
import { createTaskWaits } from "./task-waits.mjs";
import { openAgentWorkspace } from "../agent/agent-workspace.mjs";
import { openDurableModels } from "../agent/durable-models.mjs";
import { createDurableResources } from "../agent/durable-resources.mjs";
import { createAgentBrowser } from "../agent/agent-browser.mjs";
import { createInteractionStore } from "../agent/interaction-store.mjs";
import { webCommands } from "../shared/pi-commands.mjs";
import { projectMessage } from "../shared/conversation.mjs";
import { ownedConversationIds } from "../shared/conversation-scope.mjs";
import { createAgentSnapshot } from "./agent-snapshot.mjs";
import { openNativeTranscriptFamily } from "../session/native-transcript-family.mjs";
import { readNativeRecord } from "../session/pi-session-storage.mjs";
import { gitInfo } from "../git/workspace-info.mjs";
import { DeskError, readDocument } from "../config/config-store.mjs";
import { attachmentLimits } from "./context-attachments.mjs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import manifest from "../../package.json" with { type: "json" };
import { parseSessionsCommand } from "../tui/sessions-command.mjs";
import {
  embeddedSdkEntry,
  configurePiNetwork,
  loadEmbeddedPiSdk,
  loadPiSettingsManager,
} from "../agent/pi-sdk.mjs";

/**
 * Durable worker HTTP：适配原生会话、资源与任务；不拥有额外执行循环。
 *
 * 接口：startDurableDesk(options) 返回 worker 服务；loadDurableExtension 加载具名扩展；
 *   读取与命令见 interfaces/session-tree.md、task-graph.md、host-tasks.md。
 * 不变量：请求目标与权限先于操作；后台恢复不趁前台 idle 覆盖配置；管理只沿原生
 *   owned 范围，等待只拥有可取消观察；远程网关范围不因新命令扩大。
 * 错误：HTTP 以 DeskError 表达 403／404／409／422／429；原生执行结果保留其终态。
 */
const commands = new Set([
  "create",
  "send",
  "configure",
  "abort",
  "compact",
  "fork",
  "rewind",
  "wait",
  "cancel",
  "subagent.spawn",
]);
async function body(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 768 * 1024) throw new DeskError(413, "请求内容过大");
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error();
    return input;
  } catch {
    throw new DeskError(400, "请求不是有效 JSON 对象");
  }
}
const json = (response, value) => sendJson(response, 200, value);
export async function loadDurableExtension(file) {
  const path = resolve(file),
    info = await stat(path),
    url = pathToFileURL(path);
  url.searchParams.set("revision", `${info.mtimeMs}:${info.size}`);
  const extension = (await import(url.href)).default;
  if (
    !extension ||
    typeof extension !== "object" ||
    typeof extension.name !== "string"
  )
    throw new Error(
      `Durable 扩展须 default 导出 defineExtension 对象：${path}`,
    );
  return extension;
}

// Durable and native TUI are two adapters at the existing Desktop seam. The
// existing bridge, page, Git, settings and package modules remain authoritative.
export async function startDurableDesk(options = {}) {
  const agentDir = resolve(
    options.agentDir ??
      process.env.PI_CODING_AGENT_DIR ??
      join(homedir(), ".pi", "agent"),
  );
  const directory = resolve(options.directory ?? join(agentDir, "desktop"));
  // Start the SDK graph in parallel with everything below; only the steps that
  // need its namespace await it. The early network step uses the same package's
  // settings submodule so a fresh host does not serialize behind the whole SDK.
  const sdkReady = loadEmbeddedPiSdk();
  // The model transport uses Node fetch, even when owned by Electron. Reuse
  // Pi's dispatcher so HTTP(S)_PROXY, NO_PROXY, settings and timeouts all apply.
  const networkSettings = (
    await loadPiSettingsManager()
  ).SettingsManager.create(options.cwd ?? process.cwd(), agentDir, {
    projectTrusted: false,
  });
  if (!(await configurePiNetwork(networkSettings, embeddedSdkEntry)))
    throw new DeskError(503, "无法初始化 Pi 网络配置，请更新资源 SDK");
  const providers =
    options.providers ??
    (options.workspace
      ? undefined
      : await openDurableModels({ agentDir, directory }));
  let policy = (await readDocument(join(agentDir, "settings.json"))).data;
  const settings = {
    get compaction() {
      return policy.compaction;
    },
    get retry() {
      const { provider, ...retry } = policy.retry ?? {};
      return retry;
    },
    get stream() {
      return { transport: policy.transport, ...policy.retry?.provider };
    },
    get steeringMode() {
      return policy.steeringMode;
    },
    get followUpMode() {
      return policy.followUpMode;
    },
  };
  let bridge, workspace, root, stopPromise, transcripts;
  let nativeOpening;
  const desktopBtw = createDesktopBtw();
  const browser =
    options.embeddedUI && options.agentBrowser !== false
      ? await createAgentBrowser({
          directory,
          cwd: options.cwd ?? process.cwd(),
          readOnly: !!options.readOnly,
          onChange: () => bridge?.publish("browser_changed", {}),
        })
      : undefined;
  const requestState = new AsyncLocalStorage();
  const taskWaits = createTaskWaits();
  const extensions = [];
  for (const file of options.extensionPaths ?? [])
    extensions.push(await loadDurableExtension(file));
  const resources =
    options.resources === false || (options.workspace && !options.agentDir)
      ? undefined
      : createDurableResources({
          agentDir,
          providers,
          durableTools: extensions.flatMap(
            (extension) => extension.tools ?? [],
          ),
          noExtensions: options.readOnly || options.noExtensions,
          readOnly: options.readOnly,
          approvalMode: options.approvalMode,
          nativeResources: options.nativeResources,
          nativeSnapshot: async (id) => {
            await initializeNative(workspace);
            if (!transcripts) throw new DeskError(503, "原生快照尚未建立");
            return transcripts.snapshot(id);
          },
          browser,
          onEvent: (kind, data) => bridge?.publish(kind, data),
        });
  async function initializeNative(target) {
    if (transcripts || (!options.nativeSessionOwner && !resources)) return;
    const state = await target.read();
    if (!state.agents[0]) return;
    return (nativeOpening ??= (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      transcripts = await openNativeTranscriptFamily({
        agentDir,
        directory,
        agents: state.agents,
        owner: options.nativeSessionOwner ?? `workspace:${directory}`,
        nativeId: options.nativeSessionOwner ? undefined : randomUUID(),
        branches: !!options.singleAgent,
        resumePath: options.nativeResumePath,
        pathHint: options.nativeSessionPath,
        workspace: target,
      });
    })());
  }
  const auth = createInteractionStore(() =>
    bridge?.publish("interaction_changed", {}),
  );
  try {
    workspace =
      options.workspace ??
      (await openAgentWorkspace({
        storagePath: join(directory, "agents.sqlite"),
        models: providers.models,
        availableModels: providers.availableModels,
        extensions,
        settings,
        ...options.workspaceOptions,
        readOnly: options.readOnly,
        approvalMode: options.approvalMode,
        sharedApproval: options.singleAgent === true,
        initialize: async (target) => {
          workspace = target;
          await resources?.attach(target);
        },
      }));
    if (options.workspace) await resources?.attach(workspace);
    // Resource sessions (tool scope, extensions, interactions) need the SDK.
    const sdk = await sdkReady;
    root = await workspace.read();
    if (!root.agents.length) {
      const settings = (await readDocument(join(agentDir, "settings.json")))
        .data;
      const preferred =
        root.models.find(
          (model) =>
            model.provider === settings.defaultProvider &&
            model.modelId === settings.defaultModel,
        ) ?? root.models[0];
      const created = await workspace.execute("create", {
        cwd: options.cwd ?? process.cwd(),
        name: options.agentName ?? "新会话",
        ...(preferred
          ? {
              model: {
                provider: preferred.provider,
                modelId: preferred.modelId,
              },
            }
          : {}),
        thinkingLevel: settings.defaultThinkingLevel ?? "medium",
      });
      if (options.nativeSessionPath && !options.nativeResumePath) {
        const record = await readNativeRecord(
          options.nativeSessionPath,
          agentDir,
        );
        if (
          record.entries.some(
            (entry) =>
              entry.customType === "pi-desktop-origin" &&
              entry.data?.nativeSessionId === record.header.id,
          )
        ) {
          const native = sdk.SessionManager.inMemory(
            undefined,
            undefined,
            record.entries,
          );
          // 首次 SDK 资源 Session 就应看到继承状态；重建 Session 会重复执行启动钩子。
          await workspace.persistNative(
            created.id,
            native
              .getBranch()
              .filter(
                (entry) =>
                  entry.type === "custom" &&
                  !entry.customType.startsWith("pi-desktop-"),
              )
              .map(({ customType, data }) => ({
                customType,
                ...(data === undefined ? {} : { data }),
              })),
            [],
            { seedDigest: record.digest },
          );
        }
      }
      await resources?.selectTools((await workspace.read(created.id)).active, {
        defaults: true,
      });
    } else if (resources) {
      for (const agent of root.agents)
        if (
          agent.idle &&
          (!agent.nativeInitialized ||
            (browser &&
              agent.nativeDefaults &&
              !agent.tools.includes("agent_browser")))
        )
          await resources.selectTools((await workspace.read(agent.id)).active, {
            defaults: true,
          });
    }
    root = await workspace.read();
    if (
      options.singleAgent &&
      root.agents[0]?.idle &&
      // 前台 idle 不涵盖 background／owned 工作；启动时不能趁其恢复改写共享配置。
      !root.tasks.length &&
      (options.agentName !== undefined ||
        options.agentInstructions !== undefined)
    ) {
      const first = root.agents[0];
      await workspace.execute("configure", {
        id: first.id,
        revision: first.revision,
        ...(options.agentName === undefined ? {} : { name: options.agentName }),
        ...(options.agentInstructions === undefined
          ? {}
          : { instructions: options.agentInstructions }),
      });
      root = await workspace.read();
    }
    await initializeNative(workspace);
    root = await workspace.read();
    const target = () => {
      const ctx = requestState.getStore();
      if (!ctx?.active) throw new DeskError(422, "请选择 Agent");
      return ctx;
    };
    const native = () => target().native;
    const interactionOwner = () =>
      requestState.getStore()?.active?.id ??
      requestState.getStore()?.interactionOwner ??
      root.agents[0]?.id;
    const interactionScope = () =>
      ownedConversationIds(interactionOwner(), root.children);
    const current = () =>
      requestState.getStore()?.snapshot ?? {
        ...root,
        cwd: options.cwd ?? process.cwd(),
        models: root.models.map((row) => ({ ...row, id: row.modelId })),
        sessionId: "",
        idle: true,
      };
    const familyIdle = () =>
      root.agents.every((agent) => agent.idle) && !root.tasks.length;
    const sharedWritable = () =>
      familyIdle() && !auth.running && (resources?.canWrite() ?? true);
    const configure = async (patch, { defer = false } = {}) => {
      const ctx = target();
      return workspace.execute("configure", {
        id: ctx.active.id,
        revision: ctx.active.revision,
        ...patch,
        ...(defer ? { defer: true } : {}),
      });
    };
    const applyingConfigurations = new Map();
    const applyDeferredConfiguration = (id) => {
      if (applyingConfigurations.has(id)) return applyingConfigurations.get(id);
      const applying = (async () => {
        const { active } = await workspace.read(id);
        if (!active.idle || !active.pendingConfiguration) return;
        await workspace.execute("configure", {
          id,
          revision: active.revision,
          ...active.pendingConfiguration,
        });
      })().finally(() => applyingConfigurations.delete(id));
      applyingConfigurations.set(id, applying);
      return applying;
    };
    const create = async (input = {}) => {
      if (options.singleAgent)
        throw new DeskError(409, "请在 Desktop 项目栏创建独立 Agent");
      const ctx = requestState.getStore();
      const model =
        input.model ??
        (ctx?.active?.model ||
          (root.models[0] && {
            provider: root.models[0].provider,
            modelId: root.models[0].modelId,
          }));
      const result = await workspace.execute("create", {
        cwd: input.cwd ?? ctx?.active?.cwd ?? options.cwd ?? process.cwd(),
        name: input.name ?? "新会话",
        ...(input.instructions === undefined
          ? {}
          : { instructions: input.instructions }),
        ...(input.shellPath === undefined
          ? {}
          : { shellPath: input.shellPath }),
        ...(input.shellEnv === undefined ? {} : { shellEnv: input.shellEnv }),
        ...(input.extensions === undefined
          ? {}
          : {
              extensions:
                resources?.normalizeExtensions(input.extensions) ??
                input.extensions,
            }),
        ...(model ? { model } : {}),
        thinkingLevel:
          input.thinkingLevel ??
          ctx?.active?.thinkingLevel ??
          policy.defaultThinkingLevel ??
          "medium",
      });
      await resources?.selectTools((await workspace.read(result.id)).active, {
        defaults: true,
      });
      if (input.tools !== undefined) {
        const active = (await workspace.read(result.id)).active;
        await workspace.execute("configure", {
          id: result.id,
          revision: active.revision,
          tools: input.tools,
        });
      }
      root = await workspace.read();
      return { ...result, sessionId: String(result.id) };
    };
    /* 退回：上下文用 Pi 从原生会话树推导出的退回点前缀重建，Durable 只提交标记；
     * 原生 leaf 的移动由紧随其后的同步循环完成。 */
    const rewind = async (input = {}) => {
      // 退回必须移动该分支自己的原生 leaf，不能借用根会话的转录句柄。
      const transcript = transcripts?.get(input.id);
      if (!transcript)
        throw new DeskError(409, "该会话没有原生转录，不能退回；可改用分叉");
      // 界面可以只给模式：会话栏的「退回分支」退回最后一条用户消息，具体目标由宿主解析。
      const entryId = Number.isSafeInteger(input.entryId)
        ? input.entryId
        : input.mode === "last-user"
          ? await lastMessageEntryId(input.id, { role: "user" })
          : undefined;
      if (!Number.isSafeInteger(entryId))
        throw new DeskError(422, "没有可退回的消息");
      await transcript.sync();
      const replay = transcript.rewindContext(entryId);
      if (!replay?.messages.length)
        throw new DeskError(409, "退回位置尚未写入原生会话，请稍后重试");
      const result = await workspace.execute("rewind", {
        id: input.id,
        entryId,
        messages: replay.messages,
        origins: replay.origins,
      });
      await transcripts?.sync(root.agents);
      root = await workspace.read();
      return result;
    };
    /* 活跃上下文里最后一条（可按角色过滤的）消息的 entry id：会话栏的「创建分支／退回分支」
     * 用它解析目标，界面不必自己猜条目，也自然避开被放弃的路径。 */
    const lastMessageEntryId = async (id, { role } = {}) => {
      const state = await workspace.read(id);
      return (
        (state.active?.messages ?? [])
          // 资源状态卡片是 UI 投影，没有 Durable entry，不能遮住真实的分支检查点。
          .filter(
            (row) =>
              Number.isSafeInteger(row.entryId) &&
              (role === undefined || row.role === role),
          )
          .at(-1)?.entryId
      );
    };
    async function reload() {
      const ctx = target();
      if (!sharedWritable())
        throw new DeskError(409, "请等待所有 Agent 空闲后重载资源");
      for (const agent of root.agents) {
        const active = (await workspace.read(agent.id)).active;
        await resources?.reload(active);
      }
      for (const file of options.extensionPaths ?? [])
        workspace.install(await loadDurableExtension(file));
      await providers?.reload();
      policy = (await readDocument(join(agentDir, "settings.json"))).data;
      root = await workspace.read();
    }
    bridge = createDeskBridge({
      ...options,
      agentDir,
      capabilities: {
        sessions: true,
        remote: true,
        newSession: true,
        switchSession: true,
        sessionCommand: true,
        canManageSessions: true,
        packageManagement: Boolean(resources),
        packageUpdates: Boolean(resources),
        packageRoot: true,
        skills: Boolean(resources),
        mcp: Boolean(resources),
        interactions: true,
        reload: true,
        auth: Boolean(providers),
        authLogout: Boolean(providers),
        providerInventory: Boolean(providers),
        providerCatalog: false,
        providerSave: Boolean(providers),
        providerRemove: Boolean(providers),
        model: true,
        thinking: true,
        trustProject: Boolean(resources),
        prompt: true,
        abort: true,
        btw: true,
        settings: true,
        canSaveSettings: true,
        projectTrusted: true,
        canWrite: true,
        canEditShared: true,
        validateTarget: true,
        canSetThinking: true,
        canDeferConfiguration: true,
        settingsChanged: true,
        gitChanged: false,
        revision: true,
        sessionTree: true,
        tasks: true,
        taskDetails: workspace.capabilities?.taskInspection === true,
        route: true,
        requestContext: true,
      },
      modelsPath: join(directory, "models.json"),
      host: options.host ?? process.env.PI_DESK_HOST ?? "127.0.0.1",
      port: options.port ?? process.env.PI_DESK_PORT ?? 0,
      snapshot: current,
      btw: (input) => {
        const active = target().active;
        const model = active.model
          ? providers?.models.getModel(
              active.model.provider,
              active.model.modelId,
            )
          : undefined;
        return desktopBtw.handle(input, {
          sessionId: String(active.id),
          model,
          modelRegistry: providers?.models,
          thinkingLevel: active.thinkingLevel,
          messages: active.messages ?? [],
        });
      },
      projectTrusted: () =>
        !options.readOnly && (native()?.read().projectTrusted ?? true),
      effectiveSettings: () => native()?.read().effectiveSettings ?? {},
      canWrite: () =>
        !!requestState.getStore()?.active?.idle &&
        !auth.running &&
        (native()?.read().canWrite ?? true),
      canDeferConfiguration: () =>
        !!requestState.getStore()?.active && !auth.running,
      canEditShared: sharedWritable,
      canManageSessions: () => true,
      canSetThinking: () =>
        !!requestState.getStore()?.active?.idle && !auth.running,
      validateTarget(input) {
        if (
          input.sessionId !== undefined &&
          String(input.sessionId) !== current().sessionId
        )
          throw new DeskError(409, "Agent 已变化，请刷新后重试");
      },
      async requestContext(request, response, run) {
        const url = new URL(request.url, "http://localhost");
        if (!url.pathname.startsWith("/api/")) return run();
        const authority = new URL(`http://${request.headers.host}`);
        if (
          request.headers.origin &&
          request.headers.origin !== authority.origin
        )
          throw new DeskError(403, "跨站请求被拒绝");
        if (
          request.method === "POST" &&
          (request.headers.origin !== authority.origin ||
            !/^application\/json(?:;|$)/i.test(
              request.headers["content-type"] ?? "",
            ))
        )
          throw new DeskError(403, "写入需要同源 JSON 请求");
        if (url.pathname === "/api/revision") {
          /* A polling probe answers from the state the host already holds: no
           * transcript sync, no workspace read and no resource host wake-up. */
          return requestState.run(
            {
              active: undefined,
              native: undefined,
              interactionOwner: Number(
                url.searchParams.get("sessionId") ?? root.agents[0]?.id,
              ),
            },
            run,
          );
        }
        const metadataOnly =
          request.method === "GET" &&
          !["/api/state", "/api/message-detail"].includes(url.pathname);
        const id =
          url.searchParams.get("sessionId") ?? url.searchParams.get("id");
        await transcripts?.sync(root.agents);
        root = await workspace.read();
        const selected =
          id === null || id === "" ? root.agents[0]?.id : Number(id);
        let result =
          selected === undefined
            ? root
            : metadataOnly
              ? { ...root, active: await workspace.agent(selected) }
              : await workspace.read(selected);
        const resourceHost = await resources?.ensure(result.active);
        if (resourceHost)
          result = metadataOnly
            ? { ...root, active: await workspace.agent(selected) }
            : await workspace.read(selected);
        const active = result.active;
        const remoteClient = request.headers["x-pi-remote-client"] === "1";
        const ctx = { active, native: resourceHost };
        const nativeInfo = resourceHost?.read();
        const nativeSnapshot = nativeInfo?.snapshot ?? {};
        const model =
          active?.model &&
          (providers?.models.getModel(
            active.model.provider,
            active.model.modelId,
          ) ??
            root.models.find(
              (row) =>
                row.provider === active.model.provider &&
                row.modelId === active.model.modelId,
            ));
        const levels = model?.id
          ? getSupportedThinkingLevels(model)
          : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        const calls = (active?.liveTools ?? [])
          .filter((call) => call.status !== "done")
          .map((call) => ({
            id: call.callId,
            name: call.name,
            arguments:
              (active.messages ?? [])
                .flatMap((message) => message.blocks)
                .find(
                  (block) =>
                    block.type === "toolCall" && block.id === call.callId,
                )?.arguments ?? "{}",
            output: call.output ?? "",
            status: call.status,
          }));
        const stats = {
          tokens: { ...active?.usage, total: active?.usage?.tokens ?? 0 },
          cost: active?.usage?.cost ?? 0,
        };
        ctx.snapshot = createAgentSnapshot({
          version: manifest.version,
          host: "durable",
          frameworkVersion: result.frameworkVersion,
          sessionId: active ? String(active.id) : "",
          name: active?.name ?? "新会话",
          cwd: active?.cwd ?? options.cwd ?? process.cwd(),
          idle: active?.idle ?? true,
          initializing: !!nativeSnapshot.initializing,
          operation: calls.length
            ? `执行 ${calls[0].name}…`
            : active?.compactions?.length
              ? "压缩上下文…"
              : "",
          activeTool: calls[0]?.name ?? "",
          compacting: !!active?.compactions?.length,
          statuses: nativeSnapshot.statuses ?? [],
          workingMessage: nativeSnapshot.workingMessage ?? "",
          model: model
            ? {
                provider: model.provider,
                id: model.id ?? model.modelId,
                name: model.name,
                input: model.input ?? ["text"],
              }
            : null,
          thinkingLevel: active?.thinkingLevel ?? "off",
          thinkingLevels: levels,
          thinkingEditable: !!active && !auth.running,
          models: root.models.map((row) => ({ ...row, id: row.modelId })),
          messages: [
            ...(active?.messages ?? []),
            ...(nativeSnapshot.widgets ?? [])
              .map((message) => projectMessage(message, message.id))
              .filter((message) => message.extensionView),
          ],
          streamingMessage: active?.partial ?? null,
          streamingText: active?.partial?.text ?? "",
          phase: active?.partial?.blocks.some(
            (block) => block.type === "thinking",
          )
            ? "thinking"
            : "output",
          activeCalls: calls,
          tools: active?.tools ?? [],
          usage: active?.contextUsage ?? null,
          stats,
          commands: resourceHost ? nativeInfo.commands : webCommands,
          git:
            active &&
            url.pathname === "/api/state" &&
            !metadataOnly &&
            !options.readOnly &&
            url.searchParams.get("view") !== "chat"
              ? await gitInfo(active.cwd)
              : null,
          // 定点重启的可见性：本次打开时接管的待恢复任务（追加字段）。
          recovery: result.recovery ?? null,
          projectTrusted:
            !options.readOnly && (nativeInfo?.projectTrusted ?? true),
          capabilities: {
            sessions: true,
            reload: true,
            auth: !!providers,
            marketplace: true,
            commands: true,
            attachments: attachmentLimits,
            durable: true,
            readOnly: !!options.readOnly,
            files: !options.readOnly,
            agentBrowser: !!browser && !remoteClient,
            browserRemoteDisabled: remoteClient,
          },
          extra: {
            ...result,
            // 会话栏判断「退回分支」是否可用：把是否绑定原生转录一并带上（追加字段）。
            agents: result.agents?.map((agent) => ({
              ...agent,
              native: !!transcripts?.get(agent.id),
            })),
            active: active ? { ...active, resourceState: undefined } : null,
            sessionCommands: true,
            configurationPending: !!active?.configurationPending,
            canDeferConfiguration: !!active && !auth.running,
          },
        });
        return requestState.run(ctx, run);
      },
      async route(request, response, url) {
        if (
          request.headers["x-pi-remote-client"] === "1" &&
          ["/_browser/frame", "/api/browser"].includes(url.pathname)
        )
          throw new DeskError(
            403,
            "Chromium 浏览器仅在电脑本地运行，远程设备不传输浏览器画面。",
          );
        if (
          browser &&
          url.pathname === "/_browser/frame" &&
          request.method === "GET"
        ) {
          const frame = browser.frame();
          if (!frame || String(frame.id) === url.searchParams.get("after")) {
            response.writeHead(204, { "Cache-Control": "no-store" });
            response.end();
          } else {
            response.writeHead(200, {
              "Content-Type": "image/jpeg",
              "Cache-Control": "no-store",
              "Content-Length": frame.bytes.length,
              "X-Pi-Frame": String(frame.id),
              "X-Pi-Width": String(frame.width),
              "X-Pi-Height": String(frame.height),
            });
            response.end(frame.bytes);
          }
          return true;
        }
        if (browser && url.pathname === "/api/browser") {
          let value;
          if (request.method === "GET") value = browser.read();
          else if (request.method === "POST")
            value = await browser.execute(await body(request));
          else throw new DeskError(405, "请求方式不支持");
          json(response, value);
          return true;
        }
        if (
          options.readOnly &&
          ["/api/git", "/api/git-analysis"].includes(url.pathname)
        )
          throw new DeskError(
            403,
            "无项目会话不提供 Git 写入或本地语言服务器执行",
          );
        if (url.pathname === "/api/fork-source") {
          if (request.method !== "POST")
            throw new DeskError(405, "请求方式不支持");
          if (
            !options.nativeSessionOwner ||
            options.readOnly ||
            request.headers["x-pi-remote-client"] === "1"
          )
            throw new DeskError(403, "此会话不提供创建分支");
          const input = await body(request);
          const ctx = target();
          if (input.id !== ctx.active.id)
            throw new DeskError(409, "操作目标与所选 Agent 不一致");
          for (const key of ["entryId", "expectedEntryId"])
            if (
              input[key] !== undefined &&
              (!Number.isSafeInteger(input[key]) || input[key] < 0)
            )
              throw new DeskError(422, "分支位置无效");
          if (
            input.entryId !== undefined &&
            input.expectedEntryId !== undefined
          )
            throw new DeskError(422, "精确分支位置不能与当前位置检查点混用");
          const transcript = transcripts?.get(ctx.active.id);
          if (!transcript) throw new DeskError(403, "此会话不提供创建分支");
          json(response, await transcript.forkSnapshot(input));
          return true;
        }
        if (url.pathname === "/api/approval" && request.method === "POST") {
          const ctx = target();
          if (!ctx.active.idle || (options.singleAgent && !familyIdle()))
            throw new DeskError(409, "请等待当前任务结束再调整权限");
          const input = await body(request);
          if (!ctx.native) throw new DeskError(409, "Pi 权限宿主未就绪");
          await configure({ approvalMode: input.mode });
          ctx.native.execute("approvalMode", input.mode);
          json(response, { mode: input.mode });
          return true;
        }
        if (url.pathname === "/api/agent" && request.method === "GET") {
          const ctx = target();
          json(response, {
            active: { ...ctx.active, resourceState: undefined },
            familyIdle: familyIdle(),
            ...(ctx.native?.describe(root) ?? {
              tools: root.tools,
              extensions: root.extensions,
            }),
            models: root.models,
          });
          return true;
        }
        if (
          url.pathname === "/api/subagent-history" &&
          request.method === "GET"
        ) {
          if (request.headers["x-pi-remote-client"] === "1")
            throw new DeskError(403, "远程连接不提供子代理历史详情");
          if (workspace.capabilities?.taskInspection !== true)
            json(response, { supported: false });
          else {
            const before = url.searchParams.get("before");
            json(response, {
              supported: true,
              ...(await workspace.subagentHistory(target().active.id, {
                ...(before === null ? {} : { before: Number(before) }),
              })),
            });
          }
          return true;
        }
        if (url.pathname === "/api/task-detail" && request.method === "GET") {
          if (request.headers["x-pi-remote-client"] === "1")
            throw new DeskError(403, "远程连接不提供整个 worker 的任务详情");
          if (workspace.capabilities?.taskInspection !== true)
            json(response, { supported: false });
          else {
            const taskId = url.searchParams.get("taskId");
            if (taskId === null || taskId.trim() === "")
              throw new DeskError(422, "任务 id 无效");
            json(
              response,
              await workspace.taskDetail(target().active.id, Number(taskId)),
            );
          }
          return true;
        }
        if (url.pathname === "/api/task-monitor" && request.method === "GET") {
          if (request.headers["x-pi-remote-client"] === "1")
            throw new DeskError(403, "远程连接不提供整个 worker 的任务监控");
          json(
            response,
            workspace.capabilities?.taskInspection === true
              ? {
                  ...(await workspace.monitor()),
                  capabilities: {
                    taskInspection: true,
                    manageTasks:
                      workspace.capabilities.manageTasks === true &&
                      !options.readOnly,
                    spawnSubagent:
                      workspace.capabilities.spawnSubagent === true &&
                      !options.readOnly,
                  },
                }
              : { supported: false },
          );
          return true;
        }
        if (url.pathname === "/api/command" && request.method === "POST") {
          const input = await body(request);
          if (!commands.has(input.command))
            throw new DeskError(404, "不支持的 Agent 操作");
          // 只读只观察状态，不开放控制入口；等待虽不拥有工作，也按管理策略受限。
          // 本地增加发起能力不改变生产远程网关的既有路径裁剪。
          if (
            options.readOnly &&
            ["wait", "cancel", "subagent.spawn"].includes(input.command)
          )
            throw new DeskError(403, "只读会话不提供任务管理操作");
          if (options.singleAgent && input.command === "create")
            throw new DeskError(409, "请在 Desktop 项目栏创建独立 Agent");
          if (
            input.sessionId !== undefined &&
            String(input.sessionId) !== current().sessionId
          )
            throw new DeskError(409, "Agent 已变化，请刷新后重试");
          if (
            input.command !== "create" &&
            (url.searchParams.has("sessionId") || url.searchParams.has("id")) &&
            input.id !== target().active.id
          )
            throw new DeskError(409, "操作目标与所选 Agent 不一致");
          let result;
          if (input.command === "create") result = await create(input);
          else if (input.command === "rewind") result = await rewind(input);
          else {
            let payload = input;
            if (
              input.command === "fork" &&
              (input.mode === "tail" || !Number.isSafeInteger(input.entryId))
            ) {
              const entryId = await lastMessageEntryId(input.id);
              if (!Number.isSafeInteger(entryId))
                throw new DeskError(422, "会话还没有可分支的内容");
              // 只约束界面的当前位置意图；精确 asOf 分叉仍是 SDK 的原生公开能力。
              if (input.expectedEntryId !== undefined) {
                if (
                  !Number.isSafeInteger(input.expectedEntryId) ||
                  input.expectedEntryId < 0
                )
                  throw new DeskError(422, "当前位置无效");
                if (input.expectedEntryId !== entryId)
                  throw new DeskError(409, "当前位置已变化，请刷新后创建分支");
              }
              payload = { ...input, entryId };
            }
            if (input.command === "wait") {
              try {
                result = await taskWaits.run(request, response, (signal) =>
                  workspace.execute(input.command, payload, { signal }),
                );
                if (response.destroyed) return true;
              } catch (error) {
                if (response.destroyed) return true;
                throw error;
              }
            } else result = await workspace.execute(input.command, payload);
            if (input.command === "configure")
              await resources?.ensure((await workspace.read(input.id)).active);
            if (input.command === "fork") {
              await resources?.selectTools(
                (await workspace.read(result.id)).active,
                { defaults: true },
              );
              result = { ...result, sessionId: String(result.id) };
            }
          }
          root = await workspace.read();
          await transcripts?.sync(root.agents);
          bridge.publish("state_changed", {});
          json(response, result);
          return true;
        }
        if (
          url.pathname === "/api/reload-extensions" &&
          request.method === "POST"
        ) {
          await body(request);
          await reload();
          json(response, { ok: true });
          return true;
        }
        return false;
      },
      /* Cheap change bits for polling clients: everything here comes from
       * memory, so an idle probe never rebuilds a projection. */
      revision: () => {
        // Read the request state directly: a probe runs without an active
        // agent, and native() would reject that on purpose.
        const host = requestState.getStore()?.native;
        return {
          workspace: root.agents
            .map(
              (agent) =>
                `${agent.id}:${agent.revision}:${agent.idle ? 1 : 0}:${agent.pendingConfiguration ? 1 : 0}`,
            )
            .join(","),
          interactions: `${auth.version()}:${resources?.interactions.version(interactionScope()) ?? 0}`,
          resources: (host?.execute("mcpRegistered") ?? [])
            .map((row) => row.name)
            .sort()
            .join(","),
        };
      },
      /* 任务图与子会话读模型：任务（所有权、等待关系、后台标记）、被任务拥有的子会话，以及
       * 正在运行的工具。只读；界面用它画任务与子代理面板，操作另走 /api/command。 */
      tasks: async (id) => {
        root = await workspace.read();
        const requested =
          id === undefined || id === null
            ? (requestState.getStore()?.active?.id ?? root.agents[0]?.id)
            : Number(id);
        if (requested === undefined) throw new DeskError(422, "请选择 Agent");
        await workspace.agent(requested);
        const scope = ownedConversationIds(requested, root.children ?? []);
        const tasks = root.tasks.filter((task) =>
          scope.has(task.conversationId),
        );
        // 只为范围内有实时任务的会话读轻量投影，不能把其他顶层会话的工具带进来。
        const tools = [];
        const seen = new Set();
        for (const task of tasks) {
          if (seen.has(task.conversationId)) continue;
          seen.add(task.conversationId);
          let live;
          try {
            live = await workspace.live(task.conversationId);
          } catch (error) {
            // 任务图与轻量视图分开读取，期间被删除的会话不再有工具可展示；其他错误不能吞掉。
            if (error.status !== 404) throw error;
          }
          for (const call of live?.liveTools ?? [])
            if (call.status !== "done")
              tools.push({
                conversationId: task.conversationId,
                callId: call.callId,
                name: call.name,
                status: call.status,
              });
        }
        return {
          sessionId: String(requested),
          tasks,
          models: root.models,
          conversations: (root.children ?? []).filter((row) =>
            scope.has(row.id),
          ),
          tools,
        };
      },
      /* 分支树读模型：本会话在 Durable 侧的 id 与分叉来源、原生树的 parent 链与 leaf、退回标记
       * 位置，以及从本会话分叉出去的分支（每个分支都是独立会话）。只读；本宿主未绑定原生转录
       * 时 native 为 null，界面据此只显示 Durable 侧信息。 */
      sessionTree: async (id) => {
        root = await workspace.read();
        const requested =
          id === undefined || id === null
            ? (requestState.getStore()?.active?.id ?? root.agents[0]?.id)
            : Number(id);
        if (requested === undefined) throw new DeskError(422, "请选择 Agent");
        const agent = await workspace.agent(requested);
        const record = root.agents.find((row) => row.id === agent.id);
        const nativeTree = transcripts?.get(agent.id)?.tree() ?? null;
        const entries = (await workspace.transcript(agent.id)).entries;
        return {
          sessionId: String(agent.id),
          name: agent.name,
          currentEntryId: (await lastMessageEntryId(agent.id)) ?? null,
          idle: agent.idle,
          // 分叉来源取自 Durable 的会话记录（parent = { conversationId, at }）。
          forkOf: record?.parent
            ? {
                conversationId: record.parent.conversationId,
                entryId: record.parent.at,
              }
            : null,
          leaf: nativeTree?.leafId ?? null,
          native: nativeTree,
          rewinds: entries
            .filter((entry) => entry.kind === "desk.rewind")
            .map((entry) => ({
              entryId: entry.id,
              rewindTo: entry.data?.rewindTo ?? null,
            })),
          branches: root.agents
            .filter((row) => row.parent?.conversationId === agent.id)
            .map((row) => ({
              id: String(row.id),
              name: row.name,
              forkOf: {
                conversationId: row.parent.conversationId,
                entryId: row.parent.at,
              },
              idle: row.idle,
            })),
        };
      },
      listSessions: async () =>
        (await workspace.read()).agents.map((agent) => ({
          id: String(agent.id),
          name: agent.name,
          cwd: agent.cwd,
          running: !agent.idle,
          // 该会话是否已绑定原生转录；会话栏据此判断「退回分支」是否可用。
          native: !!transcripts?.get(agent.id),
        })),
      newSession: async (input) => {
        const result = await create(input);
        return { ...result, sessionId: String(result.id) };
      },
      async sessionCommand(args) {
        const command = parseSessionsCommand(args);
        if (command.action === "new") {
          const result = await create();
          return { ...result, text: `已创建 Agent ${result.id}` };
        }
        if (["show", "list", "help"].includes(command.action))
          return {
            text:
              "/sessions new · /sessions use ID · /sessions stop [ID]\n" +
              root.agents
                .map((agent) => `${agent.id} · ${agent.name} · ${agent.cwd}`)
                .join("\n"),
          };
        const id =
          command.id === undefined ? target().active.id : Number(command.id);
        const selected = (await workspace.read(id)).active;
        if (command.action === "stop") await workspace.execute("abort", { id });
        return {
          sessionId: String(id),
          text:
            command.action === "stop" ? `已停止 ${selected.name}` : undefined,
        };
      },
      switchSession: async (id) => {
        const selected = (await workspace.read(Number(id))).active;
        return { sessionId: String(selected.id) };
      },
      async prompt(message, mode, attachments, requestId, original = message) {
        requestId ??= randomUUID();
        const ctx = target();
        if (
          auth.running ||
          (ctx.active.idle && !(ctx.native?.read().canWrite ?? true))
        )
          throw new DeskError(409, "请先完成配置或交互");
        const match = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
        if (match) {
          const name = match[1],
            args = match[2]?.trim() ?? "";
          if (name === "compact")
            return workspace.execute("compact", {
              id: ctx.active.id,
              instructions: args || undefined,
            });
          if (name === "name") return configure({ name: args });
          if (name === "reload") return reload();
          if (!ctx.native) throw new DeskError(422, "未知 Pi 命令");
        }
        let images = attachments?.images;
        if (ctx.native) {
          const prepared = await ctx.native.execute("input", message, {
            original,
            requestId,
            images,
            source: "rpc",
            mode: mode === "follow_up" ? "followUp" : "steer",
          });
          if (prepared.handled) return;
          message = prepared.message;
          images = prepared.images;
        }
        await applyDeferredConfiguration(ctx.active.id);
        await transcripts?.check();
        await workspace.execute(
          "send",
          {
            id: ctx.active.id,
            message:
              message + (attachments?.text ? "\n\n" + attachments.text : ""),
            images,
            requestId,
            mode: mode === "follow_up" ? "followUp" : "steer",
          },
          {
            presentation: {
              source: "user",
              ...(original === message && !attachments?.text
                ? {}
                : { original }),
            },
          },
        );
        await transcripts?.sync(root.agents);
      },
      abort: () => workspace.execute("abort", { id: target().active.id }),
      setModel: (provider, modelId, { defer = false } = {}) =>
        configure({ model: { provider, modelId } }, { defer }),
      setThinking: (level, { defer = false } = {}) =>
        configure({ thinkingLevel: level }, { defer }),
      reload,
      settingsChanged: () => native()?.execute("settingsChanged"),
      skillInventory: () => native()?.execute("skillInventory") ?? [],
      mcpRegistered: () => native()?.execute("mcpRegistered") ?? [],
      mcpTools: () => native()?.execute("mcpTools") ?? [],
      mcpAction: resources
        ? (input) => native().execute("mcpAction", input)
        : undefined,
      trustProject: resources
        ? (trusted) => {
            if (options.readOnly)
              throw new DeskError(403, "无项目会话不能授予项目权限");
            return native().execute("trustProject", trusted);
          }
        : undefined,
      packageRoot: (source, scope) =>
        native()?.execute("packageRoot", source, scope),
      packageAction: resources
        ? (input) => native().execute("packageAction", input)
        : undefined,
      packageUpdates: resources
        ? () => native().execute("packageUpdates")
        : undefined,
      providerInventory: providers
        ? () => providers.desktopInventory()
        : undefined,
      providerSave: providers ? (input) => providers.save(input) : undefined,
      providerRemove: providers
        ? (input) => providers.remove(input)
        : undefined,
      refreshModels: async () => {
        await providers?.refresh();
        root = await workspace.read();
      },
      authStart(input) {
        if (!providers || !["api_key", "oauth"].includes(input.type))
          throw new DeskError(422, "认证方式无效");
        return auth.start(`${input.provider} 登录`, async (interaction) => {
          await providers.models.login(input.provider, input.type, interaction);
          bridge.publish("state_changed", {});
        });
      },
      authLogout: async (provider) => {
        await providers?.models.logout(provider);
        bridge.publish("state_changed", {});
      },
      interactions: {
        list: () => [
          ...auth.list(),
          ...(resources?.interactions.list(
            interactionScope(),
            interactionOwner(),
          ) ?? []),
        ],
        reply(input) {
          if (auth.list().some((job) => job.id === input.id)) auth.reply(input);
          else resources?.interactions.reply(interactionScope(), input);
        },
      },
    });
    /* Streaming used to rebuild the whole workspace projection on every commit
     * and broadcast it, so a single answer cost hundreds of full reads and
     * snapshot fetches. The delta window keeps the same information flowing:
     * live partials become assistant updates the page applies in place, and a
     * full read plus state_changed only happens when committed history or the
     * idle flag actually changed (or when a workspace cannot report live state). */
    const DELTA_WINDOW_MS = 150;
    const agentSignatures = new Map();
    let deltaTimer, deltaBusy, deltaQueued;
    async function flushDeltas() {
      deltaTimer = undefined;
      if (stopped || deltaBusy) {
        deltaQueued = true;
        return;
      }
      deltaBusy = true;
      try {
        await transcripts?.sync(root.agents);
        let structural = typeof workspace.live !== "function";
        for (const agent of root.agents) {
          if (typeof workspace.live !== "function") break;
          let state;
          try {
            state = await workspace.live(agent.id);
          } catch {
            continue;
          }
          const structure = `${state.idle ? 1 : 0}:${state.entryCount}:${state.lastEntryId}`;
          if (agentSignatures.get(`structure:${agent.id}`) !== structure) {
            agentSignatures.set(`structure:${agent.id}`, structure);
            structural = true;
          }
          const partial = state.partial ?? null;
          const partialKey = partial
            ? `${partial.id}:${String(partial.text ?? "").length}:${partial.blocks?.length ?? 0}`
            : "";
          if (agentSignatures.get(`partial:${agent.id}`) !== partialKey) {
            agentSignatures.set(`partial:${agent.id}`, partialKey);
            if (partial)
              bridge.publish("assistant_update", {
                sessionId: String(agent.id),
                message: partial,
                phase: partial.blocks?.some(
                  (block) => block.type === "thinking",
                )
                  ? "thinking"
                  : "output",
              });
          }
        }
        if (structural) {
          const value = await workspace.read();
          root = value;
          bridge.publish("state_changed", {});
          for (const agent of value.agents)
            if (agent.idle && agent.pendingConfiguration)
              void applyDeferredConfiguration(agent.id).catch(() => {});
        }
      } catch {
        /* A failed delta window must never stop the host. */
      } finally {
        deltaBusy = false;
        if (deltaQueued) {
          deltaQueued = false;
          scheduleDeltas();
        }
      }
    }
    function scheduleDeltas() {
      if (deltaTimer) return;
      deltaTimer = setTimeout(() => void flushDeltas(), DELTA_WINDOW_MS);
      deltaTimer.unref?.();
    }
    const unsubscribe = workspace.subscribe(() => scheduleDeltas());
    for (const agent of root.agents)
      if (agent.idle && agent.pendingConfiguration)
        void applyDeferredConfiguration(agent.id).catch(() => {});
    const url = await bridge.start();
    let stopped = false;
    const stop = () =>
      (stopPromise ??= (async () => {
        stopped = true;
        clearTimeout(deltaTimer);
        deltaTimer = undefined;
        unsubscribe();
        auth.cancelAll();
        // 先释放独立观察请求，再关闭传输与任务执行资源，避免关机被长等待拖住。
        await taskWaits.close();
        await bridge.stop();
        resources?.cancelInteractions();
        const closingBrowser = browser?.close();
        try {
          await transcripts?.close();
        } finally {
          await workspace.close();
          await resources?.close();
          await closingBrowser;
        }
      })());
    return {
      url,
      workspace,
      nativeSession: transcripts?.metadata,
      bridge,
      stop,
      get stopped() {
        return stopped;
      },
    };
  } catch (error) {
    await taskWaits.close();
    await browser?.close();
    await bridge?.stop();
    await workspace?.close();
    await resources?.close();
    throw error;
  }
}
