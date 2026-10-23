import { validateApprovalMode } from "./pi-permissions.mjs";
import {
  defineExtension,
  defineTool,
  section,
  AssistantEntry,
  configure,
  hook,
  GenerationTask,
  CompactionTask,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { withAbortSignal } from "@earendil-works/chord/context";
import { startWebSlot } from "../server/web.mjs";
import { embeddedSdkEntry, loadEmbeddedPiSdk } from "./pi-sdk.mjs";
import { DesktopResources } from "./desktop-documents.mjs";
import { readFile } from "node:fs/promises";
import { commandCatalog } from "../shared/pi-commands.mjs";
import { expandNativePrompt } from "./pi-sdk.mjs";
import { DeskError } from "../config/config-store.mjs";
import { ReadOnlyWeb } from "./read-only-tools.mjs";
import { createNativeRuntime } from "./native-runtime.mjs";

/**
 * 每个 Agent 一个 Pi 资源会话宿主：把 Pi 的工具、扩展、技能、MCP、包管理与交互
 * 投影成 facade（边界文档的 seam B）。
 *
 * 接口：`createDurableResources(options)` 返回
 *   `{ attach, ensure, normalizeExtensions, selectTools, reload, close, cancelInteractions, canWrite, interactions }`，
 *   其 facade 为 `{ read, describe, execute }`；完整 action 表、顺序与错误见
 *   docs/architecture/interfaces/resource-session.md。
 * 不变量：资源会话不跑模型循环；`ensure(active)` 幂等并按会话缓存；`desk-native:*`
 *   扩展按 scope 过滤；只读只裁剪工具集，不改变 facade 形状；事件方向单向。
 * 错误：DeskError(404／422) 表示无效的资源操作、未知命令与未加载技能。
 */
// 复用原生资源 loader、MCP 实现、包管理器与 UI 交互；这个 runtime 不接收普通聊天，
// 也不跑模型循环。
export function createDurableResources({
  agentDir,
  onEvent = () => {},
  noExtensions = false,
  readOnly = false,
  nativeResources = {},
  durableTools = [],
  approvalMode = "yolo",
  providers,
  browser,
}) {
  const hosts = new Map(),
    readyHosts = new Map(),
    retiring = new Map();
  let workspace,
    unsubscribe,
    cleanup,
    cleanupAgain = false,
    closing = false;
  const report = (id, error) =>
    onEvent("notification", {
      sessionId: String(id),
      type: "error",
      message: `Pi 资源维护失败：${error.message}`,
    });
  async function reapOwned() {
    if (closing || ![...readyHosts.values()].some((host) => host.owned)) return;
    const state = await workspace.read();
    for (const row of state.children) {
      const host = readyHosts.get(row.id);
      if (
        !host?.owned ||
        state.tasks.some(
          (task) =>
            task.id === row.owner?.taskId || task.conversationId === row.id,
        )
      )
        continue;
      const release = (async () => {
        // 先完成原生结束事件及其持久化；扩展可能在结束边界提交下一轮工作。
        await host.nativeRuntime.flush();
        if (!(await workspace.agent(row.id)).idle) return;
        await host.nativeRuntime.dispose();
        await host.app.stop();
        workspace.uninstall(host.extension);
        hosts.delete(row.id);
        readyHosts.delete(row.id);
      })();
      retiring.set(row.id, release);
      try {
        await release;
      } finally {
        retiring.delete(row.id);
      }
    }
  }
  function scheduleCleanup() {
    if (closing) return;
    cleanupAgain = true;
    if (cleanup) return;
    cleanup = Promise.resolve()
      .then(async () => {
        while (cleanupAgain && !closing) {
          cleanupAgain = false;
          await reapOwned();
        }
      })
      .catch((error) => {
        if (!closing) report("", error);
      })
      .finally(() => {
        cleanup = undefined;
      });
  }
  async function ensureHost(active) {
    if (!active) return undefined;
    await retiring.get(active.id);
    if (closing) throw new DeskError(409, "Pi 资源宿主已关闭");
    const piSdk = await loadEmbeddedPiSdk();
    let pending = hosts.get(active.id);
    if (pending) {
      const host = await pending;
      if (host.cwd === active.cwd) {
        await host.refresh(active);
        return host;
      }
      if (!active.idle) throw new DeskError(409, "工具仍在原目录运行");
      await host.nativeRuntime.dispose();
      await host.app.stop();
      hosts.delete(active.id);
      readyHosts.delete(active.id);
    }
    let createdRuntime;
    pending = (async () => {
      const manager = piSdk.SessionManager.inMemory(active.cwd);
      for (const entry of active.resourceState?.entries ?? [])
        manager.appendCustomEntry(entry.customType, entry.data);
      const approvalPolicy = {
        mode: validateApprovalMode(active.approvalMode ?? approvalMode),
      };
      let capabilities;
      let invocation, lastAssistant;
      let installed;
      const installedReady = new Promise((resolve) => {
        installed = resolve;
      });
      const nativeRuntime = (createdRuntime = createNativeRuntime({
        workspace,
        id: active.id,
        ready: async (context) => {
          await installedReady;
          if (context) await ready(context);
          else await app.ready;
        },
        onError: (error) =>
          onEvent("notification", {
            sessionId: String(active.id),
            type: "error",
            message: `Pi 扩展运行失败：${error.message}`,
          }),
        syncTools: async () => {
          const latest = await workspace.agent(active.id);
          const tools = app.runtime.session.getActiveToolNames();
          if (
            latest.idle &&
            (tools.length !== latest.tools.length ||
              tools.some((name) => !latest.tools.includes(name)))
          )
            await workspace.execute("configure", {
              id: active.id,
              revision: latest.revision,
              tools,
              nativeDefaults: latest.nativeDefaults,
            });
        },
      }));
      const environmentTools = readOnly
        ? [
            ...CodingTools.tools.filter((tool) => tool.name === "read"),
            ...ReadOnlyWeb.tools,
          ]
        : [...CodingTools.tools, ...durableTools];
      // 保留 Pi 的原生 read 工具：Durable 的 read 目前不接受图片，
      // 而图片解码／缩放与同一套扩展／审批钩子由 Pi 拥有。
      const customTools = environmentTools
        .filter((tool) => tool.name !== "read")
        .map((tool) => ({
          name: tool.name,
          label: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          annotations: {
            readOnlyHint: readOnly || tool.name === "read",
            destructiveHint: !readOnly && tool.name !== "read",
          },
          async execute(callId, args, signal) {
            if (!invocation)
              throw new DeskError(409, "工具必须在 Durable 任务中执行");
            const ctx = signal
              ? withAbortSignal(signal, invocation.context)
              : invocation.context;
            let output = "";
            const result = await tool.execute(
              args,
              {
                ...invocation.api,
                callId,
                output(value) {
                  output = (output + value).slice(-50000);
                  invocation.api.output(value);
                },
              },
              ctx,
            );
            return {
              content:
                result.content ??
                (output ? [{ type: "text", text: output }] : []),
              details: result.details ?? {},
              isError:
                !!result.isError ||
                result.diagnostics?.some((item) => item.severity === "error"),
            };
          },
        }));
      const modelRuntime =
        providers?.resourceOptions &&
        (await piSdk.ModelRuntime.create(providers.resourceOptions()));
      const provider =
        active.model && providers?.models.getProvider(active.model.provider);
      if (provider) modelRuntime.registerNativeProvider(provider);
      const app = await startWebSlot({
        agentDir,
        sdk: piSdk,
        sdkEntry: embeddedSdkEntry,
        cwd: active.cwd,
        sessionManager: manager,
        noExtensions,
        nativeResources: {
          ...nativeResources,
          ...(readOnly ? { extensions: [] } : {}),
        },
        readOnly,
        approvalPolicy,
        customTools,
        resourcesOnly: true,
        bindResourceSession: (current, transport) =>
          nativeRuntime.bind(current, transport),
        extensionFactories: browser
          ? [{ name: "desktop-browser", factory: (pi) => browser.factory(pi) }]
          : [],
        modelRuntime,
        toolSignal: () => invocation?.context.abortSignal,
        bridgeFactory(options) {
          capabilities = options;
          return {
            start: async () => "resource://local",
            stop: async () => {},
            publish(kind, data) {
              onEvent(kind, { ...data, sessionId: String(active.id) });
            },
          };
        },
      });
      const ready = async (context) => {
        context.abortSignal?.throwIfAborted();
        const cancel = () => capabilities.interactions.cancelAll();
        context.abortSignal?.addEventListener("abort", cancel, { once: true });
        try {
          await app.ready;
          context.abortSignal?.throwIfAborted();
        } finally {
          context.abortSignal?.removeEventListener("abort", cancel);
        }
      };
      const host = {
        id: active.id,
        name: active.name,
        owned: active.subagent === true,
        cwd: active.cwd,
        app,
        capabilities,
        scope: `desk-native:${active.id}`,
        nativeRuntime,
      };
      let installedNames = new Set(),
        pendingDefaults = new Set(),
        mutation = Promise.resolve();
      let syncedProvider = provider;
      host.update = (run) => {
        const result = mutation.then(run);
        mutation = result.catch(() => {});
        return result;
      };
      host.refresh = (selected) =>
        host.update(async () => {
          host.name = selected.name;
          const loaded = app.runtime.session.getAllTools();
          const added = loaded.filter((tool) => !installedNames.has(tool.name));
          if (added.length || loaded.length !== installedNames.size)
            host.install();
          for (const tool of added)
            if (
              !readOnly &&
              ["direct", "model-only"].includes(tool.exposure) &&
              app.runtime.session.getToolDefinition(tool.name)
                ?.defaultActive !== false
            )
              pendingDefaults.add(tool.name);
          const latest = await workspace.agent(selected.id);
          approvalPolicy.mode = validateApprovalMode(
            latest.approvalMode ?? approvalMode,
          );
          if (latest.idle && host.capabilities.canWrite()) {
            const modelProvider =
              latest.model &&
              providers?.models.getProvider(latest.model.provider);
            if (modelProvider && syncedProvider !== modelProvider) {
              modelRuntime.registerNativeProvider(modelProvider);
              syncedProvider = modelProvider;
            }
            const model =
              latest.model &&
              modelRuntime?.getModel(
                latest.model.provider,
                latest.model.modelId,
              );
            const session = app.runtime.session;
            if (
              model &&
              (session.model?.provider !== model.provider ||
                session.model?.id !== model.id)
            )
              await session.setModel(model);
            if (session.thinkingLevel !== latest.thinkingLevel)
              session.setThinkingLevel(latest.thinkingLevel);
          }
          if (
            !latest.nativeDefaults ||
            !latest.extensions.includes(host.scope)
          ) {
            pendingDefaults.clear();
            return;
          }
          if (!latest.idle || !pendingDefaults.size) return;
          try {
            await workspace.execute("configure", {
              id: latest.id,
              revision: latest.revision,
              nativeDefaults: true,
              tools: [...new Set([...latest.tools, ...pendingDefaults])],
            });
            pendingDefaults.clear();
          } catch (error) {
            if (error.status !== 409) throw error;
          }
        });
      host.approvalPolicy = approvalPolicy;
      host.install = () => {
        const session = app.runtime.session;
        const tools = session
          .getAllTools()
          .filter(
            (tool) =>
              !readOnly ||
              ["read", "web_fetch", "web_search", "agent_browser"].includes(
                tool.name,
              ),
          );
        installedNames = new Set(
          session.getAllTools().map((tool) => tool.name),
        );
        const extension = defineExtension({
          name: host.scope,
          hooks: [
            hook(CompactionTask, {
              modelRuntime: (api, context) =>
                nativeRuntime.modelRuntime(api, context),
            }),
            hook(GenerationTask, {
              modelRuntime: (api, context) =>
                nativeRuntime.modelRuntime(api, context),
              beforeRequest: (request, _api, context) =>
                nativeRuntime.beforeRequest(request, context),
              afterResponse: (message, _api, context) =>
                nativeRuntime.afterResponse(message, context),
              afterTools: (assistant, results) =>
                nativeRuntime.afterTools(assistant, results),
            }),
          ],
          sections: [
            section("pi_project_resources", async (_input, context) => {
              await ready(context);
              return nativeRuntime.systemPrompt();
            }),
          ],
          tools: tools.map((tool) =>
            defineTool({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              // ExtensionAPI 没有重放契约；即使 MCP 声明 read-only 提示，
              // 原生与嵌套调用也仍不安全。
              executionMode: "sequential",
              async execute(args, api, context) {
                if (
                  api.conversationId !== active.id ||
                  api.env?.cwd !== host.cwd
                )
                  throw new DeskError(409, "工具运行环境不属于当前 Agent");
                await ready(context);
                // 原生自动输入不经过 HTTP ensure；工具边界必须读取当前策略，不能依赖页面刷新。
                approvalPolicy.mode = validateApprovalMode(
                  (await workspace.agent(active.id)).approvalMode ??
                    approvalMode,
                );
                const agent = await api.agent(context);
                // Durable 内置工具不属于资源 Session，不能借同步选择将它们交给另一执行循环。
                const chosen = agent.tools
                  .map((tool) => tool.name)
                  .filter((name) => host.registered.has(name));
                const current = session.getActiveToolNames();
                if (
                  chosen.length !== current.length ||
                  chosen.some((name) => !current.includes(name))
                )
                  session.setActiveToolsByName(chosen);
                const nativeBefore = session.getActiveToolNames();
                const task = await api.getTask(api.taskId, context);
                if (task?.input?.assistant !== lastAssistant) {
                  const entry = await api.commit(
                    (tx) => tx.entry(AssistantEntry, task.input.assistant),
                    context,
                  );
                  nativeRuntime.record(entry?.model ?? []);
                  lastAssistant = task.input.assistant;
                }
                context.abortSignal?.throwIfAborted();
                invocation = { api, context };
                const cancel = () => capabilities.interactions.cancelAll();
                context.abortSignal?.addEventListener("abort", cancel, {
                  once: true,
                });
                let result;
                try {
                  result = await app.executeTool(
                    tool.name,
                    api.callId,
                    args,
                    context.abortSignal,
                    (update) => {
                      for (const block of update.content ?? [])
                        if (block.type === "text") api.output(block.text);
                    },
                  );
                } finally {
                  context.abortSignal?.removeEventListener("abort", cancel);
                  invocation = undefined;
                }
                await api.commit(async (tx) => {
                  const selected = session.getActiveToolNames();
                  if (
                    selected.length !== nativeBefore.length ||
                    selected.some((name) => !nativeBefore.includes(name))
                  ) {
                    const added = selected
                      .filter((name) => !nativeBefore.includes(name))
                      .map((name) => host.registered.get(name))
                      .filter(Boolean);
                    const removed = nativeBefore
                      .filter((name) => !selected.includes(name))
                      .map((name) => host.registered.get(name))
                      .filter(Boolean);
                    await configure(tx, api.conversationId, {
                      tools: { add: added, remove: removed },
                    });
                  }
                  const document = await tx.doc(
                    DesktopResources,
                    api.conversationId,
                  );
                  document.entries = JSON.parse(
                    JSON.stringify(
                      session.sessionManager
                        .getBranch()
                        .filter((entry) => entry.type === "custom")
                        .map(({ customType, data }) => ({
                          customType,
                          ...(data === undefined ? {} : { data }),
                        })),
                    ),
                  );
                }, context);
                return {
                  content: result.content,
                  ...(result.terminate ? { control: { terminate: true } } : {}),
                  ...(result.details === undefined
                    ? {}
                    : { details: result.details }),
                  ...(result.isError
                    ? {
                        isError: true,
                        diagnostics: [
                          {
                            severity: "error",
                            message: "Pi 扩展工具执行失败",
                          },
                        ],
                      }
                    : {}),
                };
              },
            }),
          ),
        });
        host.extension = extension;
        host.registered = new Map(
          [...CodingTools.tools, ...extension.tools].map((tool) => [
            tool.name,
            tool,
          ]),
        );
        workspace.install(extension);
      };
      host.install();
      installed();
      readyHosts.set(active.id, host);
      void app.ready
        .then(async () => {
          if (!closing) await host.refresh(await workspace.agent(active.id));
        })
        .catch((error) => {
          if (!closing) report(active.id, error);
        });
      return host;
    })();
    hosts.set(active.id, pending);
    try {
      return await pending;
    } catch (error) {
      await createdRuntime?.dispose();
      hosts.delete(active.id);
      throw error;
    }
  }
  function facade(host) {
    if (!host) return undefined;
    const capabilities = host.capabilities;
    async function expandPrompt(
      message,
      { original = message, requestId } = {},
    ) {
      const match = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
      if (!match) return { message };
      const name = match[1],
        args = match[2]?.trim() ?? "";
      const session = host.app.runtime.session;
      const command = session.extensionRunner.getCommand(name);
      if (command) {
        await workspace.recordInput(host.id, original, requestId);
        await command.handler(
          args,
          session.extensionRunner.createCommandContext(),
        );
        await host.nativeRuntime.flush();
        return { handled: true };
      }
      if (session.promptTemplates.some((template) => template.name === name))
        return {
          message: await expandNativePrompt(
            message,
            session.promptTemplates,
            embeddedSdkEntry,
          ),
        };
      if (name.startsWith("skill:")) {
        const skill = session.resourceLoader
          .getSkills()
          .skills.find((skill) => skill.name === name.slice(6));
        if (!skill) throw new DeskError(422, "技能未加载");
        return {
          message: `<skill name="${skill.name}">\n${await readFile(skill.filePath, "utf8")}\n</skill>\n${args}`,
        };
      }
      throw new DeskError(422, "未知 Pi 命令");
    }
    async function prepareInput(message, options = {}) {
      const session = host.app.runtime.session;
      const match = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
      if (match && session.extensionRunner.getCommand(match[1]))
        return expandPrompt(message, options);
      const prepared = await host.nativeRuntime.input(message, options.images, {
        source: options.source ?? "rpc",
        mode: options.mode,
        expandPromptTemplates: false,
      });
      if (prepared.handled) {
        await workspace.recordInput(
          host.id,
          options.original ?? message,
          options.requestId,
        );
        await host.nativeRuntime.flush();
        return prepared;
      }
      const expandedName = /^\/([^\s]+)/.exec(prepared.message)?.[1];
      if (expandedName && !session.extensionRunner.getCommand(expandedName))
        return {
          ...prepared,
          ...(await expandPrompt(prepared.message, options)),
        };
      return prepared;
    }
    return Object.freeze({
      read() {
        return {
          snapshot: capabilities.snapshot(),
          commands: commandCatalog(host.app.runtime.session),
          canWrite: capabilities.canWrite(),
          projectTrusted: capabilities.projectTrusted?.() ?? true,
          effectiveSettings: capabilities.effectiveSettings?.() ?? {},
        };
      },
      describe(catalog) {
        return {
          tools: [
            ...new Set(
              catalog.toolRegistrations
                .filter(
                  (row) =>
                    !row.extension.startsWith("desk-native:") ||
                    row.extension === host.scope,
                )
                .map((row) => row.name),
            ),
          ],
          extensions: catalog.extensions.filter(
            (name) => !name.startsWith("desk-native:") || name === host.scope,
          ),
        };
      },
      execute(action, ...args) {
        if (action === "approvalMode") {
          host.approvalPolicy.mode = validateApprovalMode(args[0]);
          return;
        }
        if (action === "expandPrompt") return expandPrompt(...args);
        if (action === "input") return prepareInput(...args);
        if (action === "packageAction")
          return capabilities.packageAction({
            ...args[0],
            sessionId: host.app.runtime.session.sessionId,
          });
        if (action.startsWith("interactions.")) {
          const method = action.slice("interactions.".length);
          if (!["list", "reply", "version"].includes(method))
            throw new DeskError(404, "资源交互操作无效");
          return capabilities.interactions[method](...args);
        }
        if (
          ![
            "settingsChanged",
            "skillInventory",
            "mcpRegistered",
            "mcpTools",
            "mcpAction",
            "trustProject",
            "packageRoot",
            "packageUpdates",
          ].includes(action)
        )
          throw new DeskError(404, "原生资源操作无效");
        return capabilities[action]?.(...args);
      },
    });
  }
  async function attach(target) {
    workspace = target;
    if (workspace.capabilities?.spawnSubagent === true)
      workspace.setOwnedPreparer((active) => selectTools(active));
    const state = await workspace.read();
    // owned 子代理拥有独立资源 scope；恢复前注册它的原生扩展，不能借用父会话的工具闭包。
    for (const agent of [
      ...state.agents,
      ...state.children.filter(
        (row) =>
          row.managed &&
          state.tasks.some(
            (task) =>
              task.id === row.owner?.taskId || task.conversationId === row.id,
          ),
      ),
    ])
      await ensureHost(await workspace.agent(agent.id));
    unsubscribe = workspace.subscribe((event) => {
      if (event?.type === "task-terminal") scheduleCleanup();
    });
  }
  async function selectTools(
    active,
    { defaults = false, newOnly = false } = {},
  ) {
    const host = await ensureHost(active);
    await host.update(async () => {
      const latest = await workspace.agent(active.id);
      if (newOnly && !latest.extensions.includes(host.scope)) return;
      const native = host.app.runtime.session
        .getActiveToolNames()
        .filter(
          (name) =>
            !readOnly && !["read", "write", "edit", "bash"].includes(name),
        );
      await workspace.execute("configure", {
        id: latest.id,
        revision: latest.revision,
        nativeInitialized: true,
        nativeDefaults: latest.nativeDefaults,
        extensions: [
          ...new Set([
            ...latest.extensions.filter(
              (name) => !name.startsWith("desk-native:"),
            ),
            host.scope,
          ]),
        ],
        tools: defaults
          ? [
              ...new Set([
                ...latest.tools,
                ...(newOnly ? [] : native),
                ...(latest.nativeDefaults ? (host.addedDefaults ?? []) : []),
                ...(browser && latest.nativeDefaults ? ["agent_browser"] : []),
              ]),
            ]
          : latest.tools,
      });
    });
    return facade(host);
  }
  async function reload(active) {
    const host = await ensureHost(active);
    const before = new Set(
      host.app.runtime.session.getAllTools().map((tool) => tool.name),
    );
    await host.capabilities.reload();
    host.addedDefaults = host.app.runtime.session
      .getAllTools()
      .filter(
        (tool) =>
          !before.has(tool.name) &&
          ["direct", "model-only"].includes(tool.exposure) &&
          host.app.runtime.session.getToolDefinition(tool.name)
            ?.defaultActive !== false,
      )
      .map((tool) => tool.name);
    host.install();
    if (active.extensions.includes(host.scope))
      await selectTools(await workspace.agent(active.id), {
        defaults: true,
        newOnly: true,
      });
    return facade(host);
  }
  async function close() {
    if (closing) return;
    closing = true;
    unsubscribe?.();
    await cleanup;
    for (const pending of hosts.values()) {
      const host = await pending.catch(() => undefined);
      await host?.nativeRuntime.dispose();
      await host?.app.stop();
    }
    hosts.clear();
    readyHosts.clear();
  }
  return {
    attach,
    ensure: async (active) => facade(await ensureHost(active)),
    normalizeExtensions: (names) =>
      names.filter((name) => !name.startsWith("desk-native:")),
    selectTools,
    reload,
    close,
    cancelInteractions: () => {
      for (const host of readyHosts.values())
        host.capabilities.interactions.cancelAll();
    },
    canWrite: () =>
      [...readyHosts.values()].every((host) => host.capabilities.canWrite()),
    // 只枚举已就绪的 owned 宿主；查看交互不能唤醒历史子会话。
    interactions: {
      list(scope, owner) {
        return [...readyHosts.values()]
          .filter((host) => scope.has(host.id))
          .flatMap((host) =>
            host.capabilities.interactions.list().map((row) => ({
              ...row,
              sourceConversationId: host.id,
              label:
                host.id === owner ? row.label : `${host.name} · ${row.label}`,
            })),
          );
      },
      version(scope) {
        return [...readyHosts.values()]
          .filter((host) => scope.has(host.id))
          .map(
            (host) => `${host.id}:${host.capabilities.interactions.version()}`,
          )
          .join(",");
      },
      reply(scope, input) {
        const host = [...readyHosts.values()].find(
          (host) =>
            scope.has(host.id) &&
            host.capabilities.interactions
              .list()
              .some((row) => row.id === input.id),
        );
        if (!host) throw new DeskError(404, "交互不存在");
        return host.capabilities.interactions.reply(input);
      },
    },
  };
}
