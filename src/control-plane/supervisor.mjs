import { validateApprovalMode } from "../agent/pi-permissions.mjs";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeskError } from "../config/config-store.mjs";
import { launchService } from "./process.mjs";
import { createPiSessions, reconcilePiSessions } from "./pi-sessions.mjs";
import { openAgentWorkspace } from "../agent/agent-workspace.mjs";
import { openNativeTranscript } from "../session/pi-session-storage.mjs";
import { openPiHistory } from "./pi-history.mjs";
import {
  openSessionArchives,
  assertNoNativeTui,
  readNativeRecord,
} from "../session/pi-session-storage.mjs";
import { projectPiRecord } from "./pi-sessions.mjs";

const runningState = (state) =>
  ["starting", "running", "stopping"].includes(state.status);

export function createSupervisor(store, options) {
  const processes = new Map();
  const sessions = createPiSessions(options.agentDir),
    histories = new Map();
  const archives = openSessionArchives(options.directory, options.agentDir);
  let discovering;
  async function discover() {
    return (discovering ??= (async () => {
      const found = await sessions.scan();
      const catalog = await store.read();
      const next = {
        projects: structuredClone(catalog.projects),
        agents: structuredClone(catalog.agents),
      };
      reconcilePiSessions(next, found);
      if (
        JSON.stringify(next) !==
        JSON.stringify({ projects: catalog.projects, agents: catalog.agents })
      )
        await store.update({}, (data) => reconcilePiSessions(data, found));
    })().finally(() => {
      discovering = undefined;
    }));
  }
  let closing = false,
    queue = Promise.resolve(),
    restoring;
  const serial = (run) => {
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };
  const lookup = async (id) => {
    const catalog = await store.read();
    const agent = catalog.agents.find((row) => row.id === id);
    if (!agent) throw new DeskError(404, "Agent 不存在");
    const project = catalog.projects.find((row) => row.id === agent.projectId);
    if (project?.removedAt)
      throw new DeskError(404, "工作区已移除，请先重新添加");
    return { agent, project };
  };
  const removableProject = (catalog, id) => {
    const project = catalog.projects.find((row) => row.id === id);
    if (!project) throw new DeskError(404, "项目不存在");
    if (
      catalog.agents.some(
        (row) =>
          row.projectId === id && runningState(processes.get(row.id) ?? {}),
      )
    )
      throw new DeskError(409, "请先停止该项目的 Agent 再移除工作区");
    return project;
  };
  async function removeProject(input) {
    if (closing) throw new DeskError(409, "Desktop 正在关闭");
    // Reject active targets before joining the queue: a starting/stopping
    // worker can otherwise hold this request behind a long lifecycle await.
    removableProject(await store.read(), input.id);
    return serial(async () => {
      if (closing) throw new DeskError(409, "Desktop 正在关闭");
      const catalog = await store.read();
      if (input.revision !== undefined && input.revision !== catalog.revision)
        throw new DeskError(409, "项目清单已变化，请刷新后重试");
      const project = removableProject(catalog, input.id);
      if (!project.removedAt) await store.removeProject(input);
      await Promise.allSettled(
        catalog.agents
          .filter((row) => row.projectId === project.id)
          .map((row) => closeHistory(row.id)),
      );
      return { id: project.id, removed: true };
    });
  }
  async function start(id) {
    if (closing) throw new DeskError(409, "Desktop 正在关闭");
    const { agent, project } = await lookup(id);
    if (agent.source === "pi")
      throw new DeskError(409, "此会话由 Pi TUI 管理，Desktop 仅同步查看记录");
    if (closing) throw new DeskError(409, "Desktop 正在关闭");
    let state = processes.get(id);
    if (state?.status === "running") return state;
    if (state?.status === "starting") {
      await state.service.ready;
      return state;
    }
    if (
      agent.archivePending ||
      ["archiving", "restoring"].includes((await archives).state(id))
    )
      throw new DeskError(409, "会话迁移尚未完成，请先重试归档或恢复");
    if (agent.archived || (await archives).state(id) === "archived")
      throw new DeskError(409, "请先恢复已归档会话");
    if (agent.projectId !== null && !project)
      throw new DeskError(404, "项目不存在");
    const projectless = agent.projectId === null;
    const cwd =
      project?.cwd ?? join(options.directory, "agents", id, "context");
    if (projectless) await mkdir(cwd, { recursive: true, mode: 0o700 });
    const service = (options.launch ?? launchService)(
      fileURLToPath(new URL("./agent-worker.mjs", import.meta.url)),
      {
        cwd,
        readOnly: projectless,
        agentName: agent.name,
        approvalMode: agent.approvalMode ?? "ask-risky",
        agentInstructions:
          (await store.read()).promptProfiles.find(
            (row) => row.id === agent.promptProfileId,
          )?.instructions ?? "",
        agentDir: options.agentDir,
        directory: join(
          options.directory,
          "agents",
          id,
          ...(agent.generation ? [`resume-${agent.generation}`] : []),
        ),
        extensionPaths: projectless ? [] : options.extensionPaths,
        noExtensions: projectless || options.noExtensions,
        nativeResources: {
          ...(projectless ? { extensions: [] } : {}),
        },
        embeddedUI: true,
        nativeSessionOwner: `${agent.id}:${agent.generation ?? 0}`,
        nativeResumePath: agent.nativeResumePath,
        nativeSessionPath: agent.nativeSessionPath,
      },
    );
    state = { status: "starting", service, pid: service.child.pid };
    processes.set(id, state);
    service.child.once("exit", (code, signal) => {
      if (processes.get(id) !== state) return;
      state.status =
        state.status === "stopping" || closing ? "stopped" : "failed";
      state.url = undefined;
      if (state.status === "failed")
        state.error = `Agent 进程已退出 (${signal ?? code})，可重新启动恢复会话`;
    });
    try {
      const ready = await service.ready;
      const address = new URL(ready.url);
      if (address.protocol !== "http:" || address.hostname !== "127.0.0.1")
        throw new Error("Agent 返回了无效的本机地址");
      if (closing) throw new Error("Desktop 正在关闭");
      if (ready.nativeSession)
        await store.update({}, (data) =>
          Object.assign(
            data.agents.find((row) => row.id === id),
            {
              nativeSessionId: ready.nativeSession.nativeSessionId,
              nativeSessionPath: ready.nativeSession.path,
            },
          ),
        );
      state.url = address.href;
      state.status = "running";
      return state;
    } catch (error) {
      state.status = "failed";
      state.error = error.message;
      await service.stop();
      throw new DeskError(503, error.message);
    }
  }
  async function stop(id) {
    const state = processes.get(id);
    if (!state || ["stopped", "failed"].includes(state.status)) return;
    state.status = "stopping";
    await state.service.stop();
    state.status = "stopped";
    state.url = undefined;
  }
  async function worker(id, path, input) {
    const state = processes.get(id);
    if (state?.status !== "running") throw new DeskError(409, "请先启动会话");
    const response = await fetch(
      new URL(path, state.url),
      input === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              Origin: new URL(state.url).origin,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(input),
          },
    );
    const result = await response.json();
    if (!response.ok)
      throw new DeskError(response.status, result.error ?? "Pi 配置失败");
    return result;
  }
  async function configureWorker(id, patch) {
    const profile = (await worker(id, "/api/agent")).active;
    if (!profile.idle) throw new DeskError(409, "请等待当前任务结束");
    return worker(id, "/api/command", {
      command: "configure",
      id: profile.id,
      revision: profile.revision,
      ...patch,
    });
  }
  async function closeHistory(id) {
    const prior = histories.get(id);
    histories.delete(id);
    if (prior) await (await prior).close();
  }
  async function migrateLegacy(agent) {
    const directory = join(options.directory, "agents", agent.id);
    const storagePath = join(directory, "agents.sqlite");
    if (!(await stat(storagePath).catch(() => null))?.isFile()) return;
    // Inspect committed history without scheduling tasks, loading user plugins,
    // or authenticating/calling a model. Durable's public reader stays authoritative.
    const workspace = await openAgentWorkspace({
      storagePath,
      resume: false,
      models: { getAvailable: async () => [], getModel: () => undefined },
    });
    let transcript;
    try {
      const root = await workspace.read(),
        active = root.agents[0];
      if (!active) return;
      transcript = await openNativeTranscript({
        agentDir: options.agentDir,
        directory,
        cwd: active.cwd,
        owner: `${agent.id}:0`,
        workspace,
        id: active.id,
      });
      const native = transcript.metadata;
      if (agent.archived) {
        const completed = transcript;
        transcript = undefined;
        await completed.close();
        await (
          await archives
        ).archive(agent.id, native.path, active.cwd, native.nativeSessionId);
      }
      await store.update({}, (data) =>
        Object.assign(
          data.agents.find((row) => row.id === agent.id),
          {
            nativeSessionId: native.nativeSessionId,
            nativeSessionPath: native.path,
            ...(agent.archived ? { archiveStored: true } : {}),
            migrationError: undefined,
          },
        ),
      );
    } finally {
      try {
        await transcript?.close();
      } finally {
        await workspace.close();
      }
    }
  }
  const running = (id) =>
    ["starting", "running", "stopping"].includes(processes.get(id)?.status);
  return {
    shared(run) {
      return serial(async () => {
        if (closing) throw new DeskError(409, "Desktop 正在关闭");
        const active = [...processes.entries()].filter(([, state]) =>
          runningState(state),
        );
        for (const [id, state] of active) {
          if (
            state.status !== "running" ||
            !(await worker(id, "/api/agent")).active.idle
          )
            throw new DeskError(
              409,
              "请等待所有 Agent 的任务结束再修改全局配置",
            );
        }
        return run({
          reload: async () => {
            const results = await Promise.allSettled(
              active.map(([id]) => worker(id, "/api/reload", {})),
            );
            return results.flatMap((result, index) =>
              result.status === "rejected" ? [active[index][0]] : [],
            );
          },
        });
      });
    },
    noteActivity(id) {
      return serial(async () => {
        if (closing) return;
        await store.update({}, (data) => {
          const agent = data.agents.find((row) => row.id === id);
          if (agent) agent.updatedAt = new Date().toISOString();
        });
      });
    },
    async read() {
      void discover().catch(() => {});
      const catalog = await store.read();
      const projects = catalog.projects.filter((row) => !row.removedAt);
      const visibleProjects = new Set(projects.map((row) => row.id));
      return {
        ...catalog,
        projects,
        agents: await Promise.all(
          catalog.agents
            .filter(
              (row) =>
                row.projectId === null || visibleProjects.has(row.projectId),
            )
            .map(async (row) => {
              const state = processes.get(row.id);
              return {
                ...row,
                status:
                  row.source === "pi"
                    ? row.missing && !row.archived && !row.archivePending
                      ? "missing"
                      : "history"
                    : (state?.status ?? "stopped"),
                pid: running(row.id) ? state?.pid : undefined,
                error: state?.error ?? row.archiveError ?? row.migrationError,
                historyAvailable:
                  row.source === "pi" ||
                  row.archiveStored ||
                  !!(
                    row.nativeSessionPath &&
                    (
                      await stat(row.nativeSessionPath).catch(() => null)
                    )?.isFile()
                  ),
              };
            }),
        ),
      };
    },
    execute(command, input = {}) {
      // Append operations revalidate their target/uniqueness in the store. A
      // background history scan or activity timestamp cannot invalidate a form
      // that adds a new row; existing-row mutations retain revision protection.
      input = { ...input };
      if (
        !input.id &&
        [
          "conversation.create",
          "agent.save",
          "project.save",
          "prompt.save",
        ].includes(command)
      )
        delete input.revision;
      if (command === "project.remove") return removeProject(input);
      if (
        command === "agent.archive" &&
        ["starting", "stopping"].includes(processes.get(input.id)?.status)
      )
        return Promise.reject(
          new DeskError(409, "会话进程正在启动或停止，请稍候再归档"),
        );
      return serial(async () => {
        if (closing) throw new DeskError(409, "Desktop 正在关闭");
        const catalog = await store.read();
        if (input.revision !== undefined && input.revision !== catalog.revision)
          throw new DeskError(409, "项目清单已变化，请刷新后重试");
        if (command === "project.rename") {
          if (
            typeof input.name !== "string" ||
            !input.name.trim() ||
            input.name.length > 120
          )
            throw new DeskError(422, "项目名称无效");
          if (
            !catalog.projects.some(
              (row) => row.id === input.id && !row.removedAt,
            )
          )
            throw new DeskError(404, "项目不存在");
          await store.update(input, (data) => {
            data.projects.find((row) => row.id === input.id).name =
              input.name.trim();
          });
          return { id: input.id };
        }
        if (command === "prompt.save") {
          const users = input.id
            ? catalog.agents.filter(
                (row) => row.promptProfileId === input.id && running(row.id),
              )
            : [];
          for (const row of users)
            if (!(await worker(row.id, "/api/agent")).active.idle)
              throw new DeskError(409, "请等待使用此人格的任务结束");
          const saved = await store.prompt(input);
          for (const row of users)
            await configureWorker(row.id, {
              instructions: input.instructions ?? "",
            });
          return saved;
        }
        if (
          [
            "agent.rename",
            "agent.pin",
            "agent.archive",
            "agent.restore",
            "agent.policy",
            "agent.prompt",
          ].includes(command)
        ) {
          const { agent } = await lookup(input.id);
          if (
            agent.source === "pi" &&
            ["agent.policy", "agent.prompt"].includes(command)
          )
            throw new DeskError(403, "请在原 Pi TUI 中配置此会话");
          let patch = {};
          if (command === "agent.rename") {
            if (
              typeof input.name !== "string" ||
              !input.name.trim() ||
              input.name.length > 120
            )
              throw new DeskError(422, "会话名称无效");
            patch.name = input.name.trim();
            if (agent.source === "pi") patch.nameOverride = true;
            if (running(agent.id))
              await configureWorker(agent.id, { name: patch.name });
          }
          if (command === "agent.pin") patch.pinned = !agent.pinned;
          if (command === "agent.archive") {
            if (running(agent.id))
              throw new DeskError(409, "正在运行的会话不能归档，请先停止进程");
            const path = agent.nativeSessionPath ?? sessions.path(agent.id);
            const { project } = await lookup(agent.id);
            try {
              await (
                await archives
              ).archive(
                agent.id,
                path,
                project?.cwd ??
                  join(options.directory, "agents", agent.id, "context"),
                agent.nativeSessionId,
              );
            } catch (error) {
              const pending = (await archives).state(agent.id) === "archiving";
              if (pending)
                await store.update({}, (data) =>
                  Object.assign(
                    data.agents.find((row) => row.id === agent.id),
                    {
                      archivePending: true,
                      desired: false,
                      archiveError:
                        "归档尚未完成，记录已备份到 SQLite，请重试归档",
                    },
                  ),
                );
              throw error;
            }
            await closeHistory(agent.id);
            patch = {
              archived: true,
              desired: false,
              archiveStored: true,
              nativeSessionPath: path,
              archivePending: false,
              archiveError: undefined,
              missing: false,
            };
          }
          if (command === "agent.restore") {
            if (agent.archiveStored)
              patch.nativeSessionPath = (
                await (await archives).restore(agent.id)
              ).path;
            patch.archived = false;
            patch.missing = false;
            patch.archivePending = false;
            patch.archiveError = undefined;
            await closeHistory(agent.id);
          }
          if (command === "agent.policy") {
            patch.approvalMode = validateApprovalMode(input.mode);
            if (running(agent.id))
              await worker(agent.id, "/api/approval", {
                mode: patch.approvalMode,
              });
          }
          if (command === "agent.prompt") {
            const prompt = catalog.promptProfiles.find(
              (row) => row.id === input.promptProfileId,
            );
            if (input.promptProfileId !== "standard" && !prompt)
              throw new DeskError(404, "系统提示词不存在");
            patch.promptProfileId = input.promptProfileId;
            if (running(agent.id))
              await configureWorker(agent.id, {
                instructions: prompt?.instructions ?? "",
              });
          }
          await store.update(input, (data) =>
            Object.assign(
              data.agents.find((row) => row.id === agent.id),
              patch,
              { updatedAt: new Date().toISOString() },
            ),
          );
          return { id: agent.id };
        }
        if (command === "agent.resume") {
          const { agent, project } = await lookup(input.id);
          const phase = (await archives).state(agent.id);
          if (
            agent.archivePending ||
            ["archiving", "restoring"].includes(phase)
          )
            throw new DeskError(409, "会话迁移尚未完成，请先完成归档或恢复");
          if (agent.archived || phase === "archived")
            throw new DeskError(409, "请先恢复已归档会话");
          if (running(agent.id))
            throw new DeskError(409, "请先停止当前 Desktop 进程");
          const path = agent.nativeSessionPath ?? sessions.path(agent.id);
          const record = await readNativeRecord(path, options.agentDir);
          const cwd =
            project?.cwd ??
            (agent.projectId === null
              ? join(options.directory, "agents", agent.id, "context")
              : undefined);
          if (!cwd || record.header.cwd !== cwd)
            throw new DeskError(422, "会话目录与项目不一致，无法接管");
          await assertNoNativeTui(cwd);
          await closeHistory(agent.id);
          await store.update(input, (data) =>
            Object.assign(
              data.agents.find((row) => row.id === agent.id),
              {
                source: "desktop",
                nativeResumePath: path,
                nativeSessionPath: path,
                generation: (agent.generation ?? 0) + 1,
                desired: true,
                missing: false,
                approvalMode: agent.approvalMode ?? "ask-risky",
                promptProfileId: agent.promptProfileId ?? "standard",
              },
            ),
          );
          await start(agent.id);
          return { id: agent.id };
        }
        if (command === "project.save") {
          if (
            input.id &&
            catalog.agents.some(
              (row) => row.projectId === input.id && running(row.id),
            )
          )
            throw new DeskError(409, "请先停止该项目的 Agent 再修改配置");
          return store.project(input);
        }
        if (command === "conversation.create") {
          const created = await store.agent({
            ...input,
            name: input.name ?? "新对话",
          });
          await store.update({}, (data) => {
            data.agents.find((row) => row.id === created.id).desired = true;
          });
          await start(created.id);
          return created;
        }
        if (command === "agent.save") {
          if (input.id && running(input.id))
            throw new DeskError(409, "请先停止 Agent 再修改配置");
          return store.agent(input);
        }
        if (!["agent.start", "agent.stop", "agent.restart"].includes(command))
          throw new DeskError(404, "不支持的 Desktop 操作");
        const targetAgent = (await lookup(input.id)).agent;
        if (targetAgent.source === "pi")
          throw new DeskError(403, "Desktop 不管理原 Pi TUI 进程");
        await store.update(input, (data) => {
          data.agents.find((row) => row.id === input.id).desired =
            command !== "agent.stop";
        });
        if (command !== "agent.start") await stop(input.id);
        if (command !== "agent.stop") await start(input.id);
        return { id: input.id };
      });
    },
    target(id) {
      const state = processes.get(id);
      if (state?.status !== "running")
        throw new DeskError(409, "请先启动 Agent");
      return state.url;
    },
    async openTarget(id) {
      const { agent } = await lookup(id);
      if (
        agent.source !== "pi" &&
        !agent.archived &&
        (running(id) || !agent.nativeSessionPath)
      )
        return this.target(id);
      if (
        agent.source !== "pi" &&
        !agent.archived &&
        !(await stat(agent.nativeSessionPath).catch(() => null))?.isFile()
      )
        throw new DeskError(409, "请先启动 Agent");
      if (agent.missing && !agent.archived && !agent.archivePending)
        throw new DeskError(404, "Pi 会话记录已不存在");
      if (!histories.has(id)) {
        if (histories.size >= 8) {
          const oldest = histories.keys().next().value;
          const prior = histories.get(oldest);
          histories.delete(oldest);
          await (await prior).close();
        }
        let archivedView;
        histories.set(
          id,
          openPiHistory({
            agent,
            agentDir: options.agentDir,
            read: async () => {
              const current = (await lookup(id)).agent;
              const value =
                current.archived || current.archivePending
                  ? (archivedView ??= projectPiRecord(
                      (await archives).read(id),
                      id,
                    ))
                  : current.nativeSessionPath
                    ? await sessions.readPath(id, current.nativeSessionPath)
                    : await sessions.read(id);
              return {
                ...value,
                name: current.name,
                archived: !!current.archived,
                archivePending: !!current.archivePending,
              };
            },
          }),
        );
      }
      const pending = histories.get(id);
      try {
        const history = await pending;
        // Removal may commit while this history bridge is being opened.
        await lookup(id);
        if (!history || histories.get(id) !== pending)
          throw new DeskError(409, "会话视图已关闭，请重试");
        return history.url;
      } catch (error) {
        if (histories.get(id) === pending)
          await closeHistory(id).catch(() => {});
        throw error;
      }
    },
    restore() {
      return (restoring ??= serial(async () => {
        // Finish durable archive/restore intents before any worker can boot.
        const known = await store.read();
        for (const state of (await archives).states()) {
          const agent = known.agents.find((row) => row.id === state.id);
          if (!agent) continue;
          try {
            let record, archived;
            if (state.phase === "archiving") {
              record = await (await archives).completeArchive(agent.id);
              archived = true;
            } else if (state.phase === "restoring") {
              record = await (await archives).restore(agent.id);
              archived = false;
            } else if (state.phase === "snapshot" && agent.archived) {
              const saved = (await archives).read(agent.id);
              record = await (
                await archives
              ).archive(
                agent.id,
                saved.path,
                saved.header.cwd,
                saved.header.id,
              );
              archived = true;
            } else if (state.phase === "archived" && !agent.archived) {
              record = (await archives).read(agent.id);
              archived = true;
            } else if (state.phase === "restored" && agent.archived) {
              record = (await archives).read(agent.id);
              archived = false;
            }
            if (record)
              await store.update({}, (data) =>
                Object.assign(
                  data.agents.find((row) => row.id === agent.id),
                  {
                    archived,
                    desired: false,
                    archiveStored: true,
                    nativeSessionPath: record.path,
                    missing: false,
                    archivePending: false,
                    archiveError: undefined,
                  },
                ),
              );
          } catch (error) {
            const phase = (await archives).state(agent.id);
            await store.update({}, (data) =>
              Object.assign(
                data.agents.find((row) => row.id === agent.id),
                {
                  archivePending: ["archiving", "restoring"].includes(phase),
                  desired: false,
                  archiveError:
                    error instanceof DeskError
                      ? error.message
                      : "会话迁移尚未完成，原始记录保留，请重试",
                },
              ),
            );
          }
        }
        const initial = await store.read();
        const initialProjects = new Set(
          initial.projects.filter((row) => !row.removedAt).map((row) => row.id),
        );
        for (const agent of initial.agents.filter(
          (row) =>
            row.source !== "pi" &&
            !row.nativeSessionPath &&
            (row.projectId === null || initialProjects.has(row.projectId)),
        )) {
          try {
            await migrateLegacy(agent);
          } catch (error) {
            await store.update({}, (data) => {
              data.agents.find((row) => row.id === agent.id).migrationError =
                error instanceof DeskError
                  ? error.message
                  : "历史导出失败，原 SQLite 记录已保留";
            });
          }
        }
        const catalog = await store.read();
        const visibleProjects = new Set(
          catalog.projects.filter((row) => !row.removedAt).map((row) => row.id),
        );
        // Independent SQLite owners can boot concurrently. Failures remain visible.
        await Promise.allSettled(
          catalog.agents
            .filter(
              (row) =>
                row.source !== "pi" &&
                row.desired &&
                (row.projectId === null ||
                  visibleProjects.has(row.projectId)) &&
                !row.archived &&
                !row.archivePending,
            )
            .map((row) => start(row.id)),
        );
      }));
    },
    async close() {
      closing = true;
      await queue;
      await restoring?.catch(() => {});
      await Promise.allSettled([...processes.keys()].map(stop));
      await Promise.allSettled(
        [...histories.values()].map(async (value) => (await value).close()),
      );
      await sessions.close();
      (await archives).close();
    },
  };
}
