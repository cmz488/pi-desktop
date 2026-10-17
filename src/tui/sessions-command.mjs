import { DeskError } from "../config/config-store.mjs";

export const SESSION_ID_PREFIX_LENGTH = 8;
// UUIDv7 starts with a timestamp: the first eight characters often coincide.
export const SESSION_ID_DISPLAY_LENGTH = 18;
export const sessionsHelp = [
  "/sessions 打开并行会话管理界面",
  "/sessions list 列出当前工作区的活动与历史会话",
  "/sessions new 新建会话，旧任务继续运行",
  "/sessions use ID 切换或恢复；也支持 /sessions ID",
  "/sessions stop [ID] 停止指定活动会话，省略 ID 则停止当前",
  "/sessions help 查看帮助；ID 可用唯一的至少 8 位前缀",
  "界面内：/new、/list、/use ID、/stop、/help、/exit",
  "Ctrl+N 新建 · Tab 切换 · Ctrl+C 停止当前 · Esc 返回原生会话",
  "原生 /new 仍替换原生会话；退出界面不停止后台任务。",
].join("\n");

/** @returns {{action: "show"|"new"|"list"|"help"|"use"|"stop", id?:string}} */
export function parseSessionsCommand(args = "") {
  if (typeof args !== "string") throw new DeskError(422, "会话命令参数无效");
  const [name, ...rest] = args.trim().split(/\s+/);
  if (!name) return { action: "show" };
  if (["new", "list", "help"].includes(name) && !rest.length)
    return { action: name };
  if (name === "use" && rest.length === 1)
    return { action: "use", id: rest[0] };
  if (name === "stop" && rest.length <= 1)
    return { action: "stop", id: rest[0] };
  if (!rest.length && !["use", "new", "list", "help"].includes(name))
    return { action: "use", id: name };
  throw new DeskError(422, "用法无效，请使用 /sessions help 查看支持的命令");
}

export function resolveSessionId(rows, input) {
  if (typeof input !== "string" || !input.trim())
    throw new DeskError(422, "请提供会话 ID");
  const id = input.trim();
  const exact = rows.find((row) => row.id === id);
  if (exact) return exact.id;
  if (id.length < SESSION_ID_PREFIX_LENGTH)
    throw new DeskError(422, "请使用完整会话 ID 或至少 8 位唯一前缀");
  const matches = rows.filter((row) => row.id.startsWith(id));
  if (!matches.length) throw new DeskError(404, "当前工作区中没有该会话");
  if (matches.length !== 1)
    throw new DeskError(409, "会话 ID 前缀不唯一，请提供更完整的 ID");
  return matches[0].id;
}
