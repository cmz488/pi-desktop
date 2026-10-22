import assert from "node:assert/strict";
import test from "node:test";
import {
  taskStatusLabel,
  taskOutcomeLabel,
  taskDeliveryLabel,
  taskKindLabel,
  isMessageFailure,
  hasMessageFailure,
  taskReceiptLabel,
  taskReceiptNotice,
} from "../src/ui/shared/task-vocabulary.js";
import { taskStatusLabel as legacyStatusLabel } from "../src/ui/shared/task-panel.js";
import {
  taskOutcomeLabel as legacyOutcomeLabel,
  taskReceiptLabel as legacyReceiptLabel,
  hasMessageFailure as legacyMessageFailure,
} from "../src/ui/shared/task-detail-view.js";

test("任务活跃态和终态标签使用同一词汇，未知值不冒充既知状态", () => {
  const labels = {
    pending: "排队",
    running: "运行中",
    waiting: "等待",
    completing: "收尾",
    completed: "已完成",
    failed: "失败",
    aborted: "已中止",
    orphaned: "无法恢复",
    faulted: "执行故障",
  };
  for (const [status, expected] of Object.entries(labels))
    assert.equal(taskStatusLabel(status), expected);
  for (const value of [
    "future-state",
    "terminal",
    "toString",
    "constructor",
    "__proto__",
  ])
    assert.equal(taskStatusLabel(value), value);
});

test("任务、投递、终态和 worker 生命周期是不同词域", () => {
  assert.equal(taskStatusLabel("pending"), "排队");
  assert.equal(taskDeliveryLabel("pending"), "等待投递");
  assert.equal(taskOutcomeLabel("pending"), "pending");
  for (const [status, expected] of Object.entries({
    queued: "已排队",
    placed: "处理中",
    done: "已回答",
    unanswered: "未完成",
    failed: "失败",
    aborted: "已中止",
    orphaned: "无法恢复",
    faulted: "执行故障",
  }))
    assert.equal(taskDeliveryLabel(status), expected);
  assert.equal(taskDeliveryLabel("running"), "running");
  assert.equal(taskStatusLabel("starting"), "starting");
  assert.equal(taskOutcomeLabel("failed"), "失败");
  for (const label of [taskOutcomeLabel, taskDeliveryLabel, taskKindLabel])
    for (const value of [
      "future-state",
      "toString",
      "constructor",
      "__proto__",
    ])
      assert.equal(label(value), value);
});

test("任务种类保留未知原生标识，不将新种类猜成子代理", () => {
  for (const [kind, expected] of Object.entries({
    "pi.generation": "模型回合",
    "pi.tool": "工具调用",
    "desk.subagent-run": "子代理",
    "desk.subagent-message": "子代理消息",
  }))
    assert.equal(taskKindLabel(kind), expected);
  assert.equal(taskKindLabel("extension.task"), "extension.task");
});

test("首次结果、后续消息和预算的提示不改写原生回执", () => {
  const task = Object.freeze({
    status: "terminal",
    outcome: Object.freeze({
      status: "completed",
      result: Object.freeze({ answer: "原生首次答案" }),
    }),
    messageResults: Object.freeze([Object.freeze({ status: "unanswered" })]),
  });
  assert.equal(taskReceiptLabel(task), "已完成（首次委托） · 后续消息未完成");
  assert.equal(
    taskReceiptNotice({ task }, "已结束"),
    "已完成（首次委托） · 后续消息未完成，请查看子代理记录",
  );
  assert.equal(task.outcome.status, "completed");
  assert.equal(task.outcome.result.answer, "原生首次答案");
  const budgetTask = {
    status: "terminal",
    outcome: { status: "completed" },
    budgetError: { message: "预算耗尽" },
  };
  assert.equal(hasMessageFailure(budgetTask), true);
  assert.equal(
    taskReceiptLabel(budgetTask),
    "已完成（首次委托） · 后续消息未完成",
  );
  assert.equal(
    hasMessageFailure({ ...budgetTask, outcome: { status: "failed" } }),
    false,
  );
});

test("消息失败集合同时用于提示和计数，处理中不是失败", () => {
  for (const status of [
    "unanswered",
    "failed",
    "aborted",
    "faulted",
    "orphaned",
  ]) {
    assert.equal(isMessageFailure(status), true);
    assert.equal(hasMessageFailure({ messageResults: [{ status }] }), true);
  }
  for (const status of ["pending", "queued", "placed", "done", "future-state"])
    assert.equal(hasMessageFailure({ messageResults: [{ status }] }), false);
  assert.equal(hasMessageFailure({}), false);
});

test("回执提示区分原生终态、中止请求标记和旧宿主空回执", () => {
  for (const [status, expected] of Object.entries({
    completed: "任务已完成",
    failed: "任务失败",
    aborted: "任务已中止",
    orphaned: "任务无法恢复",
    faulted: "任务执行故障",
  }))
    assert.equal(
      taskReceiptNotice(
        { task: { status: "terminal", outcome: { status } } },
        "回退",
      ),
      expected,
    );
  assert.equal(
    taskReceiptNotice({ abortStatus: "marked" }, "回退"),
    "已提交任务中止请求，尚未确认终态",
  );
  assert.equal(
    taskReceiptNotice({ abortStatus: "terminal" }, "回退"),
    "任务此前已结束，请查看原生结果",
  );
  assert.equal(taskReceiptNotice(undefined, "旧宿主提示"), "旧宿主提示");
  assert.equal(taskReceiptLabel({ status: "running" }), "运行中");
  assert.equal(
    taskReceiptLabel({
      status: "terminal",
      outcome: { status: "future-outcome" },
    }),
    "future-outcome",
  );
});

test("旧公共 module 导出继续指向同一词汇 implementation", () => {
  assert.equal(legacyStatusLabel, taskStatusLabel);
  assert.equal(legacyOutcomeLabel, taskOutcomeLabel);
  assert.equal(legacyReceiptLabel, taskReceiptLabel);
  assert.equal(legacyMessageFailure, hasMessageFailure);
  assert.equal(
    taskReceiptLabel({ status: "running" }, () => "旧标签"),
    "旧标签",
  );
  assert.equal(
    taskReceiptLabel(
      { status: "terminal", outcome: { status: "completed" } },
      () => "旧标签",
    ),
    "已完成",
  );
});
