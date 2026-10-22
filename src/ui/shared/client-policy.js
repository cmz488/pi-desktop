/**
 * 客户端能力策略：投影显式声明、当前目标和调用方收窄，不拥有后端权限。
 *
 * 接口：readClientPolicy(context, {supported}?) 返回只读资格；见
 *   docs/architecture/interfaces/client-policy.md。
 * 不变量：未声明不启用读取；只读不等于不能聊天；远程任务命令是否可用仍由调用方收窄。
 * 错误：无副作用、不发请求；unsupported 与未就绪都拒绝相关读写，不猜测已执行或已结束。
 */
export function readClientPolicy(context = {}, { supported } = {}) {
  const capabilities = context.capabilities ?? {};
  const ready =
    context.ready !== false && String(context.sessionId ?? "") !== "";
  const remote = capabilities.remote === true;
  const readOnly = capabilities.readOnly === true;
  const available = ready && supported !== false;
  const taskRead = available && capabilities.tasks === true;
  const taskCommands =
    (context.taskCommands ?? context.sessionCommands) === true;
  return Object.freeze({
    ready,
    remote,
    readOnly,
    supported: supported !== false,
    canReadTasks: taskRead,
    // 某些直接宿主允许远程管理本会话；网关 adapter 必须显式传 taskCommands:false。
    canManageTasks: taskRead && taskCommands && !readOnly,
    canReadTaskDetails:
      available && capabilities.taskDetails === true && !remote,
    canReadSubagentHistory:
      available &&
      capabilities.taskDetails === true &&
      capabilities.sessionTree === true &&
      !remote,
    canReadBranches: available && capabilities.sessionTree === true,
    // 消息菜单也使用原生会话命令，不能要求它先读取整棵分支树。
    canManageBranches:
      available && context.sessionCommands === true && !readOnly && !remote,
    canOpenTaskWorkbench: taskRead && !remote,
    canViewSettings: !remote,
    canCompose: ready && capabilities.nativeHistory !== true,
  });
}
