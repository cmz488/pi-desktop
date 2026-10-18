import { extensionAdapterRegistry } from "./extension-adapters.mjs";

// Only navigation fields cross the wire; editors request a specific record.
const pick = (row, fields) =>
  Object.fromEntries(
    fields
      .filter((key) => row[key] !== undefined)
      .map((key) => [key, row[key]]),
  );
export function workspaceIndex(catalog) {
  return {
    revision: catalog.revision,
    projects: catalog.projects.map((row) => pick(row, ["id", "name", "cwd"])),
    agents: catalog.agents.map((row) => ({
      ...pick(row, [
        "id",
        "name",
        "projectId",
        "source",
        "status",
        "pid",
        "error",
        "archived",
        "archivePending",
        "historyAvailable",
        "updatedAt",
        "createdAt",
        "pinned",
        "approvalMode",
        "promptProfileId",
      ]),
      nativeSessionAvailable: !!row.nativeSessionPath,
    })),
    promptProfiles: catalog.promptProfiles.map((row) =>
      pick(row, ["id", "name"]),
    ),
  };
}

// The focused chat loads a bounded page, never model catalogs, task journals,
// resource state or a second copy of the entire active conversation.
export function chatSnapshot(snapshot, limit = 50, revision = () => "") {
  const {
    active,
    models,
    tasks,
    commands,
    tools,
    toolRegistrations,
    extensions,
    ...chat
  } = snapshot;
  const messages = snapshot.messages ?? [];
  return {
    ...chat,
    commandsRevision: revision(commands ?? []),
    agents: snapshot.agents?.map((row) =>
      pick(row, [
        "id",
        "name",
        "cwd",
        "idle",
        "revision",
        "model",
        // 会话栏判断分支条目是否可退回、以及分支来源标签所需（追加字段）。
        "native",
        "forkOf",
      ]),
    ),
    messages: messages.slice(-limit).map((row) => {
      const hidden =
        row.role === "toolResult" ||
        row.blocks?.some((block) =>
          ["thinking", "toolCall"].includes(block.type),
        );
      if (!hidden) return row;
      return {
        ...row,
        ...(row.extensionView
          ? {
              extensionView: {
                ...row.extensionView,
                title: String(row.extensionView.title ?? "").slice(0, 160),
                body: "",
                tasks: [],
                items: [],
              },
            }
          : {}),
        detailRevision: revision(row),
        lazy: true,
        ...(row.role === "toolResult"
          ? { text: (row.text ?? "").slice(0, 160), blocks: [] }
          : {
              blocks: row.blocks.map((block) =>
                block.type === "thinking"
                  ? { ...block, text: (block.text ?? "").slice(0, 90) }
                  : block.type === "toolCall"
                    ? {
                        ...block,
                        arguments: (block.arguments ?? "").slice(0, 100),
                      }
                    : block,
              ),
            }),
      };
    }),
    historyMore: !!snapshot.historyMore || messages.length > limit,
    historyTotal: snapshot.historyTotal ?? messages.length,
  };
}

// Private responses stay in this page's bounded memory, never localStorage or a
// shared HTTP cache. A validator saves the body when the host has no changes.
export function createIndexedFetch(
  fetcher = (...args) => fetch(...args),
  maxBytes = 8 * 1024 * 1024,
) {
  const entries = new Map();
  let bytes = 0;
  return async function read(url, options = {}) {
    const cacheable = !options.method || options.method === "GET";
    const prior = cacheable ? entries.get(url) : undefined;
    const headers = new Headers(options.headers);
    if (prior?.etag) headers.set("If-None-Match", prior.etag);
    const response = await fetcher(url, {
      ...options,
      cache: "no-store",
      headers,
    });
    if (response.status === 304 && prior) return prior.value;
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(value.error ?? `请求失败 (${response.status})`),
        { status: response.status },
      );
    if (cacheable) {
      if (prior) {
        bytes -= prior.size;
        entries.delete(url);
      }
      const size = JSON.stringify(value).length * 2;
      const etag = response.headers.get("etag");
      if (etag && size <= maxBytes) {
        while (entries.size >= 32 || bytes + size > maxBytes) {
          const key = entries.keys().next().value;
          bytes -= entries.get(key).size;
          entries.delete(key);
        }
        entries.set(url, { etag, value, size });
        bytes += size;
      }
    }
    return value;
  };
}

// Display projection only: native messages and their block order remain intact.
export function projectConversationTimeline(
  rows,
  { streamingMessage, activeCalls = [], sessionId = "" } = {},
) {
  // Host adapters use different IDs (for example Durable's "partial"). The
  // display stream has one identity, independent of the persisted transcript.
  const liveMessage = streamingMessage
    ? { ...streamingMessage, id: "streaming" }
    : undefined;
  const { messages, states } = extensionAdapterRegistry.layout(
    liveMessage ? [...rows, liveMessage] : rows,
    { sessionId },
  );
  const paired = new Set(
    messages.flatMap((message) =>
      (message.blocks ?? [])
        .filter((block) => block.type === "toolCall")
        .map((block) => block.id),
    ),
  );
  for (const call of activeCalls) {
    if (
      !paired.has(call.id) &&
      !messages.some(
        (row) => row.role === "toolResult" && row.toolCallId === call.id,
      )
    ) {
      messages.push({
        role: "assistant",
        id: `active:${call.id}`,
        blocks: [{ type: "toolCall", ...call }],
      });
      paired.add(call.id);
    }
  }
  const timeline = [];
  const activity = (message, block, index) => {
    const source = {
      id: message.id,
      lazy: message.lazy,
      streaming: message.id === "streaming",
    };
    const key =
      block.type === "toolCall"
        ? `tool:${block.id}`
        : `${message.eventKey ?? message.id ?? messages.indexOf(message)}:${index}`;
    let group = timeline.at(-1);
    if (group?.blocks?.[0]?.type !== "activity") {
      group = {
        role: "assistant",
        id: `activity:${key}`,
        blocks: [{ type: "activity", entries: [] }],
      };
      timeline.push(group);
    }
    const entries = group.blocks[0].entries;
    const previous = entries.at(-1);
    // Merge adjacent thinking even across assistant-message/stream boundaries,
    // but never move it across a tool call, model output or user turn.
    if (block.type === "thinking" && previous?.block.type === "thinking") {
      previous.block.text = [previous.block.text, block.text]
        .filter(Boolean)
        .join("\n\n");
      previous.sources.push(source);
    } else entries.push({ block: { ...block }, sources: [source], key });
  };
  for (const message of messages) {
    if (message.role === "custom") {
      if (message.display !== false)
        timeline.push({
          ...message,
          blocks: [
            {
              type: "extension",
              view: message.extensionView,
              text: message.text ?? "",
            },
          ],
        });
      continue;
    }
    if (message.role === "user") {
      timeline.push(message);
      continue;
    }
    if (message.role === "toolResult" && paired.has(message.toolCallId))
      continue;
    const blocks =
      message.role === "toolResult"
        ? [{ type: "toolCall", id: message.toolCallId, name: message.toolName }]
        : message.blocks?.length
          ? message.blocks
          : [{ type: "text", text: message.text ?? "" }];
    for (const [index, block] of blocks.entries()) {
      if (block.type === "text" && message.role === "assistant") {
        if (block.text?.trim())
          timeline.push({
            ...message,
            error: undefined,
            stopReason: undefined,
            blocks: [block],
          });
      } else activity(message, block, index);
    }
    if (message.error || ["error", "aborted"].includes(message.stopReason))
      timeline.push({ ...message, blocks: [], text: "" });
  }
  timeline.push(...states);
  return timeline;
}
