import { usageMetrics } from "../shared/conversation.mjs";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * The client should not have to infer activity by parsing host prose. This
 * typed field is additive: operation stays for older pages and extensions.
 */
export function activityFor({
  operation = "",
  activeTool = "",
  compacting = false,
  initializing = false,
  workingMessage = "",
  idle = true,
  history = false,
} = {}) {
  if (history) return { kind: "history", label: "会话记录" };
  if (initializing) return { kind: "initializing", label: "加载扩展…" };
  if (compacting) return { kind: "compacting", label: "压缩上下文…" };
  if (operation) {
    const text = String(operation);
    if (/^执行\s+/.test(text) || /^执行\s*$/.test(text))
      return { kind: "tool", label: text };
    if (/^(?:pi\s*)?正在思考/i.test(text))
      return { kind: "thinking", label: "思考中" };
    if (/^(?:等待|waiting\b|wait\b|await\b)/i.test(text))
      return { kind: "waiting", label: "等待中" };
    if (/^压缩上下文/.test(text)) return { kind: "compacting", label: text };
    return { kind: "working", label: text };
  }
  if (activeTool) return { kind: "tool", label: `执行 ${activeTool}…` };
  if (workingMessage) return { kind: "working", label: String(workingMessage) };
  return { kind: idle ? "idle" : "working", label: idle ? "就绪" : "运行中" };
}

/**
 * One Agent read model for every host. Hosts provide facts; this module owns
 * the common shape, defaults and the typed activity projection.
 */
export function createAgentSnapshot(input = {}) {
  const stats = input.stats ?? {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
  const activity =
    input.activity ??
    activityFor({
      operation: input.operation,
      activeTool: input.activeTool,
      compacting: input.compacting,
      initializing: input.initializing,
      workingMessage: input.workingMessage,
      idle: input.idle,
      history: input.history,
    });
  const operation =
    input.operation ??
    (activity.kind === "idle" || activity.kind === "history"
      ? ""
      : activity.label);
  return {
    ...(input.extra ?? {}),
    version: input.version ?? "",
    host: input.host ?? "",
    ...(input.frameworkVersion
      ? { frameworkVersion: input.frameworkVersion }
      : {}),
    sessionId: String(input.sessionId ?? ""),
    name: input.name ?? "新会话",
    cwd: input.cwd ?? "",
    idle: input.idle === true,
    initializing: input.initializing === true,
    operation,
    activity,
    workingMessage: input.workingMessage ?? "",
    statuses: Array.isArray(input.statuses) ? input.statuses : [],
    /**
     * 扩展 UI 状态：工作行可见性、折叠思考标签、工具展开态、窗口标题、补全提供者数量，
     * 以及 ui-capabilities 报告（声明层级 + 本次会话触达的降级／拒绝成员）。
     * 客户端据此渲染真实能力，而不是假设终端语义成立。
     */
    ui: input.ui ?? {
      workingVisible: true,
      hiddenThinkingLabel: "",
      toolsExpanded: false,
      title: "",
      autocompleteProviders: 0,
      capabilities: { members: {}, usedMembers: [], counts: {} },
    },
    commands: Array.isArray(input.commands) ? input.commands : [],
    stats,
    metrics: input.metrics ?? usageMetrics(stats),
    git: input.git ?? null,
    // 恢复信息：本次接管时未完成的 Durable 任务（追加字段，无待恢复工作时为 null）。
    recovery: input.recovery ?? null,
    model: input.model ?? null,
    thinkingLevel: input.thinkingLevel ?? "off",
    thinkingEditable: input.thinkingEditable === true,
    thinkingLevels: Array.isArray(input.thinkingLevels)
      ? input.thinkingLevels
      : THINKING_LEVELS,
    usage: input.usage ?? null,
    tools: Array.isArray(input.tools) ? input.tools : [],
    messages: Array.isArray(input.messages) ? input.messages : [],
    streamingText: input.streamingText ?? "",
    streamingMessage: input.streamingMessage ?? null,
    phase: input.phase ?? "",
    activeCalls: Array.isArray(input.activeCalls) ? input.activeCalls : [],
    projectTrusted: input.projectTrusted !== false,
    models: Array.isArray(input.models) ? input.models : [],
    capabilities: input.capabilities ?? {},
  };
}
