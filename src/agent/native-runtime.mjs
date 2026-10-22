import { createHash, randomUUID } from "node:crypto";
import { contentText } from "../shared/conversation.mjs";
import { loadPiMessages } from "./pi-sdk.mjs";

/**
 * 原生资源会话与 Durable 回合之间的桥（边界文档 seam B 的内侧）。
 *
 * 接口：`createNativeRuntime({ workspace, id, ready, syncTools, onError })` 返回
 *   `{ record, bind, flush, beforeRequest, afterResponse, afterTools, dispose }`；
 *   字段与调用顺序见 docs/architecture/interfaces/resource-session.md。
 * 不变量：Pi 拥有扩展状态与调度，Durable 拥有每一个被接受的模型回合；资源会话不跑
 *   第二个模型循环；消息与事件方向单向（Durable 提交 → Pi 生命周期）。
 * 错误：初始化与工具同步的失败经 `onError` 上报，不静默丢弃。
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
    assistant;
  let messages = [],
    toolResults = [];
  const mirrored = new Map();
  const nativeInputs = [];
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
    queue.push(item);
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
          await save([{ message, triggerTurn: !!item.options?.triggerTurn }]);
          if (!item.options?.triggerTurn) continue;
          nativeInputs.push(message);
        } else await save();
        const content = item.custom ? item.message.content : item.content;
        await workspace.execute(
          "send",
          {
            id,
            message: contentText(content),
            images: Array.isArray(content)
              ? content.filter((block) => block.type === "image")
              : undefined,
            mode: item.options?.deliverAs === "steer" ? "steer" : "followUp",
            requestId: `native:${randomUUID()}`,
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
      await flush();
      await runner().emit({ type: "agent_settled" });
      await save();
      await flush();
    } finally {
      settling = false;
    }
  }
  return {
    record: mirror,
    bind(current) {
      session = current;
      current.sendUserMessage = (content, options) =>
        enqueue({ content, options });
      current.sendCustomMessage = (message, options) =>
        enqueue({ custom: true, message, options });
      if (boundRunners.has(runner())) return;
      boundRunners.add(runner());
      const createContext = runner().createContext.bind(runner());
      runner().createContext = () =>
        Object.defineProperties(createContext(), {
          isIdle: { value: () => idle && !queue.length },
          hasPendingMessages: { value: () => !!queue.length },
          signal: { get: () => controller.signal },
          abort: {
            value: () => {
              void workspace.execute("abort", { id }).catch(report);
            },
          },
        });
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
      if (!run) {
        controller = new AbortController();
        run = true;
        messages = [];
        toolResults = [];
        const user = request.messages.findLast(
          (message) => message.role === "user",
        );
        const nativeIndex = nativeInputs.findIndex(
          (message) =>
            contentText(message.content) === contentText(user?.content),
        );
        const input =
          nativeIndex < 0 ? user : nativeInputs.splice(nativeIndex, 1)[0];
        const result = await runner().emitBeforeAgentStart(
          contentText(user?.content),
          undefined,
          runner().createCommandContext().getSystemPromptOptions(),
        );
        for (const message of result.messages ?? [])
          await session.sendCustomMessage(message, { triggerTurn: false });
        await runner().emit({ type: "agent_start" });
        if (input) {
          messages.push(input);
          await runner().emit({ type: "message_start", message: input });
          await runner().emit({ type: "message_end", message: input });
        }
        controller.signal.throwIfAborted();
      }
      await runner().emit({ type: "turn_start" });
      const projected = await runner().emitContext([...request.messages]);
      await save();
      return { messages: (await loadPiMessages()).convertToLlm(projected) };
    },
    async afterResponse(message) {
      assistant = message;
      messages.push(message);
      mirror([message]);
      await runner().emit({ type: "message_start", message });
      await runner().emit({ type: "message_end", message });
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
      nativeInputs.length = 0;
      if (draining) await draining.catch(() => {});
      if (observing) await observing;
    },
  };
}
