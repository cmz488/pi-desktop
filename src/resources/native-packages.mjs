import { open } from "node:fs/promises";
import { join } from "node:path";
import { DeskError } from "../config/config-store.mjs";

const MAX_MANIFEST_BYTES = 512 * 1024;

export async function installedPackageVersion(root) {
  if (!root) return { installedVersion: null };
  let file;
  try {
    file = await open(join(root, "package.json"), "r");
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES)
      return {
        installedVersion: null,
        versionError: "包 manifest 过大或不是普通文件",
      };
    const bytes = Buffer.alloc(info.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await file.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > info.size)
      return {
        installedVersion: null,
        versionError: "包 manifest 在读取中变化，请刷新",
      };
    const manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(0, bytesRead))
        .replace(/^\uFEFF/, ""),
    );
    return {
      installedVersion:
        typeof manifest.version === "string" && manifest.version.length <= 128
          ? manifest.version
          : null,
    };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      return { installedVersion: null };
    return {
      installedVersion: null,
      versionError: "无法读取已安装版本，请检查原生包 manifest",
    };
  } finally {
    await file?.close();
  }
}

export async function checkNativePackageUpdates(manager) {
  if (typeof manager.checkForAvailableUpdates !== "function")
    return { supported: false, rows: [] };
  const rows = await manager.checkForAvailableUpdates();
  return {
    supported: true,
    rows: rows.map(({ source, scope, type }) => ({
      source,
      scope: scope === "user" ? "global" : scope,
      type,
    })),
  };
}

export async function runNativePackageAction(manager, settings, input) {
  const local = /^(?:[./~]|[A-Za-z]:[\\/])/.test(input.source ?? "");
  const source =
    local && input.action !== "install"
      ? manager.getInstalledPath(
          input.source,
          input.scope === "project" ? "project" : "user",
        )
      : input.source;
  if (input.action !== "update-all" && !source)
    throw new DeskError(422, "无法定位本地插件来源");
  if (input.action === "update-all") await manager.update();
  else if (input.action === "install")
    await manager.installAndPersist(input.source, {
      local: input.scope === "project",
    });
  else if (input.action === "remove")
    await manager.removeAndPersist(source, {
      local: input.scope === "project",
    });
  else if (input.action === "update") {
    // Native update(source) resolves an unscoped local argument against cwd,
    // while user package declarations are relative to agentDir. Resolve local
    // identity using the public scoped API before delegating the update.
    await manager.update(source);
  } else throw new DeskError(422, "原生包操作无效");
  await settings.flush();
  if (settings.drainErrors().length)
    throw new DeskError(
      500,
      "Pi 原生包配置保存失败；包动作可能已更改磁盘，请检查配置权限／格式后用原生方式处理，不会自动回滚或重载",
    );
}
