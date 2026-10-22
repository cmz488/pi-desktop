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
  const folds = new Map(
    [...detail.querySelectorAll("details[data-task-disclosure]")].map(
      (node) => [node.dataset.taskDisclosure, node.open],
    ),
  );
  const focused = detail.contains(document.activeElement)
    ? document.activeElement.dataset.taskDisclosureToggle
    : undefined;
  const disclosure = (key, title, open = false) => {
    const node = element("details", "host-task-disclosure");
    const identity = `${data.task.id}:${key}`;
    node.dataset.taskDisclosure = identity;
    node.open = folds.has(identity) ? folds.get(identity) : open;
    const summary = element("summary", "", title);
    summary.dataset.taskDisclosureToggle = identity;
    summary.dataset.workbenchFocus = `task-detail:${identity}`;
    node.append(summary);
    return node;
  };
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
  const content = element("div", "host-task-result");
  content.dataset.hostOutcome = data.task.outcome?.status ?? data.task.status;
  content.dataset.messageFailure = String(hasMessageFailure(data.task));
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
  content.append(heading);
  if (label) content.append(element("p", "host-task-detail-label", label));
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

  const answer = data.task.outcome?.result?.answer;
  if (answer) {
    const block = message("assistant", answer);
    block.querySelector("small").textContent = "首次回答";
    content.append(block);
  }
  for (const child of data.children) {
    const conversation = element("section", "host-task-conversation");
    const title = element("h4", "", child.name);
    title.append(element("small", "", `子会话 #${child.id}`));
    conversation.append(title);
    const output = child.messages.findLast(
      (entry) => entry.role === "assistant" && entry.text,
    );
    const question = child.messages.find((entry) => entry.role === "user");
    if (child.partial?.text)
      conversation.append(message("assistant", child.partial.text, true));
    else if (!answer && output) {
      const block = message("assistant", output.text);
      block.querySelector("small").textContent = "最新输出";
      conversation.append(block);
    } else if (!answer && question) {
      const block = message("user", question.text);
      block.querySelector("small").textContent = "委托内容";
      conversation.append(
        block,
        element("p", "host-task-note", "等待输出，执行状态会自动更新。"),
      );
    }
    if (child.messagesTruncated || child.toolsTruncated)
      conversation.append(
        element(
          "p",
          "host-task-note",
          "仅显示最近的消息与工具记录，完整内容仍保存在子会话。",
        ),
      );
    if (child.messages.length || child.tools.length) {
      const activity = disclosure(
        `activity:${child.id}`,
        `委托与执行记录（${child.messages.length + child.tools.length} 条）`,
      );
      activity.classList.add("host-task-activity");
      const entries = element("div", "host-task-records");
      for (const entry of child.messages) {
        const block = message(entry.role, entry.text);
        if (entry.toolName)
          block.querySelector("small").textContent = `工具 ${entry.toolName}`;
        entries.append(block);
      }
      for (const tool of child.tools) {
        const block = message("toolResult", tool.output);
        block.querySelector("small").textContent =
          `${tool.name} · ${OUTCOMES[tool.status] ?? statusLabel(tool.status)}`;
        entries.append(block);
      }
      activity.append(entries);
      conversation.append(activity);
    }
    content.append(conversation);
  }
  if (!data.children.length && !answer)
    content.append(
      element(
        "p",
        "host-task-note",
        "暂无子代理输出，可返回会话查看执行过程。",
      ),
    );

  if (data.task.messageResults?.length) {
    const failed = data.task.messageResults.filter((row) =>
      ["unanswered", "failed", "aborted", "faulted", "orphaned"].includes(
        row.status,
      ),
    ).length;
    const results = disclosure(
      "messages",
      `消息处理（${data.task.messageResults.length} 条${failed ? `，${failed} 条未完成` : ""}）`,
      failed > 0,
    );
    const rows = element("div", "host-task-records");
    const labels = {
      pending: "等待投递",
      queued: "已排队",
      placed: "处理中",
      done: "已回答",
      unanswered: "未完成",
    };
    for (const row of data.task.messageResults) {
      const item = element("section", "host-task-delivery");
      item.dataset.messageSubmission = String(
        row.submissionId ?? row.deliveryTaskId,
      );
      item.dataset.status = row.status;
      item.append(
        element("span", "", row.mode === "followUp" ? "后续消息" : "引导消息"),
        element("small", "", `#${row.submissionId ?? row.deliveryTaskId}`),
        element(
          "strong",
          "",
          labels[row.status] ?? OUTCOMES[row.status] ?? row.status,
        ),
      );
      if (row.error)
        item.append(element("p", "host-task-error", row.error.message));
      rows.append(item);
    }
    if (data.task.messageResultsTruncated)
      rows.append(
        element(
          "p",
          "host-task-note",
          "仅显示最近的消息处理状态，较早记录未展示。",
        ),
      );
    results.append(rows);
    content.append(results);
  } else if (data.task.messageResultsTruncated)
    content.append(
      element(
        "p",
        "host-task-note",
        "仅显示最近的消息处理状态，较早记录未展示。",
      ),
    );
  if (data.hasMoreChildren)
    content.append(
      element("p", "host-task-note", "部分子会话未显示，完整记录仍保留。"),
    );
  detail.replaceChildren(content);
  detail.scrollTop = scroll;
  if (focused)
    [...detail.querySelectorAll("[data-task-disclosure-toggle]")]
      .find((node) => node.dataset.taskDisclosureToggle === focused)
      ?.focus({ preventScroll: true });
  signatures.set(detail, signature);
}
