/**
 * `window.pi` 适配层：把 Percho 渲染进程的传输契约接到我们的 Host HTTP 上。
 *
 * 接口：`createHostApi({ endpoint, fetchImpl })` 返回与 `window.pi` 同形的对象。
 *   `endpoint(path, input)` 由调用方提供（浏览器用 fetch，测试用 fixture）；
 *   `call(channel, args)` 按 `channels.mjs` 的通道名分发，`subscribe(name, listener)` 订阅事件。
 * 不变量：
 *   - 每个通道的实现在 `support.mjs` 里显式登记；未实现的通道抛 `HostApiUnsupported`，
 *     不做静默成功，也不回落到别的通道；
 *   - 事件订阅返回可用的退订函数，且只移除自己那个 listener；
 *   - 本层不做业务判断（不解析消息、不改状态），只做形状转换与错误映射。
 * 为什么存在：Percho 的 renderer 只认 `window.pi`。把 IPC 换成 HTTP 而不改 store 语义，
 *   才能复用它的状态模型，而不是重写 40k 行渲染代码。
 * 错误：未实现的通道 → `HostApiUnsupported`；Host 非 2xx → `HostApiError`（带 status）。
 */

/** 通道未实现；调用方可以据此隐藏界面而不是假装成功。 */
export class HostApiUnsupported extends Error {
  constructor(channel, reason) {
    super(`${channel} 尚未在此 Host 上实现：${reason}`);
    this.name = "HostApiUnsupported";
    this.code = "HOST_API_UNSUPPORTED";
    this.channel = channel;
  }
}

/** Host 返回非 2xx 或被调用方拒绝。 */
export class HostApiError extends Error {
  constructor(channel, status, message) {
    super(`${channel} 失败（${status}）：${message}`);
    this.name = "HostApiError";
    this.code = "HOST_API_ERROR";
    this.channel = channel;
    this.status = status;
  }
}

/**
 * @param {object} options
 * @param {(path: string, input: unknown) => Promise<any>} options.invoke
 *   向 Host 发请求；`path` 是路由（如 `/api/state`），`input` 是请求体。
 * @param {(event: string, payload: any) => void} [options.onSubscribe]
 *   订阅建立时由调用方接上真实事件流；缺省时订阅只登记 listener。
 */
export function createHostApi({ invoke, onSubscribe } = {}) {
  if (typeof invoke !== "function")
    throw new TypeError("HostApi 需要 invoke(path, input)");
  return { invoke, onSubscribe };
}

/** 服务端返回的错误体里取一条可读消息。 */
function errorMessage(body) {
  const text =
    typeof body === "string"
      ? body
      : (body?.error?.message ?? body?.error ?? body?.message ?? "");
  return String(text || "请求失败");
}

/**
 * 由支持表与实现表构造 `window.pi`。
 *
 * 方法名来自通道表里的 `key`（Percho 的表键），不是通道的 action 部分：
 * `permission:getConfig`、`contextManager:getConfig`、`channelWatch:getConfig` 共享同一个 action，
 * 用 action 会互相覆盖。
 *
 * @param {object} options
 * @param {object} options.channels  `UI_CHANNELS`
 * @param {Record<string, (args: any, context: object) => Promise<any>>} options.handlers
 *   已实现通道的处理函数；键是通道名。
 * @param {object} options.support  `UI_SUPPORT`
 * @param {object} options.subscriptionSupport `UI_SUBSCRIPTION_SUPPORT`
 * @param {(name: string, channel: string, listener: (payload: any) => void) => () => void} [options.subscribe]
 * @param {string} [options.platform]
 */
export function buildHostApi({
  channels,
  handlers,
  support,
  subscriptionSupport,
  subscribe,
  platform = "linux",
  desktop = globalThis.window?.piDesk,
}) {
  const unsupportedChannel = (channel) => {
    const row = support[channel];
    if (row?.status === "unsupported")
      return new HostApiUnsupported(channel, row.reason);
    return new HostApiUnsupported(channel, "没有登记的实现");
  };

  const api = Object.create(null);
  const unavailableEnvironment = Object.create(null);
  for (const [channel, entry] of Object.entries(channels)) {
    // `domain:action` 是 Percho 的通用分发占位，没有独立方法名。
    if (!entry.key) continue;
    unavailableEnvironment[entry.key] = async () => {
      throw new HostApiUnsupported(
        channel,
        "此 Host 只提供本地执行环境，不能将远程操作转交给本地",
      );
    };
    api[entry.key] = async (args) => {
      const row = support[channel];
      if (row?.status !== "implemented") throw unsupportedChannel(channel);
      const handler = handlers[channel];
      if (typeof handler !== "function")
        throw new HostApiUnsupported(
          channel,
          "支持表标记为已实现但缺少处理函数",
        );
      return handler(args ?? {});
    };
  }

  /**
   * 事件订阅。
   *
   * 未实现的订阅**不抛错**：订阅发生在应用启动阶段，一个未实现的频道不该让整个界面崩掉；
   * 但它必须可见——`subscriptionReport()` 会列出本次会话里触达过的未实现订阅，与 A3 的
   * `onTerminalInput` 同一原则：可用的退订函数 + 可观测的降级，而不是静默假成功。
   */
  const unsupportedSubscriptions = new Map();
  for (const [name, row] of Object.entries(subscriptionSupport)) {
    unavailableEnvironment[name] = () => () => {};
    api[name] = (listener) => {
      if (row.status !== "implemented") {
        unsupportedSubscriptions.set(
          name,
          (unsupportedSubscriptions.get(name) ?? 0) + 1,
        );
        return () => {};
      }
      if (typeof listener !== "function") return () => {};
      if (!subscribe) return () => {};
      return subscribe(name, row.channel ?? name, listener);
    };
  }

  api.platform = platform;
  api.supports = (channel) => support[channel]?.status === "implemented";
  // Percho 的 renderer 用 `getPathForFile` 处理拖入文件的路径；GUI 宿主没有真实文件路径。
  api.getPathForFile = (file) => desktop?.filePath?.(file) ?? "";
  /**
   * `forEnvironment(ref)`：Percho 多环境版的执行入口。
   *
   * 只有本地环境可执行；其他环境的方法明确拒绝，订阅不接入本地事件。
   * 已保存的远程身份不能借用本地 API，否则同号会话会被误读或误写。
   */
  api.forEnvironment = (ref) =>
    ref === undefined || ref?.kind === "local" ? api : unavailableEnvironment;
  /** 本次会话触达过的未实现订阅：让“少了什么”可查，而不是静默。 */
  api.subscriptionReport = () =>
    Object.fromEntries(
      [...unsupportedSubscriptions.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, used]) => [
          name,
          { used, reason: subscriptionSupport[name].reason },
        ]),
    );
  return api;
}
