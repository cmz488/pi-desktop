import { createHash, randomUUID } from "node:crypto";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { contentText } from "../shared/conversation.mjs";
import {
  loadPiMessages,
  expandNativePrompt,
  embeddedSdkEntry,
} from "./pi-sdk.mjs";

/**
 * 原生资源会话与 Durable 回合之间的桥（边界文档 seam B 的内侧）。
 *
 * 接口：`createNativeRuntime({ workspace, id, ready, syncTools, onError })` 返回
 *   `{ record, input, systemPrompt, bind, flush, beforeRequest, afterResponse, afterTools, dispose }`；
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
    assistant,
    promptUpdate;
  let messages = [],
    toolResults = [];
  const mirrored = new Map();
  const boundRunners = new WeakSet();
  let stopReady;
  const stopped = new Promise((resolve) => {
    stopReady = resolve;
  });
  const waitReady = () => Promise.race([ready(), stopped]);
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
  async function save(extra = []) {
    if (disposed) return;
    const entries = JSON.parse(
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
  async function settle() {
    if (disposed || settling || !session) return;
    const active = await workspace.agent(id);
    if (disposed) return;
    idle = active.idle;
    if (!run || !idle) return;
    settling = true;
    try {
      run = false;
      await runner().emit({ type: "agent_end", messages });
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
    input: processInput,
    // force 仅属于 provider 请求，不能被 Durable 的 section renderer 记录进历史。
    systemPrompt: () =>
      promptUpdate ? getSystemMessageText(promptUpdate) : session.systemPrompt,
    bind(current) {
      session = current;
      current.sendUserMessage = (content, options) =>
        enqueue({ content, options });
      current.sendCustomMessage = (message, options) =>
        enqueue({ custom: true, message, options });
      if (boundRunners.has(runner())) return;
      boundRunners.add(runner());
      const createContext = runner().createContext.bind(runner());
      runner().createContext = () => {
        const context = createContext();
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
              return controller.signal;
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
    async beforeRequest(request, context) {
      await waitReady();
      context.abortSignal?.throwIfAborted();
      idle = false;
      mirror(request.messages);
      let pending = [];
      if (!run) {
        session._runSystemPromptOptions = undefined;
        promptUpdate = undefined;
        const prior = (await workspace.transcript(id)).entries.at(-1)?.id ?? 0;
        controller = new AbortController();
        run = true;
        messages = [];
        toolResults = [];
        const user = request.messages.findLast(
          (message) => message.role === "user",
        );
        const origin = request.entries?.findLast((entry) =>
          entry.model?.some((message) => message.role === "user"),
        );
        const input = origin?.data?.nativeMessage ?? user;
        const promptOptions = runner()
          .createCommandContext()
          .getSystemPromptOptions();
        const selectedBefore = [...promptOptions.selectedTools];
        const result = await runner().emitBeforeAgentStart(
          contentText(user?.content),
          Array.isArray(user?.content)
            ? user.content.filter((block) => block.type === "image")
            : undefined,
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
        if (input) {
          messages.push(input);
          await runner().emit({ type: "message_start", message: input });
          await runner().emit({ type: "message_end", message: input });
        }
        controller.signal.throwIfAborted();
      }
      await runner().emit({ type: "turn_start" });
      const incoming = [...request.messages, ...pending];
      const firstSystem = incoming.findIndex(
        (message) => message.role === "system",
      );
      if (firstSystem > 0) incoming.unshift(...incoming.splice(firstSystem, 1));
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
    },
    async afterResponse(message) {
      await runner().emit({ type: "message_start", message });
      await session._emitExtensionEvent({ type: "message_end", message });
      assistant = message;
      messages.push(message);
      mirror([message]);
      if (message.stopReason !== "toolUse")
        await runner().emit({ type: "turn_end", message, toolResults: [] });
      await save();
    },
    async afterTools(assistantId, resultIds) {
      const entries = (await workspace.transcript(id)).entries;
      assistant =
        entries
          .find((entry) => entry.id === assistantId)
          ?.model?.find((message) => message.role === "assistant") ?? assistant;
      toolResults = entries
        .filter((entry) => resultIds.includes(entry.id))
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "toolResult");
      mirror(toolResults);
      messages.push(...toolResults);
      for (const result of toolResults)
        await runner().emit({
          type: "tool_execution_end",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          result,
          isError: !!result.isError,
        });
      await runner().emit({
        type: "turn_end",
        message: assistant,
        toolResults,
      });
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
    },
  };
}
