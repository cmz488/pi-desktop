import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DeskError } from "../config/config-store.mjs";

/**
 * 客户端 UI 状态的持久化（侧栏折叠、置顶、主题、上次模型、导航工作区）。
 *
 * 接口：`createUiStateStore(directory)` 返回 `{ read(name), write(name, value), dailyDir() }`。
 * 不变量：写入是原子的（同目录临时文件 + rename），单个文档上限 1 MiB，只接受 JSON 对象。
 *   不做版本围栏——这是单客户端的展示偏好，最后写入者胜出符合预期语义（与配置文档不同）。
 * 为什么放在 Host：这些值必须跨页面刷新存活，而页面的 `window.pi` 只能读 Host。
 *   Percho 原本把它们放在 Electron userData；我们放在每个工作空间的数据目录。
 * 错误：超限或形状非法抛 DeskError(422)；IO 错误原样传播。
 */
const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** 只允许这两个文档名；写成任意名字就是一条未受控的写路径。 */
const DOCUMENTS = Object.freeze({
  uiState: "ui-state.json",
  environmentUiState: "environment-ui-state.json",
});

export function createUiStateStore(directory) {
  const pathOf = (name) => {
    const file = DOCUMENTS[name];
    if (!file) throw new DeskError(422, `未知的 UI 状态文档：${name}`);
    return join(directory, file);
  };

  return {
    /** 读取；从未写过时返回 null（与 Percho 的 default 一致）。 */
    async read(name) {
      try {
        const text = await readFile(pathOf(name), "utf8");
        if (!text.trim()) return null;
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new DeskError(422, "UI 状态文档必须是 JSON 对象");
        return value;
      } catch (error) {
        if (error.code === "ENOENT") return null;
        // JSON 损坏时明确失败：静默当作空会把用户的偏好悄悄清掉。
        if (error instanceof SyntaxError)
          throw new DeskError(422, "UI 状态文档不是有效 JSON");
        throw error;
      }
    },

    /** 原子写入。 */
    async write(name, value) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new DeskError(422, "UI 状态必须是 JSON 对象");
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES)
        throw new DeskError(422, "UI 状态过大");
      const path = pathOf(name);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, path);
      return value;
    },

    /**
     * 日常空间目录。
     *
     * Percho 用它放「不属于任何项目」的会话；我们没有这个概念，所以返回工作空间数据目录下的
     * `daily`，语义仍是「一个可写、按工作空间隔离的普通目录」，不伪造项目路径。
     */
    dailyDir: () => join(directory, "daily"),
  };
}