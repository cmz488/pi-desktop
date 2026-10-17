import { extensionAdapterRegistry } from "./extension-adapters.mjs";

export const contentText = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
export function projectMessage(message, id) {
  return {
    id,
    eventKey: message.timestamp,
    role: message.role,
    customType: message.customType,
    display: message.display,
    extensionView: extensionAdapterRegistry.project(message),
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    isError: message.isError,
    ...(message.stopReason ? { stopReason: message.stopReason } : {}),
    ...(message.errorMessage ? { error: message.errorMessage } : {}),
    text: contentText(message.content),
    blocks: (Array.isArray(message.content) ? message.content : []).flatMap(
      (block) => {
        if (block.type === "thinking")
          return [
            {
              type: "thinking",
              text: String(block.thinking ?? ""),
            },
          ];
        if (block.type === "text")
          return [{ type: "text", text: String(block.text ?? "") }];
        if (block.type === "toolCall")
          return [
            {
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: JSON.stringify(block.arguments ?? {}, null, 2),
            },
          ];
        if (block.type === "image")
          return [{ type: "attachment", text: "图片附件" }];
        return [];
      },
    ),
  };
}

// Mirrors Pi 0.99.2 AgentSession.getSessionStats using the extension's public
// read-only SessionManager. Count all entries, including compacted/forked usage.
export function statsFromEntries(entries) {
  const stats = {
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    totalMessages: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  const add = (usage) => {
    if (!usage) return;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"])
      stats.tokens[key] += Number(usage[key] ?? 0);
    stats.cost += Number(usage.cost?.total ?? 0);
  };
  for (const entry of entries) {
    if (["usage", "branch_summary", "compaction"].includes(entry.type))
      add(entry.usage);
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    stats.totalMessages++;
    const message =
      entry.type === "message" ? entry.message : { role: "custom" };
    if (message.role === "user") stats.userMessages++;
    else if (message.role === "toolResult") {
      stats.toolResults++;
      add(message.usage);
    } else if (message.role === "assistant") {
      stats.assistantMessages++;
      stats.toolCalls += Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "toolCall").length
        : 0;
      add(message.usage);
    }
  }
  stats.tokens.total =
    stats.tokens.input +
    stats.tokens.output +
    stats.tokens.cacheRead +
    stats.tokens.cacheWrite;
  return stats;
}

export function usageMetrics(stats) {
  const tokens = stats?.tokens ?? {};
  const input = Number(tokens.input ?? 0),
    cached = Number(tokens.cacheRead ?? 0),
    written = Number(tokens.cacheWrite ?? 0);
  return {
    total: Number(
      tokens.total ?? input + (tokens.output ?? 0) + cached + written,
    ),
    input,
    output: Number(tokens.output ?? 0),
    cost: Number(stats?.cost ?? 0),
    cacheRead: cached,
    cacheWrite: written,
    cacheHitRate:
      input + cached + written > 0 ? cached / (input + cached + written) : null,
  };
}

export function projectToolEvent(event, previous = {}) {
  const result = event.result ?? event.partialResult;
  return {
    ...previous,
    id: event.toolCallId,
    name: event.toolName ?? previous.name,
    parentId: event.parentToolCallId ?? previous.parentId,
    arguments:
      event.args !== undefined
        ? JSON.stringify(event.args, null, 2)
        : previous.arguments,
    status:
      event.type === "tool_execution_end"
        ? event.isError
          ? "error"
          : "complete"
        : "running",
    output: result ? contentText(result.content) : previous.output,
    isError: event.isError ?? previous.isError,
  };
}
