import { startDurableDesk } from "../server/durable-server.mjs";

/**
 * The worker's process boundary is the Agent runtime seam.
 *
 * The Host still owns spawning, restart, readiness and teardown. A runtime
 * only owns the in-process agent harness behind that process. Keeping the
 * seam here lets another runtime arrive later without teaching the supervisor
 * how that runtime is implemented.
 */
export function defineAgentRuntime({ id, start }) {
  if (typeof id !== "string" || !id.trim())
    throw new TypeError("Agent runtime 必须提供非空 id");
  if (typeof start !== "function")
    throw new TypeError("Agent runtime 必须提供 start");
  return Object.freeze({ id, start });
}

export function createDurableRuntime({ start = startDurableDesk } = {}) {
  return defineAgentRuntime({
    id: "durable",
    start(options = {}) {
      return start({
        ...options,
        singleAgent: true,
        host: "127.0.0.1",
        port: 0,
      });
    },
  });
}

export const defaultAgentRuntime = createDurableRuntime();
