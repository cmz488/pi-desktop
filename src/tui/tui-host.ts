import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createDeskBridge } from "../server/bridge.mjs";
import { DeskError } from "../config/config-store.mjs";
import { launchDesktop } from "../desktop/desktop-launcher.mjs";
import { getSessionHost } from "./session-manager.mjs";

type Snapshot = Record<string, unknown>;
interface TuiSnapshot extends Snapshot {
  backend: { id: string; pid: number; owner: "tui" };
  host: "tui";
  replacing: boolean;
  idle: boolean;
}
type Action = (
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
) => Promise<unknown>;
interface PendingAction {
  run: Action;
  exclusive: boolean;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
const ACTION_DISPATCH_TIMEOUT_MS = 30_000;
const REBIND_TIMEOUT_MS = 30_000;
// Queue/usage/tool-loadout changes have no public extension event. Probe only
// small native state keys, only while a frontend subscribes; never poll full messages.
const STATE_CHECK_INTERVAL_MS = 250;

// Pi recreates extension factories on reload/new/resume. Process-owned transport
// must outlive those factories, but never the TUI's AgentSessionRuntime.
declare global {
  var __piDesktopTuiHosts: Map<string, TuiHost> | undefined;
}

class TuiHost {
  readonly backend: TuiSnapshot["backend"] = {
    id: randomUUID(),
    pid: process.pid,
    owner: "tui",
  };
  readonly sessions: ReturnType<typeof getSessionHost>;
  constructor(agentDir: string) {
    this.sessions = getSessionHost(agentDir);
    this.sessions.backend = this.backend;
  }
  bridge: ReturnType<typeof createDeskBridge> | undefined;
  busy = false;
  private currentContext?: ExtensionContext;
  private currentPi?: ExtensionAPI;
  private readSnapshot?: () => Snapshot;
  private readFingerprint?: () => string;
  private lastFingerprint?: string;
  private stateCheck?: ReturnType<typeof setInterval>;
  private lastSnapshot: Snapshot = {};
  private rebinding?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, PendingAction>();
  private desktop?: ChildProcess;
  private desktopUrl?: string;

