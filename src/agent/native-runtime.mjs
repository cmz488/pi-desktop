import { createHash, randomUUID } from "node:crypto";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { AsyncLocalStorage } from "node:async_hooks";
import { createNativeModelRuntime } from "./native-model-runtime.mjs";
import { compileNativeBoundary } from "./native-boundary.mjs";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { contentText } from "../shared/conversation.mjs";
import {
  loadPiMessages,
  expandNativePrompt,
  embeddedSdkEntry,
} from "./pi-sdk.mjs";

/**
 * 原生资源会话与 Durable 回合之间的桥（边界文档 seam B 的内侧）。
 *
 * 接口：`createNativeRuntime({ workspace, id, nativeSnapshot, ready, syncTools, onError })` 返回
 *   `{ record, stateEntries, withToolContext, initialize, input, systemPrompt, modelRuntime, bind, flush,
 *      beforeRequest, afterResponse, afterTools, afterTurn, beforeSettle, dispose }`；
 *   字段与调用顺序见 docs/architecture/interfaces/resource-session.md。
 * 不变量：Pi 拥有扩展状态与 handler 顺序，Durable 拥有被接受的模型回合；资源会话不跑
 *   第二个模型循环；原生输入经准入进入 Durable，观察与事件回放不重新触发执行。
 * 错误：初始化与工具同步的失败经 `onError` 上报；过期 context 保留 SDK 原生同步错误。
 */

const signature = (message) =>
  message.role === "toolResult"
    ? `tool:${message.toolCallId}`
    : createHash("sha256").update(JSON.stringify(message)).digest("hex");

/**
 * 公开 Session 的消息方法与 Runner 上下文在这条兼容 seam 上被代理：Pi 的扩展与调度
 * 继续按原语义工作，而模型回合仍由 Durable 拥有。
 */
