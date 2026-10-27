import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  parseSessionsCommand,
  resolveSessionId,
  sessionsHelp,
} from "./sessions-command.mjs";
import { createDeskBridge } from "../server/bridge.mjs";
import { DeskError } from "../config/config-store.mjs";
import { createInteractionStore } from "../agent/interaction-store.mjs";

// One process-owned registry, not one Agent per frontend. A slot owns its SDK
// session and private projection/interaction store; transport is shared in memory.
export class SessionHost {
  constructor({ agentDir, host = "headless", createSlot } = {}) {
    this.agentDir = agentDir;
    this.host = host;
    this.createSlot = createSlot;
    this.backend = { id: randomUUID(), pid: process.pid, owner: host };
    this.slots = new Map();
    this.listeners = new Set();
    this.mutation = Promise.resolve();
    this.closed = false;
    this.nativeInteractions = createInteractionStore(() => {
      const slot = this.slots.get(this.nativeId);
      if (slot) this.publish(slot, "interaction_changed", {});
    });
    // TUI drafts survive closing/reopening the overlay, but never enter snapshots.
    this.tuiDrafts = new Map();
    /** @type {undefined | (() => void)} */
    this.showView = undefined;
    /** @type {undefined | (() => void)} */
    this.closeView = undefined;
    /** @type {undefined | (() => Promise<string>)} */
    this.startNative = undefined;
  }
  get active() {
    const slot = this.slots.get(this.focusId);
    if (!slot) throw new DeskError(409, "会话管理器尚未就绪");
    return slot;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(slot, kind, data = {}) {
    if (this.closed || !this.slots.has(slot.id)) return;
    this.bridge?.publish(kind, { ...data, sessionId: slot.id });
    for (const listener of this.listeners) listener();
  }
  changed() {
    this.bridge?.publish("state_changed", { sessionId: this.focusId });
    for (const listener of this.listeners) listener();
  }
  snapshot() {
    return {
      ...this.active.options.snapshot(),
      host: this.host,
      backend: this.backend,
      sessionId: this.active.id,
      sessionManagement: true,
      sessionCommands: true,
    };
  }
  liveRows() {
    return [...this.slots.values()].map((slot) => {
      const state = slot.options.snapshot();
      return {
        id: slot.id,
        name: state.name,
        messageCount: state.stats?.totalMessages ?? state.messages?.length ?? 0,
        running: !state.idle && !state.initializing && !state.replacing,
        initializing: !!state.initializing,
        waiting: !!slot.options.interactions?.running,
        live: true,
        native: !!slot.native,
        current: slot.id === this.focusId,
        modified: slot.modified,
      };
    });
  }
  async list() {
    const history = (await this.active.options.listSessions?.()) ?? [];
    const live = this.liveRows();
    return [
      ...live,
      ...history
        .filter((row) => !this.slots.has(row.id))
        .map((row) => ({ ...row, live: false, running: false })),
    ];
  }
  serialize(run) {
    const result = this.mutation.then(() => {
      if (this.closed) throw new DeskError(409, "会话管理器已关闭");
      return run();
    });
    this.mutation = result.catch(() => {}); // Caller still receives the original error.
    return result;
  }
  transport(options, { native = false } = {}) {
    const id = options.snapshot().sessionId;
    const slot = { id, options, native, modified: new Date().toISOString() };
    if (native && this.nativeId && this.nativeId !== id)
      this.slots.delete(this.nativeId);
    this.slots.set(id, slot);
    if (native) this.nativeId = id;
    this.focusId ??= id;
    if (!this.slots.has(this.focusId)) this.focusId = id;
    this.baseOptions ??= options;
    this.changed();
    return {
      slot,
      start: async () =>
        native ? this.start() : (this.url ?? "http://127.0.0.1/"),
      stop: async () => {
        if (native) await this.stopTransport();
      },
      publish: (kind, data) => this.publish(slot, kind, data),
      connectionDetails: (...args) => this.bridge.connectionDetails(...args),
      get connectedClients() {
        return this.owner.bridge?.connectedClients ?? 0;
      },
      owner: this,
    };
  }
  // Native /new remains a replacement. Only its native slot is rebound; all
  // managed SDK slots survive. Never relabel a running slot with another ID.
  rebindNative(snapshot) {
    if (!this.nativeId) return;
    const slot = this.slots.get(this.nativeId);
    const id = snapshot.sessionId;
    if (id === slot.id) return;
    const selected = this.focusId === slot.id;
    this.slots.delete(slot.id);
    slot.id = id;
    this.nativeId = id;
    this.slots.set(id, slot);
    if (selected) this.focusId = id;
    this.changed();
  }
  focus(id, { show = true } = {}) {
    if (!this.slots.has(id)) throw new DeskError(404, "会话不存在");
    this.focusId = id;
    if (show) this.showView?.();
    this.changed();
  }
  create(options = {}) {
    return this.serialize(() => this.openSlot(options));
  }
  // Called only within serialize: lookup and opening a writer are one mutation.
  async openSlot({ initial = false, path } = {}) {
    const parent = this.focusId ? this.active.options.snapshot() : undefined;
    if (
      !initial &&
      !path &&
      (await this.active.options.beforeNewSession?.())?.cancelled
    )
      return { cancelled: true };
    let app, slot;
    try {
      app = await this.createSlot({
        path,
        parent,
        bridgeFactory: (options) => {
          const transport = this.transport(options);
          slot = transport.slot;
          return transport;
        },
        controller: this,
      });
      slot.app = app;
      this.focus(slot.id, { show: !initial });
      return { cancelled: false, id: slot.id };
    } catch (error) {
      if (slot) {
        await app?.stop();
        this.slots.delete(slot.id);
      }
      throw error;
    }
  }
  select(input) {
    return this.serialize(async () => {
      const history = (await this.active.options.sessionHistory?.()) ?? [];
      const id = resolveSessionId(
        [
          ...this.liveRows(),
          ...history.filter((row) => !this.slots.has(row.id)),
        ],
        input,
      );
      if (this.slots.has(id)) {
        this.focus(id);
        return { cancelled: false, id };
      }
      return this.openSlot({ path: history.find((row) => row.id === id).path });
    });
  }
  managesPath(path) {
    return (
      typeof path === "string" &&
      [...this.slots.values()].some((slot) => {
        const file = slot.app?.runtime.session.sessionManager.getSessionFile();
        return !slot.native && file && resolve(file) === resolve(path);
      })
    );
  }
  async stopSession(input = this.focusId) {
    // Capture the intended slot before awaiting; never stop a newly focused slot.
    const id = resolveSessionId(this.liveRows(), input);
    const slot = this.slots.get(id);
    slot.options.interactions?.cancelAll();
    await slot.options.abort();
    this.changed();
    return { id };
  }
  async command(args = "") {
    const command = parseSessionsCommand(args);
    if (command.action === "help")
      return { action: command.action, text: sessionsHelp };
    if (command.action === "list" || command.action === "show")
      return { action: command.action, rows: await this.list() };
    const result =
      command.action === "new"
        ? await this.create()
        : command.action === "use"
          ? await this.select(command.id)
          : await this.stopSession(command.id);
    if (result?.cancelled) throw new DeskError(409, "扩展取消了会话切换");
    return { action: command.action, ...result };
  }
  async selectPath(path) {
    const rows = (await this.active.options.sessionHistory?.()) ?? [];
    const row = rows.find((row) => row.path === path);
    if (!row) throw new DeskError(404, "当前工作区中没有该会话");
    return this.select(row.id);
  }
  validateTarget(input) {
    if (input.sessionId !== undefined && input.sessionId !== this.focusId)
      throw new DeskError(409, "当前会话已变化，请刷新后重试");
  }
  routeOptions() {
    const manager = this;
    const overrides = {
      snapshot: () => manager.snapshot(),
      capabilities: {
        ...(manager.baseOptions?.capabilities ?? {}),
        sessions: true,
        newSession: true,
        switchSession: true,
        sessionCommand: true,
        canManageSessions: true,
        canEditShared: true,
        validateTarget: true,
      },
      listSessions: () => manager.list(),
      newSession: () => manager.create(),
      switchSession: (id) => manager.select(id),
      sessionCommand: (args) => manager.command(args),
      gitChanged: () => {
        for (const slot of manager.slots.values()) slot.options.gitChanged?.();
      },
      abort: () => manager.stopSession(),
      canManageSessions: () => !manager.closed,
      validateTarget: (input) => manager.validateTarget(input),
      canEditShared: () =>
        [...manager.slots.values()].every((slot) => slot.options.canWrite()),
    };
    return new Proxy(this.baseOptions, {
      get(base, key) {
        if (key in overrides) return overrides[key];
        if (
          [
            "agentDir",
            "host",
            "port",
            "autoPort",
            "tlsCert",
            "tlsKey",
          ].includes(key)
        )
          return base[key];
        return manager.active.options[key] ?? base[key];
      },
    });
  }
  async start() {
    if (this.closed) throw new DeskError(409, "会话管理器已关闭");
    this.bridge ??= createDeskBridge(this.routeOptions());
    this.url = await this.bridge.start();
    return this.url;
  }
  async stopTransport() {
    const bridge = this.bridge;
    this.bridge = undefined;
    this.url = undefined;
    await bridge?.stop();
  }
  async dispose() {
    if (this.disposing) return this.disposing;
    this.closed = true;
    this.nativeInteractions.cancelAll();
    this.closeView?.();
    this.disposing = (async () => {
      await this.mutation;
      const results = await Promise.allSettled(
        [...this.slots.values()].map((slot) => slot.app?.stop()),
      );
      await this.stopTransport();
      this.slots.clear();
      this.tuiDrafts.clear();
      this.listeners.clear();
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "会话清理未完成",
        );
    })();
    return this.disposing;
  }
}

const HOSTS = Symbol.for("pi-desktop.session-managers");
export function getSessionHost(agentDir, createSlot) {
  const hosts = (globalThis[HOSTS] ??= new Map());
  let host = hosts.get(agentDir);
  if (!host || host.closed) {
    host = new SessionHost({ agentDir, host: "tui", createSlot });
    hosts.set(agentDir, host);
  }
  if (createSlot) host.createSlot = createSlot;
  return host;
}