  get ready() {
    return !!this.currentContext && !!this.readSnapshot;
  }
  get context() {
    if (!this.currentContext)
      throw new DeskError(409, "Pi 正在替换或重载当前会话");
    return this.currentContext;
  }
  get pi() {
    if (!this.currentPi) throw new DeskError(409, "Pi 正在替换或重载当前会话");
    return this.currentPi;
  }
  factoryLoaded() {
    // Other session_start handlers may wait for a human (e.g. MCP OAuth).
    // Loading this factory proves it is still enabled; do not time out that wait.
    clearTimeout(this.rebinding);
    this.rebinding = undefined;
  }
  bind(
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    snapshot: () => Snapshot,
    fingerprint: () => string = () => "",
  ) {
    clearTimeout(this.rebinding);
    this.currentContext = ctx;
    this.currentPi = pi;
    this.readSnapshot = snapshot;
    this.readFingerprint = fingerprint;
    this.sessions.rebindNative(snapshot());
  }
  snapshot(): TuiSnapshot {
    if (this.readSnapshot) this.lastSnapshot = this.readSnapshot();
    return {
      ...this.lastSnapshot,
      backend: this.backend,
      host: "tui",
      replacing: !this.ready,
      thinkingEditable: this.ready && !this.busy,
      operation: this.ready
        ? this.lastSnapshot.operation
        : "切换或重载当前会话…",
      idle: this.ready && !this.busy && !!this.lastSnapshot.idle,
    };
  }
  changed() {
    this.lastFingerprint = this.readFingerprint?.();
    this.bridge?.publish("state_changed", {});
  }
  suspend() {
    this.snapshot();
    this.currentContext = undefined;
    this.currentPi = undefined;
    this.readSnapshot = undefined;
    this.readFingerprint = undefined;
    this.changed();
    // If the extension was removed by /reload, no factory will rebind it.
    this.rebinding = setTimeout(() => {
      void this.stop();
    }, REBIND_TIMEOUT_MS);
    this.rebinding.unref();
  }
  async start(options: Parameters<typeof createDeskBridge>[0]) {
    const bridge = (this.bridge ??= this.sessions.transport(
      {
        ...options,
        interactions: this.sessions.nativeInteractions,
        abort: async () => {
          this.sessions.nativeInteractions.cancelAll();
          await options.abort();
        },
      },
      { native: true },
    ));
    const url = await bridge.start();
    this.stateCheck ??= setInterval(() => {
      if (
        !this.ready ||
        !this.bridge?.connectedClients ||
        !this.readFingerprint
      )
        return;
      try {
        if (this.readFingerprint() !== this.lastFingerprint) this.changed();
      } catch {
        this.readFingerprint = undefined;
        this.currentContext?.ui.notify(
          "Pi 共享状态检测失败；请在 TUI 重载扩展。",
          "error",
        );
      }
    }, STATE_CHECK_INTERVAL_MS);
    this.stateCheck.unref();
    return url;
  }
  async openDesktop(url: string) {
    if (
      this.desktop &&
      this.desktop.exitCode === null &&
      this.desktop.signalCode === null &&
      this.desktopUrl === url
    )
      return;
    this.desktop = await launchDesktop(url);
    this.desktopUrl = url;
    this.desktop.on("exit", (code, signal) => {
      if (code && !signal)
        this.bridge?.publish("notification", {
          type: "error",
          message: `Desktop 前端退出（${code}）；Pi-Agent 仍运行，可继续使用 TUI 或手机。`,
        });
    });
  }
  request(run: Action, { exclusive = true } = {}): Promise<unknown> {
    if (!this.ready || this.busy || (exclusive && !this.context.isIdle()))
      return Promise.reject(new DeskError(409, "请等待当前 Pi 操作完成"));
    if (exclusive) this.busy = true;
    this.changed();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeskError(504, "Pi 未及时接收前端操作"));
      }, ACTION_DISPATCH_TIMEOUT_MS);
      this.pending.set(id, { run, exclusive, resolve, reject, timer });
      try {
        // Native dispatch supplies a fresh command-capable context. Capturing the
        // context from a previous /desk invocation would break after /new.
        this.pi.sendUserMessage(`/desk _action ${id}`, {
          expandPromptTemplates: true,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    }).finally(() => {
      if (exclusive) this.busy = false;
      this.changed();
    });
  }
  async handle(id: string, ctx: ExtensionCommandContext, pi: ExtensionAPI) {
    const action = this.pending.get(id);
    if (!action) throw new DeskError(404, "Pi 前端操作已失效");
    this.pending.delete(id);
    clearTimeout(action.timer);
    try {
      if (action.exclusive && !ctx.isIdle())
        throw new DeskError(409, "Pi 正在执行任务");
      action.resolve(await action.run(ctx, pi));
    } catch (error) {
      action.reject(error);
    }
  }
  async stop() {
    clearTimeout(this.rebinding);
    clearInterval(this.stateCheck);
    this.stateCheck = undefined;
    for (const action of this.pending.values()) {
      clearTimeout(action.timer);
      action.reject(new DeskError(409, "Pi 前端连接服务已停止"));
    }
    this.pending.clear();
    await this.bridge?.stop();
    this.bridge = undefined;
  }
  async quit(agentDir: string) {
    await this.sessions.dispose();
    await this.stop();
    this.currentContext = undefined;
    this.currentPi = undefined;
    this.readSnapshot = undefined;
    this.readFingerprint = undefined;
    globalThis.__piDesktopTuiHosts?.delete(agentDir);
  }
}

export function getTuiHost(agentDir: string): TuiHost {
  const hosts = (globalThis.__piDesktopTuiHosts ??= new Map());
  let host = hosts.get(agentDir);
  if (!host) {
    host = new TuiHost(agentDir);
    hosts.set(agentDir, host);
  }
  host.factoryLoaded();
  return host;
}
