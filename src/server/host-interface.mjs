import { DeskError } from "../config/config-store.mjs";
import { createRequestTarget } from "./target-guard.mjs";

/**
 * Resolve an optional operation against the adapter on every call.
 *
 * TUI reuses one transport while its focused slot changes; caching the first
 * slot's functions here would send the next prompt to the previous Agent.
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
 * The Host seam is a declared set of capabilities and domain operations, not
 * a bag whose optional keys the HTTP bridge probes one by one.
 *
 * Adapters still supply host-specific implementations; this module gives all
 * of them the same shape, explicit capability flags, and target-token helper.
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
