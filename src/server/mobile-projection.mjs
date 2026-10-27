import {
  toTranscript,
  emptyTranscript,
} from "../ui-next/session-projection.mjs";
export { toTranscript, emptyTranscript };

/** 单条投影仅供调用者检查；工具结果在完整转录里按 toolCallId 合并。 */
export function toUiMessage(message, index) {
  const row = toTranscript([message]).messages[0];
  return (
    row ?? {
      kind: "system",
      id: `h${index}`,
      text: message?.text ?? "",
      timestamp: Number(message?.timestamp ?? 0),
    }
  );
}

export function deriveView(agent, live) {
  const stats = live?.stats ?? agent?.stats;
  const runningTool = (live?.liveTools ?? live?.activeCalls ?? []).find(
    (call) => call.status !== "done",
  );
  return {
    sessionId: String(agent.id),
    name: agent.name ?? "未命名会话",
    cwd: "",
    agentActive: live ? live.idle === false : agent.idle === false,
    compacting: Boolean(live?.compacting),
    queued: Array.isArray(live?.queued)
      ? live.queued.length > 0
      : Number(live?.queued ?? 0) > 0,
    currentTool: runningTool?.name ?? null,
    assistantTail: live?.partial?.text?.slice(-200) || null,
    todos: [],
    pendingPermission: null,
    lastError: agent.error ?? null,
    stats: stats
      ? {
          inputTokens: Number(stats.tokens?.input ?? 0),
          outputTokens: Number(stats.tokens?.output ?? 0),
          cost: Number(stats.cost ?? 0),
        }
      : null,
    lastActivity: Number(agent.updatedAt ?? agent.createdAt ?? 0),
  };
}
