import { DeskError } from "../config/config-store.mjs";

/**
 * HTTP 任务等待租约：只拥有观察请求的取消与资源，不拥有任务的执行或中止。
 *
 * 接口：createTaskWaits({ leaseMs?, capacity? }) → run(request, response, wait)、close()；
 *   wait(signal) 必须遵守取消，完整契约见 docs/architecture/interfaces/task-graph.md。
 * 不变量：每个请求有期限和独立 signal；断连／到期／关闭只取消观察者；所有出口清理资源。
 * 错误：配置无效 422、租约到期 408、容量用尽 429、关闭 503；断连为内部 499。
 */
const WAIT_LEASE_MS = 40000;
const WAIT_CAPACITY = 32;
const MAX_TIMER_MS = 2 ** 31 - 1;

export function createTaskWaits({
  leaseMs = WAIT_LEASE_MS,
  capacity = WAIT_CAPACITY,
} = {}) {
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0 ||
    leaseMs > MAX_TIMER_MS ||
    !Number.isSafeInteger(capacity) ||
    capacity <= 0
  )
    throw new DeskError(422, "等待资源配置无效");
  const active = new Set();
  let closed = false;
  return {
    async run(request, response, wait) {
      if (closed) throw new DeskError(503, "等待服务已关闭");
      if (active.size >= capacity)
        throw new DeskError(429, "等待请求过多，请稍后重试");
      const controller = new AbortController();
      const done = Promise.withResolvers();
      const entry = { controller, done: done.promise };
      const disconnect = () =>
        controller.abort(new DeskError(499, "等待连接已关闭，任务继续运行"));
      active.add(entry);
      request.once("aborted", disconnect);
      // IncomingMessage 的 close 也可能表示请求体读完，不能用它取消仍连接的响应。
      response.once("close", disconnect);
      const timer = setTimeout(
        () =>
          controller.abort(new DeskError(408, "等待租约已到期，任务继续运行")),
        leaseMs,
      );
      timer.unref?.();
      try {
        if (request.aborted || response.destroyed) disconnect();
        return await wait(controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      } finally {
        clearTimeout(timer);
        request.off("aborted", disconnect);
        response.off("close", disconnect);
        active.delete(entry);
        done.resolve();
      }
    },
    async close() {
      closed = true;
      const pending = [...active];
      for (const { controller } of pending)
        controller.abort(new DeskError(503, "等待服务已关闭，任务状态保留"));
      await Promise.all(pending.map((entry) => entry.done));
    },
  };
}
