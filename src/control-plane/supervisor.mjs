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
import { createSessionFamilies } from "./session-families.mjs";
import { createFamilyArchives } from "./family-archives.mjs";
import { createHostTasks } from "./host-tasks.mjs";
import {
  openSessionArchives,
  assertNoNativeTui,
  readNativeRecord,
} from "../session/pi-session-storage.mjs";
import { projectPiRecord } from "./pi-sessions.mjs";

/**
 * Host 侧的项目与 Agent 生命周期、只读历史视图与归档。
 *
 * 接口：`createSupervisor(store, options)` 返回 `{ shared, noteActivity, revision, read,
 *   execute, target, openTarget, restore, close, monitorTasks, manageTask, taskDetail }`；
 *   任务聚合另见 docs/architecture/interfaces/host-tasks.md，其他命令与顺序见
 *   docs/architecture/interfaces/lifecycle.md。
 * 不变量：`revision()` 不做每 Agent 的会话文件 stat，`read()` 做；追加型命令（无
 *   `input.id`）不参与 revision 冲突，已有行修改必须带 revision；历史视图按 LRU 上限 8；
 *   `restore()` 必须在任何 worker 启动前完成归档／恢复意图；有期望代际的路由同时校验
 *   目录与运行进程，不转发给新库同号任务；本模块不接触 Durable 内部。
 * 错误：DeskError 表达“未启动”“记录已丢失”“视图已关闭”“归档进行中”等状态。
 */

const FORK_REQUEST_MS = 12000;
const runningState = (state) =>
  ["starting", "running", "stopping"].includes(state.status);

