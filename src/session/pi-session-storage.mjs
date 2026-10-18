import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  chmod,
  readdir,
  readlink,
  realpath,
  link,
  unlink,
} from "node:fs/promises";
import { join, dirname, relative, isAbsolute, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { DatabaseSync } from "node:sqlite";
import { embeddedSdkEntry, loadPiSessionManager } from "../agent/pi-sdk.mjs";

/* The transcript and archive paths only need the session-manager submodule.
 * Capture it once so the synchronous archive readers keep their contract. */
let sessionSdk;
const sessionModule = async () => (sessionSdk ??= await loadPiSessionManager());
import { DeskError } from "../config/config-store.mjs";

const { getDefaultSessionDir } = await import(
  new URL("./core/session-manager.js", embeddedSdkEntry)
);
export const sessionDigest = (text) =>
  createHash("sha256").update(text).digest("hex");
export async function sessionRoots(agentDir) {
  // Pi 1.0 uses sessions/. Also discover older/custom installations using session/.
  const standard = join(agentDir, "sessions"),
    legacy = join(agentDir, "session");
  const exists = async (path) => {
    try {
      return !!(await realpath(path));
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  };
  const [a, b] = await Promise.all([exists(standard), exists(legacy)]);
  return {
    primary: b && !a ? legacy : standard,
    roots: b ? [standard, legacy] : [standard],
  };
}
export async function nativeSessionDirectory(cwd, agentDir) {
  const { primary } = await sessionRoots(agentDir);
  const standard = getDefaultSessionDir(cwd, agentDir);
  // Reuse Pi's cwd encoding even when an existing installation uses session/.
  const result = primary.endsWith("/session")
    ? join(primary, relative(join(agentDir, "sessions"), standard))
    : standard;
  await mkdir(result, { recursive: true, mode: 0o700 });
  return result;
}
export async function readNativeRecord(path, agentDir) {
  const sdk = await sessionModule();
  const { roots } = await sessionRoots(agentDir);
  const resolved = await realpath(path);
  const inside = await Promise.all(
    roots.map(async (root) => {
      try {
        const part = relative(await realpath(root), resolved);
        return (
          part && !isAbsolute(part) && part !== ".." && !part.startsWith("..")
        );
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }),
  );
  if (!inside.some(Boolean))
    throw new DeskError(403, "会话记录不在 Pi 会话目录中");
  const file = await open(resolved, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 64 * 1024 * 1024)
      throw new DeskError(413, "会话记录超过 64 MiB，暂不能打开");
    const raw = await file.readFile("utf8"),
      after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new DeskError(409, "Pi 正在写入会话，请稍后重试");
    const entries = sdk.parseSessionEntries(raw),
      header = entries.find((row) => row.type === "session");
    if (!header?.id || !header.cwd)
      throw new DeskError(422, "Pi 会话记录格式无效");
    return { path: resolved, raw, entries, header, digest: sessionDigest(raw) };
  } finally {
    await file.close();
  }
}
// This detects native CLI owners on the supported Linux desktop. It deliberately
// blocks any Pi CLI in this cwd: the TUI offers no cross-process writer lock.
export async function assertNoNativeTui(
  cwd,
  { sessionPath, sessionId, action = "继续" } = {},
) {
  if (process.platform !== "linux")
    throw new DeskError(
      409,
      "当前系统无法确认 Pi TUI 已退出，请先在 TUI 中结束会话；暂只支持 Linux 会话迁移",
    );
  const target = await realpath(cwd).catch((error) => {
    if (error.code === "ENOENT") return resolve(cwd);
    throw error;
  });
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    let native = false;
    try {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (
        !/(?:^|\0)(?:[^\0]*\/)?pi(?:\0|$)|pi-coding-agent\/dist\/cli\.(?:js|mjs)/.test(
          command,
        )
      )
        continue;
      native = true;
      const processCwd = await readlink(`/proc/${pid}/cwd`),
        args = command.split("\0");
      const flag = args.findIndex(
        (arg) => arg === "--session" || arg.startsWith("--session="),
      );
      const explicit =
        flag < 0
          ? undefined
          : args[flag].startsWith("--session=")
            ? args[flag].slice(10)
            : args[flag + 1];
      const ownsFile =
        explicit &&
        ((sessionId && sessionId.startsWith(explicit)) ||
          (sessionPath && resolve(processCwd, explicit) === sessionPath));
      if (processCwd === target || ownsFile)
        throw new DeskError(
          409,
          `该会话或项目仍有 Pi TUI 运行，请退出 TUI 后再${action}`,
        );
    } catch (error) {
      if (error instanceof DeskError) throw error;
      if (native && ["EACCES", "EPERM"].includes(error.code))
        throw new DeskError(409, "无法确认 Pi TUI 已退出，未迁移会话");
      if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code))
        throw error;
    }
  }
}

