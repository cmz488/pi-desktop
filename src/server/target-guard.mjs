import { DeskError } from "../config/config-store.mjs";

/**
 * A request-scoped identity for the Agent a write is allowed to touch.
 *
 * Routes await filesystem, Git, attachment and model work. Capturing the
 * target once and asserting it after each await keeps those races at one seam
 * instead of re-reading the snapshot with slightly different rules per route.
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
