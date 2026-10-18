import { AsyncLocalStorage } from "node:async_hooks";
import { createDeskBridge } from "../server/bridge.mjs";
import { DeskError } from "../config/config-store.mjs";
import { createAgentSnapshot } from "../server/agent-snapshot.mjs";

export async function openPiHistory({ agent, read, agentDir }) {
  const context = new AsyncLocalStorage();
  let current = await read(),
    polling,
    closed = false;
  const bridge = createDeskBridge({
    agentDir,
    host: "127.0.0.1",
    port: 0,
    embeddedUI: true,
    capabilities: {
      sessions: false,
      remote: false,
      newSession: false,
      switchSession: false,
      sessionCommand: false,
      canManageSessions: false,
      packageManagement: false,
      packageUpdates: false,
      packageRoot: false,
      skills: false,
      mcp: false,
      interactions: false,
      reload: false,
      auth: false,
      authLogout: false,
      providerInventory: false,
      providerCatalog: false,
      providerSave: false,
      providerRemove: false,
      model: false,
      thinking: false,
      trustProject: false,
      prompt: false,
      abort: false,
      btw: false,
      settings: false,
      canSaveSettings: false,
      projectTrusted: true,
      canWrite: false,
      canEditShared: false,
      validateTarget: false,
      canSetThinking: false,
      canDeferConfiguration: false,
      settingsChanged: false,
      gitChanged: false,
      route: true,
      requestContext: true,
    },
    snapshot: () => {
      const merged = { ...current, ...context.getStore() };
      return createAgentSnapshot({
        ...merged,
        host: "pi-history",
        idle: true,
        initializing: false,
        history: true,
        version: "1.0.0",
        operation: "",
        models: [],
        tools: [],
        thinkingLevels: [],
        thinkingEditable: false,
        statuses: [],
        workingMessage: "",
        projectTrusted: false,
        capabilities: {
          nativeHistory: true,
          readOnly: true,
          files: !!agent.projectId,
        },
        extra: {
          ...merged,
          sessionCommands: false,
          liveTools: [],
          historyTotal: current.messages.length,
        },
      });
    },
    canWrite: () => false,
    canEditShared: () => false,
    projectTrusted: () => false,
    async requestContext(request, _response, run) {
      if (!request.url.startsWith("/api/")) return run();
      const url = new URL(request.url, "http://localhost");
      if (
        ["/api/state", "/api/events", "/api/message-detail"].includes(
          url.pathname,
        )
      )
        current = await read();
      const limit = Math.min(
        10000,
        Math.max(1, Number(url.searchParams.get("historyLimit")) || 300),
      );
      return context.run(
        {
          messages:
            url.pathname === "/api/message-detail"
              ? current.messages
              : current.messages.slice(-limit),
          historyMore: current.messages.length > limit,
        },
        run,
      );
    },
    async route(request, response, url) {
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new DeskError(
          403,
          "此会话由 Pi TUI 管理，Desktop 仅同步查看记录",
        );
      if (
        url.pathname.startsWith("/api/") &&
        ![
          "/api/state",
          "/api/events",
          "/api/message-detail",
          "/api/files",
        ].includes(url.pathname)
      ) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ rows: [], commands: [] }));
        return true;
      }
      return false;
    },
  });
  const url = await bridge.start();
  const timer = setInterval(() => {
    if (closed || polling || !bridge.connectedClients) return;
    polling = read()
      .then((next) => {
        if (next.revision !== current.revision || next.name !== current.name) {
          current = next;
          bridge.publish("state_changed", {});
        }
      })
      .catch(() => {})
      .finally(() => {
        polling = undefined;
      });
  }, 1500);
  timer.unref();
  return {
    url,
    async close() {
      closed = true;
      clearInterval(timer);
      await polling;
      await bridge.stop();
    },
  };
}
