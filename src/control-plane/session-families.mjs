import { join } from "node:path";
import {
  readNativeTranscriptFamily,
  nativeBranchIdentity,
} from "../session/native-transcript-family.mjs";

/**
 * Host 的会话族归属：只消费 worker 发布的原生文件清单，不读取 Durable 存储。
 *
 * 接口：`createSessionFamilies({ store, directory })` 提供 `directory(agent)`、
 *   `remember(agent)` 与 `claim(found, sessions, catalog)`；`mergeNativeSessions`
 *   合并已验证的归属列表，保持 id／path／nativeSessionId 唯一；归属字段见
 *   docs/architecture/interfaces/lifecycle.md。
 * 不变量：历史分支仍属于原 Desktop Agent；扫描与迁移使用同一份文件归属，
 *   不把分支注册成第二个进程；缺少清单的旧 worker 保持单转录语义。
 * 错误：清单读取失败会记录可见的迁移错误并抛出；新文件读取的瞬时冲突留待下次扫描。
 */

export function mergeNativeSessions(before = [], next = []) {
  const members = new Map(before.map((row) => [row.nativeSessionId, row]));
  for (const row of next) {
    for (const [key, prior] of members)
      if (prior.id === row.id || prior.path === row.path) members.delete(key);
    members.set(row.nativeSessionId, row);
  }
  return [...members.values()].sort((a, b) => a.id - b.id);
}

export function createSessionFamilies({ store, directory }) {
  const location = (agent) =>
    join(
      directory,
      "agents",
      agent.id,
      ...(agent.generation ? [`resume-${agent.generation}`] : []),
    );
  return {
    directory: location,
    async remember(agent) {
      if (agent.source === "pi") return;
      let manifest;
      try {
        manifest = await readNativeTranscriptFamily(location(agent));
      } catch (error) {
        await store.update({}, (data) => {
          const row = data.agents.find((entry) => entry.id === agent.id);
          if (row)
            row.familyError = error.status
              ? error.message
              : "无法读取会话族元数据，请检查存储权限";
        });
        throw error;
      }
      if (!manifest) return;
      const members = mergeNativeSessions(
        agent.nativeSessions,
        manifest.members,
      );
      if (
        JSON.stringify(members) === JSON.stringify(agent.nativeSessions) &&
        !agent.familyError
      )
        return;
      await store.update({}, (data) => {
        const row = data.agents.find((entry) => entry.id === agent.id);
        if (!row) return;
        row.nativeSessions = mergeNativeSessions(
          row.nativeSessions,
          manifest.members,
        );
        delete row.familyError;
      });
    },
    async claim(found, sessions, catalog) {
      const known = new Set(
        catalog.agents.flatMap((agent) => [
          agent.nativeSessionId,
          ...(agent.nativeSessions ?? []).map((row) => row.nativeSessionId),
        ]),
      );
      const owners = new Map(
        catalog.agents
          .filter((row) => row.source !== "pi")
          .map((row) => [`${row.id}:${row.generation ?? 0}`, row.id]),
      );
      const next = [];
      for (const session of found) {
        if (known.has(session.nativeSessionId) || !owners.size) {
          next.push(session);
          continue;
        }
        let record;
        try {
          // 清单与文件不是同一个原子写：只对未知的新文件检查互操作标记，覆盖两者之间的崩溃窗口。
          record = await sessions.record(session.id);
        } catch (error) {
          if (error.code === "ENOENT" || error.status === 409) continue;
          // 大型 TUI 记录仍可列在历史中，但不能借这个冷路径扩展文件读取上限。
          if (error.status === 413) {
            next.push(session);
            continue;
          }
          throw error;
        }
        const marker = record.entries.findLast(
          (entry) => entry.customType === "pi-desktop-family",
        )?.data;
        if (
          owners.has(marker?.owner) &&
          Number.isSafeInteger(marker.conversationId) &&
          marker.conversationId >= 0 &&
          nativeBranchIdentity(marker.owner, marker.conversationId) ===
            session.nativeSessionId
        )
          next.push({
            ...session,
            desktopOwner: owners.get(marker.owner),
            conversationId: marker.conversationId,
            nativeSessionPath: record.path,
          });
        else next.push(session);
      }
      return next;
    },
  };
}
