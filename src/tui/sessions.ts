import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type TUI,
  type OverlayHandle,
} from "@earendil-works/pi-tui";
import { DeskError } from "../config/config-store.mjs";
import {
  parseSessionsCommand,
  sessionsHelp,
  SESSION_ID_DISPLAY_LENGTH,
} from "./sessions-command.mjs";
import { getSessionHost } from "./session-manager.mjs";
import { startWebSlot } from "../server/web.mjs";
import type { AskQuestion } from "../agent/questionnaire.mjs";

const UI_REFRESH_MS = 250;
// Strip terminal controls from model/metadata text before applying theme ANSI.
const plain = (text: unknown) =>
  String(text ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const errorText = (error: unknown) =>
  error instanceof DeskError
    ? plain(error.message)
    : "操作未完成，请检查当前任务、交互或模型配置";
type Host = ReturnType<typeof getSessionHost>;
interface LiveRow {
  id: string;
  name: string;
  current?: boolean;
  running?: boolean;
  waiting?: boolean;
  live?: boolean;
  modified?: string | number | Date;
}
interface PromptJob {
  id: string;
  label: string;
  status: string;
  prompt?: {
    id: string;
    message: string;
    secret?: boolean;
    options?: { id: string; label: string }[];
  };
}
type Result = Awaited<ReturnType<Host["command"]>>;
interface SlotRequest {
  path?: string;
  parent?: { cwd?: string };
  bridgeFactory: (
    options: Parameters<Host["transport"]>[0],
  ) => ReturnType<Host["transport"]>;
  controller: Host;
}
const rowText = (row: LiveRow) =>
  `${row.current ? ">" : " "}${plain(row.name)} · ${row.running ? "运行中" : row.waiting ? "等待交互" : row.live ? "空闲" : "历史"} · ${row.id}`;

/** Public extension UI, not a second terminal renderer or a patched Pi core. */
export default function sessionsExtension(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const manager = getSessionHost(agentDir);
  let context: ExtensionContext | undefined;
  let view: SessionsView | undefined;
  let handle: OverlayHandle | undefined;
  let restoreUi: (() => void) | undefined;
  let originalCustom: ExtensionContext["ui"]["custom"] | undefined;
  let opening = false;
  let preserveFocus = false;
  let pendingResult: Result | undefined;
  let askQuestions: AskQuestion[] | undefined;
  pi.on("tool_execution_start", (event) => {
    if (
      event.toolName === "ask_user_question" &&
      Array.isArray(event.args?.questions)
    )
      askQuestions = event.args.questions as AskQuestion[];
  });
  pi.on("tool_execution_end", (event) => {
    if (event.toolName === "ask_user_question") askQuestions = undefined;
  });

  const close = (preserve = false) => {
    preserveFocus = preserve;
    view?.close();
  };
  const compatible = () => {
    if (
      typeof manager.command === "function" &&
      manager.tuiDrafts instanceof Map
    )
      return true;
    // /reload preserves process-owned sessions; never discard them for new code.
    if (manager.nativeId && manager.focusId !== manager.nativeId)
      manager.focus(manager.nativeId, { show: false });
    context?.ui.notify(
      "当前进程保留了旧版会话管理器；请等所有任务结束后重启 Pi 加载新版。后台任务未被停止。",
      "warning",
    );
    return false;
  };
  const show = (result?: Result) => {
    if (!compatible()) return;
    pendingResult = result;
    if (view) {
      view.present(result);
      return;
    }
    // RPC has UI notifications/dialogs, but cannot render custom TUI components.
    if (opening || context?.mode !== "tui" || !context.hasUI || manager.closed)
      return;
    const ctx = context;
    opening = true;
    const runCustom = originalCustom ?? ctx.ui.custom.bind(ctx.ui);
    void runCustom<void>(
      (tui, theme, _keys, done) => {
        view = new SessionsView(tui, theme, manager, () => {
          if (!preserveFocus && !manager.closed && manager.nativeId)
            manager.focus(manager.nativeId, { show: false });
          preserveFocus = false;
          done();
        });
        view.present(pendingResult);
        return view;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "top-left",
          width: "100%",
          maxHeight: "100%",
          margin: 0,
        },
        onHandle: (value) => {
          handle = value;
        },
      },
    )
      .catch(() =>
        ctx.ui.notify("会话管理界面未能打开，请重新执行 /sessions", "error"),
      )
      .finally(() => {
        opening = false;
        view = undefined;
        handle = undefined;
        pendingResult = undefined;
      });
  };
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    manager.showView = show;
    manager.closeView = () => close(true);
    manager.createSlot = ({
      path,
      parent,
      bridgeFactory,
      controller,
    }: SlotRequest) =>
      startWebSlot({
        agentDir,
        cwd: parent?.cwd ?? ctx.cwd,
        sessionDir: ctx.sessionManager.getSessionDir(),
        sessionPath: path,
        parent,
        bridgeFactory,
        sessionController: controller,
      });
    restoreUi?.();
    const ui = ctx.ui;
    originalCustom = ui.custom.bind(ui);
    const originals = {
      select: ui.select,
      confirm: ui.confirm,
      input: ui.input,
      editor: ui.editor,
      custom: ui.custom,
    };
    const request = (
      title: string,
      prompt: Record<string, unknown>,
      options?: { signal?: AbortSignal; timeout?: number },
    ) => {
      const signal =
        options?.timeout === undefined
          ? options?.signal
          : AbortSignal.any([
              AbortSignal.timeout(options.timeout),
              ...(options.signal ? [options.signal] : []),
            ]);
      return new Promise<string | undefined>((resolve) => {
        manager.nativeInteractions.start(
          title,
          async (interaction: {
            prompt: (input: Record<string, unknown>) => Promise<string>;
          }) => {
            try {
              resolve(await interaction.prompt({ ...prompt, signal }));
            } catch {
              resolve(undefined);
            } finally {
              manager.changed();
            }
          },
        );
        manager.changed();
      });
    };
    // Decorate only while the overlay owns focus; foreign custom UI stays native.
    ui.select = (title, values, opts) =>
      view || opening
        ? request(
            title,
            {
              type: "select",
              message: title,
              options: values.map((value) => ({ id: value, label: value })),
            },
            opts,
          )
        : originals.select(title, values, opts);
    ui.confirm = (title, message, opts) =>
      view || opening
        ? request(
            title,
            {
              type: "select",
              message,
              options: [
                { id: "yes", label: "确认" },
                { id: "no", label: "取消" },
              ],
            },
            opts,
          ).then((value) => value === "yes")
        : originals.confirm(title, message, opts);
    ui.input = (title, placeholder, opts) =>
      view || opening
        ? request(
            title,
            { type: "text", message: title, placeholder, secret: true },
            opts,
          )
        : originals.input(title, placeholder, opts);
    ui.editor = (title, prefill) =>
      view || opening
        ? request(title, { type: "text", message: title, placeholder: prefill })
        : originals.editor(title, prefill);
    ui.custom = async (factory, opts) => {
      if (askQuestions) {
        if (view && manager.nativeId)
          manager.focus(manager.nativeId, { show: false });
        if (view) handle?.setHidden(true);
        const questions = askQuestions;
        askQuestions = undefined;
        let jobId: string | undefined;
        try {
          return await originals.custom((tui, theme, keys, done) => {
            jobId = manager.nativeInteractions.start(
              "Ask User",
              async (interaction: {
                prompt: (input: Record<string, unknown>) => Promise<unknown>;
              }) => {
                let result: unknown;
                try {
                  result = await interaction.prompt({
                    type: "questionnaire",
                    message: "Ask User",
                    questions,
                  });
                } catch {
                  result = { answers: [], cancelled: true };
                }
                done(result as Parameters<typeof done>[0]);
                manager.changed();
              },
            );
            manager.changed();
            return factory(tui, theme, keys, (result) =>
              manager.nativeInteractions.settle(jobId!, result),
            );
          }, opts);
        } finally {
          if (jobId)
            manager.nativeInteractions.settle(jobId, {
              answers: [],
              cancelled: true,
            });
          handle?.setHidden(false);
          manager.changed();
        }
      }
      if (!view) return originals.custom(factory, opts);
      if (manager.nativeId) manager.focus(manager.nativeId, { show: false });
      handle?.setHidden(true);
      try {
        return await originals.custom(factory, opts);
      } finally {
        handle?.setHidden(false);
      }
    };
    restoreUi = () => {
      Object.assign(ui, originals);
      originalCustom = undefined;
    };
    if (
      manager.focusId &&
      manager.nativeId &&
      manager.focusId !== manager.nativeId
    )
      show();
  });
  // Native resume would open a second writer for an already managed SDK slot.
  pi.on("session_before_switch", (event, ctx) => {
    const path = event.targetSessionFile;
    const managed =
      typeof manager.managesPath === "function"
        ? manager.managesPath(path)
        : path &&
          [...manager.slots.values()].some(
            (slot) =>
              !slot.native &&
              slot.app?.runtime.session.sessionManager.getSessionFile() &&
              resolve(
                slot.app.runtime.session.sessionManager.getSessionFile(),
              ) === resolve(path),
          );
    if (event.reason === "resume" && managed) {
      ctx.ui.notify(
        "该会话已在 /sessions 中打开，请使用 /sessions use ID 切换，避免重复写入",
        "warning",
      );
      return { cancel: true };
    }
    return undefined;
  });
  pi.on("session_shutdown", (event) => {
    close(event.reason !== "quit");
    restoreUi?.();
    restoreUi = undefined;
    context = undefined;
  });
  pi.registerCommand("sessions", {
    description:
      "并行会话管理：new、list、use ID、stop [ID]、help；旧任务继续运行",
    getArgumentCompletions: (prefix) =>
      ["new", "list", "use ", "stop", "help"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      context = ctx;
      try {
        const parsed = parseSessionsCommand(args);
        if (parsed.action === "help") {
          ctx.ui.notify(sessionsHelp, "info");
          return;
        }
        if (!compatible()) return;
        if (!manager.startNative) {
          ctx.ui.notify("请同时加载 Pi Desk 连接扩展", "error");
          return;
        }
        await manager.startNative();
        const result = await manager.command(args);
        if (ctx.mode === "tui") show(result);
        else
          ctx.ui.notify(
            "rows" in result
              ? result.rows.map(rowText).join("\n")
              : `会话操作完成：${result.action}`,
            "info",
          );
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });
}

export class SessionsView {
  private input = new Input();
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private currentId = "";
  private requestId = "";
  private error = "";
  private panel: string[] | undefined;
  private picker: LiveRow[] | undefined;
  private search = new Input();
  private selected = 0;
  private scroll = 0;
  focused = false;
  private tui: TUI;
  private theme: Theme;
  private manager: Host;
  private done: () => void;
  constructor(tui: TUI, theme: Theme, manager: Host, done: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.manager = manager;
    this.done = done;
    this.syncInput();
    this.input.onSubmit = (value) => {
      void this.submit(value);
    };
    this.unsubscribe = manager.subscribe(() => {
      this.syncInput();
      tui.requestRender();
    });
    this.timer = setInterval(() => tui.requestRender(), UI_REFRESH_MS);
    this.timer.unref();
  }
  private saveDraft() {
    if (!this.requestId && this.currentId)
      this.manager.tuiDrafts.set(this.currentId, this.input.getValue());
  }
  close() {
    if (!this.closed) {
      this.saveDraft();
      this.closed = true;
      this.done();
    }
  }
  dispose() {
    this.saveDraft();
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.timer);
  }
  invalidate() {
    this.input.invalidate();
  }
  private interaction() {
    const jobs: PromptJob[] =
      this.manager.active.options.interactions?.list() ?? [];
    return jobs.find((job) => job.status === "running" && job.prompt);
  }
  private syncInput() {
    if (this.closed || this.manager.closed) return;
    const id = this.manager.focusId;
    const promptKey = this.interaction()?.prompt?.id ?? "";
    if (this.currentId === id && this.requestId === promptKey) return;
    this.saveDraft();
    this.currentId = id;
    this.requestId = promptKey;
    // A new binding must not retain another session/dialog's undo or kill ring.
    this.input = new Input();
    this.input.onSubmit = (value) => {
      void this.submit(value);
    };
    this.input.setValue(
      promptKey ? "" : (this.manager.tuiDrafts.get(id) ?? ""),
    );
    this.scroll = 0;
    this.panel = undefined;
  }
  present(result?: Result) {
    this.picker = result && "rows" in result ? result.rows : undefined;
    this.search.setValue("");
    this.selected = Math.max(
      0,
      this.picker?.findIndex((row) => row.current) ?? 0,
    );
    this.panel =
      result && "rows" in result && result.action === "list"
        ? result.rows.map(rowText)
        : result && "text" in result
          ? result.text.split("\n")
          : undefined;
    this.scroll = 0;
    this.tui.requestRender();
  }
  private async command(args: string) {
    try {
      this.present(await this.manager.command(args));
      this.error = "";
    } catch (error) {
      this.error = errorText(error);
    }
    this.tui.requestRender();
  }
  private async submit(value: string) {
    this.syncInput();
    const sessionId = this.currentId;
    const slot = this.manager.active;
    const job = this.interaction();
    try {
      if (job?.prompt)
        slot.options.interactions.reply({
          id: job.id,
          promptId: job.prompt.id,
          value,
        });
      else if (value.trim() === "/exit") {
        this.close();
        return;
      } else if (
        /^\/(?:new|list|use|stop|help|sessions)(?:\s|$)/.test(value.trim())
      ) {
        const args = value
          .trim()
          .replace(/^\/(?:sessions\s*|)/, "")
          .trim();
        this.present(await this.manager.command(args));
      } else if (/^\/git(?:\s|$)/.test(value.trim())) {
        if (!this.manager.gitCommand)
          throw new DeskError(409, "Git 扩展尚未加载，请等任务结束后更新宿主");
        const output = await this.manager.gitCommand(
          value.trim().replace(/^\/git\s*/, ""),
        );
        if (this.currentId === sessionId)
          this.panel = String(output).split("\n");
      } else if (value.trim()) {
        this.panel = undefined;
        await slot.options.prompt(value, "steer");
      }
      this.manager.tuiDrafts.delete(sessionId);
      if (this.currentId === sessionId) this.input.setValue("");
      this.error = "";
      this.scroll = 0;
    } catch (error) {
      this.error = errorText(error);
    }
    this.manager.changed();
  }
  private pickerRows() {
    const live: LiveRow[] = this.manager.liveRows();
    const rows = [
      ...live,
      ...(this.picker ?? []).filter(
        (row) => !live.some((item) => item.id === row.id),
      ),
    ];
    const query = this.search.getValue().toLocaleLowerCase();
    return rows.filter((row) =>
      `${row.name} ${row.id}`.toLocaleLowerCase().includes(query),
    );
  }
  private renderPicker(width: number): string[] {
    const rows = this.pickerRows();
    this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
    this.search.focused = this.focused;
    const height = Math.max(1, this.tui.terminal.rows);
    const search = this.search.render(Math.max(1, width));
    const room = Math.max(0, height - search.length - 4);
    const start = Math.max(0, this.selected - room + 1);
    const list = rows.slice(start, start + room).map((row, i) => {
      const date = new Date(row.modified ?? 0);
      const updated =
        date.getTime() > 0
          ? date.toISOString().slice(5, 16).replace("T", " ")
          : "—";
      const status = row.waiting
        ? "等待交互"
        : row.running
          ? "运行中"
          : row.live
            ? "空闲"
            : "历史";
      const name = plain(row.name).replace(/[\r\n\t]/g, " ");
      const text = `${i + start === this.selected ? "›" : " "} ${status} ${updated} ${name}${row.current ? " · 当前" : ""}`;
      return this.theme.fg(
        i + start === this.selected ? "accent" : "text",
        text,
      );
    });
    if (!rows.length && room)
      list.push(this.theme.fg("muted", "没有匹配的会话"));
    while (list.length < room) list.push("");
    return [
      this.theme.fg("accent", "Pi Sessions · 选择会话"),
      ...search,
      ...list,
      this.error || `匹配 ${rows.length} · 输入名称或 ID 搜索`,
      "↑↓ 选择 · Enter 进入 · Esc 返回",
      "Ctrl+N 新建 · Ctrl+C 停止当前会话",
    ]
      .slice(0, height)
      .map((line) => truncateToWidth(line, width, "", true));
  }
  handleInput(data: string) {
    this.syncInput();
    if (
      this.picker &&
      !matchesKey(data, "escape") &&
      !matchesKey(data, "ctrl+c") &&
      !matchesKey(data, "ctrl+n") &&
      !matchesKey(data, "tab")
    ) {
      const rows = this.pickerRows();
      if (matchesKey(data, "up"))
        this.selected = Math.max(0, this.selected - 1);
      else if (matchesKey(data, "down"))
        this.selected = Math.min(
          Math.max(0, rows.length - 1),
          this.selected + 1,
        );
      else if (matchesKey(data, "enter")) {
        const row = rows[this.selected];
        if (row) void this.command(`use ${row.id}`);
      } else {
        this.search.handleInput(data);
        this.selected = 0;
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "tab")) this.picker = undefined;
    if (matchesKey(data, "escape")) {
      this.close();
      return;
    }
    // Dedicated shortcuts are controls, never replies to a pending secret dialog.
    if (matchesKey(data, "ctrl+c")) void this.command(`stop ${this.currentId}`);
    else if (matchesKey(data, "ctrl+n")) void this.command("new");
    else if (matchesKey(data, "tab")) {
      const rows: LiveRow[] = this.manager.liveRows();
      if (rows.length)
        this.manager.focus(
          rows[
            (rows.findIndex((row) => row.id === this.currentId) + 1) %
              rows.length
          ].id,
        );
    } else if (matchesKey(data, "pageUp")) this.scroll += 5;
    else if (matchesKey(data, "pageDown"))
      this.scroll = Math.max(0, this.scroll - 5);
    else this.input.handleInput(data);
    this.tui.requestRender();
  }
  render(width: number): string[] {
    this.syncInput();
    if (this.picker) return this.renderPicker(width);
    const state = this.manager.snapshot();
    const job = this.interaction();
    const height = Math.max(8, this.tui.terminal.rows);
    const body: string[] = [];
    if (this.panel)
      for (const line of this.panel)
        body.push(...wrapTextWithAnsi(plain(line), Math.max(1, width - 2)));
    else
      for (const message of [
        ...(state.messages ?? []),
        ...(state.streamingMessage ? [state.streamingMessage] : []),
      ]) {
        body.push(
          this.theme.fg(
            "muted",
            `[${plain(message.role)}${message.toolName ? ` · ${plain(message.toolName)}` : ""}]`,
          ),
        );
        for (const block of message.blocks ?? [
          { type: "text", text: message.text },
        ]) {
          const text =
            block.type === "toolCall"
              ? `[工具 ${plain(block.name)}]\n${plain(block.arguments)}`
              : plain(block.text);
          body.push(...wrapTextWithAnsi(text, Math.max(1, width - 2)));
        }
      }
    for (const call of state.activeCalls ?? [])
      body.push(`[工具 ${plain(call.name)} · ${plain(call.status)}]`);
    if (job?.prompt) {
      body.push(
        this.theme.fg("warning", plain(job.label)),
        plain(job.prompt.message),
      );
      for (const choice of job.prompt.options ?? [])
        body.push(`${plain(choice.id)}: ${plain(choice.label)}`);
    }
    const rows: LiveRow[] = this.manager.liveRows();
    const header = [
      this.theme.fg(
        "accent",
        `Pi Sessions · ${plain(state.name)} · ${state.sessionId}`,
      ),
      rows
        .map(
          (row) =>
            `${row.current ? ">" : ""}${plain(row.name)} ${row.running ? "运行中" : row.waiting ? "等待交互" : "空闲"} (${row.id.slice(0, SESSION_ID_DISPLAY_LENGTH)})`,
        )
        .join(" | "),
      this.theme.fg(
        "dim",
        "Ctrl+N 新建 · Tab 切换 · Ctrl+C 停止 · Esc 返回 · /list /use ID /help",
      ),
    ];
    const status = `${state.idle ? "空闲" : plain(state.operation) || "运行中"} · ${plain(state.model?.name ?? state.model?.id ?? "未选模型")} · ${plain(state.thinkingLevel)} · ${state.metrics?.totalTokens ?? state.stats?.tokens?.total ?? 0} Tokens`;
    this.input.focused = this.focused;
    const inputLines = job?.prompt?.secret
      ? [`> ${"•".repeat(this.input.getValue().length)}`]
      : this.input.render(Math.max(1, width));
    const count = Math.max(0, height - header.length - inputLines.length - 2);
    const end = Math.max(0, body.length - this.scroll);
    const content = body.slice(Math.max(0, end - count), end);
    while (content.length < count) content.unshift("");
    return [
      ...header,
      ...content,
      this.theme.fg(this.error ? "error" : "dim", this.error || status),
      ...inputLines,
      "",
    ]
      .slice(0, height)
      .map((line) => truncateToWidth(line, width, "", true));
  }
}
