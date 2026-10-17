import { open, realpath, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, basename } from "node:path";
import { constants } from "node:fs";
import { DeskError } from "../config/config-store.mjs";

const inside = (root, path) => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
};
// Read-only project browsing; callers supply the already selected Agent root.
export async function readWorkspaceFile(cwd, input = "") {
  if (
    typeof input !== "string" ||
    input.length > 4096 ||
    input.includes("\0") ||
    isAbsolute(input)
  )
    throw new DeskError(422, "文件路径无效");
  const root = await realpath(cwd);
  const lexical = resolve(root, input);
  if (!inside(root, lexical)) throw new DeskError(403, "文件不在当前工作区内");
  let path;
  try {
    path = await realpath(lexical);
  } catch {
    throw new DeskError(404, "文件不存在或无法访问");
  }
  if (!inside(root, path)) throw new DeskError(403, "符号链接指向工作区之外");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (process.platform === "linux") {
      const opened = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!inside(root, opened)) throw new DeskError(403, "文件位置已变化");
    }
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      return {
        kind: "directory",
        path: input,
        name: basename(root),
        truncated: entries.length > 500,
        entries: entries
          .sort(
            (a, b) =>
              Number(b.isDirectory()) - Number(a.isDirectory()) ||
              a.name.localeCompare(b.name),
          )
          .slice(0, 500)
          .map((row) => ({
            name: row.name,
            directory: row.isDirectory(),
            link: row.isSymbolicLink(),
          })),
      };
    }
    if (!info.isFile()) throw new DeskError(422, "不支持预览此类文件");
    const type = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
    }[/\.[^.]+$/.exec(path.toLowerCase())?.[0]];
    const limit = type ? 2 * 1024 * 1024 : 512 * 1024;
    if (info.size > limit)
      return {
        kind: "unsupported",
        name: basename(path),
        path: input,
        size: info.size,
        message: `文件超过预览上限（${type ? "2 MiB" : "512 KiB"}）`,
      };
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new DeskError(413, "文件读取期间超过预览上限");
    const data = buffer.subarray(0, bytesRead);
    if (type)
      return {
        kind: "image",
        name: basename(path),
        path: input,
        size: bytesRead,
        url: `data:${type};base64,${data.toString("base64")}`,
      };
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (text.includes("\0")) throw new Error();
      return {
        kind: "text",
        name: basename(path),
        path: input,
        size: bytesRead,
        text,
      };
    } catch {
      return {
        kind: "unsupported",
        name: basename(path),
        path: input,
        size: bytesRead,
        message: "此文件不是可预览的 UTF-8 文本或图片",
      };
    }
  } finally {
    await handle.close();
  }
}
