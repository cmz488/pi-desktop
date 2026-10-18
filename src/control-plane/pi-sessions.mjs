import { createHash } from "node:crypto";
import { stat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadPiSessionManager } from "../agent/pi-sdk.mjs";

/* Host-only module: the transcript projection is synchronous, so bind the
 * session submodule once here instead of threading awaits through callers. */
const { SessionManager, buildSessionProjection } = await loadPiSessionManager();
import { DeskError } from "../config/config-store.mjs";
import {
  projectMessage,
  statsFromEntries,
  usageMetrics,
} from "../shared/conversation.mjs";
import {
  sessionRoots,
  readNativeRecord,
} from "../session/pi-session-storage.mjs";

const identity = (path) => {
  const value = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};
export function projectPiRecord(record, id) {
  const manager = SessionManager.inMemory(
    record.header.cwd,
    undefined,
    record.entries,
  );
  const branch = manager.getBranch(),
    projection = manager.buildSessionProjection();
  // Keep older messages visible in history while applying Pi's context edits.
  const history = buildSessionProjection(
    branch.map((entry) =>
      entry.type === "compaction"
        ? { ...entry, type: "custom", customType: "desktop-history-compaction" }
        : entry,
    ),
  );
  const messages = history.entries.flatMap((entry) =>
    entry.messages.map((message, index) =>
      projectMessage(message, `${entry.sourceEntry.id}:${index}`),
    ),
  );
  const stats = statsFromEntries(branch);
  return {
    name: manager.getSessionName() ?? "Pi 会话",
    cwd: record.header.cwd,
    sessionId: id,
    messages,
    stats,
    metrics: usageMetrics(stats),
    model: projection.model
      ? {
          ...projection.model,
          id: projection.model.modelId,
          name: projection.model.modelId,
        }
      : null,
    thinkingLevel: projection.thinkingLevel,
    revision: record.digest,
  };
}
export function createPiSessions(agentDir) {
  let rows = [],
    pending,
    scanned = 0,
    closed = false;
  const files = new Map(),
    cache = new Map();
  return {
    async scan(force = false) {
      if (closed) return rows;
      if (pending) return pending;
      if (!force && Date.now() - scanned < 5000) return rows;
      pending = (async () => {
        const { roots } = await sessionRoots(agentDir);
        const directories = [];
        for (const root of roots) {
          directories.push(root);
          try {
            directories.push(
              ...(await readdir(root, { withFileTypes: true }))
                .filter((entry) => entry.isDirectory())
                .map((entry) => join(root, entry.name)),
            );
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        // Pi's custom listAll(directory) lists one directory, unlike default
        // listAll(). Bound parallel native parsing across cwd directories.
        const found = [];
        let position = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, directories.length) }, async () => {
            while (position < directories.length) {
              const dir = directories[position++];
              found.push(...(await SessionManager.listAll(dir)));
            }
          }),
        );
        const next = [];
        for (const info of found) {
          if (!info.cwd || !info.messageCount) continue;
          const id = identity(info.path);
          next.push({
            id,
            cwd: info.cwd,
            name:
              info.name ||
              info.firstMessage?.replace(/\s+/g, " ").slice(0, 80) ||
              "Pi 会话",
            createdAt: info.created.toISOString(),
            updatedAt: info.modified.toISOString(),
            nativeSessionId: info.id,
            messageCount: info.messageCount,
          });
          files.set(id, info.path);
        }
        const alive = new Set(next.map((row) => row.id));
        for (const id of files.keys())
          if (!alive.has(id)) {
            files.delete(id);
            cache.delete(id);
          }
        rows = next;
        scanned = Date.now();
        return rows;
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    path(id) {
      const path = files.get(id);
      if (!path) throw new DeskError(404, "Pi 会话记录已不存在，请刷新列表");
      return path;
    },
    async record(id) {
      return readNativeRecord(this.path(id), agentDir);
    },
    async read(id) {
      return this.readPath(id, this.path(id));
    },
    async readPath(id, path) {
      const info = await stat(path);
      const signature = `${path}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      if (cache.get(id)?.signature === signature) return cache.get(id);
      const record = await readNativeRecord(path, agentDir);
      if (
        rows.some((row) => row.id === id) &&
        record.header.id !== rows.find((row) => row.id === id).nativeSessionId
      )
        throw new DeskError(409, "Pi 会话文件已替换，请刷新列表");
      if (cache.get(id)?.revision === record.digest) return cache.get(id);
      const value = { ...projectPiRecord(record, id), signature };
      cache.set(id, value);
      if (cache.size > 6) cache.delete(cache.keys().next().value);
      return value;
    },
    async close() {
      closed = true;
      await pending?.catch(() => {});
      cache.clear();
      files.clear();
    },
  };
}
export function reconcilePiSessions(data, sessions) {
  const alive = new Set();
  for (const session of sessions) {
    // Desktop's native JSONL and its Durable worker are one sidebar row.
    let agent =
      data.agents.find(
        (row) =>
          row.nativeSessionId === session.nativeSessionId ||
          (row.source !== "pi" && row.id === session.nativeSessionId),
      ) ?? data.agents.find((row) => row.id === session.id);
    if (agent && agent.source !== "pi") {
      alive.add(agent.id);
      continue;
    }
    let project = data.projects.find((row) => row.cwd === session.cwd);
    // A removed workspace remains a tombstone for native discovery. Only an
    // explicit add restores it; neither old nor newly written TUI JSONL does.
    if (project?.removedAt) {
      if (agent) alive.add(agent.id);
      continue;
    }
    if (!project) {
      project = {
        id: identity(`project:${session.cwd}`),
        cwd: session.cwd,
        name: basename(session.cwd),
        source: "pi",
      };
      data.projects.push(project);
    }
    if (!agent) {
      agent = {
        id: session.id,
        projectId: project.id,
        source: "pi",
        desired: false,
      };
      data.agents.push(agent);
    }
    alive.add(agent.id);
    if (agent.archived || agent.archivePending) continue;
    const { cwd, name, id, ...metadata } = session;
    Object.assign(agent, metadata, { projectId: project.id, missing: false });
    if (!agent.nameOverride) agent.name = name;
  }
  for (const agent of data.agents)
    if (
      agent.source === "pi" &&
      !agent.archived &&
      !agent.archivePending &&
      !alive.has(agent.id)
    )
      agent.missing = true;
}