export function createNativeRuntime({
  workspace,
  id,
  nativeSnapshot,
  ready,
  syncTools,
  onError,
}) {
  let session,
    disposed = false,
    run = false,
    idle = true,
    settling = false;
  let controller = new AbortController();
  let queue = [],
    draining,
    saved,
    promptUpdate,
    models,
    assistantStarted = false,
    loop = false,
    turnIndex = -1,
    runInput;
  const signals = new AsyncLocalStorage();
  let messages = [];
  const mirrored = new Map();
  const boundRunners = new WeakSet();
  let stopReady;
  const stopped = new Promise((resolve) => {
    stopReady = resolve;
  });
  const waitReady = (context) => Promise.race([ready(context), stopped]);
  let observing,
    dirty = false;
  const unsubscribe = workspace.subscribe((event) => {
    if (event?.type === "abort" && event.id === id) controller.abort();
    if (disposed || !session || !run) return;
    dirty = true;
    if (observing) return;
    observing = Promise.resolve()
      .then(async () => {
        while (dirty && !disposed && run) {
          dirty = false;
          await settle();
        }
      })
      .catch(report)
      .finally(() => {
        observing = undefined;
      });
  });
  const report = (error) => {
    if (!disposed) onError(error);
  };
  const runner = () => session.extensionRunner;
  function stateEntries() {
    return JSON.parse(
      JSON.stringify(
        session.sessionManager
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
      ),
    );
  }
  async function save(extra = []) {
    if (disposed) return;
    const entries = stateEntries();
    const next = JSON.stringify(entries);
    if (saved === next && !extra.length) return;
    await workspace.persistNative(id, entries, extra);
    saved = next;
  }
  function enqueue(item) {
    if (disposed) return Promise.reject(new Error("原生扩展运行时已关闭"));
    queue.push({ ...item, requestId: `native:${randomUUID()}` });
    queueMicrotask(() => void flush().catch(report));
    return Promise.resolve();
  }
  async function flush() {
    if (draining) return draining;
    draining = (async () => {
      await waitReady();
      while (queue.length && !disposed) {
        const item = queue.shift();
        await syncTools();
        if (item.custom) {
          const message = {
            ...item.message,
            role: "custom",
            timestamp: Date.now(),
          };
          session.sessionManager.appendCustomMessageEntry(
            message.customType,
            message.content ?? [],
            message.display ?? true,
            message.details,
          );
          session.refreshContext();
          await save([
            {
              message,
              triggerTurn: !!item.options?.triggerTurn,
              requestId: item.requestId,
              mode: item.options?.deliverAs === "steer" ? "steer" : "followUp",
            },
          ]);
          continue;
        }
        await save();
        const prepared = await processInput(
          contentText(item.content),
          Array.isArray(item.content)
            ? item.content.filter((block) => block.type === "image")
            : undefined,
          {
            source: "extension",
            mode: item.options?.deliverAs,
            expandPromptTemplates: item.options?.expandPromptTemplates === true,
          },
        );
        if (prepared.handled) continue;
        await workspace.execute(
          "send",
          {
            id,
            message: prepared.message,
            images: prepared.images,
            mode: item.options?.deliverAs === "steer" ? "steer" : "followUp",
            requestId: item.requestId,
          },
          { presentation: { source: "automatic" } },
        );
      }
    })();
    try {
      await draining;
    } finally {
      draining = undefined;
    }
  }
  async function processInput(message, images, options = {}) {
    await waitReady();
    if (
      options.expandPromptTemplates &&
      message.startsWith("/") &&
      (await session._tryExecuteExtensionCommand(message))
    ) {
      await save();
      return { handled: true };
    }
    idle = (await workspace.agent(id)).idle;
    if (idle && controller.signal.aborted) controller = new AbortController();
    const result = await runner().emitInput(
      message,
      images,
      options.source ?? "rpc",
      idle ? undefined : options.mode,
    );
    if (result.action === "handled") {
      await save();
      return { handled: true };
    }
    message = result.action === "transform" ? result.text : message;
    images = result.action === "transform" ? (result.images ?? images) : images;
    if (options.expandPromptTemplates) {
      message = session._expandSkillCommand(message);
      message = await expandNativePrompt(
        message,
        session.promptTemplates,
        embeddedSdkEntry,
      );
    }
    await save();
    return { message, images };
  }
  function mirror(input) {
    const counts = new Map();
    for (const message of input) {
      if (!["user", "assistant", "toolResult"].includes(message.role)) continue;
      const key = signature(message),
        count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count <= (mirrored.get(key) ?? 0)) continue;
      session.sessionManager.appendMessage(message);
      mirrored.set(key, count);
    }
    session.refreshContext();
  }
  async function canonical() {
    await save();
    const snapshot = await nativeSnapshot(id);
    session.sessionManager._loadEntries([snapshot.header, ...snapshot.entries]);
    if (snapshot.leafId) session.sessionManager.branch(snapshot.leafId);
    else session.sessionManager.resetLeaf();
    session.refreshContext();
    mirrored.clear();
    for (const entry of session.sessionManager.getBranch())
      if (entry.type === "message") {
        const key = signature(entry.message);
        mirrored.set(key, (mirrored.get(key) ?? 0) + 1);
      }
    return snapshot;
  }
  async function endLoop() {
    if (!loop) return;
    loop = false;
    await runner().emit({ type: "agent_end", messages });
  }
  async function boundary(type, event, api, context) {
    return signals.run(context.abortSignal, async () => {
      if (type === "agent_before_settle") await endLoop();
      await flush();
      let snapshot = await canonical();
      const mapping = new Map(snapshot.mapping);
      const entries = new Map(
        snapshot.entries.map((entry) => [entry.id, entry]),
      );
      const messageEntryId = mapping.get(event.assistant);
      const toolResultEntryIds = event.results.map((id) => mapping.get(id));
      if (!messageEntryId || toolResultEntryIds.some((id) => !id))
        throw new Error("原生边界缺少已发布的消息身份");
      const result = await runner().emitBoundary(
        {
          type,
          outcome: event.outcome,
          ...(type === "turn_end"
            ? {
                turnIndex,
                message: entries.get(messageEntryId).message,
                toolResults: toolResultEntryIds.map(
                  (id) => entries.get(id).message,
                ),
                messageEntryId,
                toolResultEntryIds,
              }
            : {}),
        },
        async (drafts) => {
          await flush();
          snapshot = await canonical();
          const pending =
            (await api.snapshot(InboxDoc, id, context))?.items.flatMap(
              (item) =>
                item.mode === "write"
                  ? []
                  : item.entry?.data?.nativeMessage
                    ? [item.entry.data.nativeMessage]
                    : (item.entry?.model ?? [
                        {
                          role: "user",
                          content: item.content,
                          timestamp: Date.now(),
                        },
                      ]),
            ) ?? [];
          const preview = session._buildBoundaryContext(drafts, type);
          preview.pendingMessages.push(...pending);
          if (pending.length) preview.canContinue = true;
          return preview;
        },
      );
      let continuation = result.continue;
      if (continuation && !result.context.canContinue) {
        session._reportInvalidBoundaryContinuation(type);
        continuation = false;
      }
      const drafts = await compileNativeBoundary(
        session,
        result.entries,
        snapshot,
      );
      if (
        type === "turn_end" &&
        event.automatic &&
        event.outcome !== "completed"
      )
        await endLoop();
      await save();
      return { entries: drafts, continue: continuation };
    });
  }
  async function settle() {
    if (disposed || settling || !session) return;
    const active = await workspace.agent(id);
    if (disposed) return;
    idle = active.idle;
    if (!run || !idle) return;
    settling = true;
    try {
      run = false;
      await endLoop();
      const previousController = controller;
      await flush();
      if (
        !run &&
        previousController === controller &&
        (await workspace.agent(id)).idle
      ) {
        session._runSystemPromptOptions = undefined;
        promptUpdate = undefined;
        await runner().emit({ type: "agent_settled" });
        await save();
        await flush();
      }
    } finally {
      settling = false;
    }
  }
  return {
    record: mirror,
    stateEntries,
    withToolContext: (context, execute) =>
      signals.run(context.abortSignal, async () => {
        if (nativeSnapshot) await canonical();
        return execute();
      }),
    async initialize() {
      if (!nativeSnapshot) return;
      await canonical();
      const active = await workspace.agent(id);
      const model =
        active.model &&
        session.modelRuntime.getModel(
          active.model.provider,
          active.model.modelId,
        );
      // 只恢复已有配置，不把绑定前的投影同步伪装成用户 setModel／model_select 操作。
      if (model) session.agent.state.model = model;
      session.setThinkingLevel(active.thinkingLevel);
      if (active.nativeInitialized || !active.nativeDefaults) {
        const loaded = new Set(session.getAllTools().map((tool) => tool.name));
        session.setActiveToolsByName(
          active.tools.filter((name) => loaded.has(name)),
        );
      }
    },
    input: processInput,
    // force 仅属于 provider 请求，不能被 Durable 的 section renderer 记录进历史。
    systemPrompt: () =>
      promptUpdate ? getSystemMessageText(promptUpdate) : session.systemPrompt,
    async modelRuntime(_api, context) {
      await waitReady(context);
      context.abortSignal?.throwIfAborted();
      if (disposed) throw new Error("原生扩展运行时已关闭");
      const ref = (await workspace.agent(id)).model;
      if (!ref || !session.modelRuntime.getModel(ref.provider, ref.modelId))
        return undefined;
      return models;
    },
    bind(current, { stream } = {}) {
      session = current;
      models = createNativeModelRuntime(
        current,
        {
          scope: (signal, action) => signals.run(signal, action),
          abort: () => controller.abort(),
          event: async (event) => {
            if (disposed) return;
            if (event.type === "start") {
              assistantStarted = true;
              await current._emitExtensionEvent({
                type: "message_start",
                message: event.partial,
              });
            } else if (event.type !== "done" && event.type !== "error") {
              await current._emitExtensionEvent({
                type: "message_update",
                message: event.partial,
                assistantMessageEvent: event,
              });
            }
          },
        },
        stream,
      );
      current.sendUserMessage = (content, options) =>
        enqueue({ content, options });
      current.sendCustomMessage = (message, options) =>
        enqueue({ custom: true, message, options });
      if (boundRunners.has(runner())) return;
      boundRunners.add(runner());
      const createContext = runner().createContext.bind(runner());
      runner().createContext = () => {
        const context = createContext();
        const nativeSignal = Object.getOwnPropertyDescriptor(
          context,
          "signal",
        ).get.bind(context);
        // 替换能力值但保留原生失效检查，不能让旧 runner 的 context 读到新回合或执行 abort。
        const assertActive = () => void context.mode;
        return Object.defineProperties(context, {
          isIdle: {
            value: () => {
              assertActive();
              return idle && !queue.length;
            },
          },
          hasPendingMessages: {
            value: () => {
              assertActive();
              return !!queue.length;
            },
          },
          signal: {
            get: () => {
              assertActive();
              return signals.getStore() ?? nativeSignal() ?? controller.signal;
            },
          },
          abort: {
            value: () => {
              assertActive();
              void workspace.execute("abort", { id }).catch(report);
            },
          },
        });
      };
    },
    async flush() {
      if (observing) await observing;
      await settle();
      await flush();
      await save();
    },
    afterTurn: (event, api, context) =>
      boundary("turn_end", event, api, context),
    beforeSettle: (event, api, context) =>
      boundary("agent_before_settle", event, api, context),
    async beforeRequest(request, context, api) {
      return signals.run(context.abortSignal, async () => {
        await waitReady(context);
        context.abortSignal?.throwIfAborted();
        idle = false;
        if (nativeSnapshot) await canonical();
        else mirror(request.messages);
        const inputRun =
          api && (await api.snapshot(LiveDoc, id, context))?.run?.inputs[0];
        if (run && inputRun !== runInput) {
          await endLoop();
          run = false;
        }
        let pending = [],
          inputMessage;
        if (!run) {
          session._runSystemPromptOptions = undefined;
          promptUpdate = undefined;
          const prior =
            (await workspace.transcript(id)).entries.at(-1)?.id ?? 0;
          controller = new AbortController();
          run = true;
          runInput = inputRun;
          loop = true;
          turnIndex = -1;
          messages = [];
          const user = request.messages.findLast(
            (message) => message.role === "user",
          );
          const origin = request.entries?.findLast((entry) =>
            entry.model?.some((message) => message.role === "user"),
          );
          inputMessage = origin?.data?.nativeMessage ?? user;
          const promptOptions = runner()
            .createCommandContext()
            .getSystemPromptOptions();
          const selectedBefore = [...promptOptions.selectedTools];
          // 1.4.0: emitBeforeAgentStart(trigger, systemPromptOptions)。
          // trigger 是 user／custom 的判别联合：user 带 prompt+images，custom 带 message。
          // 原生 request 只可能是用户输入启动，所以这里用 user 分支。
          const result = await runner().emitBeforeAgentStart(
            {
              messageType: "user",
              prompt: contentText(user?.content),
              ...(Array.isArray(user?.content) &&
              user.content.some((block) => block.type === "image")
                ? {
                    images: user.content.filter(
                      (block) => block.type === "image",
                    ),
                  }
                : {}),
            },
            promptOptions,
          );
          const selected = result.systemPromptOptions.selectedTools;
          if (
            selected.length === selectedBefore.length &&
            selected.every((name, index) => name === selectedBefore[index])
          )
            result.systemPromptOptions.selectedTools =
              session.getActiveToolNames();
          promptUpdate = session._preparePromptAndToolLoadout(
            result.systemPromptOptions,
            [],
          ) ?? {
            role: "system",
            content: "",
            sections: {},
            timestamp: Date.now(),
          };
          session._runSystemPromptOptions = result.systemPromptOptions;
          for (const message of result.messages ?? [])
            await session.sendCustomMessage(message, { triggerTurn: false });
          await flush();
          pending = (
            await workspace.transcript(id, { since: prior })
          ).entries.flatMap((entry) => entry.model ?? []);
          await runner().emit({ type: "agent_start" });
        }
        if (!loop) {
          messages = [];
          loop = true;
          turnIndex = -1;
          await runner().emit({ type: "agent_start" });
        }
        turnIndex++;
        await runner().emit({
          type: "turn_start",
          turnIndex,
          timestamp: Date.now(),
        });
        if (inputMessage) {
          messages.push(inputMessage);
          await runner().emit({ type: "message_start", message: inputMessage });
          await runner().emit({ type: "message_end", message: inputMessage });
        }
        controller.signal.throwIfAborted();
        assistantStarted = false;
        const incoming = [...request.messages, ...pending];
        const firstSystem = incoming.findIndex(
          (message) => message.role === "system",
        );
        if (firstSystem > 0)
          incoming.unshift(...incoming.splice(firstSystem, 1));
        if (promptUpdate)
          incoming.push({
            ...promptUpdate,
            sections: { ...promptUpdate.sections, pi_project_resources: null },
          });
        const projected = await session.agent.transformContext(
          incoming,
          controller.signal,
        );
        await save();
        return { messages: (await loadPiMessages()).convertToLlm(projected) };
      });
    },
    async afterResponse(message, context) {
      return signals.run(context?.abortSignal, async () => {
        if (!assistantStarted)
          await runner().emit({ type: "message_start", message });
        await session._emitExtensionEvent({ type: "message_end", message });
        messages.push(message);
        if (!nativeSnapshot) mirror([message]);
        await save();
      });
    },
    async afterTools(_assistantId, resultIds) {
      const entries = (await workspace.transcript(id)).entries;
      const toolResults = entries
        .filter((entry) => resultIds.includes(entry.id))
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "toolResult");
      messages.push(...toolResults);
      await save();
    },
    async dispose() {
      disposed = true;
      controller.abort();
      stopReady();
      unsubscribe();
      queue = [];
      if (draining) await draining.catch(() => {});
      if (observing) await observing;
      signals.disable();
    },
  };
}