export function createSupervisor(store, options) {
  const processes = new Map();
  const sessions = createPiSessions(options.agentDir),
    histories = new Map();
  const archives = openSessionArchives(options.directory, options.agentDir);
  const families = createSessionFamilies({
    store,
    directory: options.directory,
  });
  const familyArchives = createFamilyArchives({ store, archives });
  let discovering;
  async function discover() {
    return (discovering ??= (async () => {
      for (const agent of (await store.read()).agents)
        await families.remember(agent);
      const catalog = await store.read();
      const found = await families.claim(
        await sessions.scan(),
        sessions,
        catalog,
      );
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
    // 在排队前先拒绝活跃目标：starting／stopping 的 worker 会把请求卡在长时间
    // 生命周期等待后面。
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
        directory: families.directory(agent),
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
    state = {
      status: "starting",
      service,
      pid: service.child.pid,
      generation: agent.generation ?? 0,
    };
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
      await families.remember((await lookup(id)).agent);
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
    await families.remember((await lookup(id)).agent);
  }
  async function worker(id, path, input, { signal, expectedGeneration } = {}) {
    const state = processes.get(id);
    if (state?.status !== "running") throw new DeskError(409, "请先启动会话");
    // catalog 校验与这里之间可能发生 resume；固定实际进程代际，不能转发给新库的同号任务。
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== state.generation
    )
      throw new DeskError(409, "Agent 存储代际已变化，请刷新后重试");
    const response = await fetch(
      new URL(path, state.url),
      input === undefined
        ? { signal }
        : {
            signal,
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
    const current = await worker(id, "/api/agent");
    const profile = current.active;
    if (!(current.familyIdle ?? profile.idle))
      throw new DeskError(409, "请等待当前任务结束");
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
    // 只读查看已提交历史：不调度任务、不加载用户插件、不认证或调用模型。
    // Durable 的公开 reader 依然是权威。
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
  const hostTasks = createHostTasks({
    list: async () =>
      (await store.read()).agents.map((row) => ({
        ...row,
        status:
          processes.get(row.id)?.status ??
          (row.source === "pi" ? "history" : "stopped"),
      })),
    request: worker,
  });
  return {
    shared(run) {
      return serial(async () => {
        if (closing) throw new DeskError(409, "Desktop 正在关闭");
        const active = [...processes.entries()].filter(([, state]) =>
          runningState(state),
        );
        for (const [id, state] of active) {
          const current =
            state.status === "running"
              ? await worker(id, "/api/agent")
              : undefined;
          if (!current || !(current.familyIdle ?? current.active.idle))
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
    monitorTasks: hostTasks.read,
    manageTask: hostTasks.command,
    taskDetail: hostTasks.detail,
    noteActivity(id, { metadataOnly = false } = {}) {
      return serial(async () => {
        if (closing) return;
        await families.remember((await lookup(id)).agent);
        if (metadataOnly) return;
        await store.update({}, (data) => {
          const agent = data.agents.find((row) => row.id === id);
          if (agent) agent.updatedAt = new Date().toISOString();
        });
      });
    },
    /* 轮询客户端先问这个：目录 revision 加内存中的进程状态，不做 read() 会做的
     * 每 Agent 会话文件 stat。 */
    async revision() {
      const catalog = await store.read();
      const processesFingerprint = [...processes.entries()]
        .map(([id, state]) => `${id}:${state.status}:${state.pid ?? ""}`)
        .join(",");
      return {
        workspace: `${catalog.revision}:${processesFingerprint}`,
      };
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
              // 文件清单只供宿主迁移使用，不把新增的内部文件路径发给客户端。
              const { nativeSessions, ...metadata } = row;
              const members = (nativeSessions ?? []).filter(
                (member) => member.generation === (row.generation ?? 0),
              );
              return {
                ...metadata,
                rootConversationId: members.find(
                  (member) => member.forkOf === null,
                )?.id,
                branches: members
                  .filter(
                    (member) =>
                      member.forkOf && typeof member.name === "string",
                  )
                  .map(({ id, name, forkOf }) => ({ id, name, forkOf })),
                status:
                  row.source === "pi"
                    ? row.missing && !row.archived && !row.archivePending
                      ? "missing"
                      : "history"
                    : (state?.status ?? "stopped"),
                pid: running(row.id) ? state?.pid : undefined,
                error:
                  state?.error ??
                  row.archiveError ??
                  row.familyError ??
                  row.migrationError,
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
      // 追加型操作在 store 里重新校验目标与唯一性：后台历史扫描或活动时间戳不能
      // 让“新增一行”的表单失效，而已有行的改动仍保留 revision 保护。
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
        if (command === "conversation.fork") {
          const { agent, project } = await lookup(input.id);
          if (agent.source === "pi" || !project || agent.archived)
            throw new DeskError(403, "此会话不提供创建分支");
          if (!Number.isSafeInteger(input.generation) || input.generation < 0)
            throw new DeskError(422, "Agent 存储代际无效");
          if (input.generation !== (agent.generation ?? 0))
            throw new DeskError(409, "Agent 存储代际已变化，请刷新后重试");
          const options = {
            expectedGeneration: input.generation,
            signal: AbortSignal.timeout(FORK_REQUEST_MS),
          };
          const request = async (path, payload) => {
            try {
              return await worker(agent.id, path, payload, options);
            } catch (error) {
              if (options.signal.aborted)
                throw new DeskError(
                  503,
                  "创建分支超时，请刷新会话清单确认结果后再重试",
                );
              throw error;
            }
          };
          const selected =
            input.conversationId ?? (await request("/api/agent")).active.id;
          if (!Number.isSafeInteger(selected) || selected < 0)
            throw new DeskError(422, "会话 ID 无效");
          const snapshot = await request(
            `/api/state?view=chat&sessionId=${selected}`,
          );
          if (
            snapshot.sessionCommands !== true ||
            snapshot.capabilities?.readOnly === true
          )
            throw new DeskError(403, "此会话不提供创建分支");
          if (!snapshot.agents.some((row) => row.id === selected))
            throw new DeskError(404, "会话不存在");
          const result = await request(`/api/command?sessionId=${selected}`, {
            command: "fork",
            id: selected,
            sessionId: String(selected),
            mode: "tail",
          });
          await families.remember(agent);
          return result;
        }
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
          for (const row of users) {
            const current = await worker(row.id, "/api/agent");
            if (!(current.familyIdle ?? current.active.idle))
              throw new DeskError(409, "请等待使用此人格的任务结束");
          }
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
            await familyArchives.archive(
              agent,
              path,
              project?.cwd ??
                join(options.directory, "agents", agent.id, "context"),
            );
            await closeHistory(agent.id);
            patch = {
              archived: true,
              desired: false,
              archiveStored: true,
              nativeSessionPath: path,
              archivePending: false,
              archiveIntent: undefined,
              archiveError: undefined,
              missing: false,
            };
          }
          if (command === "agent.restore") {
            if (agent.archiveIntent === "archive")
              throw new DeskError(409, "会话族归档尚未完成，请先重试归档");
            if (agent.archiveStored)
              patch.nativeSessionPath = (
                await familyArchives.restore(agent)
              ).path;
            patch.archived = false;
            patch.missing = false;
            patch.archivePending = false;
            patch.archiveIntent = undefined;
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
          if (familyArchives.isFamily(agent))
            throw new DeskError(
              409,
              "会话族包含独立分支，请使用重启恢复；不能只接管一份原生记录",
            );
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
    target(id, expectedGeneration) {
      const state = processes.get(id);
      if (state?.status !== "running")
        throw new DeskError(409, "请先启动 Agent");
      if (
        expectedGeneration !== undefined &&
        expectedGeneration !== state.generation
      )
        throw new DeskError(409, "Agent 存储代际已变化，请刷新后重试");
      return state.url;
    },
    async openTarget(id, expectedGeneration) {
      const { agent } = await lookup(id);
      if (
        expectedGeneration !== undefined &&
        expectedGeneration !== (agent.generation ?? 0)
      )
        throw new DeskError(409, "Agent 存储代际已变化，请刷新后重试");
      if (
        agent.source !== "pi" &&
        !agent.archived &&
        (running(id) || !agent.nativeSessionPath)
      )
        return this.target(id, expectedGeneration);
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
        // 打开历史桥的过程中，移除操作可能已经提交。
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
        // 在任何 worker 启动前完成 durable 归档／恢复意图。
        const known = await store.read();
        for (const agent of known.agents) {
          const state = {
            id: agent.id,
            phase: (await archives).state(agent.id),
          };
          try {
            if (familyArchives.isFamily(agent)) {
              await familyArchives.recover(agent);
              continue;
            }
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
                  archivePending:
                    familyArchives.isFamily(agent) ||
                    ["archiving", "restoring"].includes(phase),
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
        // 独立的 SQLite owner 可以并发启动；失败必须保持可见。
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
      await discovering?.catch(() => {});
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
