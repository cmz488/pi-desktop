/** Host 的模型消息／投影消息转换成 Percho 历史契约；桌面和手机共用。 */
const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

export function toSessionMessages(messages) {
  const rows = [];
  const tools = new Map();
  for (const [index, message] of (messages ?? []).entries()) {
    const blocks = message.blocks ?? message.content ?? [];
    const parts = Array.isArray(blocks) ? blocks : [];
    const timestamp = Number(message.eventKey ?? message.timestamp ?? 0);
    const text =
      typeof message.text === "string" ? message.text : textOf(message.content);
    if (message.role === "toolResult") {
      let tool = tools.get(message.toolCallId);
      if (!tool) {
        tool = {
          id: message.toolCallId ?? `tool-${index}`,
          name: message.toolName ?? "tool",
          args: "{}",
          output: "",
          isError: false,
        };
        rows.push({
          role: "assistant",
          text: "",
          thinking: "",
          tools: [tool],
          images: [],
          timestamp,
        });
      }
      tool.output = text;
      tool.isError = message.isError === true;
      tool.endedAt = timestamp;
      if (typeof message.details?.patch === "string")
        tool.diff = message.details.patch;
      continue;
    }
    if (!["user", "assistant"].includes(message.role)) {
      if (text) rows.push({ role: "system", text, timestamp });
      continue;
    }
    const calls = parts
      .filter((block) => block.type === "toolCall")
      .map((block) => {
        const tool = {
          id: block.id,
          name: block.name,
          args:
            typeof block.arguments === "string"
              ? block.arguments
              : JSON.stringify(block.arguments ?? {}),
          output: "",
          isError: false,
        };
        tools.set(tool.id, tool);
        return tool;
      });
    rows.push({
      role: message.role,
      text,
      thinking: parts
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking ?? block.text ?? "")
        .join("\n"),
      tools: calls,
      images: parts
        .filter((block) => block.type === "image")
        .map(({ data, mimeType }) => ({ data, mimeType })),
      timestamp,
      ...(message.entryId === undefined
        ? {}
        : { entryId: String(message.entryId) }),
      ...(message.stopReason ? { stopReason: message.stopReason } : {}),
      ...(message.errorMessage || message.error
        ? { errorMessage: message.errorMessage ?? message.error }
        : {}),
    });
  }
  return rows;
}

export function emptyTranscript() {
  return {
    messages: [],
    streaming: null,
    phase: "idle",
    agentActive: false,
    unseenCompletion: false,
    followUpQueue: [],
    compacting: false,
    todos: [],
    pendingLlmError: null,
    retrying: null,
  };
}

/** 已提交历史和正在生成的 partial 是两个独立字段，不把 partial 写入历史。 */
export function toTranscript(
  messages,
  { streaming, active = Boolean(streaming), compacting = false } = {},
) {
  return {
    ...emptyTranscript(),
    messages: toSessionMessages(messages).flatMap((message, index) => {
      const row = {
        ...message,
        kind: message.role,
        id: `h${index}`,
        ...(message.tools
          ? {
              tools: message.tools.map((tool) => ({
                ...tool,
                key: tool.id,
                state: tool.isError ? "error" : "done",
              })),
            }
          : {}),
      };
      if (message.role !== "assistant" || message.stopReason !== "error")
        return [row];
      return [
        row,
        {
          kind: "error",
          id: `e${index}`,
          text: "",
          timestamp: message.timestamp,
          error: {
            severity: "error",
            source: "llm",
            titleKey: "error.title.llmGeneric",
            detail: String(message.errorMessage ?? "模型请求失败").slice(
              0,
              4096,
            ),
            actions: ["copyDetail"],
            timestamp: message.timestamp,
          },
        },
      ];
    }),
    phase: streaming ? "streaming" : "idle",
    agentActive: active,
    compacting,
    streaming: streaming
      ? {
          id: String(streaming.id ?? "streaming"),
          text: String(streaming.text ?? ""),
          thinking: String(
            streaming.thinking ??
              (streaming.blocks ?? [])
                .filter((block) => block.type === "thinking")
                .map((block) => block.text)
                .join("\n"),
          ),
          tools: [],
          pendingImages: [],
          subagentRuns: [],
          subagentByToolCallId: {},
          activeToolIndex: -1,
          toolByContentIndex: {},
          activity: [],
          textBlockIndex: null,
        }
      : null,
  };
}
