import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DeskError } from "../config/config-store.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");
export function personalityPath(directory, id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    throw new DeskError(422, "人格标识无效");
  return join(directory, "personalities", id, "AGENTS.md");
}
export async function readPersonality(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > 128 * 1024)
      throw new DeskError(422, "AGENTS.md 必须是小于 128 KiB 的普通文件");
    const bytes = await file.readFile();
    if (bytes.length > 128 * 1024)
      throw new DeskError(422, "AGENTS.md 内容过大");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { file: path, content, revision: digest(content), exists: true };
  } catch (error) {
    if (error.code === "ENOENT")
      return { file: path, content: "", revision: digest(""), exists: false };
    if (error.code === "ELOOP")
      throw new DeskError(422, "AGENTS.md 不支持符号链接");
    throw error;
  } finally {
    await file?.close();
  }
}
export async function writePersonality(path, input) {
  if (
    typeof input.content !== "string" ||
    Buffer.byteLength(input.content) > 128 * 1024 ||
    input.content.includes("\0")
  )
    throw new DeskError(422, "人格提示词必须是小于 128 KiB 的文本");
  if (typeof input.revision !== "string")
    throw new DeskError(422, "请先读取人格配置");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let lock;
  const temp = `${path}.${randomUUID()}.tmp`,
    lockPath = `${path}.pi-desk-lock`;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new DeskError(409, "人格配置正在保存，请稍后重试");
    throw error;
  }
  try {
    const before = await readPersonality(path);
    if (before.revision !== input.revision)
      throw new DeskError(409, "AGENTS.md 已在其他窗口修改，请重新读取");
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(input.content);
      await file.sync();
    } finally {
      await file.close();
    }
    if ((await readPersonality(path)).revision !== before.revision)
      throw new DeskError(409, "AGENTS.md 在保存前发生变化");
    await rename(temp, path);
    return readPersonality(path);
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await lock.close();
    await unlink(lockPath);
  }
}