// Durable remains the task journal. Pi SessionManager produces the native
// transcript; an atomic replacement commits messages and their replay checkpoint
// together, so a crash cannot duplicate a tool result on the next export.
export async function openNativeTranscript({
  agentDir,
  directory,
  cwd,
  owner,
  resumePath,
  pathHint,
  workspace,
  id,
}) {
  const sdk = await sessionModule();
  const metadataPath = join(directory, "native-session.json");
  let failure;
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let record;
  const path = metadata?.path ?? resumePath ?? pathHint;
  if (path) {
    try {
      record = await readNativeRecord(path, agentDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (
    record &&
    metadata &&
    record.digest !== metadata.digest &&
    record.entries.at(-1)?.data?.owner !== owner
  )
    throw new DeskError(
      409,
      "此 JSONL 已被 Pi TUI 修改，请通过“在 Desktop 中继续”重新接管最新记录",
    );
  let manager;
  if (record)
    manager = sdk.SessionManager.inMemory(cwd, undefined, record.entries);
  else {
    const created = sdk.SessionManager.create(
      cwd,
      await nativeSessionDirectory(cwd, agentDir),
      { id: owner.split(":")[0] },
    );
    manager = sdk.SessionManager.inMemory(cwd, undefined, [
      created.getHeader(),
    ]);
    metadata = { path: created.getSessionFile() };
  }
  metadata ??= { path: record.path };
  metadata.nativeSessionId = manager.getSessionId();
  const release = await lockfile
    .lock(metadata.path, {
      realpath: false,
      stale: 10000,
      update: 2000,
      onCompromised: () => {
        failure = new DeskError(409, "Pi 会话写锁已失效");
      },
    })
    .catch((error) => {
      if (error.code === "ELOCKED")
        throw new DeskError(409, "此 Pi 会话已被另一个 Desktop 进程接管");
      throw error;
    });
  try {
    const marks = manager
      .getEntries()
      .filter(
        (row) =>
          row.type === "custom" &&
          row.customType === "pi-desktop-sync" &&
          row.data?.owner === owner &&
          row.data.conversation === id,
      );
    let through = 0;
    const mapping = new Map();
    for (const mark of marks) {
      through = Math.max(through, mark.data.through ?? 0);
      for (const [key, value] of mark.data.mapping ?? [])
        mapping.set(Number(key), value);
    }
    // Older exports incorrectly trusted a newest-first page's first ID as the
    // watermark. Rebuild owned transcripts from the intact Durable journal.
    const rebuilding = !!(
      record &&
      !resumePath &&
      marks.length &&
      marks.at(-1).data.version !== 2
    );
    if (rebuilding) {
      manager = sdk.SessionManager.inMemory(cwd, undefined, [record.header]);
      mapping.clear();
      through = 0;
    }
    if (record && !marks.length) {
      const projected = manager.buildSessionProjection();
      const active = await workspace.agent(id);
      await workspace.execute("configure", {
        id,
        revision: active.revision,
        ...(projected.model ? { model: projected.model } : {}),
        thinkingLevel: projected.thinkingLevel,
      });
      const imported = await workspace.importNative(id, record.entries);
      through = imported.through;
      for (const pair of imported.mapping) mapping.set(...pair);
      manager.appendCustomEntry("pi-desktop-sync", {
        owner,
        version: 2,
        conversation: id,
        through,
        mapping: [...mapping],
      });
    }
    let expected = record?.digest,
      queue = Promise.resolve();
    async function save() {
      if (resumePath) await assertNoNativeTui(cwd);
      if (expected !== undefined) {
        const current = await readNativeRecord(metadata.path, agentDir);
        if (current.digest !== expected)
          throw new DeskError(
            409,
            "Pi TUI 已修改此会话，Desktop 已停止写入，请重新接管最新记录",
          );
      }
      manager.appendCustomEntry("pi-desktop-sync", {
        owner,
        version: 2,
        conversation: id,
        through,
        mapping: [],
      });
      const raw =
        [manager.getHeader(), ...manager.getEntries()]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n";
      if (Buffer.byteLength(raw) > 64 * 1024 * 1024)
        throw new DeskError(
          413,
          "会话记录超过 64 MiB，请保留 SQLite 并在 Pi 中整理历史",
        );
      const temp = join(
        dirname(metadata.path),
        `.pi-desktop-${randomUUID()}.tmp`,
      );
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, metadata.path);
      expected = sessionDigest(raw);
      metadata = {
        path: metadata.path,
        nativeSessionId: manager.getSessionId(),
        digest: expected,
      };
      const metaTemp = metadataPath + ".tmp";
      const meta = await open(metaTemp, "w", 0o600);
      try {
        await meta.writeFile(JSON.stringify(metadata));
        await meta.sync();
      } finally {
        await meta.close();
      }
      await rename(metaTemp, metadataPath);
    }
    let dirty = rebuilding || (record && !marks.length);
    async function synchronize() {
      if (failure) throw failure;
      const { active, entries } = await workspace.transcript(id);
      const config = JSON.stringify([
        active.name,
        active.model,
        active.thinkingLevel,
      ]);
      const lastConfig = manager
        .getEntries()
        .findLast((row) => row.customType === "pi-desktop-config")
        ?.data?.config;
      if (lastConfig !== config) {
        manager.appendSessionInfo(active.name);
        if (active.model)
          manager.appendModelChange(
            active.model.provider,
            active.model.modelId,
          );
        manager.appendThinkingLevelChange(active.thinkingLevel);
        manager.appendCustomEntry("pi-desktop-config", { config });
        dirty = true;
      }
      for (const entry of entries) {
        if (entry.id <= through) continue;
        if (entry.kind === "desk.native-context-upgrade") {
          // This repairs the Durable representation, not the native user's
          // context. Exporting it would add an artificial edit to Pi JSONL.
          through = entry.id;
          dirty = true;
          continue;
        }
        if (entry.kind === "desk.rewind") {
          // 退回：把原生 leaf 移回退回点，之后的条目成为它的子条目；原路径保留在文件里。
          // 标记自身的 model 就是该点之前的上下文（它们已在原生日志中），所以不重复导出；
          // 自定义条目对模型不可见，使 Pi 与 Durable 看到同一份上下文。
          const native = mapping.get(entry.data?.rewindTo);
          if (native !== undefined) {
            manager.branch(native);
            manager.appendCustomEntry("pi-desktop-rewind", {
              conversation: id,
              rewindTo: entry.data.rewindTo,
              native,
            });
          }
          through = entry.id;
          dirty = true;
          continue;
        }
        let first;
        if (entry.kind === "pi.reset") manager.resetLeaf();
        if (entry.kind === "pi.compaction") {
          const summary = (entry.model ?? [])
            .map((m) =>
              typeof m.content === "string"
                ? m.content
                : m.content
                    .filter((b) => b.type === "text")
                    .map((b) => b.text)
                    .join("\n"),
            )
            .join("\n");
          first = manager.appendCompaction(
            summary,
            mapping.get(entry.head) ?? null,
            0,
            { durable: entry.data },
          );
        } else {
          for (const message of entry.data?.nativeMessage?.role === "custom"
            ? [entry.data.nativeMessage]
            : (entry.model ?? [])) {
            if (message.role === "custom") {
              const native = manager.appendCustomMessageEntry(
                message.customType,
                message.content,
                message.display,
                message.details,
              );
              first ??= native;
              continue;
            }
            if (!["user", "assistant", "toolResult"].includes(message.role))
              continue;
            const native = manager.appendMessage(message);
            first ??= native;
          }
        }
        for (const edit of entry.edits ?? []) {
          const native = mapping.get(edit.target);
          if (native)
            manager.appendContextEdit(
              native,
              edit.action === "omit"
                ? null
                : {
                    content: edit.messages.flatMap((message) =>
                      typeof message.content === "string"
                        ? [{ type: "text", text: message.content }]
                        : message.content,
                    ),
                  },
            );
        }
        if (first) mapping.set(entry.id, first);
        through = entry.id;
        manager.appendCustomEntry("pi-desktop-sync", {
          owner,
          version: 2,
          conversation: id,
          through,
          mapping: first ? [[entry.id, first]] : [],
        });
        dirty = true;
      }
      const custom = manager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" &&
            !entry.customType.startsWith("pi-desktop-"),
        )
        .map((entry) => ({
          customType: entry.customType,
          ...(entry.data === undefined ? {} : { data: entry.data }),
        }));
      const resourceEntries = active.resourceState?.entries ?? [];
      if (
        resourceEntries.length >= custom.length &&
        custom.every(
          (entry, index) =>
            JSON.stringify(entry) === JSON.stringify(resourceEntries[index]),
        )
      ) {
        for (const entry of resourceEntries.slice(custom.length)) {
          manager.appendCustomEntry(entry.customType, entry.data);
          dirty = true;
        }
      }
      // Setup-only sessions follow Pi's own rule: no JSONL until the first message.
      if (
        dirty &&
        manager.getEntries().some((entry) => entry.type === "message")
      ) {
        await save();
        dirty = false;
      }
      return metadata;
    }
    const sync = () => {
      const next = queue.then(synchronize);
      queue = next.catch((error) => {
        failure = error;
      });
      return next;
    };
    await sync();
    return {
      sync,
      /* 退回点之前的模型上下文，用 Pi 自己的推导（含压缩与编辑），供 Host 写入 Durable
       * 头部标记；该条目尚未写入原生日志时返回 undefined。 */
      rewindMessages(entryId) {
        const native = mapping.get(entryId);
        if (native === undefined || !manager.getEntry(native)) return undefined;
        const entries = manager.getEntries();
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        return sdk.buildSessionContext(entries, native, byId).messages;
      },
      /* 原生会话树的只读投影：只描述结构与位置（父子、活跃路径、leaf、分支点、退回标记），
       * 不携带模型语义；界面靠它画分支树，退回/分叉仍走 Host 命令。 */
      tree() {
        const entries = manager.getEntries();
        const leafId = manager.getLeafId();
        const active = new Set(manager.getBranch().map((entry) => entry.id));
        // Durable 条目 id 与原生条目 id 的对应关系：界面在节点上发起退回／分叉时需要 Durable id。
        const durableId = new Map(
          [...mapping].map(([key, value]) => [value, key]),
        );
        const childCount = new Map();
        for (const entry of entries)
          if (entry.parentId)
            childCount.set(
              entry.parentId,
              (childCount.get(entry.parentId) ?? 0) + 1,
            );
        /* 节点的可读提示：消息取首段文本，其余为 null。只在投影里做一次，界面不再解析内容。 */
        const preview = (entry, limit = 80) => {
          const content = entry.message?.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .map((part) => part.text ?? "")
                    .join("")
                    .trim()
                : "";
          return text ? text.slice(0, limit) : null;
        };
        return {
          leafId: leafId ?? null,
          nodes: entries.map((entry) => ({
            id: entry.id,
            parentId: entry.parentId ?? null,
            type: entry.type,
            role: entry.message?.role ?? null,
            customType: entry.customType ?? null,
            label: manager.getLabel(entry.id) ?? null,
            preview: preview(entry),
            rewindTo: entry.data?.rewindTo ?? null,
            entryId: durableId.get(entry.id) ?? null,
            active: active.has(entry.id),
            leaf: entry.id === leafId,
            branchPoint: (childCount.get(entry.id) ?? 0) > 1,
            children: childCount.get(entry.id) ?? 0,
          })),
        };
      },
      async check() {
        if (failure) throw failure;
        if (resumePath) await assertNoNativeTui(cwd);
        if (
          expected !== undefined &&
          (await readNativeRecord(metadata.path, agentDir)).digest !== expected
        )
          throw new DeskError(409, "原会话已被 Pi TUI 修改，请重新接管");
      },
      get metadata() {
        return metadata;
      },
      async close() {
        try {
          await sync();
        } finally {
          await release();
        }
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}

// SQLite owns the complete record before a native file is moved. Phase markers
// recover the filesystem/catalog gap after a crash; staging files never end in
// .jsonl, so Pi cannot discover a half-finished move or restoration.
export async function openSessionArchives(directory, agentDir) {
  await sessionModule();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const databasePath = join(directory, "session-archives.sqlite"),
    db = new DatabaseSync(databasePath);
  await chmod(databasePath, 0o600);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, path TEXT NOT NULL, raw TEXT NOT NULL, digest TEXT NOT NULL, archived_at TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS session_archive_versions (id TEXT NOT NULL,digest TEXT NOT NULL,raw TEXT NOT NULL,path TEXT NOT NULL,archived_at TEXT NOT NULL,PRIMARY KEY(id,digest))",
  );
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((row) => row.name),
  );
  if (!columns.has("phase"))
    db.exec(
      "ALTER TABLE sessions ADD COLUMN phase TEXT NOT NULL DEFAULT 'snapshot'",
    );
  const setPhase = (id, phase) =>
    db.prepare("UPDATE sessions SET phase=? WHERE id=?").run(phase, id);
  const rowFor = (id) =>
    db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
  const stagePath = (record, id, kind) =>
    join(
      dirname(record.path),
      `.pi-desktop-${kind}-${sessionDigest(id)}.pending`,
    );
  const maybeRecord = async (path) =>
    readNativeRecord(path, agentDir).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  async function lease(path, run) {
    let compromised = false;
    const release = await lockfile
      .lock(path, {
        realpath: false,
        stale: 10000,
        update: 2000,
        onCompromised: () => {
          compromised = true;
        },
      })
      .catch((error) => {
        if (error.code === "ELOCKED")
          throw new DeskError(409, "该会话仍被 Desktop 进程占用，请先停止进程");
        throw error;
      });
    const check = () => {
      if (compromised) throw new DeskError(409, "会话迁移写锁已失效");
    };
    try {
      return await run(check);
    } finally {
      await release();
    }
  }
  async function syncDirectory(path) {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  async function prepareParent(path) {
    const { roots } = await sessionRoots(agentDir);
    const allowed = (
      await Promise.all(
        roots.map(async (root) => [
          resolve(root),
          await realpath(root).catch((error) => {
            if (error.code === "ENOENT") return resolve(root);
            throw error;
          }),
        ]),
      )
    ).flat();
    if (
      !allowed.some((root) => {
        const part = relative(root, path);
        return (
          part && !isAbsolute(part) && part !== ".." && !part.startsWith("..")
        );
      })
    )
      throw new DeskError(403, "归档路径不属于 Pi 会话目录");
    let ancestor = dirname(path);
    while (true) {
      try {
        if ((await realpath(ancestor)) !== ancestor)
          throw new DeskError(403, "原会话目录已被符号链接替换");
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }
  function decode(id) {
    const sdk = sessionSdk;
    if (!sdk) throw new DeskError(409, "会话归档尚未就绪，请稍后重试");
    const row = rowFor(id);
    if (!row) throw new DeskError(404, "未找到归档记录");
    if (sessionDigest(row.raw) !== row.digest)
      throw new DeskError(409, "归档记录校验失败");
    const entries = sdk.parseSessionEntries(row.raw),
      header = entries.find((entry) => entry.type === "session");
    if (!header?.id || !header.cwd)
      throw new DeskError(422, "归档会话格式无效");
    return {
      raw: row.raw,
      path: row.path,
      entries,
      header,
      digest: row.digest,
      phase: row.phase,
    };
  }
  async function noWriter(record, action) {
    await assertNoNativeTui(record.header.cwd, {
      sessionPath: record.path,
      sessionId: record.header.id,
      action,
    });
  }
  async function finishArchive(id, record, check) {
    const sdk = await sessionModule();
    const stage = stagePath(record, id, "archive");
    await noWriter(record, "归档");
    check();
    const original = await maybeRecord(record.path),
      parked = await maybeRecord(stage);
    if (original && original.digest !== record.digest) {
      if (!parked) setPhase(id, "snapshot");
      throw new DeskError(409, "JSONL 已发生变化，未移除源记录，请重新归档");
    }
    if (parked && parked.digest !== record.digest)
      throw new DeskError(409, "迁移暂存记录已发生变化，记录仍已保留");
    if (original && parked)
      throw new DeskError(
        409,
        "原路径和归档暂存路径同时有记录，未覆盖任何文件",
      );
    if (original) await rename(record.path, stage);
    const moved = await maybeRecord(stage);
    if (moved) {
      try {
        if (moved.digest !== record.digest)
          throw new DeskError(409, "JSONL 在迁移时发生变化，未删除记录");
        await noWriter(record, "归档");
        check();
        if (await maybeRecord(record.path))
          throw new DeskError(409, "原路径已被重新写入，未删除任何会话记录");
      } catch (error) {
        // Exclusive link restores the exact moved inode without replacing a
        // newly created native file. If it cannot roll back, keep staging+SQLite.
        try {
          await link(stage, record.path);
          await unlink(stage);
          await syncDirectory(record.path);
          setPhase(id, "snapshot");
        } catch {
          /* Both copies remain recoverable. */
        }
        throw error;
      }
      await unlink(stage);
      await syncDirectory(record.path);
    }
    check();
    setPhase(id, "archived");
    return record;
  }
  return {
    states() {
      return db.prepare("SELECT id,phase FROM sessions").all();
    },
    state(id) {
      return rowFor(id)?.phase;
    },
    read: decode,
    async archive(id, path, cwd, nativeId) {
      const sdk = await sessionModule();
      const previous = rowFor(id);
      if (previous?.phase === "archived") return decode(id);
      if (previous?.phase === "archiving") return this.completeArchive(id);
      if (previous?.phase === "restoring")
        throw new DeskError(409, "会话正在恢复，请稍后重试归档");
      let record = await maybeRecord(path);
      if (!record) {
        if (!cwd || !nativeId) throw new DeskError(404, "Pi 会话记录已不存在");
        const manager = sdk.SessionManager.inMemory(cwd, { id: nativeId }),
          entries = [manager.getHeader()],
          raw = JSON.stringify(entries[0]) + "\n";
        record = {
          path,
          entries,
          header: entries[0],
          raw,
          digest: sessionDigest(raw),
        };
      }
      if (nativeId && record.header.id !== nativeId)
        throw new DeskError(409, "原路径中的 Pi 会话 ID 已变化，未归档");
      await prepareParent(record.path);
      return lease(record.path, async (check) => {
        await noWriter(record, "归档");
        check();
        db.prepare(
          "INSERT OR IGNORE INTO session_archive_versions SELECT id,digest,raw,path,archived_at FROM sessions WHERE id=?",
        ).run(id);
        db.prepare(
          "INSERT INTO sessions (id,path,raw,digest,archived_at,phase) VALUES (?,?,?,?,?,'archiving') ON CONFLICT(id) DO UPDATE SET path=excluded.path,raw=excluded.raw,digest=excluded.digest,archived_at=excluded.archived_at,phase=excluded.phase",
        ).run(
          id,
          record.path,
          record.raw,
          record.digest,
          new Date().toISOString(),
        );
        return finishArchive(id, record, check);
      });
    },
    async completeArchive(id) {
      const record = decode(id);
      await prepareParent(record.path);
      return lease(record.path, (check) => finishArchive(id, record, check));
    },
    async restore(id) {
      const record = decode(id);
      await prepareParent(record.path);
      return lease(record.path, async (check) => {
        await noWriter(record, "恢复");
        check();
        const existing = await maybeRecord(record.path);
        if (
          existing &&
          (existing.header.id !== record.header.id ||
            existing.digest !== record.digest)
        )
          throw new DeskError(
            409,
            "原路径已有不同记录，归档保留在 SQLite 中，未覆盖源文件",
          );
        const parked = stagePath(record, id, "archive");
        if (await maybeRecord(parked))
          throw new DeskError(409, "归档迁移尚未完成，请先重试归档");
        const stage = stagePath(record, id, "restore");
        if (!existing) {
          setPhase(id, "restoring");
          const file = await open(
            stage,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_TRUNC |
              constants.O_NOFOLLOW,
            0o600,
          );
          try {
            await file.chmod(0o600);
            await file.writeFile(record.raw);
            await file.sync();
          } finally {
            await file.close();
          }
          await noWriter(record, "恢复");
          check();
          if (
            (await readNativeRecord(stage, agentDir)).digest !== record.digest
          )
            throw new DeskError(409, "恢复暂存记录发生变化，未发布会话");
          // Publishing is exclusive and atomic; Pi never sees a partial JSONL.
          try {
            await link(stage, record.path);
          } catch (error) {
            if (error.code === "EEXIST")
              throw new DeskError(409, "原路径已被其他进程写入，未覆盖记录");
            throw error;
          }
          await syncDirectory(record.path);
        }
        await unlink(stage).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        check();
        setPhase(id, "restored");
        return record;
      });
    },
    close() {
      db.close();
    },
  };
}
