import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { contentText } from "../shared/conversation.mjs";
import { DeskError } from "../config/config-store.mjs";
import { normalizeInputPresentation } from "../shared/input-presentation.mjs";

/**
 * 输入的展示来源：只保存宿主已知的原始文字，原生 submission／entry 仍是接纳真相。
 *
 * 接口：createInputPresentation(harness, context) -> submit／record／read／seed；不等待原生工作。
 * 不变量：按公开 submission.entry 精确关联，不按标签或消息时间猜；无来源时保留原文；
 *   模型贡献不变，局部串行只将来源落盘与原生接纳成组，不调度模型／工具。
 * 错误：存储与原生接纳错误向调用者传播；正文摘要不符时安全回退，不隐藏内容。
 */
const MAX_ORIGINAL_UNITS = 512000;
const Presentations = defineDoc({
  kind: "desk.input-presentation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ unbound: {}, byEntry: {} }),
});
const digest = (text) => createHash("sha256").update(text).digest("hex");

export function createInputPresentation(harness, context) {
  const admissions = new Map();
  return {
    async record(conversation, original, requestId) {
      if (typeof original !== "string" || original.length > MAX_ORIGINAL_UNITS)
        throw new DeskError(422, "输入原文无效");
      return conversation.submit(
        {
          type: "write",
          requestId: `command-display:${requestId}`,
          entry: {
            kind: "desk.input-command",
            model: [],
            data: { version: 1, original, timestamp: Date.now() },
          },
        },
        context,
      );
    },
    async submit(conversation, draft, presentation) {
      if (!presentation) return conversation.submit(draft, context);
      if (
        !["user", "automatic"].includes(presentation.source) ||
        (presentation.original !== undefined &&
          (typeof presentation.original !== "string" ||
            presentation.original.length > MAX_ORIGINAL_UNITS))
      )
        throw new DeskError(422, "输入展示来源无效");
      // 前次拒绝已交还原调用者，不能因此阻塞同会话的后续原生接纳。
      const admission = (admissions.get(conversation.id) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await conversation.commit(async (tx) => {
            // 已接纳的幂等请求保留第一次来源；未接纳的旧尝试可以被当前重试覆盖。
            if (await tx.submissionByRequest(conversation.id, draft.requestId))
              return;
            const document = await tx.doc(Presentations, conversation.id);
            document.unbound[`request:${draft.requestId}`] = {
              requestId: draft.requestId,
              conversationId: conversation.id,
              digest: digest(contentText(draft.content)),
              presentation: {
                source: presentation.source,
                ...(presentation.original === undefined
                  ? {}
                  : { original: presentation.original }),
              },
            };
          }, context);
          try {
            return await conversation.submit(draft, context);
          } catch (error) {
            try {
              await conversation.commit(async (tx) => {
                // 确认未接纳才清理；回执不确定但已存在的原生 submission 仍保留来源。
                if (
                  !(await tx.submissionByRequest(
                    conversation.id,
                    draft.requestId,
                  ))
                )
                  delete (await tx.doc(Presentations, conversation.id)).unbound[
                    `request:${draft.requestId}`
                  ];
              }, context);
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                "输入接纳失败，来源记录未能确认",
              );
            }
            throw error;
          }
        });
      admissions.set(conversation.id, admission);
      try {
        return await admission;
      } finally {
        if (admissions.get(conversation.id) === admission)
          admissions.delete(conversation.id);
      }
    },
    async seed(tx, id, entryId, value) {
      const presentation = normalizeInputPresentation(value);
      if (!presentation) return;
      (await tx.doc(Presentations, id)).byEntry[entryId] = presentation;
    },
    async read(id) {
      const saved = await harness.snapshot(Presentations, id, context);
      if (!saved) return {};
      if (!Object.keys(saved.unbound).length) return saved.byEntry;
      return harness.commit(async (tx) => {
        const document = await tx.doc(Presentations, id);
        for (const [key, origin] of Object.entries(document.unbound)) {
          const submission = await tx.submissionByRequest(
            origin.conversationId,
            origin.requestId,
          );
          if (submission?.entry !== undefined) {
            const entry = await tx.entry(submission.entry);
            const message = entry?.model?.find(
              (message) => message.role === "user",
            );
            document.byEntry[submission.entry] =
              message && digest(contentText(message.content)) === origin.digest
                ? origin.presentation
                : { source: "unknown" };
            delete document.unbound[key];
          } else if (submission?.status === "unanswered")
            delete document.unbound[key];
        }
        return JSON.parse(JSON.stringify(document.byEntry));
      }, context);
    },
  };
}
