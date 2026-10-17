import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSessionHost } from "./session-manager.mjs";
import {
  getGitRepository,
  parseGitCommand,
  gitActions,
  gitHelp,
  GitCommandError,
  isGitBusy,
} from "../git/git-manager.mjs";
import { DeskError } from "../config/config-store.mjs";
const safeText = (value: string) =>
  value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** Native and managed-session /git use one service and the public interaction store. */
export default function gitExtension(pi: ExtensionAPI) {
  const host = getSessionHost(getAgentDir());
  const run = async (
    args: string,
    ctx: ExtensionContext,
    overlay = false,
  ): Promise<string> => {
    const input = parseGitCommand(args);
    if (input.action === "help") return gitHelp;
    const snapshot = host.focusId ? host.snapshot() : undefined;
    const slot = host.focusId ? host.active : undefined;
    const cwd = snapshot?.cwd ?? ctx.cwd;
    const id = snapshot?.sessionId ?? ctx.sessionManager.getSessionId();
    const binding = `${id}:${cwd}`;
    if (!(slot?.options.projectTrusted?.() ?? ctx.isProjectTrusted()))
      throw new DeskError(
        403,
        "请先在 Pi 信任项目，再打开 Git（仓库过滤器可能执行程序）",
      );
    const repo = await getGitRepository(cwd);
    const guard = () => {
      if (!(slot?.options.projectTrusted?.() ?? ctx.isProjectTrusted()))
        throw new DeskError(403, "请先在 Pi 信任项目，再执行 Git 写操作");
      if (host.focusId && host.focusId !== id)
        throw new DeskError(409, "当前会话已变化");
      if (
        !ctx.isIdle() ||
        [...host.slots.values()].some((item) => !item.options.canWrite())
      )
        throw new DeskError(409, "请等所有会话任务和配置操作结束后写入 Git");
    };
    if (!gitActions.includes(input.action)) {
      const result = await repo.read(input);
      const rows = result.files.map(
        (file: { index: string; worktree: string; path: string }) =>
          `${file.index}${file.worktree} ${file.path}`,
      );
      return safeText(
        result.output ??
          `${result.branch}\n${input.action === "branches" ? result.branches.join("\n") : rows.join("\n") || "工作区干净"}`,
      );
    }
    guard();
    const plan = await repo.prepare(input, binding);
    guard();
    const message = safeText(
      `${cwd}\n${JSON.stringify(plan.request)}\n已暂存：${plan.staged.join(", ") || "无"}\n当前变更：${(plan.affected ?? []).join(", ") || "无"}\n${plan.warning}`,
    );
    let accepted: boolean;
    if (overlay && slot?.options.interactions) {
      accepted = await new Promise<boolean>((resolve) => {
        slot.options.interactions.start(
          "确认 Git 操作",
          async (ui: {
            prompt(input: Record<string, unknown>): Promise<string>;
          }) => {
            try {
              resolve(
                (await ui.prompt({
                  type: "select",
                  message,
                  options: [
                    { id: "yes", label: "确认执行" },
                    { id: "no", label: "取消" },
                  ],
                })) === "yes",
              );
            } catch {
              resolve(false);
            } finally {
              host.changed();
            }
          },
        );
        host.changed();
      });
    } else accepted = await ctx.ui.confirm("确认 Git 操作", message);
    if (!accepted) return "Git 操作已取消";
    const result = await repo.confirm(plan.token, binding, guard);
    if (host.focusId) host.routeOptions().gitChanged?.();
    return safeText(result.output || "Git 操作已完成");
  };
  pi.on("session_start", (_event, ctx) => {
    host.gitCommand = (args: string) => run(args, ctx, true);
  });
  pi.on("input", (_event, ctx) => {
    if (isGitBusy(ctx.cwd)) {
      ctx.ui.notify("Git 写操作正在运行，请完成后再发送消息", "warning");
      return { action: "handled" as const };
    }
    return undefined;
  });
  pi.registerCommand("git", {
    description:
      "Git 历史/show、暂存/提交、merge/checkout、soft/mixed reset、tag 与远端同步（写入须确认）",
    getArgumentCompletions: (prefix) =>
      [
        "status",
        "diff ",
        "stage ",
        "unstage ",
        "commit ",
        "branches",
        "switch ",
        "log",
        "show ",
        "merge ",
        "checkout ",
        "checkout -b ",
        "checkout --detach ",
        "reset soft ",
        "reset mixed ",
        "tags",
        "tag ",
        "tag -d ",
        "tag annotate ",
        "fetch",
        "pull",
        "push",
        "help",
      ]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        ctx.ui.notify(await run(args, ctx), "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof DeskError || error instanceof GitCommandError
            ? error.message
            : "Git 读取失败，请检查仓库与文件编码",
          "error",
        );
      }
    },
  });
}
