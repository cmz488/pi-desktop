import { startDurableDesk } from "../server/durable-server.mjs";

/**
 * Agent runtime seam：worker 进程内执行 harness 的定义（当前 adapter 是 Durable）。
 *
 * 接口：`defineAgentRuntime({ id, start })` 产出冻结的 runtime；`createDurableRuntime()`
 *   包装 `startDurableDesk` 并固定 `singleAgent: true`、回环地址与随机端口；
 *   `defaultAgentRuntime` 是 worker 入口使用的实例。详见
 *   docs/architecture/interfaces/agent-runtime.md。
 * 不变量：Host 拥有 spawn／restart／readiness／teardown，runtime 只拥有进程内 harness；
 *   进程边界就是这条 seam（边界文档的 seam A）。
 * 错误：`id` 为空串或 `start` 不是函数时抛 TypeError。
 */

/** The worker's process boundary is the Agent runtime seam. */
// 保留这条 seam 的理由：另一个 runtime 接入时无需教会 supervisor 它的实现细节。
export function defineAgentRuntime({ id, start }) {
  if (typeof id !== "string" || !id.trim())
    throw new TypeError("Agent runtime 必须提供非空 id");
  if (typeof start !== "function")
    throw new TypeError("Agent runtime 必须提供 start");
  return Object.freeze({ id, start });
}

export function createDurableRuntime({ start = startDurableDesk } = {}) {
  return defineAgentRuntime({
    id: "durable",
    start(options = {}) {
      return start({
        ...options,
        singleAgent: true,
        host: "127.0.0.1",
        port: 0,
      });
    },
  });
}

export const defaultAgentRuntime = createDurableRuntime();
