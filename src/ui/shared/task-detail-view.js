/**
 * 原生任务详情展示：以纯文本呈现安全回执和子会话，不持有执行生命周期。
 *
 * 接口：renderTaskDetail／taskOutcomeLabel／taskReceiptLabel／hasMessageFailure；见
 *   docs/architecture/interfaces/read-panels.md。
 * 不变量：相同内容不重建 DOM；更新保留滚动；回答编号只取原生回执。
 * 错误：数据由已校验的详情 interface 提供；读取失败由调用方展示。
 */
const signatures = new WeakMap();
const OUTCOMES = {
  completed: "已完成",
  failed: "失败",
  aborted: "已中止",
  orphaned: "无法恢复",
  faulted: "执行故障",
};
const MESSAGE_ROLES = {
  user: "用户",
  assistant: "助手",
  toolResult: "工具",
  custom: "扩展",
};
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
export function taskOutcomeLabel(status) {
  return OUTCOMES[status] ?? status;
}

export function hasMessageFailure(task) {
  return (
    !!(task.outcome?.status === "completed" && task.budgetError) ||
    (task.messageResults ?? []).some((row) =>
      ["unanswered", "failed", "aborted", "faulted", "orphaned"].includes(
        row.status,
      ),
    )
  );
}
export function taskReceiptLabel(task, statusLabel = (value) => value) {
  const label = task.outcome
    ? taskOutcomeLabel(task.outcome.status)
    : statusLabel(task.status);
  return hasMessageFailure(task)
    ? `${label}（首次委托） · 后续消息未完成`
    : label;
}

export function renderTaskDetail(
  detail,
  data,
  { label = "", statusLabel = (value) => value } = {},
) {
  const signature = JSON.stringify({
    label,
    task: data.task,
    children: data.children,
    hasMoreChildren: data.hasMoreChildren,
  });
  if (
    signature === signatures.get(detail) &&
    detail.querySelector("[data-task-detail-result]")
  )
    return;
  const scroll = detail.scrollTop;
  const content = element("div", "host-task-result");
  const outcome = data.task.outcome?.status;
  content.dataset.hostOutcome = outcome ?? data.task.status;
  content.dataset.taskDetailResult = "true";
  const heading = element("header", "host-task-result-heading");
  heading.append(
    element("strong", "", taskReceiptLabel(data.task, statusLabel)),
    element("small", "", `原生任务 #${data.task.id}`),
  );
  const answerEntryId = data.task.outcome?.result?.answerEntryId;
  if (Number.isSafeInteger(answerEntryId) && answerEntryId >= 0) {
    const reference = element("small", "", `原生回答 #${answerEntryId}`);
    reference.dataset.hostAnswerReference = String(answerEntryId);
    heading.append(reference);
  }
  content.append(heading, element("p", "host-task-detail-label", label));
  if (data.task.outcome?.error)
    content.append(
      element("p", "host-task-error", data.task.outcome.error.message),
    );
  if (
    data.task.budgetError &&
    data.task.budgetError.message !== data.task.outcome?.error?.message
  )
    content.append(
      element("p", "host-task-error", data.task.budgetError.message),
    );
  if (data.task.messageResults?.length) {
    const results = element("section", "host-task-conversation");
    results.append(element("h4", "", "消息处理状态"));
    const labels = {
      pending: "等待投递",
      queued: "已排队",
      placed: "处理中",
      done: "已回答",
      unanswered: "未完成",
    };
    for (const row of data.task.messageResults) {
      const item = element("section", "host-task-message");
      item.dataset.messageSubmission = String(
        row.submissionId ?? row.deliveryTaskId,
      );
      item.append(
        element(
          "small",
          "",
          `${row.mode === "followUp" ? "后续消息" : "引导消息"} · #${row.submissionId ?? row.deliveryTaskId}`,
        ),
        element(
          "p",
          "",
          labels[row.status] ?? OUTCOMES[row.status] ?? row.status,
        ),
      );
      if (row.error)
        item.append(element("p", "host-task-error", row.error.message));
      results.append(item);
    }
    content.append(results);
  }
  if (data.task.messageResultsTruncated)
    content.append(
      element(
        "p",
        "host-task-note",
        "仅显示最近的消息处理状态，较早记录未展示。",
      ),
    );
  const message = (role, text, partial = false) => {
    const node = element("section", "host-task-message");
    node.dataset.hostMessageRole = role;
    if (partial) node.dataset.hostPartial = "true";
    node.append(
      element(
        "small",
        "",
        partial ? "正在输出" : (MESSAGE_ROLES[role] ?? role),
      ),
      element("div", "host-task-message-body", text),
    );
    return node;
  };
  for (const child of data.children) {
    const conversation = element("section", "host-task-conversation");
    const title = element("h4", "", child.name);
    title.append(element("small", "", `子会话 #${child.id}`));
    conversation.append(title);
    for (const entry of child.messages) {
      const block = message(entry.role, entry.text);
      if (entry.toolName)
        block.querySelector("small").textContent = `工具 ${entry.toolName}`;
      conversation.append(block);
    }
    if (child.partial)
      conversation.append(message("assistant", child.partial.text, true));
    if (child.messagesTruncated || child.toolsTruncated)
      conversation.append(
        element(
          "p",
          "host-task-note",
          "仅显示最近的消息与工具记录，完整内容仍保存在子会话。",
        ),
      );
    for (const tool of child.tools) {
      const node = message("toolResult", tool.output);
      node.querySelector("small").textContent =
        `${tool.name} · ${OUTCOMES[tool.status] ?? statusLabel(tool.status)}`;
      conversation.append(node);
    }
    content.append(conversation);
  }
  if (!data.children.length && data.task.outcome?.result?.answer)
    content.append(message("assistant", data.task.outcome.result.answer));
  if (data.hasMoreChildren)
    content.append(
      element("p", "host-task-note", "部分子会话未显示，完整记录仍保留。"),
    );
  detail.replaceChildren(content);
  detail.scrollTop = scroll;
  signatures.set(detail, signature);
}
