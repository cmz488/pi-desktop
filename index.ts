import {
  getAgentDir,
  VERSION,
  SessionManager,
  DefaultPackageManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  projectMessage,
  projectToolEvent,
  statsFromEntries,
  usageMetrics,
} from "./src/shared/conversation.mjs";
import { gitInfo } from "./src/git/workspace-info.mjs";
import { DeskError } from "./src/config/config-store.mjs";
import { createDesktopBtw } from "./src/agent/btw-desktop.mjs";
import { getTuiHost } from "./src/tui/tui-host.js";
import { webCommands } from "./src/shared/pi-commands.mjs";
import sessionsExtension from "./src/tui/sessions.js";
import gitExtension from "./src/tui/git.js";
import {
  checkNativePackageUpdates,
  runNativePackageAction,
} from "./src/resources/native-packages.mjs";
import {
  attachmentLimits,
  prepareAttachments,
} from "./src/server/context-attachments.mjs";

/** The native TUI owns one Pi-Agent; Desktop and phone are attached frontends. */
export default function piDesktop(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const host = getTuiHost(agentDir);
  const desktopBtw = createDesktopBtw();
  sessionsExtension(pi);
  gitExtension(pi);
  let context: ExtensionContext | undefined;
  let streamingText = "";
  let streamingMessage: ReturnType<typeof projectMessage> | null = null;
  let streamingPhase = "";
  let compacting = false;
  let git: Awaited<ReturnType<typeof gitInfo>> = null;
  let gitGeneration = 0;
  let packageInventory:
    | { cwd: string; trusted: boolean; manager: DefaultPackageManager }
    | undefined;
  const activeCalls = new Map<string, ReturnType<typeof projectToolEvent>>();

  const snapshot = () => {
    if (!context) throw new DeskError(409, "Pi 会话尚未就绪");
    const stats = {
      ...statsFromEntries(context.sessionManager.getEntries()),
      sessionId: context.sessionManager.getSessionId(),
      sessionFile: context.sessionManager.getSessionFile(),
      contextUsage: context.getContextUsage(),
    };
    const commands = [
      ...webCommands,
      ...pi
        .getCommands()
        .filter((command) => command.name !== "desk")
        .map((command) => ({
          name: command.name,
          label: command.name,
          description: command.description ?? "Pi 命令",
          source: command.source === "extension" ? "extension" : command.source,
          action: "prompt",
        })),
    ].filter(
      (row, index, rows) =>
        rows.findIndex((item) => item.name === row.name) === index,
    );
    return {
      version: VERSION,
      sessionId: context.sessionManager.getSessionId(),
      name: pi.getSessionName() ?? "当前 pi 会话",
      cwd: context.cwd,
      idle: context.isIdle() && !compacting,
      operation: compacting ? "压缩上下文…" : "",
      hasPendingMessages: context.hasPendingMessages(),
      model: context.model
        ? {
            provider: context.model.provider,
            id: context.model.id,
            name: context.model.name,
            input: context.model.input,
          }
        : null,
      usage: context.getContextUsage(),
      stats,
      metrics: usageMetrics(stats),
      tools: pi.getActiveTools(),
      messages: context.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "message" || entry.type === "custom_message",
        )
        .slice(-150)
        .flatMap((entry) =>
          entry.type === "message"
            ? [projectMessage(entry.message, entry.id)]
            : [
                projectMessage(
                  {
                    role: "custom",
                    customType: entry.customType,
                    content: entry.content,
                    display: entry.display,
                    details: entry.details,
                    timestamp: entry.timestamp,
                  },
                  entry.id,
                ),
              ],
        ),
      streamingText,
      streamingMessage,
      phase: streamingPhase,
      git,
      thinkingLevel: pi.getThinkingLevel(),
      thinkingLevels: context.model
        ? getSupportedThinkingLevels(context.model)
        : ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      activeCalls: [...activeCalls.values()],
      commands,
      projectTrusted: context.isProjectTrusted(),
      models: context.modelRegistry
        .getAvailable()
        .filter((model) =>
          [
            "stored",
            "models_json_key",
            "models_json_command",
            "runtime",
          ].includes(
            context!.modelRegistry.getProviderAuthStatus(model.provider)
              .source ?? "",
          ),
        )
        .map((model) => ({
          provider: model.provider,
          id: model.id,
          name: model.name,
          api: model.api,
        })),
      capabilities: {
        sessions: true,
        reload: true,
        auth: false,
        marketplace: true,
        commands: true,
        attachments: attachmentLimits,
      },
    };
  };
  const fingerprint = () => {
    const current = context;
    if (!current) return "unbound";
    return JSON.stringify({
      sessionId: current.sessionManager.getSessionId(),
      leafId: current.sessionManager.getLeafId(),
      model: [current.model?.provider, current.model?.id],
      thinking: pi.getThinkingLevel(),
      tools: pi.getActiveTools(),
      idle: current.isIdle(),
      pending: current.hasPendingMessages(),
      models: current.modelRegistry
        .getAvailable()
        .map((model) => [
          model.provider,
          model.id,
          model.name,
          current.modelRegistry.getProviderAuthStatus(model.provider).source,
        ]),
    });
  };
  const bind = (ctx: ExtensionContext) => {
    context = ctx;
    host.bind(ctx, pi, snapshot, fingerprint);
    host.sessions.startNative = start;
  };
  const update = (ctx: ExtensionContext) => {
    bind(ctx);
    host.changed();
  };
  const updateGit = async (ctx: ExtensionContext) => {
    const generation = ++gitGeneration;
    const value = await gitInfo(ctx.cwd);
    if (
      generation !== gitGeneration ||
      context?.sessionManager.getSessionId() !==
        ctx.sessionManager.getSessionId()
    )
      return;
    git = value;
    host.changed();
  };
  pi.on("session_start", (_event, ctx) => {
    packageInventory = undefined;
    streamingText = "";
    streamingMessage = null;
    streamingPhase = "";
    compacting = false;
    activeCalls.clear();
    git = null;
    update(ctx);
    void updateGit(ctx);
  });
  pi.on("agent_start", (_event, ctx) => {
    activeCalls.clear();
    update(ctx);
  });
  pi.on("agent_end", (_event, ctx) => update(ctx));
  pi.on("agent_settled", (_event, ctx) => {
    update(ctx);
    void updateGit(ctx);
  });
  pi.on("model_select", (_event, ctx) => {
    update(ctx);
    // Native setModel emits an extension event, not a TUI session event.
    // Invalidate the native footer via public UI so remote changes render too.
    if (host.bridge)
      ctx.ui.setStatus("pi-desk", "Desktop / 手机共享当前 Pi-Agent");
  });
  pi.on("thinking_level_select", (_event, ctx) => update(ctx));
  pi.on("session_info_changed", (_event, ctx) => update(ctx));
  pi.on("session_tree", (_event, ctx) => {
    streamingText = "";
    streamingMessage = null;
    streamingPhase = "";
    activeCalls.clear();
    update(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => {
    compacting = true;
    update(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    compacting = false;
    update(ctx);
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    compacting = false;
    update(ctx);
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "assistant") {
      streamingText = "";
      streamingMessage = projectMessage(event.message, "streaming");
    }
    update(ctx);
  });
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") {
      streamingText = "";
      streamingMessage = null;
      streamingPhase = "";
    }
    update(ctx);
  });
  pi.on("message_update", (event, ctx) => {
    bind(ctx);
    streamingMessage = projectMessage(event.message, "streaming");
    streamingText = streamingMessage.text;
    streamingPhase = event.assistantMessageEvent.type.startsWith("thinking")
      ? "thinking"
      : "output";
    host.bridge?.publish("assistant_update", {
      message: streamingMessage,
      phase: event.assistantMessageEvent.type,
    });
  });
  const toolUpdate = (
    event: Parameters<typeof projectToolEvent>[0],
    ctx: ExtensionContext,
  ) => {
    bind(ctx);
    const call = projectToolEvent(event, activeCalls.get(event.toolCallId));
    activeCalls.set(call.id, call);
    if (activeCalls.size > 100)
      activeCalls.delete(activeCalls.keys().next().value!);
    host.bridge?.publish("tool_update", call);
  };
  pi.on("tool_execution_start", toolUpdate);
  pi.on("tool_execution_update", toolUpdate);
  pi.on("tool_execution_end", toolUpdate);
  pi.on("session_shutdown", async (event) => {
    ++gitGeneration;
    if (event.reason === "quit") await host.quit(agentDir);
    else host.suspend();
    context = undefined;
  });

  const sessions = async () =>
    SessionManager.list(
      host.context.cwd,
      host.context.sessionManager.getSessionDir(),
    );
  const packageManager = (ctx: ExtensionContext) => {
    const settings = SettingsManager.create(ctx.cwd, agentDir, {
      projectTrusted: ctx.isProjectTrusted(),
    });
    return {
      settings,
      manager: new DefaultPackageManager({
        cwd: ctx.cwd,
        agentDir,
        settingsManager: settings,
      }),
    };
  };
  const start = () =>
    host.start({
      agentDir,
      autoPort: !process.env.PI_DESK_PORT,
      capabilities: {
        sessions: true,
        newSession: true,
        switchSession: true,
        sessionCommand: true,
        canManageSessions: true,
        packageManagement: true,
        packageUpdates:
          typeof DefaultPackageManager.prototype.checkForAvailableUpdates ===
          "function",
        packageRoot: true,
        skills: false,
        mcp: false,
        interactions: true,
        reload: true,
        auth: false,
        authLogout: false,
        providerInventory: false,
        providerCatalog: false,
        providerSave: false,
        providerRemove: false,
        model: true,
        thinking: true,
        trustProject: false,
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
        canDeferConfiguration: false,
        settingsChanged: true,
        gitChanged: true,
        route: false,
        requestContext: false,
      },
      snapshot: () => host.snapshot(),
      btw: async (input: {
        action?: string;
        sessionId?: string;
        threadId?: string;
        question?: string;
      }) => {
        const runtime = await host.request(
          async (ctx, api) => {
            if (
              input.sessionId &&
              input.sessionId !== ctx.sessionManager.getSessionId()
            )
              throw new DeskError(409, "当前 Pi 会话已变化，请重新打开侧问答");
            return {
              sessionId: ctx.sessionManager.getSessionId(),
              model: ctx.model,
              modelRegistry: ctx.modelRegistry,
              thinkingLevel: ctx.thinkingLevel ?? api.getThinkingLevel(),
              messages: ctx.sessionManager.getBranch(),
            };
          },
          { exclusive: false },
        );
        return desktopBtw.handle(input, runtime);
      },
      gitChanged: () => {
        if (context) void updateGit(context);
      },
      canWrite: () => host.ready && !host.busy && !!host.snapshot().idle,
      canSetThinking: () => host.ready && !host.busy,
      projectTrusted: () => host.context.isProjectTrusted(),
      effectiveSettings: () => host.pi.getSettings(),
      packageRoot: (source: string, scope: string) => {
        if (
          !host.ready ||
          (scope === "project" && !host.context.isProjectTrusted())
        )
          return undefined;
        const ctx = host.context,
          trusted = ctx.isProjectTrusted();
        if (
          !packageInventory ||
          packageInventory.cwd !== ctx.cwd ||
          packageInventory.trusted !== trusted
        )
          packageInventory = {
            cwd: ctx.cwd,
            trusted,
            manager: packageManager(ctx).manager,
          };
        return packageInventory.manager.getInstalledPath(
          source,
          scope === "project" ? "project" : "user",
        );
      },
      settingsChanged: () => {
        packageInventory = undefined;
      },
      packageUpdates:
        typeof DefaultPackageManager.prototype.checkForAvailableUpdates ===
        "function"
          ? () =>
              checkNativePackageUpdates(packageManager(host.context).manager)
          : undefined,
      packageAction: (input: {
        action: string;
        source: string;
        scope: string;
        sessionId: string;
        cwd: string;
      }) =>
        host.request(async (ctx) => {
          if (
            input.sessionId !== ctx.sessionManager.getSessionId() ||
            input.sessionId !== host.sessions.focusId ||
            input.cwd !== ctx.cwd
          )
            throw new DeskError(409, "当前会话或工作区已变化，请刷新插件列表");
          if (input.scope === "project" && !ctx.isProjectTrusted())
            throw new DeskError(403, "请先信任项目再管理项目插件");
          const { manager, settings } = packageManager(ctx);
          manager.setProgressCallback((event) =>
            host.bridge?.publish("package_progress", {
              action: event.action,
              type: event.type,
              source: event.source,
            }),
          );
          await runNativePackageAction(manager, settings, input);
          packageInventory = undefined;
        }),
      listSessions: async () =>
        (await sessions()).slice(0, 100).map((entry) => ({
          id: entry.id,
          name: entry.name ?? entry.firstMessage ?? "会话",
          modified: entry.modified,
          messageCount: entry.messageCount,
        })),
      sessionHistory: sessions,
      newSession: () => host.request((ctx) => ctx.newSession()),
      switchSession: (id: string) =>
        host.request(async (ctx) => {
          const entry = (
            await SessionManager.list(
              ctx.cwd,
              ctx.sessionManager.getSessionDir(),
            )
          ).find((entry) => entry.id === id);
          if (!entry) throw new DeskError(404, "当前工作区中没有该会话");
          return ctx.switchSession(entry.path);
        }),
      reload: () => host.request((ctx) => ctx.reload()),
      prompt: (
        message: string,
        mode: string,
        attachments?: Awaited<ReturnType<typeof prepareAttachments>> & {
          sessionId?: string;
        },
      ) =>
        host.request(
          async (ctx, api) => {
            if (
              attachments?.sessionId &&
              attachments.sessionId !== ctx.sessionManager.getSessionId()
            )
              throw new DeskError(409, "当前会话已变化，请刷新后重试");
            if (host.snapshot().operation)
              throw new DeskError(409, "请等待当前 Pi 操作完成");
            const match = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
            if (match) {
              const name = match[1],
                args = match[2]?.trim() ?? "";
              if (["name", "compact", "reload"].includes(name)) {
                if (!ctx.isIdle())
                  throw new DeskError(409, "请等待当前任务完成");
                if (name === "name") {
                  if (!args || args.length > 200)
                    throw new DeskError(422, "会话名称长度应为 1–200 字符");
                  api.setSessionName(args);
                } else if (name === "compact")
                  ctx.compact({ customInstructions: args || undefined });
                else await ctx.reload();
                return;
              }
              if (name === "desk")
                throw new DeskError(422, "请在 TUI 使用 /desk 管理前端连接");
              if (!api.getCommands().some((command) => command.name === name))
                throw new DeskError(422, "请从 / 命令菜单选择操作");
            }
            const text =
              message + (attachments?.text ? "\n\n" + attachments.text : "");
            api.sendUserMessage(
              attachments?.images.length
                ? [{ type: "text", text }, ...attachments.images]
                : text,
              {
                deliverAs: mode === "follow_up" ? "followUp" : "steer",
                expandPromptTemplates: true,
              },
            );
          },
          { exclusive: false },
        ),
      abort: () => host.context.abort(),
      setModel: (provider: string, id: string) =>
        host.request(async (ctx, api) => {
          const model = ctx.modelRegistry.find(provider, id);
          if (!model) throw new DeskError(422, "模型不存在");
          if (!(await api.setModel(model)))
            throw new DeskError(422, "模型缺少可用认证");
        }),
      setThinking: (level: Parameters<ExtensionAPI["setThinkingLevel"]>[0]) => {
        const targetId = host.context.sessionManager.getSessionId();
        return host.request(
          async (ctx, api) => {
            if (
              targetId !== ctx.sessionManager.getSessionId() ||
              targetId !== host.sessions.focusId
            )
              throw new DeskError(409, "当前会话已变化，请刷新后重试");
            api.setThinkingLevel(level);
          },
          { exclusive: false },
        );
      },
      refreshModels: () =>
        host.request(async (ctx) => {
          await ctx.modelRegistry.refresh();
          const error = ctx.modelRegistry.getError();
          if (error) throw new DeskError(422, error);
        }),
    });

  pi.registerCommand("desk", {
    description:
      "打开共享当前 Pi-Agent 的 Desktop；/desk web 仅启动手机 Web，/desk stop 停止连接服务",
    handler: async (args, ctx) => {
      bind(ctx);
      if (args.startsWith("_action ")) {
        await host.handle(args.slice(8).trim(), ctx, pi);
        return;
      }
      const action = args.trim();
      if (action === "stop") {
        await host.stop();
        ctx.ui.setStatus("pi-desk", undefined);
        ctx.ui.notify("前端连接服务已停止；TUI 和 Pi-Agent 仍运行", "info");
        return;
      }
      if (action === "help") {
        ctx.ui.notify(
          "/desk 打开 Desktop；/desk web 仅启动 Web；/desk stop 停止连接服务。Desktop 和手机共享此 TUI 的当前会话；退出 TUI 后后端与连接服务结束。",
          "info",
        );
        return;
      }
      if (action && action !== "web") {
        ctx.ui.notify(
          "支持 /desk、/desk web、/desk stop、/desk help",
          "warning",
        );
        return;
      }
      let url: string;
      try {
        url = await start();
      } catch (error) {
        await host.stop();
        ctx.ui.notify(
          `Pi 前端连接服务启动失败：${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      ctx.ui.setStatus("pi-desk", "Desktop / 手机共享当前 Pi-Agent");
      ctx.ui.notify(
        `Pi Desk：${url}\n电脑与手机使用同一个后端，局域网地址见 Web 设置 → 远程连接。退出 TUI 后服务结束。`,
        "info",
      );
      if (!action) {
        try {
          await host.openDesktop(url);
        } catch (error) {
          ctx.ui.notify(
            `Desktop 启动失败：${error instanceof Error ? error.message : String(error)}；Web 服务仍在线。`,
            "error",
          );
        }
      }
    },
  });
}
