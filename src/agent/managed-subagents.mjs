import {
  AssistantEntry,
  defineExtension,
  defineTask,
} from "@earendil-works/pi-durable";
import { contentText } from "../shared/conversation.mjs";

/**
 * Host 子代理薄适配：使用 Durable task、owned conversation 与 submission 运行一次委托。
 *
 * 接口：createManagedSubagents({ createChild, prepareChild }) 返回 { extension, task }；
 *   createChild(tx, task) 原子创建 owned 会话与应用元数据，prepareChild 绑定原生资源。
 * 不变量：不创建执行器或模型循环；子会话身份先写检查点，submission 使用固定 requestId；
 *   调度、重启、终态及自底向上的取消全部由 Durable 承担，等待不会冒充成功。
 * 错误：原生准入／执行错误交给 Durable；unanswered 保存失败回执，abort 保存原生中止结果。
 */
export const MANAGED_SUBAGENT_KIND = "desk.subagent-run";
const ANSWER_PREVIEW_CHARS = 12000;

export function createManagedSubagents({ createChild, prepareChild }) {
  const task = defineTask({
    name: MANAGED_SUBAGENT_KIND,
    version: 1,
    initial: () => ({ phase: "create" }),
    phases: {
      create: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          const child = await createChild(tx, task);
          return {
            status: "running",
            checkpoint: { phase: "prepare", conversationId: child },
          };
        }, context);
      },
      prepare: async (task, runtime, context) => {
        const child = task.state.checkpoint.conversationId;
        await prepareChild(child, task.input.config, context);
        await runtime.commit(
          () => ({
            status: "running",
            checkpoint: { phase: "run", conversationId: child },
          }),
          context,
        );
      },
      run: async (task, runtime, context) => {
        const id = task.state.checkpoint.conversationId;
        const child = await runtime.conversation(id, context);
        if (!child) throw new Error("子代理会话不存在");
        const submission = await child.submit(
          {
            type: "input",
            content: task.input.prompt,
            requestId: `desktop-subagent:${task.id}`,
          },
          context,
        );
        const settled = await submission.wait(context);
        const result = {
          conversationId: id,
          submissionId: submission.id,
          status: settled.status,
        };
        await runtime.commit(async (tx) => {
          if (settled.status !== "done")
            return {
              status: "terminal",
              outcome: {
                status: "failed",
                result,
                error: { message: `子代理未完成：${settled.reason}` },
              },
            };
          // 上下文可能继续变化；结果只读取 submission 已决定的不可变回答。
          const entry = await tx.entry(AssistantEntry, settled.answer);
          const answer = entry?.model?.find(
            (message) => message.role === "assistant",
          );
          if (!answer) throw new Error("子代理原生回答不存在");
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                ...result,
                answerEntryId: settled.answer,
                answer: contentText(answer.content).slice(
                  0,
                  ANSWER_PREVIEW_CHARS,
                ),
              },
            },
          };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "用户中止子代理任务" },
        }),
        context,
      );
    },
  });
  return {
    task,
    extension: defineExtension({ name: "desk-subagents", tasks: [task] }),
  };
}
