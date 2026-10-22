import assert from "node:assert/strict";
import { test } from "node:test";
import { readClientPolicy } from "../src/ui/shared/client-policy.js";

const local = {
  sessionId: "0",
  sessionCommands: true,
  capabilities: { tasks: true, taskDetails: true, sessionTree: true },
};

test("未声明能力不启动读取；会话命令不以方法存在或任务声明推导", () => {
  const policy = readClientPolicy({ sessionId: "1" });
  assert.equal(policy.canReadTasks, false);
  assert.equal(policy.canReadBranches, false);
  assert.equal(policy.canReadTaskDetails, false);
  assert.equal(policy.canReadSubagentHistory, false);
  assert.equal(policy.canManageTasks, false);
  assert.equal(policy.canManageBranches, false);
  assert.equal(
    readClientPolicy({ ...local, sessionCommands: undefined }).canManageTasks,
    false,
  );
  assert.equal(
    readClientPolicy({ ...local, sessionCommands: undefined })
      .canManageBranches,
    false,
  );
  assert(Object.isFrozen(policy));
});

test("本地显式能力允许读取和管理；数字零是有效目标", () => {
  const policy = readClientPolicy({ ...local, sessionId: 0 });
  for (const key of [
    "ready",
    "canReadTasks",
    "canManageTasks",
    "canReadTaskDetails",
    "canReadSubagentHistory",
    "canReadBranches",
    "canManageBranches",
    "canOpenTaskWorkbench",
    "canViewSettings",
    "canCompose",
  ])
    assert.equal(policy[key], true, key);
});

test("只读仍可查看任务和分支、打开快捷入口与聊天，但不管理", () => {
  const policy = readClientPolicy({
    ...local,
    capabilities: { ...local.capabilities, readOnly: true },
  });
  for (const key of [
    "canReadTasks",
    "canReadBranches",
    "canReadTaskDetails",
    "canReadSubagentHistory",
    "canOpenTaskWorkbench",
    "canCompose",
  ])
    assert.equal(policy[key], true, key);
  assert.equal(policy.canManageTasks, false);
  assert.equal(policy.canManageBranches, false);
});

test("远程读写保持不同语义；不能覆盖网关的显式命令收窄", () => {
  const remote = {
    ...local,
    capabilities: { ...local.capabilities, remote: true },
  };
  const direct = readClientPolicy(remote);
  assert.equal(direct.canReadTasks, true);
  assert.equal(direct.canReadBranches, true);
  assert.equal(
    direct.canManageTasks,
    true,
    "直接宿主原有本会话管理不被通用 remote 判断误禁",
  );
  for (const key of [
    "canManageBranches",
    "canReadTaskDetails",
    "canReadSubagentHistory",
    "canOpenTaskWorkbench",
    "canViewSettings",
  ])
    assert.equal(direct[key], false, key);
  assert.equal(
    readClientPolicy({ ...remote, taskCommands: false }).canManageTasks,
    false,
  );
  assert.equal(
    readClientPolicy({ ...local, taskCommands: false }).canManageTasks,
    false,
  );
  assert.equal(
    readClientPolicy({ ...local, sessionCommands: false, taskCommands: true })
      .canManageTasks,
    true,
  );
  assert.equal(
    readClientPolicy({ ...remote, taskCommands: false }).canCompose,
    true,
  );
});

test("新目标未就绪保留模式事实，但不得读取、管理或提交旧会话", () => {
  for (const context of [
    { ...local, ready: false },
    { ...local, sessionId: "" },
    { ...local, sessionId: undefined },
  ]) {
    const policy = readClientPolicy(context);
    for (const key of [
      "ready",
      "canReadTasks",
      "canManageTasks",
      "canReadTaskDetails",
      "canReadSubagentHistory",
      "canReadBranches",
      "canManageBranches",
      "canOpenTaskWorkbench",
      "canCompose",
    ])
      assert.equal(policy[key], false, key);
  }
  const remote = readClientPolicy({
    ...local,
    ready: false,
    capabilities: { ...local.capabilities, remote: true },
  });
  assert.equal(remote.remote, true);
  assert.equal(
    remote.canViewSettings,
    false,
    "不能因换目标清掉权限事实而闪出本地设置",
  );
});

test("supported:false 与未声明／尚未探测不同，且不授予管理资格", () => {
  const policy = readClientPolicy(local, { supported: false });
  assert.equal(policy.ready, true);
  assert.equal(policy.supported, false);
  for (const key of [
    "canReadTasks",
    "canManageTasks",
    "canReadTaskDetails",
    "canReadSubagentHistory",
    "canReadBranches",
    "canManageBranches",
    "canOpenTaskWorkbench",
  ])
    assert.equal(policy[key], false, key);
  assert.equal(
    policy.canCompose,
    true,
    "单项读模型 unsupported 不关闭独立的原生聊天入口",
  );
  assert.equal(
    readClientPolicy(local).canReadTasks,
    true,
    "未探测只允许显式声明后的首次读取",
  );
});

test("各读取声明独立；详情不等于任务清单，命令不依赖树读取", () => {
  const details = readClientPolicy({
    ...local,
    capabilities: { taskDetails: true },
  });
  assert.equal(details.canReadTaskDetails, true);
  assert.equal(details.canReadTasks, false);
  assert.equal(details.canReadSubagentHistory, false);
  assert.equal(details.canManageBranches, true);
  const history = readClientPolicy({
    ...local,
    capabilities: { taskDetails: true, sessionTree: true },
  });
  assert.equal(history.canReadSubagentHistory, true);
  assert.equal(history.canReadTasks, false);
  assert.equal(
    readClientPolicy({
      ...local,
      capabilities: { ...local.capabilities, nativeHistory: true },
    }).canCompose,
    false,
  );
});
