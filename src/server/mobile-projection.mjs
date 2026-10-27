/**
 * 手机端实时投影：把我们的会话状态映射成 Percho 手机端消费的形状。
 *
 * 接口：`deriveView(state)` 生成 `LanSessionView`；`toTranscript(messages)` 生成
 *   `SessionTranscriptState`（Percho 的 reducer 状态）；`emptyTranscript()` 为无消息时的初值。
 * 不变量：
 *   - 投影是**纯函数**且只读：不修改会话状态、不触发模型或工具；
 *   - 出网内容必须已经过 `mobile-data.mjs` 的裁剪（调用方负责），本模块不重复脱敏；
 *   - 形状对齐 Percho 的 shared 类型，字段缺失时给出该类型允许的空值而不是省略键——
 *     手机端按字段存在性分支，缺键会让它静默不渲染；
 *   - 不伪造状态：没有工具在跑就返回 null，没有错误就返回 null。
 * 为什么需要适配层：Percho 的手机端读的是它自己的 `SessionEvent` reducer 结果。我们的会话
 *   状态来自 Durable 的投影（`workspace.live` / `transcript`），事件形状不同。与其重写它的
 *   reducer，不如在服务端直接产出它期望的**状态**——手机端只消费状态，不消费我们的事件。
 */

/** Percho `SessionTranscriptState` 的初值（对应 shared 的 `emptyTranscript()`）。 */
export function emptyTranscript() {
  return {
    messages: [],
    streaming: null,
    phase: "idle",
    agentActive: false,
    pendingLlmError: null,
    runEndedAt: null,
  };
}

/**
 * 我们的消息 → Percho 的 `UIMessage`。
 *
 * 只映射手机端真正渲染的几种 kind：user／assistant／tool／system。未知角色落 system，
 * 保证内容不丢而不误标成用户输入。
 */
export function toUiMessage(message, index) {
  const text = typeof message?.text === "string" ? message.text : "";
  const id = String(message?.id ?? `${message?.role ?? "m"}-${index}`);
  const timestamp = Number(message?.eventKey ?? message?.timestamp ?? Date.now());
  switch (message?.role) {
    case "user":
      return { kind: "user", id, text, timestamp };
    case "assistant":
      return {
        kind: "assistant",
        id,
        text,
        timestamp,
        ...(message?.stopReason === "error" && message?.error
          ? { error: { message: String(message.error) } }
          : {}),
      };
    case "toolResult":
      return {
        kind: "tool",
        id,
        text,
        timestamp,
        toolName: String(message?.toolName ?? "tool"),
        ...(message?.isError ? { isError: true } : {}),
      };
    default:
      return { kind: "system", id, text, timestamp };
  }
}

/**
 * 消息数组 → `SessionTranscriptState`。
 *
 * `streaming` 只在调用方明确给出 partial 时才有内容；否则为 null（空闲语义）。
 */
export function toTranscript(messages, { streaming } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  return {
    ...emptyTranscript(),
    messages: list.map(toUiMessage),
    phase: streaming ? "streaming" : "idle",
    agentActive: Boolean(streaming),
    streaming: streaming
      ? {
          id: String(streaming.id ?? "streaming"),
          text: String(streaming.text ?? ""),
          thinking: String(streaming.thinking ?? ""),
          startedAt: Number(streaming.startedAt ?? Date.now()),
        }
      : null,
  };
}

/**
 * 会话状态 → `LanSessionView`。
 *
 * 输入取自 `workspace.read()` 的 agent 行与 `workspace.live()` 的运行态；两者都可能缺字段，
 * 所以每个字段都按类型允许的空值兜底。
 */
export function deriveView(agent, live) {
  const stats = live?.stats ?? agent?.stats ?? null;
  const tail = live?.partial?.text;
  const runningTool = Array.isArray(live?.activeCalls)
    ? live.activeCalls.find((call) => call?.status === "running")
    : undefined;
  return {
    sessionId: String(agent?.id ?? ""),
    name: String(agent?.name ?? "未命名会话"),
    cwd: String(agent?.cwd ?? ""),
    agentActive: Boolean(live && live.idle === false) || agent?.status === "running",
    compacting: Array.isArray(live?.compactions) && live.compactions.length > 0,
    queued: Number(live?.queued ?? 0) > 0,
    currentTool: runningTool?.name ?? null,
    assistantTail: typeof tail === "string" && tail ? tail.slice(-200) : null,
    todos: [],
    pendingPermission: null,
    lastError: typeof agent?.error === "string" && agent.error ? agent.error : null,
    stats: stats
      ? {
          inputTokens: Number(stats.tokens?.input ?? 0),
          outputTokens: Number(stats.tokens?.output ?? 0),
          cost: Number(stats.cost ?? 0),
        }
      : null,
    lastActivity: Number(agent?.updatedAt ?? Date.now()),
  };
}