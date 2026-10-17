import { validateApprovalMode } from "./pi-permissions.mjs";
import {
  defineExtension,
  defineTool,
  section,
  AssistantEntry,
  configure,
  hook,
  GenerationTask,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { withAbortSignal } from "@earendil-works/chord/context";
import { startWebSlot } from "../server/web.mjs";
import { embeddedPiSdk as piSdk, embeddedSdkEntry } from "./pi-sdk.mjs";
import { DesktopResources } from "./desktop-documents.mjs";
import { readFile } from "node:fs/promises";
import { commandCatalog } from "../shared/pi-commands.mjs";
import { expandNativePrompt } from "./pi-sdk.mjs";
import { DeskError } from "../config/config-store.mjs";
import { ReadOnlyWeb } from "./read-only-tools.mjs";
import { createNativeRuntime } from "./native-runtime.mjs";

// Reuse the native resource loader, MCP implementation, package manager and UI
// interactions. This runtime never receives normal chat or runs a model loop.
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
    readyHosts = new Map();
  let workspace,
    closing = false;
  async function ensureHost(active) {
    if (!active) return undefined;
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
      const approvalPolicy = { mode: validateApprovalMode(approvalMode) };
      let capabilities;
      let invocation, lastAssistant;
      let installed;
      const installedReady = new Promise((resolve) => {
        installed = resolve;
      });
      const nativeRuntime = (createdRuntime = createNativeRuntime({
        workspace,
        id: active.id,
        ready: async () => {
          await installedReady;
          await app.ready;
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
      // Keep Pi's native read tool: Durable's read currently rejects images.
      // Pi owns image decoding/resizing and the same extension/approval hooks.
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
        bindResourceSession: (current) => nativeRuntime.bind(current),
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
            hook(GenerationTask, {
              beforeRequest: (request, _api, context) =>
                nativeRuntime.beforeRequest(request, context),
              afterResponse: (message) => nativeRuntime.afterResponse(message),
              afterTools: (assistant, results) =>
                nativeRuntime.afterTools(assistant, results),
            }),
          ],
          sections: [
            section("pi_project_resources", async (_input, context) => {
              await ready(context);
              return session.systemPrompt;
            }),
          ],
          tools: tools.map((tool) =>
            defineTool({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              // ExtensionAPI has no replay contract. Native and nested calls stay
              // unsafe even if MCP advertises read-only hints.
              executionMode: "sequential",
              async execute(args, api, context) {
                if (
                  api.conversationId !== active.id ||
                  api.env?.cwd !== host.cwd
                )
                  throw new DeskError(409, "工具运行环境不属于当前 Agent");
                await ready(context);
                const agent = await api.agent(context);
                const chosen = agent.tools.map((tool) => tool.name);
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
        .catch(() => {});
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
    async function expandPrompt(message) {
      const match = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
      if (!match) return { message };
      const name = match[1],
        args = match[2]?.trim() ?? "";
      const session = host.app.runtime.session;
      const command = session.extensionRunner.getCommand(name);
      if (command) {
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
        if (action === "expandPrompt") return expandPrompt(args[0]);
        if (action === "packageAction")
          return capabilities.packageAction({
            ...args[0],
            sessionId: host.app.runtime.session.sessionId,
          });
        if (action.startsWith("interactions.")) {
          const method = action.slice("interactions.".length);
          if (!["list", "reply"].includes(method))
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
    for (const agent of (await workspace.read()).agents)
      await ensureHost(await workspace.agent(agent.id));
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
  };
}
