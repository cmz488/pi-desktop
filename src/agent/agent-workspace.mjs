import { mkdir, realpath, stat, chmod } from "node:fs/promises";
import { dirname, resolve, basename } from "node:path";
import lockfile from "proper-lockfile";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineDoc,
  defineExtension,
  section,
  configure,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import durableManifest from "@earendil-works/pi-durable/package.json" with { type: "json" };
import {
  calculateContextTokens,
  estimateMessageTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import { projectMessage } from "../shared/conversation.mjs";
import { ownedConversationIds } from "../shared/conversation-scope.mjs";
import { DeskError } from "../config/config-store.mjs";
import { DesktopResources } from "./desktop-documents.mjs";
import { loadPiMessages, loadPiSessionManager } from "./pi-sdk.mjs";

import { readOnlyEnvironment, ReadOnlyWeb } from "./read-only-tools.mjs";

const context = BACKGROUND_CONTEXT;
const AgentProfile = defineDoc({
  kind: "desk.agent",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ name: "Agent", revision: 1, shellPath: "", shellEnv: {} }),
});
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const text = (value, limit, label) => {
  if (typeof value !== "string" || value.length > limit || value.includes("\0"))
    throw new DeskError(422, `${label}无效`);
  return value;
};
async function projectDirectory(input) {
  text(input, 4096, "项目目录");
  try {
    const cwd = await realpath(resolve(input));
    if (!(await stat(cwd)).isDirectory()) throw new Error("not directory");
    return cwd;
  } catch {
    throw new DeskError(422, "项目目录不存在或无法访问");
  }
}
function usageTotal(doc = {}) {
  const total = {
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  for (const row of Object.values(doc.models ?? {})) {
    total.tokens += row.totalTokens ?? 0;
    total.cost += row.cost?.total ?? 0;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"])
      total[key] += row[key] ?? 0;
  }
  // 工具计费计入花费，但从不进入模型缓存命中率分母。
  for (const row of Object.values(doc.tools ?? {}))
    total.cost += row.cost?.total ?? 0;
  return total;
}
function contextUsage(view, contextWindow) {
  if (!(contextWindow > 0)) return null;
  let measured;
  const after = view.head?.id ?? -Infinity;
  for (let index = view.entries.length - 1; index >= 0 && !measured; index--) {
    if (view.entries[index].id <= after) continue;
    measured = view.contributions[index].findLast(
      (message) =>
        message.role === "assistant" &&
        calculateContextTokens(message.usage) > 0,
    );
  }
  if (view.head && !measured)
    return { tokens: null, percent: null, contextWindow, estimated: true };
  const from = measured ? view.messages.lastIndexOf(measured) + 1 : 0;
  const trailing = view.messages.slice(from);
  const tokens =
    (measured ? calculateContextTokens(measured.usage) : 0) +
    trailing.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return {
    tokens,
    contextWindow,
    percent: (tokens / contextWindow) * 100,
    estimated: !measured || trailing.length > 0,
  };
}

/**
 * Durable workspace：把 Durable Harness 的会话、任务、文档与用量包成一个深 module。
 *
 * 接口：`openAgentWorkspace(options)` 返回 `{ read, live, agent, execute, transcript,
 *   persistNative, importNative, install, subscribe, close }`；options、命令表、
 *   不变量与错误表见 docs/architecture/interfaces/durable-workspace.md。
 * `read()` 额外返回 `recovery`（本次打开时接管的待恢复任务及实时状态，无则 null）。
 * 不变量：单 writer（proper-lockfile 独占 + SQLite）；先 commit 再显示；每次调用先过
 *   `guard()`；`read` 是全量摘要、`live` 跳过 transcript；每会话一份 agent 文档。
 * 错误：DeskError(404／409／422) 表达“不存在”“存储被占用或宿主已关闭”“参数无效”。
 */
// 应用侧的 seam：调用者提交具名命令、读取已提交视图；准入、重放、调度、压缩与取消
// 都由 Durable 拥有。
export async function openAgentWorkspace(options) {
  const { models } = options;
  if (
    !models ||
    typeof Harness.open !== "function" ||
    typeof createRegistry !== "function"
  )
    throw new Error("Pi Durable 公开接口不兼容");
  const registry = options.registry ?? createRegistry();
  registry.install(
    options.readOnly
      ? defineExtension({
          name: "coding-tools",
          tools: CodingTools.tools.filter((tool) => tool.name === "read"),
        })
      : CodingTools,
  );
  if (options.readOnly) registry.install(ReadOnlyWeb);
  registry.install(
    defineExtension({
      name: "desk-context",
      sections: options.readOnly
        ? []
        : [
            section("working_directory", (input) => input.env?.cwd),
            section("project_instructions", async (input, ctx) => {
              const value = await input.env?.readTextFile("AGENTS.md", ctx);
              return value?.ok ? value.value.slice(0, 64000) : undefined;
            }),
          ],
    }),
  );
  if (!options.readOnly)
    for (const extension of options.extensions ?? [])
      registry.install(extension);
  let release,
    storage = options.storage,
    harness,
    graph;
  let closed = false,
    closePromise,
    compromised,
    ownerReady = false;
  let interrupted = [],
    resumedAt = "";
  const recoveryTask = (task) => ({
    id: task.id,
    kind: task.kind,
    conversationId: task.conversationId,
    background: !!task.background,
    statusAtOpen: task.state.status,
  });
  /* 恢复状态是追加式的读模型：记录新宿主接管时看到的待恢复任务，并按当前任务图汇报每项
   * 是否仍在进行，供 /api/state 与界面展示；没有待恢复工作时为 null。 */
  function recoveryStatus() {
    if (!interrupted.length) return null;
    const live = graph.value.tasks;
    const tasks = interrupted.map((task) => ({
      ...task,
      status: live[task.id] ? live[task.id].state.status : "done",
    }));
    return {
      resumedAt,
      count: tasks.length,
      outstanding: tasks.filter((task) => task.status !== "done").length,
      tasks,
    };
  }
  const listeners = new Set();
  const notify = (event) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* a disconnected UI cannot break commits */
      }
    }
  };
  try {
    if (!storage) {
      const path = resolve(options.storagePath);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        release = await lockfile.lock(path, {
          realpath: false,
          stale: 10000,
          update: 2000,
          onCompromised: (error) => {
            compromised = error;
            if (ownerReady) void close().catch(() => {});
          },
        });
      } catch (error) {
        if (error.code === "ELOCKED")
          throw new DeskError(409, "Agent 存储正在被另一个宿主占用");
        throw error;
      }
      storage = await openNodeSqliteStorage(path);
      await chmod(path, 0o600);
    }
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: options.settings,
        env:
          options.env ??
          (async (target, ctx) => {
            const profile = await target.read.snapshot(
              AgentProfile,
              target.conversationId,
              ctx,
            );
            const env = new NodeExecutionEnv({
              cwd: target.cwd,
              shellPath: profile?.shellPath || undefined,
              shellEnv: { ...process.env, ...profile?.shellEnv },
            });
            return options.readOnly ? readOnlyEnvironment(env) : env;
          }),
      },
      context,
    );
    graph = await harness.taskGraph(context);
    // 上一次 owner（崩溃或关闭）留下的工作：重启后运行中的任务以 pending 出现，
    // 而本进程还没创建任何任务，所以此刻图里的每个节点都是待恢复工作。
    interrupted = Object.values(graph.value.tasks).map(recoveryTask);
    resumedAt = new Date().toISOString();
  } catch (error) {
    if (harness) await harness.close(context);
    else await storage?.close?.(context);
    await release?.();
    throw error;
  }
  const unsubscribe = harness.subscribeCommits(() => queueMicrotask(notify));
  const unsubscribeRegistry = registry.subscribe(notify);
  const guard = () => {
    if (closed || compromised) throw new DeskError(409, "Agent 宿主已关闭");
  };
  /* 一次扫描拿到全部会话记录：顶层会话（含 ownerless 分支）与子会话共用同一份记录，
   * parent/owner 是 Durable 自己的关系字段，界面不再依赖会话文档里的副本。 */
  async function scanAll() {
    return harness.commit(async (tx) => {
      const rows = [];
      let cursor;
      do {
        const page = await tx.scanConversations({}, 200, cursor);
        rows.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
      return rows;
    }, context);
  }
  async function conversations() {
    return (await scanAll()).filter((row) => !row.owner);
  }
  async function conversation(id, { allowOwned = false } = {}) {
    if (!Number.isSafeInteger(id) || id < 0)
      throw new DeskError(422, "Agent ID 无效");
    const found = await harness.conversation(id, context);
    const managed = await harness.snapshot(AgentProfile, id, context);
    // 子会话没有 Desktop 配置文档，但任务面板仍需观察它的在跑工具；写命令不走这个例外。
    const owned =
      !managed && allowOwned
        ? (await scanAll()).some((row) => row.id === id && row.owner)
        : false;
    if (!found || (!managed && !owned))
      throw new DeskError(404, "Agent 不存在");
    return found;
  }
  async function scopedTask(id, taskId) {
    if (!Number.isSafeInteger(taskId) || taskId < 0)
      throw new DeskError(422, "任务 id 无效");
    const task = await harness.getTask(taskId, context);
    const scope = ownedConversationIds(id, await scanAll());
    // 越界与未知任务使用同一个错误，不能借任务 id 查询其他会话的工作。
    if (!task || !scope.has(task.conversationId))
      throw new DeskError(404, "任务不存在");
    return task;
  }
  async function repairNativeContext(selected) {
    // 旧版导入把原生 UI 角色写进了模型历史。用 Durable 的编辑修复生效贡献；
    // 不可变历史与原生 entry ID 保持不变。必须在资源读取或任务续跑之前完成。
    const { convertToLlm } = await loadPiMessages();
    const view = await selected.context(context);
    const edits = view.entries.flatMap((entry, index) => {
      const messages = view.contributions[index];
      return entry.data?.nativeSessionId &&
        messages.some((message) => message.role === "custom")
        ? [
            {
              target: entry.id,
              action: "replace",
              messages: convertToLlm(messages),
            },
          ]
        : [];
    });
    if (edits.length)
      await selected.commit(
        (tx) =>
          tx.appendEntry(selected.id, {
            kind: "desk.native-context-upgrade",
            edits,
          }),
        context,
      );
  }
  const foreground = (id) =>
    Object.values(graph.value.tasks).some(
      (task) => task.conversationId === id && !task.background,
    );
  /* Pi 的 UI 角色已规范成 LLM 消息，界面贡献不能再从 model 反推，否则会丢卡片或显示摘要。
   * `projectActive` 与退回的“消息原点”必须沿用同一条规则，避免过滤后发生索引错位。 */
  const contributed = (entry) =>
    (Array.isArray(entry.data?.nativeMessages)
      ? entry.data.nativeMessages
      : entry.data?.nativeMessage?.role === "custom"
        ? [entry.data.nativeMessage]
        : (entry.model ?? [])
    ).filter((message) =>
      ["user", "assistant", "toolResult", "custom"].includes(message.role),
    );
  // 兼容未提供原生来源的直接调用方；复杂历史无法对齐时必须拒绝，不能伪装成标记来源。
  const prefixOrigins = (entries, entryId) =>
    entries
      .filter((entry) => entry.id <= entryId)
      .flatMap((entry) =>
        contributed(entry).map(
          (_, index) => entry.data?.origins?.[index] ?? entry.id,
        ),
      );
  async function summary(conversation) {
    const [agent, profile] = await Promise.all([
      conversation.agent(context),
      harness.snapshot(AgentProfile, conversation.id, context),
    ]);
    return {
      id: conversation.id,
      name: profile?.name ?? "Agent",
      revision: profile?.revision ?? 0,
      cwd: agent.cwd,
      model: profile?.pendingConfiguration?.model ?? agent.model,
      thinkingLevel:
        profile?.pendingConfiguration?.thinkingLevel ?? agent.thinkingLevel,
      configurationPending: !!profile?.pendingConfiguration,
      pendingConfiguration: profile?.pendingConfiguration ?? null,
      tools: agent.tools.map((tool) => tool.name),
      extensions: agent.extensions.map((extension) => extension.name),
      instructions: agent.instructions ?? "",
      shellPath: profile?.shellPath ?? "",
      environmentKeys: Object.keys(profile?.shellEnv ?? {}),
      nativeInitialized: !!profile?.nativeInitialized,
      nativeDefaults: profile?.nativeDefaults !== false,
      idle: !foreground(conversation.id),
    };
  }
  async function agent(id) {
    guard();
    const selected = await conversation(id);
    return {
      ...(await summary(selected)),
      resourceState: await harness.snapshot(
        DesktopResources,
        selected.id,
        context,
      ),
    };
  }
  // Agent 投影的轻量一半：足够便宜，可以每个流式窗口跑一次。`transcript` 会加上
  // 昂贵部分（每条已提交 entry 都过 projectMessage），所以只需要状态／流式片段／
  // 工具的调用者必须关掉它。
  async function projectActive(
    id,
    { transcript: withTranscript = true, allowOwned = false } = {},
  ) {
    const selected = await conversation(id, { allowOwned });
    const view = await selected.viewState(context);
    try {
      const live = view.value.docs["pi.live"] ?? {};
      const entries = view.value.entries;
      const agentSummary = await summary(selected);
      const model =
        agentSummary.model &&
        models.getModel(
          agentSummary.model.provider,
          agentSummary.model.modelId,
        );
      const projected = await selected.context(context);
      const lastEntry = entries.at(-1);
      const active = {
        ...agentSummary,
        contextUsage: contextUsage(projected, model?.contextWindow),
        ...(withTranscript
          ? {
              messages: entries.flatMap((entry) =>
                contributed(entry).map((message, index) => ({
                  ...projectMessage(message, `${entry.id}:${index}`),
                  entryId: entry.data?.origins?.[index] ?? entry.id,
                  stopReason: message.stopReason,
                  error: message.errorMessage,
                })),
              ),
            }
          : {}),
        partial: live.generation?.message
          ? projectMessage(live.generation.message, "partial")
          : null,
        liveTools: live.tools ?? [],
        retry: live.generation?.retry,
        compactions: live.compactions ?? [],
        queued: (view.value.docs["pi.inbox"]?.items ?? []).map((item) => ({
          id: item.id,
          mode: item.mode,
        })),
        usage: usageTotal(view.value.docs["pi.usage"]),
        resourceState: await harness.snapshot(
          DesktopResources,
          selected.id,
          context,
        ),
        // 廉价的结构指纹：live 窗口用它比对，而不是重建整个 transcript 来判断
        // 历史是否变化。
        entryCount: entries.length,
        lastEntryId: lastEntry ? String(lastEntry.id) : "",
      };
      if (!withTranscript) return active;
      const latestResources = new Map(
        (active.resourceState?.entries ?? []).map((entry) => [
          entry.customType,
          entry,
        ]),
      );
      for (const [type, entry] of latestResources) {
        const message = projectMessage(
          {
            role: "custom",
            customType: type,
            display: true,
            content: "",
            details: entry.data,
          },
          `resource:${type}`,
        );
        if (message.extensionView) active.messages.push(message);
      }
      return active;
    } finally {
      view.dispose();
    }
  }
  async function live(id) {
    guard();
    return projectActive(id, { transcript: false, allowOwned: true });
  }
  async function read(id) {
    guard();
    const records = await scanAll();
    const agents = [];
    for (const record of records) {
      if (record.owner) continue;
      if (await harness.snapshot(AgentProfile, record.id, context))
        agents.push({
          ...(await summary(await harness.conversation(record.id, context))),
          // 分叉来源取自会话记录：顶层会话也可能是从更早的会话分叉来的。
          parent: record.parent ?? null,
        });
    }
    /* 子会话：被任务拥有的会话（子代理）等非顶层会话；顶层会话见 agents。 */
    const children = [];
    for (const record of records) {
      if (!record.owner) continue;
      const profile = await harness.snapshot(AgentProfile, record.id, context);
      children.push({
        id: record.id,
        name: profile?.name ?? `会话 ${record.id}`,
        parent: record.parent ?? null,
        owner: record.owner,
        idle: !foreground(record.id),
      });
    }
    const available = (await models.getAvailable()).map((model) => ({
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      api: model.api,
      contextWindow: model.contextWindow,
    }));
    const snapshot = registry.snapshot();
    const result = {
      frameworkVersion: durableManifest.version,
      agents,
      models: available,
      tools: [...new Set(snapshot.tools().map((row) => row.tool.name))],
      toolRegistrations: snapshot
        .tools()
        .map((row) => ({ name: row.tool.name, extension: row.extension.name })),
      extensions: snapshot.installed().map((extension) => extension.name),
      tasks: Object.values(graph.value.tasks).map((task) => ({
        id: task.id,
        conversationId: task.conversationId,
        kind: task.kind,
        status: task.state.status,
        background: !!task.background,
        // 所有权边：父任务；null 表示由会话自己拥有。
        owner: task.owner ?? null,
        // waiting 时等待的任务 id；其余状态为空数组。
        waitingOn: task.state.on ?? [],
      })),
      children,
      recovery: recoveryStatus(),
      active: null,
    };
    if (id === undefined) return result;
    result.active = await projectActive(id);
    return result;
  }
  async function changes(input, prior) {
    const patch = {},
      profile = {};
    if (
      options.readOnly &&
      prior &&
      input.cwd !== undefined &&
      input.cwd !== prior.cwd
    )
      throw new DeskError(403, "无项目会话不能切换到项目目录");
    if (input.cwd !== undefined) patch.cwd = await projectDirectory(input.cwd);
    if (input.name !== undefined)
      profile.name =
        text(input.name, 120, "Agent 名称").trim() ||
        basename(patch.cwd ?? prior?.cwd ?? "Agent");
    if (input.instructions !== undefined)
      patch.instructions = text(input.instructions, 64000, "额外指令");
    if (input.thinkingLevel !== undefined) {
      if (!levels.includes(input.thinkingLevel))
        throw new DeskError(422, "思考等级无效");
      patch.thinkingLevel = input.thinkingLevel;
    }
    if (input.model !== undefined) {
      const model = models.getModel(
        input.model?.provider,
        input.model?.modelId,
      );
      if (!model) throw new DeskError(422, "模型不存在，请先配置提供商");
      patch.model = { provider: model.provider, modelId: model.id };
    }
    const snapshot = registry.snapshot();
    for (const key of ["tools", "extensions"]) {
      if (input[key] === undefined) continue;
      if (
        !Array.isArray(input[key]) ||
        input[key].some((name) => typeof name !== "string")
      )
        throw new DeskError(422, "工具或扩展选择无效");
      const known =
        key === "tools"
          ? new Map(snapshot.tools().map((row) => [row.tool.name, row.tool]))
          : new Map(
              snapshot
                .installed()
                .map((extension) => [extension.name, extension]),
            );
      patch[key] = input[key].map((name) => {
        if (
          options.readOnly &&
          key === "tools" &&
          !["read", "web_fetch", "web_search", "agent_browser"].includes(name)
        )
          throw new DeskError(403, "无项目会话不能启用写入、Shell 或插件工具");
        if (
          key === "extensions" &&
          name.startsWith("desk-native:") &&
          name !== `desk-native:${prior?.id}`
        )
          throw new DeskError(422, "不能选择其他 Agent 的工具运行环境");
        if (!known.has(name))
          throw new DeskError(
            422,
            `未知${key === "tools" ? "工具" : "扩展"}：${name}`,
          );
        return known.get(name);
      });
    }
    if (input.tools !== undefined) profile.nativeDefaults = false;
    for (const key of ["nativeInitialized", "nativeDefaults"])
      if (typeof input[key] === "boolean") profile[key] = input[key];
    if (input.shellPath !== undefined)
      profile.shellPath = text(input.shellPath, 4096, "Shell 路径");
    if (input.shellEnv !== undefined) {
      if (
        !input.shellEnv ||
        Array.isArray(input.shellEnv) ||
        typeof input.shellEnv !== "object" ||
        Object.keys(input.shellEnv).length > 100
      )
        throw new DeskError(422, "环境变量无效");
      profile.shellEnv = Object.fromEntries(
        Object.entries(input.shellEnv).map(([key, value]) => {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            throw new DeskError(422, "环境变量名称无效");
          return [key, text(value, 8192, "环境变量值")];
        }),
      );
    }
    return { patch, profile };
  }
  async function execute(command, input = {}) {
    guard();
    if (command === "create") {
      const { patch, profile } = await changes(input);
      patch.extensions ??= registry
        .snapshot()
        .installed()
        .filter((extension) => !extension.name.startsWith("desk-native:"));
      if (!patch.cwd) throw new DeskError(422, "请选择项目目录");
      const created = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: patch,
          init: async (tx, id) =>
            Object.assign(await tx.doc(AgentProfile, id), profile),
        },
        context,
      );
      return { id: created.id };
    }
    const selected = await conversation(input.id);
    if (command === "send") {
      const message = text(input.message, 512000, "消息");
      if (!message.trim() && !input.images?.length)
        throw new DeskError(422, "消息不能为空");
      const requestId = text(input.requestId, 200, "请求 ID");
      if (!requestId) throw new DeskError(422, "缺少请求 ID");
      const model = (await selected.agent(context)).model;
      const definition =
        model && models.getModel(model.provider, model.modelId);
      if (!definition || !(await models.getAuth(definition)))
        throw new DeskError(422, "请先为 Agent 选择已配置的模型");
      const mode = input.mode ?? "followUp";
      if (!["steer", "followUp", "reject"].includes(mode))
        throw new DeskError(422, "消息模式无效");
      const submission = await selected.submit(
        {
          type: "input",
          content: input.images?.length
            ? [{ type: "text", text: message }, ...input.images]
            : message,
          requestId,
          whenBusy: mode,
        },
        context,
      );
      return { id: selected.id, submissionId: submission.id };
    }
    if (command === "abort") {
      notify({ type: "abort", id: selected.id });
      await selected.abort(context, { background: input.background === true });
      return { id: selected.id };
    }
    if (command === "compact") {
      return { taskId: await selected.compact(input.instructions, context) };
    }
    if (command === "configure") {
      const prior = await summary(selected);
      const { patch, profile } = await changes(input, prior);
      let deferred = false;
      await selected.commit(async (tx) => {
        // profile revision 与任务扫描都在 Durable 的提交线上校验。
        const tasks = await Promise.all(
          ["pending", "running", "waiting", "completing"].map((status) =>
            tx.scanTasks({ conversationId: selected.id, status }, 1),
          ),
        );
        const running = tasks.some((page) => page.items.length);
        const document = await tx.doc(AgentProfile, selected.id);
        if (
          input.revision !== undefined &&
          input.revision !== document.revision
        )
          throw new DeskError(409, "Agent 配置已变化，请刷新");
        if (running) {
          const canDefer =
            input.defer === true &&
            Object.keys(patch).length > 0 &&
            Object.keys(patch).every((key) =>
              ["model", "thinkingLevel"].includes(key),
            ) &&
            Object.keys(profile).length === 0;
          if (!canDefer)
            throw new DeskError(409, "请等待 Agent 空闲后修改运行配置");
          document.pendingConfiguration = {
            ...document.pendingConfiguration,
            ...patch,
          };
          deferred = true;
        } else {
          await configure(tx, selected.id, patch);
          delete document.pendingConfiguration;
        }
        Object.assign(document, profile);
        document.revision++;
      }, context);
      return { id: selected.id, deferred };
    }
    if (command === "fork") {
      if (!Number.isSafeInteger(input.entryId))
        throw new DeskError(422, "分叉位置无效");
      const fork = await selected.fork(
        input.entryId,
        {
          ownership: { kind: "ownerless" },
          init: async (tx, id) => {
            const profile = await tx.doc(AgentProfile, id);
            profile.name += " · 分支";
            profile.revision++;
          },
        },
        context,
      );
      // 分叉可能停在父会话的修复条目之前，从而再次继承旧的 custom 贡献。
      await repairNativeContext(fork);
      return { id: fork.id };
    }
    if (command === "rewind") {
      // 退回：追加一个头部标记（head: "self"），它的 model 就是退回点之前的模型上下文，
      // 因此后续回合从该点继续，而原始条目全部留在存储里。原生日志的 leaf 移动由同步循环
      // 在见到该标记时用 Pi 的 branch() 完成。
      if (!Number.isSafeInteger(input.entryId))
        throw new DeskError(422, "退回位置无效");
      if (!Array.isArray(input.messages) || input.messages.length > 2000)
        throw new DeskError(422, "退回上下文无效");
      const { entries } = await workspace.transcript(selected.id);
      const known = new Set(entries.map((entry) => entry.id));
      if (!known.has(input.entryId)) throw new DeskError(404, "退回位置不存在");
      const messages = input.messages.filter(
        (message) => message.role !== "system",
      );
      const origins =
        input.origins === undefined
          ? prefixOrigins(entries, input.entryId)
          : input.origins;
      if (
        !Array.isArray(origins) ||
        origins.some((id) => !Number.isSafeInteger(id) || id < 0)
      )
        throw new DeskError(422, "退回消息来源无效");
      if (origins.length !== contributed({ model: messages }).length)
        throw new DeskError(409, "退回消息来源不一致，请重新读取会话");
      if (origins.some((id) => !known.has(id)))
        throw new DeskError(404, "退回消息来源不存在");
      // 默认宿主传入 Pi 活跃投影的原点；旧调用无法对齐时拒绝，不能丢掉映射。
      // Pi 的摘要／custom 是 UI 角色，Durable model 只接受 LLM 消息；原始贡献只供界面投影。
      const { convertToLlm } = await loadPiMessages();
      const nativeMessages = messages.some(
        (message) =>
          !["user", "assistant", "toolResult"].includes(message.role),
      )
        ? messages
        : undefined;
      const marker = await selected.commit(
        (tx) =>
          tx.appendEntry(selected.id, {
            kind: "desk.rewind",
            head: "self",
            model: convertToLlm(messages),
            data: {
              rewindTo: input.entryId,
              origins,
              ...(nativeMessages ? { nativeMessages } : {}),
            },
          }),
        context,
      );
      return { id: selected.id, entryId: marker.id, rewindTo: input.entryId };
    }
    if (command === "wait") {
      // 等待：给定 taskId 时等那个任务结束；否则等该会话空闲。两者都只观察，不改变任务。
      if (input.taskId !== undefined) {
        await scopedTask(selected.id, input.taskId);
        await harness.waitForTask(input.taskId, context);
        return {
          id: selected.id,
          taskId: input.taskId,
          idle: !foreground(selected.id),
        };
      }
      await selected.waitForIdle(context);
      return { id: selected.id, idle: true };
    }
    if (command === "cancel") {
      // 取消：taskId 指定单个任务；background 只取消后台任务；否则取消该会话当前的工作。
      if (input.taskId !== undefined) {
        await scopedTask(selected.id, input.taskId);
        await harness.abortTask(input.taskId, context);
        return { id: selected.id, taskId: input.taskId, cancelled: true };
      }
      if (input.background === true) {
        // 只取消后台任务：按任务图里的 background 标记逐个中止，不等前台工作结束
        // （Durable 的 abortConversation(background) 会等到会话空闲，对界面是阻塞风险）。
        const scope = ownedConversationIds(selected.id, await scanAll());
        const background = Object.values(graph.value.tasks).filter(
          (task) => task.background && scope.has(task.conversationId),
        );
        await Promise.all(
          background.map((task) => harness.abortTask(task.id, context)),
        );
        return {
          id: selected.id,
          cancelled: true,
          background: true,
          tasks: background.map((task) => task.id),
          idle: !foreground(selected.id),
        };
      }
      await selected.abort(context);
      return {
        id: selected.id,
        cancelled: true,
        background: false,
        idle: !foreground(selected.id),
      };
    }
    throw new DeskError(404, "不支持的 Agent 操作");
  }
  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      unsubscribe();
      unsubscribeRegistry();
      listeners.clear();
      graph.dispose();
      try {
        await harness.close(context);
      } finally {
        await release?.();
      }
    })();
    return closePromise;
  }
  ownerReady = true;
  if (compromised) {
    await close();
    throw compromised;
  }
  const workspace = {
    read,
    async persistNative(id, entries, messages = []) {
      guard();
      const { convertToLlm } = await loadPiMessages();
      await conversation(id);
      await harness.commit(async (tx) => {
        const document = await tx.doc(DesktopResources, id);
        document.entries = entries;
        for (const { message, triggerTurn } of messages)
          await tx.appendEntry(id, {
            kind: "desk.native-message",
            model: triggerTurn ? [] : convertToLlm([message]),
            data: { nativeMessage: message },
          });
      }, context);
    },
    async transcript(id) {
      guard();
      const selected = await conversation(id),
        entries = [];
      let cursor;
      do {
        const page = await selected.entries({}, 200, cursor, context);
        entries.push(...page.items);
        cursor = page.next;
      } while (cursor !== undefined);
      return {
        active: {
          ...(await summary(selected)),
          resourceState: await harness.snapshot(DesktopResources, id, context),
        },
        entries: entries.sort((a, b) => a.id - b.id),
      };
    },
    async importNative(id, entries) {
      guard();
      const { convertToLlm } = await loadPiMessages();
      const { SessionManager, sessionEntryToContextMessages } =
        await loadPiSessionManager();
      const selected = await conversation(id);
      const prior = (await workspace.transcript(id)).entries;
      const nativeHeader = entries.find((entry) => entry.type === "session");
      const imported = prior.filter(
        (entry) => entry.data?.nativeSessionId === nativeHeader?.id,
      );
      if (imported.length)
        return {
          through: Math.max(...imported.map((entry) => entry.id)),
          mapping: imported.map((entry) => [
            entry.id,
            entry.data.nativeEntryId,
          ]),
        };
      if (
        prior.some((entry) =>
          (entry.model ?? []).some((message) => message.role !== "system"),
        )
      )
        throw new DeskError(409, "只能向空会话接管 Pi 记录");
      const native = SessionManager.inMemory(undefined, undefined, entries),
        mapping = [];
      let through = 0;
      await selected.commit(async (tx) => {
        const branch = native.getBranch();
        const resources = await tx.doc(DesktopResources, id);
        resources.entries = branch
          .filter(
            (entry) =>
              entry.type === "custom" &&
              !entry.customType.startsWith("pi-desktop-"),
          )
          .map((entry) => ({
            customType: entry.customType,
            ...(entry.data === undefined ? {} : { data: entry.data }),
          }));
        const ids = new Map();
        for (const entry of branch) {
          const sourceMessages = sessionEntryToContextMessages(entry);
          const model = convertToLlm(sourceMessages).filter((message) =>
            ["user", "assistant", "toolResult"].includes(message.role),
          );
          if (!model.length && entry.type !== "context_edit") continue;
          const draft = {
            kind:
              entry.type === "compaction"
                ? "pi.compaction"
                : "desk.native-import",
            model,
            data: {
              nativeSessionId: nativeHeader.id,
              nativeEntryId: entry.id,
              // Durable 的 model 字段只接受 LLM 消息；原始原生 custom 消息
              // 单独保留给卡片投影。
              ...(sourceMessages[0]?.role === "custom"
                ? { nativeMessage: sourceMessages[0] }
                : {}),
            },
          };
          if (entry.type === "compaction")
            draft.head = ids.get(entry.firstKeptEntryId) ?? "self";
          if (entry.type === "context_edit" && ids.has(entry.targetId))
            draft.edits = [
              entry.replacement === null
                ? { target: ids.get(entry.targetId), action: "omit" }
                : {
                    target: ids.get(entry.targetId),
                    action: "replace",
                    messages: convertToLlm(
                      sessionEntryToContextMessages({
                        ...native.getEntry(entry.targetId),
                        message: {
                          ...native.getEntry(entry.targetId)?.message,
                          content: entry.replacement.content,
                        },
                      }),
                    ),
                  },
            ];
          const added = await tx.appendEntry(id, draft);
          ids.set(entry.id, added.id);
          mapping.push([added.id, entry.id]);
          through = added.id;
        }
      }, context);
      return { through, mapping };
    },
    agent,
    live,
    execute,
    install(extension) {
      guard();
      registry.install(extension);
    },
    subscribe(listener) {
      guard();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  };
  try {
    for (const record of await conversations())
      if (await harness.snapshot(AgentProfile, record.id, context))
        await repairNativeContext(await conversation(record.id));
    await options.initialize?.(workspace);
  } catch (error) {
    await close();
    throw error;
  }
  if (options.resume !== false) harness.resume();
  return workspace;
}
