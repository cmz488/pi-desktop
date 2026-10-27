import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DeskError } from "../config/config-store.mjs";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const DOCUMENTS = Object.freeze({
  uiState: "ui-state.json",
  environmentUiState: "environment-ui-state.json",
});

/** 展示偏好按文档串行写入；UiState 是局部更新，环境工作区是完整快照。 */
export function createUiStateStore(directory) {
  const pending = new Map();
  const pathOf = (name) => {
    if (!Object.hasOwn(DOCUMENTS, name))
      throw new DeskError(422, `未知的 UI 状态文档：${name}`);
    return join(directory, DOCUMENTS[name]);
  };
  const validate = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new DeskError(422, "UI 状态必须是 JSON 对象");
  };
  async function read(name) {
    try {
      const value = JSON.parse(await readFile(pathOf(name), "utf8"));
      validate(value);
      // 兼容旧适配器误存的一层请求包络。
      return Object.keys(value).length === 1 &&
        value.state &&
        typeof value.state === "object" &&
        !Array.isArray(value.state)
        ? value.state
        : value;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof SyntaxError)
        throw new DeskError(422, "UI 状态文档不是有效 JSON");
      throw error;
    }
  }
  return {
    read,
    write(name, value, { merge = false } = {}) {
      const path = pathOf(name);
      const operation = (pending.get(name) ?? Promise.resolve()).then(
        async () => {
          validate(value);
          const next = merge ? { ...(await read(name)), ...value } : value;
          const text = JSON.stringify(next);
          if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES)
            throw new DeskError(422, "UI 状态过大");
          await mkdir(dirname(path), { recursive: true });
          const temp = `${path}.${randomUUID()}.tmp`;
          try {
            await writeFile(temp, text, { mode: 0o600, flag: "wx" });
            await rename(temp, path);
          } finally {
            await rm(temp, { force: true });
          }
          return next;
        },
      );
      // 一次失败只反馈给该请求，后续保存仍可重试。
      pending.set(
        name,
        operation.catch(() => {}),
      );
      return operation;
    },
    dailyDir: () => join(directory, "daily"),
  };
}
