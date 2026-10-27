import { toTranscript } from "./session-projection.mjs";
import { toDialogs } from "./interactions.mjs";

/** 每个 worker 保留自己的 SSE；将 Host 通知转换为 Percho 的权威状态事件。 */
export function createSubscriptions({
  sessions,
  EventSource: Source = globalThis.EventSource,
  onError = console.error,
  ownsInteraction = () => false,
}) {
  const listeners = new Map(),
    streams = new Map();
  let timer,
    refreshing = false,
    stopped = true;
  const emit = (name, payload) => {
    for (const listener of listeners.get(name) ?? []) listener(payload);
  };
  async function sync(client) {
    if (client.busy) {
      client.again = true;
      return;
    }
    client.busy = true;
    try {
      do {
        client.again = false;
        const value = await sessions.state(client.id);
        if (streams.get(client.id) !== client) return;
        client.nativeId = String(value.sessionId);
        const transcript = toTranscript(value.messages, {
          active: value.idle === false,
          streaming: value.idle === false ? value.streamingMessage : undefined,
          compacting: value.activity?.kind === "compacting",
          activeCalls: value.activeCalls,
          retrying: value.retrying,
        });
        emit("onEvent", {
          sessionId: client.id,
          event: {
            type: "desktop_snapshot",
            transcript,
            usage: value.usage ?? null,
            name: value.name,
            desktopUi: {
              ...value.ui,
              statuses: value.statuses,
              workingMessage: value.workingMessage,
              activity: value.activity,
              recovery: value.recovery,
            },
          },
        });
        const jobs = (await sessions.get("/api/interactions", client.id)).rows;
        if (streams.get(client.id) !== client) return;
        const dialogs = toDialogs(
          jobs.filter((job) => !ownsInteraction(client.id, job.id)),
          client.id,
        );
        const next = new Set(dialogs.map((row) => row.id));
        for (const request of dialogs)
          if (!client.dialogs.has(request.id))
            emit("onExtensionDialogRequest", request);
        for (const id of client.dialogs)
          if (!next.has(id))
            emit("onExtensionDialogResolved", {
              sessionId: client.id,
              requestId: id,
              reason: "answered",
            });
        client.dialogs = next;
      } while (client.again && streams.get(client.id) === client);
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      client.busy = false;
    }
  }
  async function refresh() {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      const rows = (await sessions.list()).filter((row) => row.active);
      if (stopped) return;
      const active = new Set(rows.map((row) => row.sessionId));
      for (const [id, client] of streams)
        if (!active.has(id)) {
          client.source.close();
          streams.delete(id);
        }
      for (const row of rows) {
        if (streams.has(row.sessionId)) continue;
        const source = new Source(
          await sessions.path("/api/events", row.sessionId),
        );
        if (stopped) {
          source.close();
          return;
        }
        const client = {
          id: row.sessionId,
          source,
          dialogs: new Set(),
          busy: false,
          again: false,
        };
        streams.set(client.id, client);
        source.onmessage = (event) => {
          if (streams.get(client.id) !== client) return;
          let payload;
          try {
            payload = JSON.parse(event.data);
          } catch (error) {
            onError(error);
            return;
          }
          const data = payload.data ?? {};
          if (
            data.sessionId !== undefined &&
            String(data.sessionId) !== client.nativeId
          )
            return;
          if (payload.kind === "notification")
            emit("onExtensionNotify", {
              sessionId: client.id,
              message: data.message,
              level: data.type ?? "info",
              extensionPath: "",
            });
          else if (payload.kind === "editor_text")
            emit("onExtensionEditorText", {
              sessionId: client.id,
              text: data.text,
            });
          else if (
            [
              "state_changed",
              "resync_required",
              "assistant_update",
              "tool_update",
              "interaction_changed",
            ].includes(payload.kind)
          )
            void sync(client);
        };
        source.onopen = () => void sync(client);
        void sync(client);
      }
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      refreshing = false;
    }
  }
  return (name, _channel, listener) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(listener);
    if (stopped) {
      stopped = false;
      void refresh();
      timer = setInterval(() => void refresh(), 1500);
    }
    return () => {
      listeners.get(name)?.delete(listener);
      if ([...listeners.values()].some((set) => set.size)) return;
      stopped = true;
      clearInterval(timer);
      for (const client of streams.values()) client.source.close();
      streams.clear();
    };
  };
}
