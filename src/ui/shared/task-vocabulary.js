/**
 * 原生任务词汇：集中清单、详情、历史与命令回执的中文展示规则。
 *
 * 接口：状态／种类标签、消息失败判定和回执提示；见 docs/architecture/interfaces/read-panels.md。
 * 不变量：纯投影，不读 DOM、不修改回执；投递与任务活跃态分别解释，不接管 worker 生命周期；
 *   未知标签原样返回，首次结果不被后续失败改写。旧 statusLabel 参数只用于兼容调用。
 * 错误：无；未知状态不推断成成功或失败。
 */
const ACTIVE_LABELS = {
  pending: "排队",
  running: "运行中",
  waiting: "等待",
  completing: "收尾",
};
const OUTCOME_LABELS = {
  completed: "已完成",
  failed: "失败",
  aborted: "已中止",
  orphaned: "无法恢复",
  faulted: "执行故障",
};
const DELIVERY_LABELS = {
  ...OUTCOME_LABELS,
  pending: "等待投递",
  queued: "已排队",
  placed: "处理中",
  done: "已回答",
  unanswered: "未完成",
};
const KIND_LABELS = {
  "pi.generation": "模型回合",
  "pi.tool": "工具调用",
  "desk.subagent-run": "子代理",
  "desk.subagent-message": "子代理消息",
};
const MESSAGE_FAILURES = new Set([
  "unanswered",
  "failed",
  "aborted",
  "faulted",
  "orphaned",
]);
const label = (labels, value) =>
  Object.hasOwn(labels, value) ? labels[value] : value;

export function taskStatusLabel(status) {
  return Object.hasOwn(ACTIVE_LABELS, status)
    ? ACTIVE_LABELS[status]
    : taskOutcomeLabel(status);
}
export function taskOutcomeLabel(status) {
  return label(OUTCOME_LABELS, status);
}
export function taskDeliveryLabel(status) {
  return label(DELIVERY_LABELS, status);
}
export function taskKindLabel(kind) {
  return label(KIND_LABELS, kind);
}
export function isMessageFailure(status) {
  return MESSAGE_FAILURES.has(status);
}
export function hasMessageFailure(task) {
  return (
    !!(task.outcome?.status === "completed" && task.budgetError) ||
    (task.messageResults ?? []).some((row) => isMessageFailure(row.status))
  );
}
export function taskReceiptLabel(task, statusLabel = taskStatusLabel) {
  const summary = task.outcome
    ? taskOutcomeLabel(task.outcome.status)
    : statusLabel(task.status);
  return hasMessageFailure(task)
    ? `${summary}（首次委托） · 后续消息未完成`
    : summary;
}
export function taskReceiptNotice(result, fallback) {
  if (result?.task && hasMessageFailure(result.task))
    return `${taskReceiptLabel(result.task)}，请查看子代理记录`;
  const outcome =
    result?.task?.status === "terminal" ? result.task.outcome?.status : null;
  if (outcome) return `任务${taskOutcomeLabel(outcome)}`;
  return result?.abortStatus === "marked"
    ? "已提交任务中止请求，尚未确认终态"
    : result?.abortStatus === "terminal"
      ? "任务此前已结束，请查看原生结果"
      : fallback;
}
