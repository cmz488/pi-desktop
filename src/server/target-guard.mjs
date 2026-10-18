import { DeskError } from "../config/config-store.mjs";

/**
 * 一次写请求的目标 token：写只能碰到开始时捕获的那个 Agent 会话与工作目录。
 *
 * 接口：`createRequestTarget(snapshot, input, validateTarget)` 返回
 *   `{ initial, sessionId, cwd, assert, assertInput }`；字段与语义见
 *   docs/architecture/interfaces/host-interface.md。
 * 不变量：捕获的是 snapshot 函数本身，期望身份在创建时固定；每次 `assert()` 重新读取
 *   最新快照比较，因此会话切换、cwd 变化或宿主仍在初始化都能被发现。
 * 错误：身份不一致或要求 `ready` 但仍在初始化／交接时抛 DeskError(409)。
 */

/**
 * 路由会等待文件系统、Git、附件与模型工作。开始时捕获目标、在每个 await 之后重新断言，
 * 把这些竞态关在一条 seam 里，而不是让每条路由用略有差异的规则重读快照。
 */
export function createRequestTarget(snapshot, input = {}, validateTarget) {
  const initial = snapshot() ?? {};
  const expected = {
    sessionId: String(initial.sessionId ?? ""),
    cwd: initial.cwd,
  };
  if (
    input.sessionId !== undefined &&
    String(input.sessionId) !== expected.sessionId
  )
    throw new DeskError(409, "当前会话已变化，请刷新后重试");
  const assert = ({
    cwd = true,
    ready = false,
    message = "当前会话已变化，请刷新后重试",
  } = {}) => {
    const latest = snapshot() ?? {};
    if (
      String(latest.sessionId ?? "") !== expected.sessionId ||
      (cwd && latest.cwd !== expected.cwd)
    )
      throw new DeskError(409, message);
    if (ready && (latest.replacing || latest.initializing))
      throw new DeskError(409, "宿主尚在初始化／交接，请稍后重试");
    return latest;
  };
  const assertInput = ({ requireSession = false, ...options } = {}) => {
    if (requireSession && input.sessionId === undefined)
      throw new DeskError(409, "当前会话已变化，请刷新后重试");
    validateTarget?.(input);
    return assert(options);
  };
  return {
    initial,
    sessionId: expected.sessionId,
    cwd: expected.cwd,
    assert,
    assertInput,
  };
}
