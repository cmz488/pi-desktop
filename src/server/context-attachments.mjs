import { mkdtemp, writeFile, rm, realpath, stat } from "node:fs/promises";
import { join, basename, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { DeskError } from "../config/config-store.mjs";
import { piSdk } from "../agent/pi-sdk.mjs";
import { getImageDimensions } from "@earendil-works/pi-tui";

export const attachmentLimits = Object.freeze({
  maxCount: 8,
  maxTotalBytes: 4 * 1024 * 1024,
  maxTextBytes: 512 * 1024,
  maxImagePixels: 32_000_000,
  imageMimeTypes: [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
  ],
});
export const ATTACHMENT_BODY_LIMIT = 6 * 1024 * 1024;
const unsupportedDocument =
  /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|pages|zip|7z|rar)$/i;
const imageExtension = /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff?)$/i;
const xmlName = (name) =>
  name
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Index local files without reading their contents or applying upload limits. */
export async function referenceFiles(paths) {
  if (!Array.isArray(paths) || paths.length > attachmentLimits.maxCount)
    throw new DeskError(422, "最多添加 8 个上下文文件");
  return Promise.all(
    paths.map(async (path) => {
      if (
        typeof path !== "string" ||
        path.length > 4096 ||
        !isAbsolute(path) ||
        /[\x00-\x1f]/.test(path)
      )
        throw new DeskError(422, "本地文件路径无效，请重新选择文件");
      try {
        const resolved = await realpath(path),
          info = await stat(resolved);
        if (!info.isFile())
          throw new DeskError(422, "请选择文件，而非文件夹或设备");
        return {
          kind: "reference",
          name: basename(resolved),
          path: resolved,
          size: info.size,
          modifiedAt: info.mtimeMs,
        };
      } catch (error) {
        if (error instanceof DeskError) throw error;
        throw new DeskError(422, "本地文件已移除或无法访问，请重新选择");
      }
    }),
  );
}

/** Uploads carry bytes; trusted local references carry only an index.
 * @param {unknown} input
 * @param {{modelInput?: readonly string[], blockImages?: boolean, autoResize?: boolean, allowReferences?: boolean}} settings
 */
export async function prepareAttachments(input = [], settings = {}) {
  if (!Array.isArray(input) || input.length > attachmentLimits.maxCount)
    throw new DeskError(422, "最多添加 8 个上下文附件");
  let total = 0;
  const files = await Promise.all(
    input.map(async (file) => {
      if (file?.kind === "reference") {
        if (!settings.allowReferences)
          throw new DeskError(403, "远程连接不能引用主机文件路径，请上传文件");
        if (file.data !== undefined)
          throw new DeskError(422, "本地引用不能同时包含上传内容");
        return (await referenceFiles([file.path]))[0];
      }
      if (
        !file ||
        typeof file.name !== "string" ||
        !file.name.trim() ||
        file.name.length > 200 ||
        /[\\/\x00-\x1f]/.test(file.name)
      )
        throw new DeskError(422, "附件名称无效");
      if (
        typeof file.data !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          file.data,
        )
      )
        throw new DeskError(422, `无法读取附件：${file.name}`);
      const bytes = Buffer.from(file.data, "base64");
      total += bytes.length;
      if (total > attachmentLimits.maxTotalBytes)
        throw new DeskError(413, "附件总大小不能超过 4 MiB");
      return {
        name: file.name,
        type: typeof file.type === "string" ? file.type : "",
        bytes,
      };
    }),
  );
  const text = [],
    names = [];
  /** @type {import("@earendil-works/pi-ai").ImageContent[]} */
  const images = [];
  if (!files.length) return { text: "", images, names };
  const directory = files.some((file) => file.kind !== "reference")
    ? await mkdtemp(join(tmpdir(), "pi-desk-context-"))
    : undefined;
  try {
    for (const [index, file] of files.entries()) {
      if (file.kind === "reference") {
        text.push(
          `<file name="${xmlName(file.name)}" path="${xmlName(file.path)}">本地文件引用，请使用文件读取工具按需读取。</file>`,
        );
        names.push(file.name);
        continue;
      }
      if (
        unsupportedDocument.test(file.name) ||
        file.bytes.subarray(0, 4).toString() === "%PDF" ||
        file.bytes.subarray(0, 2).toString() === "PK"
      )
        throw new DeskError(
          422,
          `Pi 当前不支持解析此附件格式：${file.name}；请先转为 UTF-8 文本或受支持的图片`,
        );
      const path = join(directory, String(index));
      await writeFile(path, file.bytes, { mode: 0o600 });
      const mime = await piSdk.detectSupportedImageMimeTypeFromFile(path);
      if (mime) {
        if (settings.blockImages)
          throw new DeskError(422, "当前 Pi 设置禁用了图片上下文");
        if (!settings.modelInput?.includes("image"))
          throw new DeskError(
            422,
            "当前模型不支持图片上下文；请选择支持图片的模型",
          );
        let data = file.bytes.toString("base64"),
          mimeType = mime,
          bytes = file.bytes;
        const dimensions =
          mime === "image/bmp"
            ? {
                widthPx:
                  file.bytes.readUInt32LE(14) === 12
                    ? file.bytes.readUInt16LE(18)
                    : file.bytes.readInt32LE(18),
                heightPx:
                  file.bytes.readUInt32LE(14) === 12
                    ? file.bytes.readUInt16LE(20)
                    : Math.abs(file.bytes.readInt32LE(22)),
              }
            : getImageDimensions(data, mime);
        if (
          !dimensions ||
          dimensions.widthPx <= 0 ||
          dimensions.heightPx <= 0 ||
          dimensions.widthPx * dimensions.heightPx >
            attachmentLimits.maxImagePixels
        )
          throw new DeskError(
            422,
            `图片尺寸无效或超过 3200 万像素：${file.name}`,
          );
        const hints = [];
        if (mime === "image/bmp") {
          const converted = await piSdk.convertToPng(data, mime);
          if (!converted)
            throw new DeskError(422, `图片转换失败：${file.name}`);
          ({ data, mimeType } = converted);
          bytes = Buffer.from(data, "base64");
          hints.push("[Image converted from image/bmp to image/png.]");
        }
        // Native public worker-based resize also validates decode and bounds
        // dimensions/encoded size without blocking the TUI's event loop.
        const resized = await piSdk.resizeImage(bytes, mimeType);
        if (!resized)
          throw new DeskError(422, `图片读取或缩放失败：${file.name}`);
        if (settings.autoResize !== false) {
          ({ data, mimeType } = resized);
          const note = piSdk.formatDimensionNote(resized);
          if (note) hints.push(note);
        }
        images.push({ type: "image", data, mimeType });
        text.push(
          `<file name="${xmlName(file.name)}">${hints.join("\n")}</file>`,
        );
      } else {
        if (
          (file.type.startsWith("image/") && file.type !== "image/svg+xml") ||
          imageExtension.test(file.name)
        )
          throw new DeskError(422, `图片格式不支持或内容无效：${file.name}`);
        if (file.bytes.length > attachmentLimits.maxTextBytes)
          throw new DeskError(413, `文本附件不能超过 512 KiB：${file.name}`);
        let content;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            file.bytes,
          );
        } catch {
          throw new DeskError(422, `附件不是有效 UTF-8 文本：${file.name}`);
        }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content))
          throw new DeskError(422, `不支持二进制附件：${file.name}`);
        text.push(`<file name="${xmlName(file.name)}">\n${content}\n</file>`);
      }
      names.push(file.name);
    }
    return { text: text.join("\n"), images, names };
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
