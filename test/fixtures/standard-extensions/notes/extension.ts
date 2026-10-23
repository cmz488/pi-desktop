import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * 会话笔记扩展夹具：只通过标准 Pi API 记录状态、提供工具和观察生命周期。
 *
 * 接口：Pi 原生工厂；对照范围见 docs/references/pi-extension-compatibility-baseline.md。
 * 不变量：工厂不安装外部监听器；事件日志只写入测试临时 cwd，不绕过原生注册／发现。
 * 错误：文件与操作错误交回 Pi 原生 handler／tool，不自行吞掉错误或启动模型。
 */
export default function (pi: ExtensionAPI) {
  const instance = randomUUID();
  let calls = 0,
    pings = 0,
    boundaryContinued = false,
    settleContinued = false;
  let userPrompt = "";
  const trace = (
    ctx: ExtensionContext,
    type: string,
    data: Record<string, unknown> = {},
  ) =>
    appendFile(
      join(ctx.cwd, "notes-events.jsonl"),
      JSON.stringify({
        type,
        instance,
        mode: ctx.mode,
        idle: ctx.isIdle(),
        hasSignal: !!ctx.signal,
        ...data,
      }) + "\n",
    );
  const text = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => part?.text ?? "").join("")
        : "";

  pi.events.on("notes:ping", () => {
    pings++;
  });
  pi.on("session_start", async (event, ctx) => {
    const stored = ctx.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === "custom" && entry.customType === "notes-state",
      );
    if (stored?.type === "custom")
      calls = Number((stored.data as { calls?: number })?.calls ?? 0);
    await trace(ctx, event.type, { reason: event.reason, calls });
    ctx.ui.setStatus("notes-status", "笔记工具就绪");
    ctx.ui.setWidget("notes-summary", ["NOTES_WIDGET_READY", "标准会话笔记"]);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    await trace(ctx, event.type, { reason: event.reason, calls });
    pi.appendEntry("notes-state", { calls, shutdown: event.reason });
  });
  pi.on("input", async (event, ctx) => {
    await trace(ctx, event.type, {
      text: event.text,
      source: event.source,
      images: event.images?.length ?? 0,
    });
    if (event.text === "TEMPLATE_ORDER_PROBE")
      return { action: "transform", text: "/fixture-template INPUT_CHAIN" };
    if (event.text === "IMAGE_INPUT_PROBE")
      return { action: "transform", text: "IMAGE_INPUT_REWRITTEN", images: [] };
    if (event.text === "INPUT_TRANSFORM_PROBE")
      return { action: "transform", text: "INPUT_REWRITTEN" };
    if (event.text === "INPUT_HANDLED_PROBE") {
      pi.sendMessage({
        customType: "notes-input",
        content: "INPUT_WAS_HANDLED",
        display: true,
      });
      return { action: "handled" };
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    userPrompt = event.prompt;
    await trace(ctx, event.type, {
      prompt: event.prompt,
      images: event.images?.length ?? 0,
    });
    if (event.prompt === "PROMPT_OVERRIDE_PROBE")
      return { systemPrompt: "FORCED_NATIVE_SYSTEM_PROMPT" };
    if (event.prompt === "BEFORE_MESSAGE_PROBE")
      return {
        message: {
          customType: "notes-before",
          content: "BEFORE_MESSAGE_CONTEXT",
          display: true,
        },
      };
  });
  pi.on("context", async (event, ctx) => {
    await trace(ctx, event.type, {
      roles: event.messages.map((message) => message.role),
    });
  });
  pi.on("context_with_system", async (event, ctx) => {
    await trace(ctx, event.type, {
      leadingSystem: event.messages[0]?.role === "system",
    });
  });
  pi.on("agent_start", async (event, ctx) => trace(ctx, event.type));
  pi.on("turn_start", async (event, ctx) =>
    trace(ctx, event.type, {
      turnIndex: event.turnIndex,
      timestamp: event.timestamp,
    }),
  );
  pi.on("message_start", async (event, ctx) =>
    trace(ctx, event.type, { role: event.message.role }),
  );
  pi.on("message_update", async (event, ctx) =>
    trace(ctx, event.type, {
      role: event.message.role,
      update: event.assistantMessageEvent.type,
    }),
  );
  pi.on("message_end", async (event, ctx) => {
    await trace(ctx, event.type, {
      role: event.message.role,
      text: text(
        "content" in event.message ? event.message.content : undefined,
      ),
    });
    if (
      event.message.role === "assistant" &&
      text(event.message.content) === "REPLACE_THIS_ANSWER"
    )
      return {
        message: {
          ...event.message,
          content: [{ type: "text", text: "REPLACED_NATIVE_ANSWER" }],
        },
      };
  });
  const traceTool = async (
    event: {
      type: string;
      toolName: string;
      toolCallId: string;
      parentToolCallId?: string;
    },
    ctx: ExtensionContext,
  ) =>
    trace(ctx, event.type, {
      toolName: event.toolName,
      callId: event.toolCallId,
      parent: event.parentToolCallId,
    });
  pi.on("tool_execution_start", traceTool);
  pi.on("tool_execution_update", traceTool);
  pi.on("tool_execution_end", traceTool);
  pi.on("turn_end", async (event, ctx) => {
    await trace(ctx, event.type, {
      turnIndex: event.turnIndex,
      messageEntryId: event.messageEntryId,
      toolResultEntryIds: event.toolResultEntryIds,
      boundary: !!event.context,
    });
    if (userPrompt === "TURN_BOUNDARY_PROBE" && !boundaryContinued) {
      boundaryContinued = true;
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "notes-boundary",
            content: "TURN_BOUNDARY_CONTEXT",
            display: true,
          },
        ],
        continue: true,
      };
    }
  });
  pi.on("agent_end", async (event, ctx) =>
    trace(ctx, event.type, { messages: event.messages.length }),
  );
  pi.on("agent_before_settle", async (event, ctx) => {
    await trace(ctx, event.type, {
      outcome: event.outcome,
      boundary: !!event.context,
    });
    if (userPrompt === "SETTLE_BOUNDARY_PROBE" && !settleContinued) {
      settleContinued = true;
      return {
        entries: [
          ...event.entries,
          {
            type: "custom_message",
            customType: "notes-settle",
            content: "SETTLE_BOUNDARY_CONTEXT",
            display: true,
          },
        ],
        continue: true,
      };
    }
  });
  pi.on("agent_settled", async (event, ctx) => trace(ctx, event.type));
  pi.registerCommand("notes-status", {
    description: "查看会话笔记状态",
    handler: async (args, ctx) => {
      await trace(ctx, "command", { calls, args });
      if (args === "reload") {
        await ctx.reload();
        return;
      }
      if (args === "send-user") {
        pi.sendUserMessage("INPUT_TRANSFORM_PROBE");
        return;
      }
      if (args === "send-image") {
        pi.sendUserMessage([
          { type: "text", text: "IMAGE_INPUT_PROBE" },
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWe8AAAAASUVORK5CYII=",
          },
        ]);
        return;
      }
      if (args === "start-custom") {
        pi.sendMessage(
          {
            customType: "notes-trigger",
            content: "CUSTOM_TRIGGER_CONTEXT",
            display: true,
          },
          { triggerTurn: true },
        );
        return;
      }
      ctx.ui.notify("NOTES_COMMAND_NOTICE", "info");
      pi.sendMessage({
        customType: "notes-status",
        content: `NOTES_COMMAND_RESULT:${calls}`,
        display: true,
        details: { calls },
      });
    },
  });
  pi.registerTool({
    name: "compat_notes",
    label: "会话笔记",
    description: "记录并回显一条会话笔记",
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("echo"),
        Type.Literal("stream"),
        Type.Literal("ping"),
        Type.Literal("block"),
      ]),
      text: Type.String(),
    }),
    outputSchema: Type.Object({ text: Type.String(), calls: Type.Number() }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async execute(_callId, args, signal, onUpdate, ctx) {
      calls++;
      if (args.op === "ping") pi.events.emit("notes:ping", {});
      await trace(ctx, "execute", {
        op: args.op,
        text: args.text,
        calls,
        pings,
        toolSignal: !!signal,
        contextSignal: !!ctx.signal,
      });
      if (args.op === "stream")
        onUpdate?.({
          content: [{ type: "text", text: "NOTES_PARTIAL_OUTPUT" }],
          details: { calls },
        });
      pi.appendEntry("notes-state", { calls });
      const value = `NOTES_RESULT:${args.text}`;
      return {
        content: [{ type: "text", text: value }],
        details: { calls, pings, instance },
        structuredContent: { text: value, calls },
      };
    },
  });
}
