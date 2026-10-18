/**
 * 任务管理范围：选中会话及其拥有的子会话后代。
 *
 * 接口：`ownedConversationIds(id, records)` 返回包含根会话的 id 集；见
 *   docs/architecture/interfaces/task-graph.md。
 * 不变量：只沿 Durable 的 `owner.conversationId` 扩展，不沿历史分叉 `parent`；
 *   不读取或修改任务状态，同一规则用于读模型与管理命令。
 * 错误：无主动抛错；输入是宿主已验证的会话 id 与 Durable 会话记录。
 */

/**
 * @param {number} id
 * @param {Iterable<{ id: number, owner?: { conversationId: number } | null }>} records
 * @returns {Set<number>}
 */
export function ownedConversationIds(id, records) {
  const children = new Map();
  for (const record of records) {
    if (!record.owner) continue;
    const parent = record.owner.conversationId;
    const siblings = children.get(parent) ?? [];
    siblings.push(record.id);
    children.set(parent, siblings);
  }
  const scope = new Set();
  const pending = [id];
  while (pending.length) {
    const current = pending.pop();
    if (scope.has(current)) continue;
    scope.add(current);
    pending.push(...(children.get(current) ?? []));
  }
  return scope;
}
