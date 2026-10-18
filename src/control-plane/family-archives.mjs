import { DeskError } from "../config/config-store.mjs";

/**
 * 会话族迁移：把一个 Desktop Agent 的原生文件作为同一项可恢复的归档意图处理。
 *
 * 接口：`createFamilyArchives({ store, archives })` 提供 `isFamily(agent)`、
 *   `archive(agent, path, cwd)`、`restore(agent)`、`recover(agent)`。
 *   见 docs/architecture/interfaces/lifecycle.md。
 * 不变量：每个文件仍走现有归档 adapter 的校验、锁与阶段恢复；先持久化整族意图，
 *   所有文件完成后才允许目录解除迁移门禁；不读取 Durable 内部，也不复制数据库。
 * 错误：文件冲突原样抛出且保持可见的 pending 状态；未完成的反向迁移返回 409。
 */
export function createFamilyArchives({ store, archives }) {
  const members = (agent, path = agent.nativeSessionPath) => [
    { key: agent.id, path, nativeSessionId: agent.nativeSessionId, root: true },
    ...(agent.nativeSessions ?? [])
      .filter((row) => row.nativeSessionId !== agent.nativeSessionId)
      .map((row) => ({
        ...row,
        key: `${agent.id}:branch:${row.nativeSessionId}`,
        root: false,
      })),
  ];
  const isFamily = (agent) => members(agent).length > 1;
  const patch = (id, value) =>
    store.update({}, (data) => {
      const row = data.agents.find((entry) => entry.id === id);
      if (!row) throw new DeskError(404, "Agent 不存在");
      Object.assign(row, value);
    });
  const prepare = async (agent, intent) => {
    if (isFamily(agent))
      await patch(agent.id, {
        archiveIntent: intent,
        archivePending: true,
        desired: false,
      });
  };
  const failure = async (agent, intent, pending) => {
    if (pending || isFamily(agent))
      await patch(agent.id, {
        archivePending: pending,
        archiveIntent: pending && isFamily(agent) ? intent : undefined,
        desired: false,
        archiveError: pending
          ? isFamily(agent)
            ? "会话族迁移尚未完成，记录已保留，请重试"
            : "归档尚未完成，记录已备份到 SQLite，请重试归档"
          : undefined,
      });
  };
  const api = {
    isFamily,
    async archive(agent, path, cwd) {
      if (agent.archiveIntent === "restore")
        throw new DeskError(409, "会话族正在恢复，请先重试恢复");
      const adapter = await archives;
      const records = members(agent, path);
      await prepare(agent, "archive");
      let root;
      try {
        for (const member of records) {
          const record = await adapter.archive(
            member.key,
            member.path,
            member.root ? cwd : undefined,
            member.nativeSessionId,
          );
          if (member.root) root = record;
        }
        return root;
      } catch (error) {
        const pending = records.some((member) =>
          ["archiving", "archived"].includes(adapter.state(member.key)),
        );
        await failure(agent, "archive", pending);
        throw error;
      }
    },
    async restore(agent) {
      if (agent.archiveIntent === "archive")
        throw new DeskError(409, "会话族归档尚未完成，请先重试归档");
      const adapter = await archives;
      await prepare(agent, "restore");
      let root;
      try {
        for (const member of members(agent)) {
          const record = await adapter.restore(member.key);
          if (member.root) root = record;
        }
        return root;
      } catch (error) {
        await failure(agent, "restore", isFamily(agent));
        throw error;
      }
    },
    async recover(agent) {
      if (!isFamily(agent)) return false;
      const adapter = await archives;
      const phases = members(agent).map((member) => adapter.state(member.key));
      const intent =
        agent.archiveIntent ??
        (phases.includes("archiving")
          ? "archive"
          : phases.includes("restoring")
            ? "restore"
            : agent.archived && phases.includes("restored")
              ? "restore"
              : !agent.archived && phases.includes("archived")
                ? "archive"
                : agent.archived && phases.includes("snapshot")
                  ? "archive"
                  : undefined);
      if (!intent) return false;
      const record =
        intent === "archive"
          ? await api.archive(agent, agent.nativeSessionPath)
          : await api.restore(agent);
      await patch(agent.id, {
        archived: intent === "archive",
        archiveStored: true,
        nativeSessionPath: record.path,
        desired: false,
        missing: false,
        archivePending: false,
        archiveIntent: undefined,
        archiveError: undefined,
      });
      return true;
    },
  };
  return api;
}
