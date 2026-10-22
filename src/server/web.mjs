import { createApprovalExtension } from "../agent/pi-permissions.mjs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeskBridge } from "./bridge.mjs";
import { createDesktopBtw } from "../agent/btw-desktop.mjs";
import {
  checkNativePackageUpdates,
  runNativePackageAction,
} from "../resources/native-packages.mjs";
import { SessionHost } from "../tui/session-manager.mjs";
import { createInteractionStore } from "../agent/interaction-store.mjs";
import { rpcQuestion } from "../agent/questionnaire.mjs";
import { attachmentLimits } from "./context-attachments.mjs";
import { DeskError } from "../config/config-store.mjs";
import { commandCatalog, webCommands } from "../shared/pi-commands.mjs";
import {
  checkPiSdk,
  loadEmbeddedPiSdk,
  webTerminalTheme,
  configurePiNetwork,
  scopedMcpCredentials,
} from "../agent/pi-sdk.mjs";
import { projectMessage, projectToolEvent } from "../shared/conversation.mjs";
import { createAgentSnapshot } from "./agent-snapshot.mjs";
import { gitInfo } from "../git/workspace-info.mjs";
import { loadWebMcp, validMcpName } from "../resources/mcp-config.mjs";
import { relative } from "node:path";
/* The SDK namespace is bound once the host loads it, so module-scope use of
 * these names stays synchronous while a fresh worker pays nothing for them. */
let VERSION,
  getAgentDir,
  SettingsManager,
  SessionManager,
  DefaultPackageManager,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  createToolSearchExtension,
  createMcpExtension,
  ProjectTrustStore,
  hasTrustRequiringProjectResources;
function bindSdk(namespace) {
  ({
    VERSION,
    getAgentDir,
    SettingsManager,
    SessionManager,
    DefaultPackageManager,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
    createCodemodeExtension,
    createToolSearchExtension,
    createMcpExtension,
    ProjectTrustStore,
    hasTrustRequiringProjectResources,
  } = namespace);
  return namespace;
}

export async function startWeb(options = {}) {
  bindSdk(await loadEmbeddedPiSdk());
  const manager = new SessionHost({
    agentDir: options.agentDir ?? getAgentDir(),
    createSlot: ({ path, parent, bridgeFactory, controller }) =>
      startWebSlot({
        ...options,
        sessionPath: path,
        parent,
        bridgeFactory,
        sessionController: controller,
      }),
  });
  await manager.create({ initial: true });
  try {
    const url = await manager.start();
    const initial = manager.active.app;
    return {
      url,
      manager,
      get bridge() {
        return manager.bridge;
      },
      get runtime() {
        return manager.active.app.runtime;
      },
      ready: initial.ready,
      stop: () => manager.dispose(),
    };
  } catch (error) {
    await manager.dispose();
    throw error;
  }
}

