import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DeskError, readDocument } from "../config/config-store.mjs";
import { discoverPluginConfig } from "./plugin-config.mjs";
import { npmPackageName } from "./package-catalog.mjs";
import { installedPackageVersion } from "./native-packages.mjs";

// Inventory identity, trust, selected workspace, readiness, update hints and
// mutual exclusion are one lifecycle; HTTP callers only request an operation.
export function createPackageManagement(options) {
  const settingsPath = join(options.agentDir, "settings.json");
  const capabilities = options.capabilities ?? {};
  const rootForPackage = capabilities.packageRoot
    ? options.packageRoot
    : undefined;
  let updateHints,
    busy = false;
  const editable = () => {
    if (!options.writable())
      throw new DeskError(409, "有会话运行中，请在任务完成后修改共享配置");
  };
  const packageTarget = () => {
    const snapshot = options.snapshot();
    return { sessionId: snapshot.sessionId, cwd: snapshot.cwd };
  };
  function checkPackageTarget(target, input = {}, requireReady = true) {
    const current = options.snapshot();
    if (
      current.sessionId !== target.sessionId ||
      current.cwd !== target.cwd ||
      (input.sessionId !== undefined && input.sessionId !== target.sessionId)
    )
      throw new DeskError(409, "当前会话或工作区已变化，请刷新插件列表");
    if (requireReady && (current.initializing || current.replacing))
      throw new DeskError(409, "宿主尚在初始化／交接，请稍后管理插件");
  }
  function applyUpdateHints(inventory) {
    const hints =
      updateHints?.key === inventory.inventoryKey ? updateHints : null;
    return {
      ...inventory,
      updatesCheckedAt: hints?.checkedAt ?? null,
      rows: inventory.rows.map((row) => ({
        ...row,
        updateAvailable:
          row.type === "package" && hints
            ? hints.rows.some(
                (item) =>
                  item.source === row.source && item.scope === row.scope,
              )
            : null,
      })),
    };
  }

  async function plugins() {
    const target = packageTarget();
    const global = await readDocument(settingsPath),
      cwd = target.cwd;
    const documents = [
      {
        scope: "global",
        document: global,
        directory: join(options.agentDir, "extensions"),
      },
    ];
    if (cwd)
      documents.push({
        scope: "project",
        document: await readDocument(join(cwd, ".pi", "settings.json")),
        directory: join(cwd, ".pi", "extensions"),
      });
    const rows = [];
    for (const { scope, document, directory } of documents) {
      for (const [index, item] of (document.data.packages ?? []).entries()) {
        const source = typeof item === "string" ? item : item.source;
        rows.push({
          id:
            scope === "global"
              ? `package:${index}`
              : `package:project:${index}`,
          name: source,
          source,
          scope,
          revision: document.revision,
          type: "package",
          packageName: source?.startsWith("npm:")
            ? npmPackageName(source)
            : null,
          enabled: typeof item === "string" || item.extensions?.length !== 0,
          description: `pi package · ${scope === "project" ? "项目" : "用户"}资源`,
          adapted: false,
        });
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        entries = [];
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const path = join(directory, entry.name);
        let extensionPath = path;
        if (entry.isDirectory()) {
          try {
            await stat(join(path, "index.ts"));
            extensionPath = join(path, "index.ts");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            try {
              await stat(join(path, "index.js"));
              extensionPath = join(path, "index.js");
            } catch (nested) {
              if (nested.code !== "ENOENT") throw nested;
              continue;
            }
          }
        } else if (!/\.(ts|js)$/.test(entry.name)) continue;
        rows.push({
          id:
            scope === "global"
              ? `file:${entry.name}`
              : `file:project:${entry.name}`,
          name: entry.name.replace(/\.(ts|js)$/, ""),
          source: extensionPath,
          scope,
          revision: document.revision,
          type: "file",
          enabled: !(document.data.extensions ?? []).includes(
            `-${extensionPath}`,
          ),
          description: `${scope === "project" ? "项目" : "用户"}目录扩展`,
          adapted: false,
        });
      }
    }
    if (["headless", "durable"].includes(options.snapshot().host))
      for (const name of ["mcp", "codemode", "tool-search"]) {
        const marker = `-builtin:${name}`,
          project =
            documents.find((item) => item.scope === "project")?.document.data
              .extensions ?? [],
          user = global.data.extensions ?? [];
        const last = [...user, ...project]
          .filter((value) => value === marker || value === `+builtin:${name}`)
          .at(-1);
        rows.push({
          id: `builtin:${name}`,
          name,
          source: `builtin:${name}`,
          scope: "global",
          revision: global.revision,
          type: "builtin",
          enabled: last !== marker,
          description: "pi 内置扩展 · 通过资源过滤管理",
          adapted: false,
        });
      }
    for (const row of rows)
      if (row.type !== "builtin") {
        checkPackageTarget(target, {}, false);
        const state = options.snapshot();
        const ready = !state.initializing && !state.replacing;
        const trusted =
          row.scope !== "project" ||
          (ready && (capabilities.projectTrusted ? options.trusted() : true));
        const root =
          ready && trusted
            ? rootForPackage?.(row.source, row.scope)
            : undefined;
        if (row.type === "package")
          Object.assign(row, await installedPackageVersion(root));
        const adapter = trusted
          ? await discoverPluginConfig(row, options.agentDir, root)
          : null;
        row.adapted = !!adapter;
      }
    checkPackageTarget(target, {}, false);
    const inventoryKey = createHash("sha256")
      .update(
        JSON.stringify({
          cwd,
          documents: documents.map(({ scope, document }) => [
            scope,
            document.revision,
          ]),
          versions: rows.map((row) => [
            row.scope,
            row.source,
            row.installedVersion,
            row.versionError,
          ]),
        }),
      )
      .digest("hex");
    return applyUpdateHints({
      revision: global.revision,
      inventoryKey,
      rows: rows.map((row) => ({
        ...row,
        pending: options.hasChanged(row.id),
      })),
      updatesSupported: capabilities.packageUpdates === true,
      writable: options.writable() === true,
      pending: options.pending(),
    });
  }
  async function check(input) {
    editable();
    if (!input.sessionId) throw new DeskError(422, "请指定当前会话再检查更新");
    const target = packageTarget(),
      runner = capabilities.packageUpdates ? options.packageUpdates : undefined;
    checkPackageTarget(target, input);
    if (!runner)
      throw new DeskError(
        501,
        "宿主未提供原生包更新检查，请等任务结束后授权更新宿主",
      );
    const before = await plugins();
    checkPackageTarget(target, input);
    editable();
    const result = await runner();
    checkPackageTarget(target, input);
    if (!result.supported)
      throw new DeskError(501, "此 Pi 版本未提供原生更新检查");
    const after = await plugins();
    if (before.inventoryKey !== after.inventoryKey)
      throw new DeskError(409, "插件配置或已安装版本已变化，请重新检查");
    updateHints = {
      key: after.inventoryKey,
      rows: result.rows,
      checkedAt: Date.now(),
    };
    return applyUpdateHints(after);
  }
  async function write(input) {
    editable();
    const target = packageTarget(),
      runner = capabilities.packageAction ? options.packageAction : undefined;
    checkPackageTarget(target, input);
    if (!runner)
      throw new DeskError(
        501,
        "宿主未提供原生包管理，请等任务结束后授权更新宿主",
      );
    if (
      !["install", "remove", "update"].includes(input.action) ||
      !["global", "project"].includes(input.scope)
    )
      throw new DeskError(422, "插件操作无效");
    if (
      typeof input.source !== "string" ||
      !input.source ||
      input.source.length > 1024 ||
      /[\0\r\n]/.test(input.source)
    )
      throw new DeskError(422, "插件来源无效");
    if (
      input.scope === "project" &&
      !(capabilities.projectTrusted && options.trusted())
    )
      throw new DeskError(403, "请先信任项目再管理项目插件");
    const document = await readDocument(
      input.scope === "global"
        ? settingsPath
        : join(target.cwd, ".pi", "settings.json"),
    );
    if (input.revision !== undefined && input.revision !== document.revision)
      throw new DeskError(409, "插件列表已变化，请刷新后确认");
    if (input.action !== "install") {
      const sources = (document.data.packages ?? []).map((item) =>
        typeof item === "string" ? item : item.source,
      );
      let configured = sources.includes(input.source);
      // Older callers can pass an absolute local source that Pi persists
      // relative to settings. Delegate identity to Pi's public resolver.
      if (!configured && input.revision === undefined) {
        const installed = rootForPackage?.(input.source, input.scope);
        configured =
          !!installed &&
          sources.some(
            (source) => rootForPackage?.(source, input.scope) === installed,
          );
      }
      if (!configured)
        throw new DeskError(409, "插件来源或配置范围已变化，请刷新列表");
    } else if (
      !(
        /^(?:\.\.?\/|~\/|\/)/.test(input.source) ||
        /^(npm:(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:@[^\s]+)?|git:https:\/\/[^\s]+)$/.test(
          input.source,
        )
      )
    )
      throw new DeskError(
        422,
        "请使用 npm:包名、git:https://仓库地址或本地路径",
      );
    if (
      input.inventoryKey !== undefined &&
      input.inventoryKey !== (await plugins()).inventoryKey
    )
      throw new DeskError(409, "插件配置或已安装版本已变化，请刷新后确认");
    checkPackageTarget(target, input);
    editable();
    await runner({
      ...input,
      sessionId: target.sessionId,
      cwd: target.cwd,
    });
    updateHints = undefined;
    options.onWrite();
    return { ok: true };
  }
  async function execute(action, input) {
    if (busy) throw new DeskError(409, "原生包检查或写入正在运行，请稍后重试");
    busy = true;
    try {
      if (action === "check") return await check(input);
      return await write({ ...input, action });
    } finally {
      busy = false;
    }
  }
  return Object.freeze({ read: plugins, execute });
}
