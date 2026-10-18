import { DeskError } from "../config/config-store.mjs";
import { createRequestTarget } from "./target-guard.mjs";

/**
 * Host 与传输之间的 seam：把每个宿主的能力与领域操作收敛成同一形状。
 *
 * 接口：`HOST_CAPABILITY_KEYS`（38 个键）、`normalizeHostCapabilities(value)`、
 *   `createHostInterface(input)`；host 的 `supports`／`require`／`target` 语义与完整
 *   操作名列表见 docs/architecture/interfaces/host-interface.md。
 * 不变量：能力是显式声明而不是推断（回调存在不自动开启能力）；`normalizeHostCapabilities`
 *   返回包含全部键的对象，未给出的为 false；操作在每次调用时重新解析；target 捕获的是
 *   snapshot 函数本身（同一个函数必须返回最新状态）。
 * 错误：输入形状错误抛 TypeError（如 “未知的 Host capability”）；宿主未提供操作抛
 *   DeskError(501)；请求目标已变化抛 DeskError(409)。
 */

/**
 * 在每次调用时重解析可选操作。
 *
 * TUI 复用同一个 transport 而聚焦 slot 会切换；在这里缓存第一个 slot 的函数，
 * 会把下一个 prompt 发给上一个 Agent。
 */
function optionalMethod(input, key) {
  const current = input[key];
  if (typeof current !== "function") return undefined;
  return (...args) => {
    const operation = input[key];
    if (typeof operation !== "function")
      throw new DeskError(501, `当前 Desktop 宿主未提供 ${key}`);
    return operation.apply(input, args);
  };
}

export const HOST_CAPABILITY_KEYS = Object.freeze([
  "sessions",
  "remote",
  "newSession",
  "switchSession",
  "sessionCommand",
  "sessionTree",
  "canManageSessions",
  "packageManagement",
  "packageUpdates",
  "packageRoot",
  "skills",
  "mcp",
  "interactions",
  "reload",
  "auth",
  "authLogout",
  "providerInventory",
  "providerCatalog",
  "providerSave",
  "providerRemove",
  "model",
  "thinking",
  "trustProject",
  "prompt",
  "abort",
  "btw",
  "settings",
  "canSaveSettings",
  "revision",
  "projectTrusted",
  "canWrite",
  "canEditShared",
  "validateTarget",
  "canSetThinking",
  "canDeferConfiguration",
  "settingsChanged",
  "gitChanged",
  "route",
  "requestContext",
]);

export function normalizeHostCapabilities(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Host capabilities 必须是对象");
  for (const key of Object.keys(value))
    if (!HOST_CAPABILITY_KEYS.includes(key))
      throw new TypeError(`未知的 Host capability：${key}`);
  return Object.freeze(
    Object.fromEntries(
      HOST_CAPABILITY_KEYS.map((key) => [key, value[key] === true]),
    ),
  );
}

/**
 * Host seam 是一组声明的能力与领域操作，不是让 HTTP bridge 逐个探测可选键的口袋。
 *
 * adapter 仍提供宿主特有的实现；本模块给它们统一形状、显式能力位与目标 token 助手。
 */
