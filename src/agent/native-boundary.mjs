import { loadPiMessages, loadPiSessionManager } from "./pi-sdk.mjs";

/**
 * 原生边界 draft adapter：Pi 校验和投影，Durable 在原任务的决策提交中写入。
 *
 * 接口：compileNativeBoundary(session, drafts, snapshot) -> Durable EntryDraft[]。
 * 不变量：目标只取已发布原生快照的来源映射，不生成助手／工具身份，不提交或运行模型。
 * 错误：未找到的来源明确失败；draft 合法性与上下文内容交给原 SDK。
 */
export async function compileNativeBoundary(session, drafts, snapshot) {
  const { convertToLlm } = await loadPiMessages();
  const { sessionEntryToContextMessages } = await loadPiSessionManager();
  const origins = new Map(snapshot.origins);
  const result = [];
  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index];
    const manager = session._createBoundaryPreviewManager(
      drafts.slice(0, index + 1),
    );
    const appended = manager.getEntry(manager.getLeafId());
    const contribution = {
      kind: "desk.native-boundary",
      data: { nativeBoundary: draft },
    };
    if (draft.type === "custom_message") {
      const [message] = sessionEntryToContextMessages(appended);
      contribution.data.nativeMessage = message;
      contribution.model = convertToLlm([message]);
    } else if (draft.type === "context_edit") {
      const target = origins.get(draft.targetId);
      if (target === undefined)
        throw new Error("边界编辑无法解析已提交的来源 entry");
      const messages = convertToLlm(
        manager
          .buildSessionProjection()
          .entries.filter(
            (entry) => origins.get(entry.sourceEntry.id) === target,
          )
          .flatMap((entry) => entry.messages),
      );
      contribution.edits = [
        messages.length
          ? { target, action: "replace", messages }
          : { target, action: "omit" },
      ];
    } else if (draft.type === "compaction") {
      const first =
        draft.firstKeptEntryId === null
          ? "self"
          : origins.get(draft.firstKeptEntryId);
      if (first === undefined)
        throw new Error("边界压缩无法解析已提交的保留 entry");
      contribution.head = first;
      contribution.model = convertToLlm(
        sessionEntryToContextMessages(appended),
      );
      contribution.data.tokensBefore = appended.tokensBefore;
      if (first !== "self") {
        const messages = convertToLlm(
          manager
            .buildSessionProjection()
            .entries.filter(
              (entry) => origins.get(entry.sourceEntry.id) === first,
            )
            .flatMap((entry) => entry.messages),
        );
        contribution.edits = [{ target: first, action: "replace", messages }];
      }
    } else if (draft.type !== "custom")
      throw new Error("未知原生边界 entry 类型");
    result.push(contribution);
  }
  return result;
}
