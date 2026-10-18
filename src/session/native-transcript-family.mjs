import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { DeskError } from "../config/config-store.mjs";
import { openNativeTranscript } from "./pi-session-storage.mjs";

/**
 * 原生转录族：同一 worker 的根会话与历史分支各有转录，仍由一个 Durable writer 导出。
 *
 * 接口：`openNativeTranscriptFamily(options)` 提供 `sync(agents?)`／`get(id)`／
 *   `check()`／`close()` 与根 `metadata`；`readNativeTranscriptFamily(directory)`
 *   读取给 Host 的原生文件归属清单。见 docs/architecture/interfaces/session-tree.md。
 * 不变量：只沿根会话的历史 `parent` 绑定分支，不绑定 owned 工具子会话；首次根转录
 *   保留原路径，分支独立标识在重启后稳定；清单由同一个 writer 原子发布。
 * 错误：转录的锁／摘要冲突原样抛出；清单格式错误或关闭后同步为 DeskError(409)。
 */

const FAMILY_FILE = "native-sessions.json";
const FAMILY_VERSION = 1;

/** @returns {Promise<{ version: number, root: number, members: { id: number, path: string, nativeSessionId: string }[] } | null>} */
export async function readNativeTranscriptFamily(directory) {
  let value;
  try {
    value = JSON.parse(await readFile(join(directory, FAMILY_FILE), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (!(error instanceof SyntaxError)) throw error;
    throw new DeskError(409, "会话族元数据无效");
  }
  const members = value?.members;
  if (
    value?.version !== FAMILY_VERSION ||
    !Number.isSafeInteger(value.root) ||
    !Array.isArray(members) ||
    members.filter((row) => row?.id === value.root).length !== 1 ||
    members.some(
      (row) =>
        !Number.isSafeInteger(row?.id) ||
        row.id < 0 ||
        typeof row.path !== "string" ||
        !isAbsolute(row.path) ||
        row.path.includes("\0") ||
        typeof row.nativeSessionId !== "string" ||
        !row.nativeSessionId ||
        row.nativeSessionId.includes("\0"),
    ) ||
    new Set(members.map((row) => row.id)).size !== members.length ||
    new Set(members.map((row) => row.path)).size !== members.length ||
    new Set(members.map((row) => row.nativeSessionId)).size !== members.length
  )
    throw new DeskError(409, "会话族元数据无效");
  return value;
}

export function nativeBranchIdentity(owner, id) {
  // 标识只由持久身份派生；若每次启动重新分配，Pi 发现器会把同一分支当作新会话。
  const hash = createHash("sha256")
    .update(`pi-desktop-branch:${owner}:${id}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

export async function openNativeTranscriptFamily({
  workspace,
  agentDir,
  directory,
  owner,
  agents,
  branches = false,
  resumePath,
  pathHint,
}) {
  const root = agents[0].id;
  const handles = new Map();
  let records = agents;
  let queue = Promise.resolve();
  let closing = false;
  let closed;
  let published = "";
  const manifest = () => ({
    version: FAMILY_VERSION,
    root,
    members: [...handles].map(([id, handle]) => ({
      id,
      path: handle.metadata.path,
      nativeSessionId: handle.metadata.nativeSessionId,
    })),
  });
  const serial = (run) => {
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  };
  async function synchronize() {
    const family = new Set([root]);
    if (branches) {
      let size;
      do {
        size = family.size;
        for (const record of records)
          if (family.has(record.parent?.conversationId)) family.add(record.id);
      } while (size !== family.size);
    }
    for (const record of records) {
      if (!family.has(record.id)) continue;
      if (!handles.has(record.id)) {
        const first = record.id === root;
        const location = first
          ? directory
          : join(directory, "branches", String(record.id));
        await mkdir(location, { recursive: true, mode: 0o700 });
        handles.set(
          record.id,
          await openNativeTranscript({
            workspace,
            id: record.id,
            agentDir,
            directory: location,
            cwd: record.cwd,
            owner: first ? owner : `${owner}:branch:${record.id}`,
            ...(first
              ? { resumePath, pathHint }
              : { nativeId: nativeBranchIdentity(owner, record.id) }),
            familyOwner: branches ? owner : undefined,
          }),
        );
      }
    }
    // 已绑定的分支可能比传入的列表更新；不能因并发请求携带旧列表而漏导出它。
    for (const handle of handles.values()) await handle.sync();
    const next = JSON.stringify(manifest());
    if (next === published) return;
    const temp = join(directory, `.native-sessions-${randomUUID()}.tmp`);
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(next);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, join(directory, FAMILY_FILE));
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    published = next;
  }
  const family = {
    sync(next) {
      if (closing) return Promise.reject(new DeskError(409, "会话族已关闭"));
      return serial(async () => {
        if (next) records = next;
        await synchronize();
      });
    },
    get(id) {
      return handles.get(Number(id));
    },
    get metadata() {
      return { ...handles.get(root)?.metadata, family: manifest() };
    },
    async check() {
      for (const handle of handles.values()) await handle.check();
    },
    close() {
      if (closed) return closed;
      closing = true;
      closed = serial(async () => {
        const results = await Promise.allSettled(
          [...handles.values()].map((handle) => handle.close()),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
      });
      return closed;
    },
  };
  try {
    await family.sync();
    return family;
  } catch (error) {
    try {
      await family.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "会话族初始化与清理失败");
    }
    throw error;
  }
}
