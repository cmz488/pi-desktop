/**
 * 对话轮次视图：把 SDK 原生树中的用户输入及其后续消息聚合成展示节点。
 *
 * 接口：projectRoundTree(model, limit) 返回 rounds／total；结构见 session-tree.md。
 * 不变量：仅做展示聚合，不推导模型上下文、不改 parent／leaf／entry；工具、思考及
 *   扩展记录不是独立轮次；窗口有界且始终包含当前位置，旧记录不从存储删除。
 * 错误：缺少原生树返回空视图；无 Durable 映射的节点保留展示但不可退回。
 */
export const DEFAULT_ROUND_LIMIT = 10;
export const MAX_ROUND_LIMIT = 200;

export function projectRoundTree(model, limit = DEFAULT_ROUND_LIMIT) {
  const nodes = model?.native?.nodes ?? [];
  const membership = new Map();
  const rounds = [];
  for (const node of nodes) {
    let round = membership.get(node.parentId);
    if (node.role === "user") {
      round = {
        id: node.id,
        parentId: round?.id ?? null,
        number: rounds.length + 1,
        prompt: node.preview || "图片或非文本提问",
        active: !!node.active,
        current: false,
        entryId: Number.isSafeInteger(node.entryId) ? node.entryId : null,
        activeEntryId: node.active ? node.entryId : null,
        answer: "",
        activeAnswer: "",
      };
      rounds.push(round);
    } else if (round && ["assistant", "toolResult"].includes(node.role)) {
      if (Number.isSafeInteger(node.entryId)) round.entryId = node.entryId;
      if (node.active && Number.isSafeInteger(node.entryId))
        round.activeEntryId = node.entryId;
      if (node.role === "assistant" && node.preview) {
        round.answer = node.preview;
        if (node.active) round.activeAnswer = node.preview;
      }
    }
    membership.set(node.id, round);
  }
  const current =
    membership.get(model?.native?.leafId ?? model?.leaf) ??
    rounds.findLast((round) => round.active);
  if (current) {
    current.current = true;
    // 退回标记的原生 leaf 不是消息身份；优先使用 Host 给出的当前活跃上下文目标。
    if (Number.isSafeInteger(model?.currentEntryId))
      current.activeEntryId = model.currentEntryId;
  }
  for (const round of rounds) {
    if (round.active) {
      round.entryId = Number.isSafeInteger(round.activeEntryId)
        ? round.activeEntryId
        : round.entryId;
      round.answer = round.activeAnswer;
    }
    delete round.activeEntryId;
    delete round.activeAnswer;
  }
  const count = Math.min(
    MAX_ROUND_LIMIT,
    Math.max(1, Number.isSafeInteger(limit) ? limit : DEFAULT_ROUND_LIMIT),
  );
  let visible = rounds.slice(-count);
  // 从较早的轮次退回后，不能被“最近 N 轮”的历史窗口挤掉当前操作位置。
  if (current && !visible.includes(current))
    visible = [...visible.slice(1), current].sort(
      (a, b) => a.number - b.number,
    );
  return { rounds: visible, total: rounds.length };
}
