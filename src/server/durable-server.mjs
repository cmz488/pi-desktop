import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createDeskBridge } from "./bridge.mjs";
import { createDesktopBtw } from "../agent/btw-desktop.mjs";
import { sendJson } from "./http-transfer.mjs";
import { openAgentWorkspace } from "../agent/agent-workspace.mjs";
import { openDurableModels } from "../agent/durable-models.mjs";
import { createDurableResources } from "../agent/durable-resources.mjs";
import { createAgentBrowser } from "../agent/agent-browser.mjs";
import { createInteractionStore } from "../agent/interaction-store.mjs";
import { webCommands } from "../shared/pi-commands.mjs";
import { projectMessage, usageMetrics } from "../shared/conversation.mjs";
import { openNativeTranscript } from "../session/pi-session-storage.mjs";
import { gitInfo } from "../git/workspace-info.mjs";
import { DeskError, readDocument } from "../config/config-store.mjs";
import { attachmentLimits } from "./context-attachments.mjs";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import manifest from "../../package.json" with { type: "json" };
import { parseSessionsCommand } from "../tui/sessions-command.mjs";
import {
  embeddedSdkEntry,
  embeddedPiSdk,
  configurePiNetwork,
} from "../agent/pi-sdk.mjs";

const commands = new Set([
  "create",
  "send",
  "configure",
  "abort",
  "compact",
  "fork",
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
  // The model transport uses Node fetch, even when owned by Electron. Reuse
  // Pi's dispatcher so HTTP(S)_PROXY, NO_PROXY, settings and timeouts all apply.
  const networkSettings = embeddedPiSdk.SettingsManager.create(
    options.cwd ?? process.cwd(),
    agentDir,
    { projectTrusted: false },
  );
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
  let bridge, workspace, root, stopPromise, transcript;
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
          browser,
          onEvent: (kind, data) => bridge?.publish(kind, data),
        });
  const auth = createInteractionStore(() =>
    bridge?.publish("interaction_changed", {}),
  );
  try {
    workspace =
      options.workspace ??
      (await openAgentWorkspace({
        storagePath: join(directory, "agents.sqlite"),
        models: providers.models,
        extensions,
        settings,
        ...options.workspaceOptions,
        readOnly: options.readOnly,
        initialize: (target) => resources?.attach(target),
      }));
    if (options.workspace) await resources?.attach(workspace);
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
    if (options.nativeSessionOwner && root.agents[0]) {
      transcript = await openNativeTranscript({
        agentDir,
        directory,
        cwd: root.agents[0].cwd,
        owner: options.nativeSessionOwner,
        resumePath: options.nativeResumePath,
        pathHint: options.nativeSessionPath,
        workspace,
        id: root.agents[0].id,
      });
      root = await workspace.read();
      if (options.nativeResumePath)
        await resources?.reload(
          (await workspace.read(root.agents[0].id)).active,
        );
    }
    const target = () => {
      const ctx = requestState.getStore();
      if (!ctx?.active) throw new DeskError(422, "请选择 Agent");
      return ctx;
    };
    const native = () => target().native;
    const current = () =>
      requestState.getStore()?.snapshot ?? {
        ...root,
        cwd: options.cwd ?? process.cwd(),
        models: root.models.map((row) => ({ ...row, id: row.modelId })),
        sessionId: "",
        idle: true,
      };
    const sharedWritable = () =>
      root.agents.every((agent) => agent.idle) &&
      !root.tasks.length &&
      !auth.running &&
      (resources?.canWrite() ?? true);
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
        const metadataOnly =
          request.method === "GET" &&
          !["/api/state", "/api/message-detail"].includes(url.pathname);
        const id =
          url.searchParams.get("sessionId") ?? url.searchParams.get("id");
        await transcript?.sync();
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
        ctx.snapshot = {
          ...result,
          active: active ? { ...active, resourceState: undefined } : null,
          version: manifest.version,
          host: "durable",
          frameworkVersion: result.frameworkVersion,
          sessionId: active ? String(active.id) : "",
          sessionCommands: true,
          name: active?.name ?? "新会话",
          cwd: active?.cwd ?? options.cwd ?? process.cwd(),
          idle: active?.idle ?? true,
          configurationPending: !!active?.configurationPending,
          canDeferConfiguration: !!active && !auth.running,
          initializing: !!nativeSnapshot.initializing,
          operation: calls.length
            ? `执行 ${calls[0].name}…`
            : active?.compactions?.length
              ? "压缩上下文…"
              : "",
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
          stats: {
            tokens: { ...active?.usage, total: active?.usage?.tokens ?? 0 },
            cost: active?.usage?.cost ?? 0,
          },
          metrics: usageMetrics({
            tokens: { ...active?.usage, total: active?.usage?.tokens ?? 0 },
            cost: active?.usage?.cost ?? 0,
          }),
          commands: resourceHost ? nativeInfo.commands : webCommands,
          git:
            active &&
            url.pathname === "/api/state" &&
            !metadataOnly &&
            !options.readOnly &&
            url.searchParams.get("view") !== "chat"
              ? await gitInfo(active.cwd)
              : null,
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
        };
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
        if (url.pathname === "/api/approval" && request.method === "POST") {
          const ctx = target();
          if (!ctx.active.idle)
            throw new DeskError(409, "请等待当前任务结束再调整权限");
          const input = await body(request);
          if (!ctx.native) throw new DeskError(409, "Pi 权限宿主未就绪");
          ctx.native.execute("approvalMode", input.mode);
          json(response, { mode: input.mode });
          return true;
        }
        if (url.pathname === "/api/agent" && request.method === "GET") {
          const ctx = target();
          json(response, {
            active: { ...ctx.active, resourceState: undefined },
            ...(ctx.native?.describe(root) ?? {
              tools: root.tools,
              extensions: root.extensions,
            }),
            models: root.models,
          });
          return true;
        }
        if (url.pathname === "/api/command" && request.method === "POST") {
          const input = await body(request);
          if (!commands.has(input.command))
            throw new DeskError(404, "不支持的 Agent 操作");
          if (options.singleAgent && ["create", "fork"].includes(input.command))
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
          else {
            result = await workspace.execute(input.command, input);
            if (input.command === "configure")
              await resources?.ensure((await workspace.read(input.id)).active);
            if (input.command === "fork")
              await resources?.selectTools(
                (await workspace.read(result.id)).active,
                { defaults: true },
              );
          }
          root = await workspace.read();
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
      listSessions: async () =>
        (await workspace.read()).agents.map((agent) => ({
          id: String(agent.id),
          name: agent.name,
          cwd: agent.cwd,
          running: !agent.idle,
        })),
      newSession: create,
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
      async prompt(message, mode, attachments, requestId) {
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
          const expanded = await ctx.native.execute("expandPrompt", message);
          if (expanded.handled) return;
          message = expanded.message;
        }
        await applyDeferredConfiguration(ctx.active.id);
        await transcript?.check();
        await workspace.execute("send", {
          id: ctx.active.id,
          message:
            message + (attachments?.text ? "\n\n" + attachments.text : ""),
          images: attachments?.images,
          requestId: requestId ?? randomUUID(),
          mode: mode === "follow_up" ? "followUp" : "steer",
        });
        await transcript?.sync();
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
          ...(native()?.execute("interactions.list") ?? []),
        ],
        reply(input) {
          if (auth.list().some((job) => job.id === input.id)) auth.reply(input);
          else native()?.execute("interactions.reply", input);
        },
      },
    });
    const unsubscribe = workspace.subscribe(() => {
      void (transcript?.sync() ?? Promise.resolve())
        .then(() => workspace.read())
        .then((value) => {
          root = value;
          bridge.publish("state_changed", {});
          for (const agent of value.agents)
            if (agent.idle && agent.pendingConfiguration)
              void applyDeferredConfiguration(agent.id).catch(() => {});
        })
        .catch(() => {});
    });
    for (const agent of root.agents)
      if (agent.idle && agent.pendingConfiguration)
        void applyDeferredConfiguration(agent.id).catch(() => {});
    const url = await bridge.start();
    let stopped = false;
    const stop = () =>
      (stopPromise ??= (async () => {
        stopped = true;
        unsubscribe();
        auth.cancelAll();
        // Cancel tool waiters through Harness before disposing their native UI/MCP runtime.
        await bridge.stop();
        resources?.cancelInteractions();
        const closingBrowser = browser?.close();
        try {
          await transcript?.close();
        } finally {
          await workspace.close();
          await resources?.close();
          await closingBrowser;
        }
      })());
    return {
      url,
      workspace,
      nativeSession: transcript?.metadata,
      bridge,
      stop,
      get stopped() {
        return stopped;
      },
    };
  } catch (error) {
    await browser?.close();
    await bridge?.stop();
    await workspace?.close();
    await resources?.close();
    throw error;
  }
}
