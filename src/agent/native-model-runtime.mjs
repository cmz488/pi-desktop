import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

/**
 * Pi 会话 Models adapter：复用原生请求 transport／provider hooks，将标准流交给 Durable。
 *
 * 接口：createNativeModelRuntime(session, {event,abort,scope}, transport) -> Pi AI Models。
 * 不变量：不调 prompt／continue，不创建任务或模型循环；provider 注册与认证属于同一 Pi Session。
 * 错误：请求准备异常形成原生 error／aborted 消息，由 Durable 分类和重试；普通 handler 错误由 Pi 报告。
 */
/**
 * @param {import("@earendil-works/pi-coding-agent").AgentSession} session
 * @param {{event: (event: import("@earendil-works/pi-ai").AssistantMessageEvent, signal?: AbortSignal) => Promise<void>, abort: () => void, scope: (signal: AbortSignal | undefined, action: () => Promise<void>) => Promise<void>}} callbacks
 * @param {import("@earendil-works/pi-coding-agent").AgentSession["agent"]["streamFunction"]} transport
 * @returns {import("@earendil-works/pi-ai").Models}
 */
export function createNativeModelRuntime(
  session,
  callbacks,
  transport = session.agent.streamFunction,
) {
  const models = session.modelRuntime;
  function optionsFor(options = {}) {
    const agent = session.agent;
    const notify =
      (first, second) =>
      async (...args) => {
        await first?.(...args);
        if (second !== first) await second?.(...args);
      };
    return {
      ...options,
      onPayload: async (payload, ...args) => {
        const changed = await options.onPayload?.(payload, ...args);
        payload = changed === undefined ? payload : changed;
        return agent.onPayload && agent.onPayload !== options.onPayload
          ? agent.onPayload(payload, ...args)
          : payload;
      },
      onResponse: notify(options.onResponse, agent.onResponse),
      onProviderStreamEvent: notify(
        options.onProviderStreamEvent,
        agent.onProviderStreamEvent,
      ),
    };
  }
  function stream(model, open, options, lifecycle) {
    const output = createAssistantMessageEventStream();
    const abort = () => {
      if (lifecycle) callbacks.abort();
    };
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    void callbacks.scope(options?.signal, async () => {
      try {
        const source = await open();
        for await (const event of source) {
          if (lifecycle && !options?.signal?.aborted)
            await callbacks.event(event, options?.signal);
          output.push(event);
        }
        output.end(await source.result());
      } catch (error) {
        const stopped = options?.signal?.aborted;
        const message = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: stopped ? "aborted" : "error",
          errorMessage: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
        };
        output.push({
          type: "error",
          reason: message.stopReason,
          error: message,
        });
        output.end();
      } finally {
        options?.signal?.removeEventListener("abort", abort);
      }
    });
    return output;
  }
  return new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple")
        return (model, input, options) =>
          stream(
            model,
            () => transport(model, input, optionsFor(options)),
            options,
            true,
          );
      if (key === "completeSimple")
        return (model, input, options) =>
          stream(
            model,
            () => transport(model, input, optionsFor(options)),
            options,
            false,
          ).result();
      if (key === "fetchDeferred")
        return (model, handle, options) =>
          stream(
            model,
            () => target.streamDeferred(model, handle, optionsFor(options)),
            options,
            true,
          ).result();
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
