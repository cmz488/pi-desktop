import { DeskError } from "../config/config-store.mjs";

/**
 * Host 任务适配：聚合 worker 原生监控，转发固定目标的管理，不持有任务或调度状态。
 *
 * 接口：createHostTasks({ list, request }) 提供 read／command／detail；见
 *   docs/architecture/interfaces/host-tasks.md。
 * 不变量：不因监控启动进程；worker 身份包含存储 generation；最多四个并行读取；
 *   等待断连只取消观察，管理不占用 Host 配置串行队列；单个 worker 失败保持局部可见。
 * 错误：目标／参数无效 422、不存在 404、未启动／代际变化 409；权限由 worker 再校验。
 */
const READ_TIMEOUT_MS = 5000;
const READ_CONCURRENCY = 4;
const COMMAND_TIMEOUT_MS = 12000;
const WAIT_TIMEOUT_MS = 45000;
const bounded = (signal, timeout) =>
  signal ? AbortSignal.any([signal, timeout]) : timeout;

export function createHostTasks({ list, request }) {
  async function target(input) {
    if (
      typeof input?.agentId !== "string" ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(input.agentId) ||
      !Number.isSafeInteger(input.conversationId) ||
      input.conversationId < 0 ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 0
    )
      throw new DeskError(422, "任务管理目标无效");
    const agent = (await list()).find((row) => row.id === input.agentId);
    if (!agent || agent.source === "pi")
      throw new DeskError(404, "Agent 不存在");
    if ((agent.generation ?? 0) !== input.generation)
      throw new DeskError(409, "Agent 存储代际已变化，请刷新后重试");
    if (agent.status !== "running") throw new DeskError(409, "请先启动会话");
    return agent;
  }
  return {
    async command(input, { signal } = {}) {
      if (
        !input ||
        !["wait", "cancel", "subagent.spawn"].includes(input.command)
      )
        throw new DeskError(422, "任务管理操作无效");
      const agent = await target(input);
      const background =
        input.command === "cancel" && input.background === true;
      if (
        input.command !== "subagent.spawn" &&
        !background &&
        (!Number.isSafeInteger(input.taskId) || input.taskId < 0)
      )
        throw new DeskError(422, "任务 id 无效");
      if (background && input.taskId !== undefined)
        throw new DeskError(422, "请选择单任务或后台任务取消方式");
      const payload = Object.freeze({
        command: input.command,
        id: input.conversationId,
        sessionId: String(input.conversationId),
        ...(input.command === "subagent.spawn"
          ? {
              name: input.name,
              prompt: input.prompt,
              config: input.config,
              requestId: input.requestId,
            }
          : background
            ? { background: true }
            : { taskId: input.taskId }),
      });
      const timeout = AbortSignal.timeout(
        input.command === "wait" ? WAIT_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
      );
      try {
        const result = await request(
          agent.id,
          `/api/command?sessionId=${payload.sessionId}`,
          payload,
          {
            signal: bounded(signal, timeout),
            expectedGeneration: input.generation,
          },
        );
        return {
          ...result,
          agentId: agent.id,
          generation: input.generation,
          conversationId: input.conversationId,
        };
      } catch (error) {
        if (timeout.aborted && !signal?.aborted)
          throw new DeskError(504, "任务管理连接超时，请刷新确认任务状态");
        throw error;
      }
    },
    async detail(input, { signal } = {}) {
      const agent = await target(input);
      if (!Number.isSafeInteger(input.taskId) || input.taskId < 0)
        throw new DeskError(422, "任务 id 无效");
      const timeout = AbortSignal.timeout(READ_TIMEOUT_MS);
      try {
        return await request(
          agent.id,
          `/api/task-detail?sessionId=${input.conversationId}&taskId=${input.taskId}`,
          undefined,
          {
            signal: bounded(signal, timeout),
            expectedGeneration: input.generation,
          },
        );
      } catch (error) {
        if (timeout.aborted && !signal?.aborted)
          throw new DeskError(504, "任务详情读取超时，请重试");
        throw error;
      }
    },
    async read({ signal } = {}) {
      const agents = await list();
      const workers = [];
      for (let index = 0; index < agents.length; index += READ_CONCURRENCY) {
        signal?.throwIfAborted();
        const rows = await Promise.all(
          agents.slice(index, index + READ_CONCURRENCY).map(async (agent) => {
            const row = {
              agentId: agent.id,
              generation: agent.generation ?? 0,
              name: agent.name,
              projectId: agent.projectId ?? null,
              status: agent.status,
              data: null,
            };
            if (agent.status !== "running" || agent.source === "pi") return row;
            try {
              return {
                ...row,
                data: await request(agent.id, "/api/task-monitor", undefined, {
                  signal: bounded(signal, AbortSignal.timeout(READ_TIMEOUT_MS)),
                  expectedGeneration: agent.generation ?? 0,
                }),
              };
            } catch (error) {
              if (signal?.aborted) throw error;
              return {
                ...row,
                error:
                  error.name === "TimeoutError"
                    ? "Agent 监控读取超时，请重试"
                    : error instanceof DeskError &&
                        [403, 409].includes(error.status)
                      ? error.message
                      : "Agent 监控暂不可用，请检查进程状态",
              };
            }
          }),
        );
        workers.push(...rows);
      }
      return {
        supported: true,
        workers,
        partial: workers.some((row) => !!row.error),
      };
    },
  };
}