export function createHostInterface(input = {}) {
  if (!input || typeof input.snapshot !== "function")
    throw new TypeError("Host 必须提供 snapshot()");
  const transport = {
    agentDir: input.agentDir ?? "",
    modelsPath: input.modelsPath,
    host: input.host,
    port: input.port,
    certPath: input.certPath,
    keyPath: input.keyPath,
    autoPort: input.autoPort,
    embeddedUI: input.embeddedUI,
    funnel: input.funnel,
    filePicker: input.filePicker,
    catalogFetch: input.catalogFetch,
    lanAddresses: input.lanAddresses,
  };
  const state = {
    get snapshot() {
      return input.snapshot;
    },
    get effectiveSettings() {
      return optionalMethod(input, "effectiveSettings");
    },
    get projectTrusted() {
      return optionalMethod(input, "projectTrusted");
    },
    get canEditShared() {
      return optionalMethod(input, "canEditShared");
    },
    get canWrite() {
      return optionalMethod(input, "canWrite");
    },
    get canSaveSettings() {
      return optionalMethod(input, "canSaveSettings");
    },
    get canManageSessions() {
      return optionalMethod(input, "canManageSessions");
    },
    get canSetThinking() {
      return optionalMethod(input, "canSetThinking");
    },
    get canDeferConfiguration() {
      return optionalMethod(input, "canDeferConfiguration");
    },
    get validateTarget() {
      return optionalMethod(input, "validateTarget");
    },
    get settingsChanged() {
      return optionalMethod(input, "settingsChanged");
    },
    get gitChanged() {
      return optionalMethod(input, "gitChanged");
    },
    get revision() {
      return optionalMethod(input, "revision");
    },
  };
  const sessions = {
    get list() {
      return optionalMethod(input, "listSessions");
    },
    get create() {
      return optionalMethod(input, "newSession");
    },
    get switch() {
      return optionalMethod(input, "switchSession");
    },
    get command() {
      return optionalMethod(input, "sessionCommand");
    },
    get tree() {
      return optionalMethod(input, "sessionTree");
    },
  };
  const resources = {
    get skills() {
      return optionalMethod(input, "skillInventory");
    },
    get mcpRegistered() {
      return optionalMethod(input, "mcpRegistered");
    },
    get mcpTools() {
      return optionalMethod(input, "mcpTools");
    },
    get mcpAction() {
      return optionalMethod(input, "mcpAction");
    },
    get packageAction() {
      return optionalMethod(input, "packageAction");
    },
    get packageRoot() {
      return optionalMethod(input, "packageRoot");
    },
    get packageUpdates() {
      return optionalMethod(input, "packageUpdates");
    },
    get interactions() {
      return input.interactions;
    },
    get trustProject() {
      return optionalMethod(input, "trustProject");
    },
    get reload() {
      return optionalMethod(input, "reload");
    },
  };
  const models = {
    get inventory() {
      return optionalMethod(input, "providerInventory");
    },
    get catalog() {
      return optionalMethod(input, "providerCatalog");
    },
    get save() {
      return optionalMethod(input, "providerSave");
    },
    get remove() {
      return optionalMethod(input, "providerRemove");
    },
    get authStart() {
      return optionalMethod(input, "authStart");
    },
    get authLogout() {
      return optionalMethod(input, "authLogout");
    },
    get refresh() {
      return optionalMethod(input, "refreshModels");
    },
    get set() {
      return optionalMethod(input, "setModel");
    },
    get setThinking() {
      return optionalMethod(input, "setThinking");
    },
  };
  const prompt = {
    get submit() {
      return optionalMethod(input, "prompt");
    },
    get abort() {
      return optionalMethod(input, "abort");
    },
    get btw() {
      return optionalMethod(input, "btw");
    },
  };
  const hooks = {
    get requestContext() {
      return optionalMethod(input, "requestContext");
    },
    get route() {
      return optionalMethod(input, "route");
    },
  };
  const capabilities = normalizeHostCapabilities(input.capabilities);
  const operations = {
    listSessions: () => sessions.list,
    newSession: () => sessions.create,
    switchSession: () => sessions.switch,
    sessionCommand: () => sessions.command,
    sessionTree: () => sessions.tree,
    packageAction: () => resources.packageAction,
    packageUpdates: () => resources.packageUpdates,
    packageRoot: () => resources.packageRoot,
    skillInventory: () => resources.skills,
    mcpAction: () => resources.mcpAction,
    mcpRegistered: () => resources.mcpRegistered,
    mcpTools: () => resources.mcpTools,
    trustProject: () => resources.trustProject,
    reload: () => resources.reload,
    providerInventory: () => models.inventory,
    providerCatalog: () => models.catalog,
    providerSave: () => models.save,
    providerRemove: () => models.remove,
    authStart: () => models.authStart,
    authLogout: () => models.authLogout,
    refreshModels: () => models.refresh,
    setModel: () => models.set,
    setThinking: () => models.setThinking,
    prompt: () => prompt.submit,
    abort: () => prompt.abort,
    btw: () => prompt.btw,
    requestContext: () => hooks.requestContext,
    route: () => hooks.route,
  };
  const host = {
    state,
    sessions,
    resources,
    models,
    prompt,
    hooks,
    transport,
    capabilities,
    get snapshot() {
      return input.snapshot;
    },
    target: (body) =>
      createRequestTarget(
        input.snapshot,
        body,
        capabilities.validateTarget
          ? optionalMethod(input, "validateTarget")
          : undefined,
      ),
    supports: (name) => capabilities[name] === true,
    require(name, message) {
      const operation = operations[name]?.();
      if (typeof operation !== "function")
        throw new DeskError(501, message ?? "当前 Desktop 宿主未提供此能力");
      return operation;
    },
    get settingsChanged() {
      return optionalMethod(input, "settingsChanged");
    },
  };
  return Object.freeze(host);
}
