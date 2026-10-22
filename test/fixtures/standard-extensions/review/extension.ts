import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * 复核扩展夹具：独立的工具门禁与标准交互，不导入另一扩展或注册任何专用客户端协议。
 *
 * 接口：Pi 原生工厂；仅测试临时 cwd 中记录事件，见扩展兼容基线。
 * 不变量：确认必须来自用户；终端组件只通过原生 custom/handleInput/done 交互。
 * 错误：操作错误保留 Pi 原生 handler／tool 语义，不自行重试或确认。
 */
export default function (pi: ExtensionAPI) {
  const trace = (
    ctx: ExtensionContext,
    type: string,
    data: Record<string, unknown> = {},
  ) =>
    appendFile(
      join(ctx.cwd, "review-events.jsonl"),
      JSON.stringify({ type, mode: ctx.mode, ...data }) + "\n",
    );
  pi.on("session_start", async (event, ctx) =>
    trace(ctx, event.type, { reason: event.reason }),
  );
  pi.on("session_shutdown", async (event, ctx) =>
    trace(ctx, event.type, { reason: event.reason }),
  );
  pi.on("tool_call", async (event, ctx) => {
    await trace(ctx, event.type, {
      name: event.toolName,
      callId: event.toolCallId,
      parent: event.parentToolCallId,
    });
    if (!("text" in event.input) || typeof event.input.text !== "string")
      return;
    if ("op" in event.input && event.input.op === "block")
      return { block: true, reason: "REVIEW_BLOCKED_THE_NOTE" };
    event.input.text += ":REVIEWED_INPUT";
  });
  pi.on("tool_result", async (event, ctx) => {
    await trace(ctx, event.type, {
      name: event.toolName,
      callId: event.toolCallId,
      parent: event.parentToolCallId,
    });
    if (typeof event.input.text !== "string") return;
    const text =
      event.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("") + ":REVIEWED_RESULT";
    const details =
      typeof event.details === "object" && event.details ? event.details : {};
    return {
      content: [{ type: "text", text }],
      details: { ...details, reviewed: true },
      ...(event.structuredContent &&
      typeof event.structuredContent === "object" &&
      !Array.isArray(event.structuredContent) &&
      "text" in event.structuredContent &&
      typeof event.structuredContent.text === "string"
        ? { structuredContent: { ...event.structuredContent, text } }
        : {}),
    };
  });
  pi.registerTool({
    name: "compat_check",
    label: "复核",
    description: "复核一项名称并返回普通结果",
    parameters: Type.Object({ target: Type.String() }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    async execute(_id, args, _signal, _onUpdate, ctx) {
      await trace(ctx, "execute", { target: args.target });
      return {
        content: [{ type: "text", text: `CHECK_RESULT:${args.target}` }],
        details: { target: args.target },
      };
    },
  });
  pi.registerCommand("review-flow", {
    description: "使用原生选择、确认、输入与编辑器完成复核",
    handler: async (args, ctx) => {
      await trace(ctx, "command", { args });
      if (args === "prefill") {
        ctx.ui.setEditorText("REVIEW_EDITOR_PREFILL");
        return;
      }
      if (args === "custom") {
        const result = await ctx.ui.custom<string | undefined>(
          (_tui, _theme, _keys, done) => ({
            render: () => [
              "REVIEW_CUSTOM_SCREEN",
              "按 y 明确确认，或取消本次交互。",
            ],
            handleInput(data: string) {
              if (data === "y") done("REVIEW_CUSTOM_ACCEPTED");
              if (data === "\u001b") done(undefined);
            },
            invalidate() {},
          }),
          { overlay: true },
        );
        await trace(ctx, "custom-result", { result: result ?? null });
        pi.sendMessage({
          customType: "review-result",
          display: true,
          content: `CUSTOM_RESULT:${result ?? "cancelled"}`,
        });
        return;
      }
      const target = await ctx.ui.select("选择复核范围", ["代码", "文档"]);
      if (!target) {
        await trace(ctx, "cancelled");
        pi.sendMessage({
          customType: "review-result",
          display: true,
          content: "REVIEW_CANCELLED",
        });
        return;
      }
      const confirmed = await ctx.ui.confirm("确认复核", `是否复核${target}？`);
      if (!confirmed) {
        await trace(ctx, "cancelled");
        return;
      }
      const note = await ctx.ui.input("补充复核要求", "输入备注");
      if (note === undefined) {
        await trace(ctx, "cancelled");
        return;
      }
      const document = await ctx.ui.editor("编辑复核摘要", `原始摘要：${note}`);
      if (document === undefined) {
        await trace(ctx, "cancelled");
        return;
      }
      ctx.ui.notify("REVIEW_NOTICE_COMPLETE", "info");
      ctx.ui.setStatus("review-status", `REVIEW_STATUS:${target}`);
      ctx.ui.setWidget("review-summary", ["REVIEW_WIDGET_COMPLETE", document], {
        placement: "belowEditor",
      });
      await trace(ctx, "completed", { target, confirmed, note, document });
      pi.sendMessage({
        customType: "review-result",
        display: true,
        content: `REVIEW_RESULT:${document}`,
        details: { target, confirmed, note, document },
      });
    },
  });
}