export async function startWebSlot(options = {}) {
  const sdk = checkPiSdk(options.sdk ?? (await loadEmbeddedPiSdk()));
  bindSdk(sdk);
  const {
    VERSION,
    getAgentDir,
    SettingsManager,
    SessionManager,
    DefaultPackageManager,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
    createCodemodeExtension,
    createToolSearchExtension,
    createMcpExtension,
    ProjectTrustStore,
    hasTrustRequiringProjectResources,
  } = sdk;
  const cwd = resolve(options.cwd ?? process.cwd()),
    agentDir = options.agentDir ?? getAgentDir();
  let bridge,
    unsubscribe,
    streamingText = "",
    streamingMessage = null,
    streamingPhase = "",
    busy = false,
    initializing = true;
  let operation = "",
    workingMessage = "",
    activeTool = "";
  const desktopBtw = createDesktopBtw();
  const extensionStatuses = new Map();
  const extensionWidgets = new Map();
  const activeCalls = new Map();
  let askQuestions;
  let git = await gitInfo(cwd),
    mcpApi,
    mcpInteraction,
    mcpFailed = false;
  let gitChecking = false;
  const updateGit = () => {
    if (gitChecking) return;
    gitChecking = true;
    gitInfo(runtime.cwd)
      .then((value) => {
        git = value;
        changed();
      })
      .finally(() => {
        gitChecking = false;
      });
  };
  const interactions = createInteractionStore(() =>
    bridge?.publish("interaction_changed", {}),
  );
  const trustStore = new ProjectTrustStore(agentDir);
  const mcpCredentials = options.noExtensions
    ? undefined
    : await scopedMcpCredentials(agentDir, options.sdkEntry, sdk);
  const createRuntime = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const policy = SettingsManager.create(cwd, agentDir, {
      projectTrusted: false,
    });
    const trusted =
      !hasTrustRequiringProjectResources(cwd) ||
      (trustStore.get(cwd) ?? policy.getDefaultProjectTrust() === "always");
    const settingsManager = SettingsManager.create(cwd, agentDir, {
      projectTrusted: trusted,
    });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime: options.modelRuntime,
      resourceLoaderOptions: {
        additionalExtensionPaths: options.readOnly
          ? []
          : options.bridgeFactory
            ? (options.nativeResources?.extensions ?? [])
            : [
                fileURLToPath(new URL("../../index.ts", import.meta.url)),
                ...(options.nativeResources?.extensions ?? []),
              ],
        additionalSkillPaths: options.nativeResources?.skills ?? [],
        additionalPromptTemplatePaths: options.nativeResources?.prompts ?? [],
        appendSystemPrompt: options.nativeResources?.instructions
          ? [options.nativeResources.instructions]
          : [],
        // The host plugins belong to the original TUI, never to child sessions.
        extensionsOverride: options.bridgeFactory
          ? (base) => ({
              ...base,
              extensions: base.extensions.filter(
                (extension) =>
                  !(
                    options.extensionFactories?.some(
                      (row) => row.name === "desktop-browser",
                    ) &&
                    /[/\\]pi-agent-browser-native[/\\]/.test(extension.path)
                  ) &&
                  !["../../index.ts", "../tui/sessions.ts"].some(
                    (name) =>
                      extension.resolvedPath ===
                      fileURLToPath(new URL(name, import.meta.url)),
                  ),
              ),
            })
          : undefined,
        noContextFiles: !!options.readOnly,
        agentsFilesOverride: options.readOnly
          ? () => ({
              agentsFiles: sdk
                .loadProjectContextFiles({ cwd: agentDir, agentDir })
                .filter((row) => dirname(row.path) === resolve(agentDir)),
            })
          : undefined,
        noExtensions: options.readOnly || (options.noExtensions ?? false),
        extensionFactories: [
          ...(options.extensionFactories ?? []),
          ...(options.approvalPolicy
            ? [
                {
                  name: "desktop-permissions",
                  factory: createApprovalExtension(options.approvalPolicy),
                },
              ]
            : []),
          ...(options.readOnly || options.noExtensions
            ? []
            : [
                {
                  name: "codemode",
                  builtin: true,
                  replaceable: true,
                  factory: createCodemodeExtension(),
                },
                {
                  name: "tool-search",
                  builtin: true,
                  replaceable: true,
                  factory: createToolSearchExtension(),
                },
                {
                  name: "mcp",
                  builtin: true,
                  replaceable: true,
                  factory: (pi) => {
                    mcpApi = pi;
                    return createMcpExtension({
                      ...(agentDir === getAgentDir()
                        ? {}
                        : {
                            loadConfig: (ctx) =>
                              loadWebMcp({
                                agentDir,
                                cwd: ctx.cwd,
                                projectTrusted:
                                  settingsManager.isProjectTrusted(),
                              }),
                          }),
                      credentials: mcpCredentials,
                      logPath: join(agentDir, "mcp.log"),
                      openUrl: (url) =>
                        mcpInteraction?.notify({
                          type: "auth_url",
                          url: String(url),
                        }),
                    })(pi);
                  },
                },
              ]),
        ],
      },
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      customTools: options.customTools,
      ...(options.readOnly
        ? {
            tools: [
              ...new Set([
                "read",
                ...(options.customTools?.map((tool) => tool.name) ?? []),
              ]),
              ...(options.extensionFactories?.some(
                (row) => row.name === "desktop-browser",
              )
                ? ["agent_browser"]
                : []),
            ],
          }
        : {}),
    });
    if (options.resourcesOnly) {
      result.session.setCacheWarmingMode("off");
      // Block this Session's model loop, not the shared provider runtime:
      // extensions may create independent Pi Agents (for example Goal's auditor).
      result.session.agent.streamFunction = () => {
        throw new DeskError(
          409,
          "资源运行时不能请求模型；请通过 Durable 发送消息",
        );
      };
    }
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const initialSettings = SettingsManager.create(cwd, agentDir);
  // SessionManager's implicit directory uses the process-wide agent dir. Pass
  // the native workspace path explicitly so --agent-dir also isolates sessions.
  const workspaceSessions = join(
    agentDir,
    "sessions",
    `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager:
      options.sessionManager ??
      (options.sessionPath
        ? SessionManager.open(options.sessionPath)
        : SessionManager.create(
            cwd,
            options.sessionDir ??
              initialSettings.getSessionDir() ??
              workspaceSessions,
          )),
  });
  const session = () => runtime.session;
  if (options.parent?.model && !options.sessionPath) {
    const model = session().modelRuntime.getModel(
      options.parent.model.provider,
      options.parent.model.id,
    );
    // Pi can expose a fallback model without configured auth. An empty new
    // conversation is still valid; inherit only an actually available choice.
    if (
      model &&
      options.parent.models?.some(
        (row) => row.provider === model.provider && row.id === model.id,
      )
    )
      await session().setModel(model);
    session().setThinkingLevel(options.parent.thinkingLevel);
  }
  const changed = () => bridge?.publish("state_changed", {});
  function uiPrompt(label, prompt) {
    if (!prompt.signal && options.toolSignal)
      prompt = { ...prompt, signal: options.toolSignal() };
    const ask = rpcQuestion(askQuestions, label, prompt.type);
    if (ask) prompt = { ...prompt, ask };
    if (mcpInteraction)
      return mcpInteraction.prompt(prompt).catch(() => undefined);
    return new Promise((resolve) =>
      interactions.start(label, async (interaction) => {
        try {
          resolve(await interaction.prompt(prompt));
        } catch {
          resolve(undefined);
        }
      }),
    );
  }
  const noop = () => {};
  const piTheme = webTerminalTheme(sdk);
  const ui = {
    select: (title, values, opts) =>
      uiPrompt(title, {
        type: "select",
        message: title,
        options: values.map((value) => ({ id: value, label: value })),
        signal: opts?.signal,
      }),
    confirm: async (title, message, opts) =>
      (await uiPrompt(title, {
        type: "select",
        message,
        options: [
          { id: "yes", label: "确认" },
          { id: "no", label: "取消" },
        ],
        signal: opts?.signal,
      })) === "yes",
    input: (title, placeholder, opts) =>
      uiPrompt(title, {
        type: "text",
        message: title,
        placeholder,
        signal: opts?.signal,
      }),
    editor: (title, prefill) =>
      uiPrompt(title, { type: "text", message: title, placeholder: prefill }),
    notify: (message, type) => {
      if (mcpInteraction) {
        mcpInteraction.notify({ type: "message", message, level: type });
        if (type === "error") mcpFailed = true;
      } else bridge?.publish("notification", { message, type });
    },
    onTerminalInput: () => noop,
    setStatus: (key, text) => {
      if (text === undefined) extensionStatuses.delete(key);
      else
        extensionStatuses.set(
          key,
          String(text)
            .replace(/\x1b\[[0-9;]*m/g, "")
            .slice(0, 200),
        );
      changed();
    },
    setWorkingMessage: (text) => {
      workingMessage = text ?? "";
      changed();
    },
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: (key, value) => {
      extensionWidgets.get(key)?.dispose?.();
      extensionWidgets.delete(key);
      if (value !== undefined) {
        try {
          extensionWidgets.set(
            key,
            typeof value === "function"
              ? value(
                  {
                    requestRender: changed,
                    terminal: { columns: 100, rows: 60 },
                    children: [],
                  },
                  piTheme,
                )
              : { render: () => value },
          );
        } catch (error) {
          bridge?.publish("notification", {
            message: `扩展组件无法显示：${error.message}`,
            type: "error",
          });
        }
      }
      changed();
    },
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: async () => undefined,
    setEditorText: (text) => bridge?.publish("editor_text", { text }),
    getEditorText: () => "",
    pasteToEditor: (text) => bridge?.publish("editor_text", { text }),
    get theme() {
      return piTheme;
    },
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({
      success: false,
      error: "请通过 Pi 主题设置管理终端主题",
    }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  };
  function resetSessionPresentation() {
    extensionStatuses.clear();
    for (const widget of extensionWidgets.values()) widget?.dispose?.();
    extensionWidgets.clear();
    workingMessage = "";
    activeTool = "";
    streamingText = "";
    streamingMessage = null;
    streamingPhase = "";
    activeCalls.clear();
  }
  async function bind(current) {
    unsubscribe?.();
    resetSessionPresentation();
    unsubscribe = current.subscribe((event) => {
      if (
        event.type === "message_start" &&
        event.message.role === "assistant"
      ) {
        streamingText = "";
        streamingMessage = projectMessage(event.message, "streaming");
      } else if (event.type === "message_update") {
        streamingMessage = projectMessage(event.message, "streaming");
        streamingPhase = event.assistantMessageEvent.type.startsWith("thinking")
          ? "thinking"
          : "output";
        streamingText = streamingMessage.text;
        bridge?.publish("assistant_update", {
          message: streamingMessage,
          phase: event.assistantMessageEvent.type,
        });
      } else if (event.type === "message_end") {
        if (event.message.role === "assistant") {
          streamingMessage = null;
          streamingText = "";
          streamingPhase = "";
        }
        changed();
      } else if (event.type.startsWith("tool_execution_")) {
        if (event.toolName === "ask_user_question") {
          if (event.type === "tool_execution_start")
            askQuestions = event.args?.questions;
          if (event.type === "tool_execution_end") askQuestions = undefined;
        }
        if (event.type === "tool_execution_end")
          options.onToolResult?.(event.toolName, event.result);
        const id = event.toolCallId;
        const previous = activeCalls.get(id) ?? {};
        const call = projectToolEvent(event, previous);
        activeCalls.set(id, call);
        if (activeCalls.size > 100)
          activeCalls.delete(activeCalls.keys().next().value);
        activeTool =
          [...activeCalls.values()].find((call) => call.status === "running")
            ?.name ?? "";
        bridge?.publish("tool_update", call);
      } else if (
        ["agent_start", "agent_end", "agent_settled"].includes(event.type)
      ) {
        if (event.type === "agent_start") activeCalls.clear();
        if (event.type === "agent_settled") updateGit();
        changed();
      }
    });
    options.bindResourceSession?.(current);
    await current.bindExtensions({
      mode: "rpc",
      uiContext: ui,
      commandContextActions: {
        waitForIdle: () => current.waitForIdle(),
        newSession: (settings) =>
          settings && Object.keys(settings).length
            ? Promise.reject(new DeskError(422, "管理器新建不接受原生替换参数"))
            : options.sessionController
              ? options.sessionController.create()
              : runtime.newSession(),
        switchSession: (path, settings) =>
          options.sessionController
            ? options.sessionController.selectPath(path)
            : runtime.switchSession(path, settings),
        fork: (id, options) => runtime.fork(id, options),
        navigateTree: (id, options) => current.navigateTree(id, options),
        reload: () => reload(),
      },
      abortHandler: () => current.abort(),
      onError: () =>
        bridge?.publish("notification", {
          message: "扩展操作未完成，请检查扩展配置",
          type: "error",
        }),
    });
  }
  runtime.setRebindSession(bind);
  const snapshot = () => {
    const current = session();
    const stats = current.getSessionStats();
    const operationText =
      operation ||
      (current.isCompacting
        ? "压缩上下文…"
        : activeTool
          ? `执行 ${activeTool}…`
          : "");
    const widgets = [...extensionWidgets].flatMap(([key, widget]) => {
      try {
        const lines = (widget?.render?.(100) ?? [])
          .slice(0, 40)
          .map((line) =>
            String(line)
              .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
              .trim()
              .slice(0, 400),
          )
          .filter(Boolean);
        return lines.length
          ? [
              {
                role: "custom",
                id: `widget:${key}`,
                customType: "pi-widget",
                display: true,
                content: "",
                details: { key, lines },
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
    return createAgentSnapshot({
      version: VERSION,
      host: "headless",
      sessionId: current.sessionManager.getSessionId(),
      name: current.sessionManager.getSessionName() ?? "新会话",
      cwd: runtime.cwd,
      idle: current.isIdle && !busy && !initializing,
      initializing,
      operation: operationText,
      activeTool,
      compacting: current.isCompacting,
      workingMessage,
      statuses: [...extensionStatuses.values()],
      commands: commandCatalog(current),
      stats,
      git,
      model: current.model
        ? {
            provider: current.model.provider,
            id: current.model.id,
            name: current.model.name,
            input: current.model.input,
          }
        : null,
      thinkingLevel: current.thinkingLevel,
      thinkingEditable: !busy && !initializing,
      thinkingLevels: current.getAvailableThinkingLevels(),
      usage: current.getContextUsage(),
      tools: current.getActiveToolNames(),
      streamingText,
      streamingMessage,
      phase: streamingPhase,
      activeCalls: [...activeCalls.values()],
      projectTrusted: current.settingsManager.isProjectTrusted(),
      models: current.modelRuntime
        .getAvailableSnapshot()
        .filter((model) =>
          [
            "stored",
            "models_json_key",
            "models_json_command",
            "runtime",
          ].includes(
            current.modelRuntime.getProviderAuthStatus(model.provider).source,
          ),
        )
        .map((model) => ({
          provider: model.provider,
          id: model.id,
          name: model.name,
          api: model.api,
        })),
      messages: current.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "message" || entry.type === "custom_message",
        )
        .slice(-150)
        .map((entry) =>
          entry.type === "message"
            ? projectMessage(entry.message, entry.id)
            : projectMessage(
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
        ),
      capabilities: {
        sessions: true,
        remote: true,
        reload: true,
        auth: true,
        marketplace: true,
        commands: true,
        attachments: attachmentLimits,
      },
      extra: { widgets },
    });
  };
  async function exclusive(run) {
    if (busy || !session().isIdle || interactions.running)
      throw new DeskError(409, "请先完成当前任务或交互");
    busy = true;
    changed();
    try {
      return await run();
    } finally {
      busy = false;
      changed();
    }
  }
  let inventoryManager, skillsCache;
  async function skillInventory() {
    if (!skillsCache)
      skillsCache = (async () => {
        const skills = (await loadEmbeddedPiSdk()).loadSkills;
        const manager = packages(
          SettingsManager.create(runtime.cwd, agentDir, {
            projectTrusted: session().settingsManager.isProjectTrusted(),
          }),
        );
        const resolved = await manager.resolve(async () => "skip");
        return resolved.skills.flatMap((resource) =>
          skills({
            cwd: runtime.cwd,
            agentDir,
            skillPaths: [resource.path],
            includeDefaults: false,
          }).skills.map((skill) => ({
            id: skill.filePath,
            name: skill.name,
            description: skill.description,
            source: resource.metadata.source,
            scope: resource.metadata.scope === "project" ? "project" : "global",
            packageSource:
              resource.metadata.origin === "package"
                ? resource.metadata.source
                : null,
            pattern:
              resource.metadata.origin === "package"
                ? relative(
                    resource.metadata.packageRoot ?? resource.metadata.baseDir,
                    resource.path,
                  ).replaceAll("\\", "/")
                : resource.path,
            enabled: resource.enabled,
          })),
        );
      })();
    return skillsCache;
  }
  const packages = (settingsManager) =>
    new DefaultPackageManager({
      cwd: runtime.cwd,
      agentDir,
      settingsManager,
      builtinExtensions: ["mcp", "llama.cpp", "codemode", "tool-search"],
    });
  async function reload() {
    inventoryManager = undefined;
    skillsCache = undefined;
    mcpApi = undefined;
    const current = session();
    await current.reload({
      // SDK 先结束并失效旧 runner；新 session_start 必须已经使用同一 Durable 资源 seam。
      beforeSessionStart: () => {
        resetSessionPresentation();
        return options.bindResourceSession?.(current);
      },
    });
    changed();
  }
  bridge = (options.bridgeFactory ?? createDeskBridge)({
    ...options,
    autoPort: options.port === undefined && !process.env.PI_DESK_PORT,
    agentDir,
    capabilities: {
      sessions: true,
      remote: true,
      newSession: true,
      switchSession: true,
      sessionCommand: false,
      canManageSessions: false,
      packageManagement: true,
      packageUpdates:
        typeof DefaultPackageManager.prototype.checkForAvailableUpdates ===
        "function",
      packageRoot: true,
      skills: true,
      mcp: true,
      interactions: true,
      reload: true,
      auth: true,
      authLogout: true,
      providerInventory: false,
      providerCatalog: true,
      providerSave: false,
      providerRemove: false,
      model: true,
      thinking: true,
      trustProject: true,
      prompt: true,
      abort: true,
      btw: true,
      settings: true,
      canSaveSettings: true,
      projectTrusted: true,
      canWrite: true,
      canEditShared: false,
      validateTarget: false,
      canSetThinking: true,
      canDeferConfiguration: false,
      settingsChanged: true,
      gitChanged: true,
      route: false,
      requestContext: false,
    },
    snapshot,
    btw: (input) => {
      const current = session();
      return desktopBtw.handle(input, {
        sessionId: current.sessionManager.getSessionId(),
        model: current.model,
        modelRegistry: current.modelRuntime,
        thinkingLevel: current.thinkingLevel,
        messages: current.sessionManager.getBranch(),
      });
    },
    gitChanged: updateGit,
    canWrite: () =>
      session().isIdle && !busy && !initializing && !interactions.running,
    canSetThinking: () => !busy && !initializing,
    prompt(message, mode, attachments) {
      if (busy || initializing || interactions.running)
        throw new DeskError(409, "请先完成配置或交互");
      const match = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
      if (match) {
        const name = match[1],
          args = match[2]?.trim() ?? "";
        if (name === "desk")
          throw new DeskError(
            422,
            "三端共享请在 TUI 执行 /desk；独立 Web 模式可用 npm run desktop 附加本服务。",
          );
        if (["compact", "reload", "name"].includes(name)) {
          if (!session().isIdle) throw new DeskError(409, "请等待当前任务完成");
          if (name === "name" && !args)
            throw new DeskError(422, "请输入 /name 会话名称");
          if (name === "name" && args.length > 200)
            throw new DeskError(422, "会话名称不能超过 200 字符");
          operation =
            name === "compact"
              ? "压缩上下文…"
              : name === "reload"
                ? "重载资源…"
                : "命名会话…";
          exclusive(async () => {
            if (name === "compact") await session().compact(args || undefined);
            else if (name === "reload") await reload();
            else session().setSessionName(args);
          })
            .then(() =>
              bridge.publish("notification", {
                message:
                  name === "compact"
                    ? "上下文压缩完成"
                    : name === "reload"
                      ? "资源已重载"
                      : "会话已命名",
                type: "info",
              }),
            )
            .catch(() =>
              bridge.publish("notification", {
                message: "Pi 操作未完成，请检查模型认证、连接或资源配置",
                type: "error",
              }),
            )
            .finally(() => {
              operation = "";
              changed();
            });
          return;
        }
        if (webCommands.some((command) => command.name === name))
          throw new DeskError(422, "请从 Web 命令菜单执行此操作");
        if (!commandCatalog(session()).some((command) => command.name === name))
          throw new DeskError(422, "未知 pi 命令，请从 / 菜单选择");
      }
      session()
        .prompt(
          message + (attachments?.text ? "\n\n" + attachments.text : ""),
          {
            source: "rpc",
            images: attachments?.images,
            streamingBehavior: mode === "follow_up" ? "followUp" : "steer",
          },
        )
        .catch(() =>
          bridge.publish("notification", {
            message: "Pi 未完成本次请求，请检查模型认证和连接",
            type: "error",
          }),
        );
    },
    abort: () => {
      session().abortCompaction();
      return session().abort();
    },
    setModel: async (provider, id) => {
      const model = session().modelRuntime.getModel(provider, id);
      if (!model) throw new DeskError(422, "模型不存在");
      await session().setModel(model);
    },
    setThinking: async (level) => session().setThinkingLevel(level),
    refreshModels: async () => {
      await session().modelRuntime.refresh();
    },
    providerCatalog: () =>
      session()
        .modelRuntime.getProviders()
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: !!provider.auth.apiKey?.login,
          oauth: !!provider.auth.oauth,
          configured: session().modelRuntime.hasConfiguredAuth(provider.id),
          authSource: session().modelRuntime.getProviderAuthStatus(provider.id)
            .source,
          models: provider.getModels().map((model) => ({
            id: model.id,
            name: model.name,
            api: model.api,
          })),
        })),
    effectiveSettings: () => session().settingsManager.getSettings(),
    projectTrusted: () => session().settingsManager.isProjectTrusted(),
    reload: () => exclusive(reload),
    settingsChanged: async () => {
      skillsCache = undefined;
      inventoryManager = undefined;
    },
    skillInventory,
    mcpRegistered: () => mcpApi?.getMcpServers() ?? [],
    mcpTools: () =>
      session()
        .getAllTools()
        .filter((tool) => tool.name.startsWith("mcp__"))
        .map((tool) => ({ name: tool.name, description: tool.description })),
    mcpAction: (input) => {
      if (
        !session()
          .extensionRunner.getRegisteredCommands()
          .some((command) => command.invocationName === "mcp")
      )
        throw new DeskError(409, "Pi MCP 扩展未启用，请在插件设置中启用并重载");
      if (
        !["status", "login", "logout", "reconnect"].includes(input.action) ||
        (input.action !== "status" && !validMcpName(input.name))
      )
        throw new DeskError(422, "MCP 操作无效");
      if (busy || !session().isIdle || interactions.running)
        throw new DeskError(409, "请先完成当前任务或交互");
      return interactions.start(
        `MCP ${input.name ?? "状态"}`,
        async (interaction) => {
          mcpInteraction = interaction;
          mcpFailed = false;
          try {
            await session().prompt(
              input.action === "status"
                ? "/mcp"
                : `/mcp ${input.action} ${input.name}`,
              { source: "rpc" },
            );
            if (mcpFailed) throw new Error("Native MCP operation failed");
          } finally {
            mcpInteraction = undefined;
            changed();
          }
        },
      );
    },
    listSessions: async () => {
      const entries = await SessionManager.list(
        runtime.cwd,
        session().sessionManager.getSessionDir(),
      );
      return entries.slice(0, 100).map((entry) => ({
        id: entry.id,
        name: entry.name ?? entry.firstMessage ?? "会话",
        modified: entry.modified,
        messageCount: entry.messageCount,
      }));
    },
    beforeNewSession: async () => ({
      cancelled:
        (
          await session().extensionRunner?.emit({
            type: "session_before_switch",
            reason: "new",
          })
        )?.cancel === true,
    }),
    sessionHistory: () =>
      SessionManager.list(
        runtime.cwd,
        session().sessionManager.getSessionDir(),
      ),
    newSession: () => exclusive(() => runtime.newSession()),
    switchSession: (id) =>
      exclusive(async () => {
        const entry = (
          await SessionManager.list(
            runtime.cwd,
            session().sessionManager.getSessionDir(),
          )
        ).find((entry) => entry.id === id);
        if (!entry) throw new DeskError(404, "会话不存在");
        return runtime.switchSession(entry.path);
      }),
    packageRoot: (source, scope) => {
      if (scope === "project" && !session().settingsManager.isProjectTrusted())
        return undefined;
      inventoryManager ??= packages(
        SettingsManager.create(runtime.cwd, agentDir, {
          projectTrusted: session().settingsManager.isProjectTrusted(),
        }),
      );
      return inventoryManager.getInstalledPath(
        source,
        scope === "project" ? "project" : "user",
      );
    },
    packageUpdates:
      typeof DefaultPackageManager.prototype.checkForAvailableUpdates ===
      "function"
        ? () =>
            checkNativePackageUpdates(
              packages(
                SettingsManager.create(runtime.cwd, agentDir, {
                  projectTrusted: session().settingsManager.isProjectTrusted(),
                }),
              ),
            )
        : undefined,
    packageAction: (input) =>
      exclusive(async () => {
        if (
          input.sessionId !== session().sessionId ||
          input.cwd !== runtime.cwd
        )
          throw new DeskError(409, "当前会话或工作区已变化，请刷新插件列表");
        const packageSettings = SettingsManager.create(runtime.cwd, agentDir, {
          projectTrusted: session().settingsManager.isProjectTrusted(),
        });
        const manager = packages(packageSettings);
        manager.setProgressCallback((event) =>
          bridge.publish("package_progress", {
            action: event.action,
            type: event.type,
            source: event.source,
          }),
        );
        await runNativePackageAction(manager, packageSettings, input);
        inventoryManager = undefined;
      }),
    authStart: (input) => {
      if (busy || interactions.running)
        throw new DeskError(409, "请完成当前操作");
      const provider = session().modelRuntime.getProvider(input.provider);
      if (
        !provider ||
        !["api_key", "oauth"].includes(input.type) ||
        !(input.type === "oauth"
          ? provider.auth.oauth
          : provider.auth.apiKey?.login)
      )
        throw new DeskError(422, "此提供商不支持此认证方式");
      return interactions.start(
        `${provider.name} 登录`,
        async (interaction) => {
          await session().modelRuntime.login(
            provider.id,
            input.type,
            interaction,
          );
          changed();
        },
      );
    },
    authLogout: (provider) =>
      exclusive(() => session().modelRuntime.logout(provider)),
    interactions,
    trustProject: (trusted) =>
      exclusive(async () => {
        if (typeof trusted !== "boolean")
          throw new DeskError(422, "信任选择无效");
        trustStore.set(runtime.cwd, trusted);
        session().settingsManager.setProjectTrusted(trusted);
        await reload();
      }),
  });
  try {
    const url = await bridge.start();
    const ready = bind(session()).then(
      () => {
        if (Array.isArray(options.parent?.tools)) {
          const available = new Set(
            session()
              .getAllTools()
              .map((tool) => tool.name),
          );
          const inherited = options.parent.tools.filter((name) =>
            available.has(name),
          );
          session().setActiveToolsByName(inherited);
          if (inherited.length !== options.parent.tools.length)
            bridge.publish("notification", {
              message:
                "部分父会话工具未在此 SDK 会话加载；未启用额外工具，请检查扩展配置",
              type: "warning",
            });
        }
        initializing = false;
        changed();
      },
      () => {
        initializing = false;
        bridge.publish("notification", {
          message: "扩展初始化未完成，请检查配置",
          type: "error",
        });
        changed();
      },
    );
    return {
      url,
      bridge,
      runtime,
      ready,
      async executeTool(name, callId, args, signal, update) {
        const current = session(),
          runner = current.extensionRunner;
        const definition = current.getToolDefinition(name);
        if (!definition) throw new DeskError(409, "工具已变化，请重载资源");
        try {
          const decision = await runner.emitToolCall({
            type: "tool_call",
            toolName: name,
            toolCallId: callId,
            input: args,
          });
          if (decision?.block)
            throw new DeskError(403, decision.reason ?? "扩展阻止了工具调用");
          if (name === "ask_user_question")
            askQuestions = (decision?.input ?? args).questions;
          const tool = sdk.wrapRegisteredTool(
            { definition, extensionPath: "pi-durable-desktop" },
            runner,
          );
          let result = await tool.execute(
            callId,
            decision?.input ?? args,
            signal,
            update,
          );
          const changed = await runner.emitToolResult({
            type: "tool_result",
            toolName: name,
            toolCallId: callId,
            input: args,
            ...result,
            isError: !!result.isError,
          });
          if (changed) result = { ...result, ...changed };
          options.onToolResult?.(name, result);
          return result;
        } finally {
          if (name === "ask_user_question") askQuestions = undefined;
        }
      },
      stop: async () => {
        interactions.cancelAll();
        session().abortCompaction();
        await session().abort();
        await ready;
        await runtime.dispose();
        for (const widget of extensionWidgets.values()) widget?.dispose?.();
        extensionWidgets.clear();
        unsubscribe?.();
        await bridge.stop();
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

export async function webMain(args = process.argv.slice(2)) {
  if (!args.includes("--legacy")) {
    const { deskMain } = await import("../../desk.mjs");
    return deskMain(args);
  }
  return legacyWebMain(args.filter((argument) => argument !== "--legacy"));
}
async function legacyWebMain(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--help" || name === "-h") {
      process.stdout.write(
        "pi web [--cwd PATH] [--host IP] [--port PORT] [--tls-cert FILE --tls-key FILE] [--no-extensions] [--no-qr]\n无需 TUI；默认 0.0.0.0:4318，电脑与手机共享一个端口；--host 127.0.0.1 仅限本机，--no-qr 不打印二维码。\n",
      );
      return;
    }
    if (name === "--no-qr") {
      options.noQr = true;
      continue;
    }
    if (name === "--no-extensions") {
      options.noExtensions = true;
      continue;
    }
    const keys = {
      "--cwd": "cwd",
      "--agent-dir": "agentDir",
      "--port": "port",
      "--host": "host",
      "--tls-cert": "certPath",
      "--tls-key": "keyPath",
    };
    if (!keys[name] || !args[i + 1])
      throw new Error(`未知或不完整的参数：${name}`);
    options[keys[name]] = args[++i];
  }
  const settings = SettingsManager.create(
    resolve(options.cwd ?? process.cwd()),
    options.agentDir ?? getAgentDir(),
    { projectTrusted: false },
  );
  const networkConfigured = await configurePiNetwork(settings);
  if (!networkConfigured)
    process.stderr.write(
      "当前 Pi 未提供网络调度适配接口；使用默认 HTTP 网络设置。\n",
    );
  const app = await startWeb(options);
  process.stdout.write(
    `Pi Web ${VERSION}\n${app.url}\n电脑可直接打开；手机扫描下方二维码，二者同步使用同一会话。\n`,
  );
  if (!options.noQr) {
    try {
      const connection = await app.bridge.connectionDetails();
      const { default: QRCode } = await import("qrcode");
      process.stdout.write(
        `手机与电脑连接同一 Wi-Fi，扫码打开 Pi（共享会话）：\n${await QRCode.toString(connection.url, { type: "terminal", small: true })}\n${connection.url}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `手机二维码未生成：${error.message}。可在网页的远程连接页面重试。\n`,
      );
    }
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  webMain().catch(() => {
    process.stderr.write(
      "Pi Web 启动失败，请检查配置、监听端口和 TLS 文件。\n",
    );
    process.exitCode = 1;
  });
