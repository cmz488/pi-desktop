import {
  AssistantEntry,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  GenerationTask,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { contentText } from "../shared/conversation.mjs";
import { DeskError } from "../config/config-store.mjs";

/**
 * Host 子代理薄适配：使用 Durable task、owned conversation 与 submission 运行一次委托。
 *
 * 接口：createManagedSubagents 接收 owned 创建／资源绑定与具名管理操作，返回
 *   { extension, task, messageTask }；模型工具及原生 invocation 约束见
 *   docs/architecture/interfaces/subagent-tools.md。
 * 不变量：不创建执行器或模型循环；子会话身份先写检查点，submission 使用固定 requestId；
 *   调度、重启、终态及自底向上的取消全部由 Durable 承担，等待不会冒充成功。
 * 错误：原生准入／执行错误交给 Durable；unanswered 保存失败回执，abort 保存原生中止结果。
 */
export const MANAGED_SUBAGENT_KIND = "desk.subagent-run";
export const SUBAGENT_MESSAGE_KIND = "desk.subagent-message";
const ANSWER_PREVIEW_CHARS = 12000;
const MAX_TOOL_JSON_BYTES = 1024 * 1024;

export function createManagedSubagents({
  createChild,
  prepareChild,
  beforeRequest,
  failureReason,
  spawn,
  read,
  result,
  message,
  list,
  wait,
  abort,
}) {
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
        const failure =
          settled.status === "done"
            ? undefined
            : await failureReason(id, context);
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
                error: {
                  message:
                    failure ??
                    `子代理未完成：${settled.reason}${typeof settled.detail === "string" ? `：${settled.detail}` : ""}`,
                },
              },
            };
          // 上下文可能继续变化；结果只读取 submission 已决定的不可变回答。
          const entry = await tx.entry(AssistantEntry, settled.answer);
          const answer = entry?.model?.find(
            (message) => message.role === "assistant",
          );
          if (!answer) throw new Error("子代理原生回答不存在");
          const fullAnswer = contentText(answer.content);
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                ...result,
                answerEntryId: settled.answer,
                answer: fullAnswer.slice(0, ANSWER_PREVIEW_CHARS),
                answerUnits: fullAnswer.length,
                answerTruncated: fullAnswer.length > ANSWER_PREVIEW_CHARS,
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
  // 消息投递本身也是原生 owned 工作：准入后先持有原委托，避免终态检查与 submit
  // 之间的竞争复活子会话；检查点与结果同时提供跨重启的稳定回执。
  const messageTask = defineTask({
    name: SUBAGENT_MESSAGE_KIND,
    version: 1,
    initial: () => ({ phase: "submit" }),
    phases: {
      submit: async (task, runtime, context) => {
        const { conversationId, content, mode, requestId, taskId } = task.input;
        const child = await runtime.conversation(conversationId, context);
        if (!child) throw new Error("子代理会话不存在");
        const submission = await child.submit(
          {
            type: "input",
            content,
            whenBusy: mode,
            requestId,
          },
          context,
        );
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: {
                taskId,
                conversationId,
                submissionId: submission.id,
                mode,
              },
            },
          }),
          context,
        );
      },
    },
    abort: task.definition.abort,
  });
  return {
    task,
    messageTask,
    extension: defineExtension({
      name: "desk-subagents",
      tasks: [task, messageTask],
      hooks: [hook(GenerationTask, { beforeRequest })],
      tools: [
        defineTool({
          name: "desk_subagent",
          description:
            "管理当前会话拥有的子代理：spawn 后台创建并立即返回 taskId；message 用 steer 或 followUp 投递指令；read 读取过程预览；result 用 offset/length 分段读取完整原生回答；list 默认只列非终态，includeTerminal/before 可分页查历史；wait 等原生终态；abort 请求原生中止。仅在用户要求委派时创建，共享目录的并行写入须隔离。taskId 不是历史分支 id；终态消息不能复活任务。取消等待不拥有工作，marked 不等于已中止。messageResults 与 budgetError 单列后续消息状态，首次 completed 不等于全部成功；旧回执 modeKnown=false 表示历史投递模式未知。",
          replay: "safe",
          // 通用文本裁剪会破坏 JSON；结构化回执只允许完整返回或明确超限。
          outputLimits: { maxBytes: MAX_TOOL_JSON_BYTES },
          parameters: Type.Object({
            action: Type.Union([
              Type.Literal("spawn"),
              Type.Literal("read"),
              Type.Literal("result"),
              Type.Literal("message"),
              Type.Literal("list"),
              Type.Literal("wait"),
              Type.Literal("abort"),
            ]),
            prompt: Type.Optional(
              Type.String({ minLength: 1, maxLength: 512000 }),
            ),
            taskId: Type.Optional(Type.Integer({ minimum: 0 })),
            includeTerminal: Type.Optional(Type.Boolean()),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
            before: Type.Optional(Type.Integer({ minimum: 0 })),
            offset: Type.Optional(Type.Integer({ minimum: 0 })),
            length: Type.Optional(Type.Integer({ minimum: 1, maximum: 32000 })),
            message: Type.Optional(
              Type.String({ minLength: 1, maxLength: 512000 }),
            ),
            mode: Type.Optional(
              Type.Union([Type.Literal("steer"), Type.Literal("followUp")]),
            ),
            name: Type.Optional(Type.String({ maxLength: 120 })),
            config: Type.Optional(
              Type.Object(
                {
                  model: Type.Optional(
                    Type.Object(
                      { provider: Type.String(), modelId: Type.String() },
                      { additionalProperties: false },
                    ),
                  ),
                  thinkingLevel: Type.Optional(
                    Type.Union(
                      [
                        "off",
                        "minimal",
                        "low",
                        "medium",
                        "high",
                        "xhigh",
                        "max",
                      ].map((value) => Type.Literal(value)),
                    ),
                  ),
                  instructions: Type.Optional(
                    Type.String({ maxLength: 64000 }),
                  ),
                  tools: Type.Optional(Type.Array(Type.String())),
                  maxTurns: Type.Optional(
                    Type.Integer({ minimum: 1, maximum: 256 }),
                  ),
                },
                { additionalProperties: false },
              ),
            ),
            requestId: Type.Optional(
              Type.String({ minLength: 1, maxLength: 200 }),
            ),
          }),
          async execute(args, api, context) {
            const response = await {
              spawn,
              read,
              result,
              message,
              list,
              wait,
              abort,
            }[args.action](args, api, context);
            const text = JSON.stringify(response);
            if (Buffer.byteLength(text, "utf8") > MAX_TOOL_JSON_BYTES)
              throw new DeskError(
                413,
                "子代理结果过大，请缩小列表或在工作台查看记录",
              );
            return {
              output: [{ type: "text", text }],
            };
          },
        }),
      ],
    }),
  };
}
