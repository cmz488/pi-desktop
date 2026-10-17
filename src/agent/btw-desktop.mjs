import { randomUUID } from "node:crypto";
import { clampThinkingLevel } from "@earendil-works/pi-ai";

const SYSTEM_PROMPT = `You answer quick side questions for a coding-agent user.

Use the provided conversation context only as background. Answer the user's side question directly and concisely. Do not claim to have changed files, run tools, or affected the main task. If the context is insufficient, say what is unknown and give the best next step.`;
const MAX_CONTEXT_CHARS = 40_000;
const MAX_QUESTION_CHARS = 10_000;

/**
 * Desktop adapter for the @narumitw/pi-btw command. It keeps side conversations
 * in process memory and calls Pi's own model registry, without adding entries to
 * the active agent session. The context and prompt follow pi-btw's side-thread
 * workflow (MIT, https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-btw).
 */
export function createDesktopBtw() {
  const threads = new Map();

  async function handle(input, runtime) {
    const sessionId = String(runtime?.sessionId ?? "");
    if (!sessionId) throw new Error("Pi 会话尚未就绪");
    const action = input?.action;
    if (action === "list") {
      return {
        rows: [...threads.values()]
          .filter((thread) => thread.sessionId === sessionId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((thread) => ({
            id: thread.id,
            title: thread.title ?? "新侧问答",
            questionCount: thread.turns.length,
            updatedAt: thread.updatedAt,
            model: thread.model.name ?? thread.model.id,
          })),
      };
    }

    if (action === "open") {
      if (input.threadId) {
        const thread = ownedThread(input.threadId, sessionId);
        return { thread: projectThread(thread) };
      }
      if (!runtime.model)
        throw new Error("当前没有可用模型，请先在输入框选择模型");
      const thread = {
        id: randomUUID(),
        sessionId,
        title: undefined,
        model: runtime.model,
        modelRegistry: runtime.modelRegistry,
        thinkingLevel: clampThinkingLevel(
          runtime.model,
          runtime.thinkingLevel ?? "off",
        ),
        conversationContext: buildDesktopBtwContext(runtime.messages ?? []),
        routingSessionId: randomUUID(),
        turns: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        running: false,
      };
      threads.set(thread.id, thread);
      return { thread: projectThread(thread) };
    }

    if (action === "ask") {
      const thread = ownedThread(input.threadId, sessionId);
      const question =
        typeof input.question === "string" ? input.question.trim() : "";
      if (!question || question.length > MAX_QUESTION_CHARS)
        throw new Error("侧问答内容不能为空，且不能超过 10000 个字符");
      if (thread.running) throw new Error("这条侧问答仍在生成中");
      thread.running = true;
      thread.controller = new AbortController();
      try {
        const response = await completeSideTurn(
          thread,
          question,
          thread.controller.signal,
        );
        if (response.stopReason === "error")
          return {
            thread: projectThread(thread),
            error: response.errorMessage ?? "侧问答模型请求失败",
          };
        if (response.stopReason === "aborted")
          return { thread: projectThread(thread), cancelled: true };
        const answer = extractText(response) || "没有收到文本回复。";
        thread.turns.push({ question, answer, response });
        thread.title ??= truncate(question, 72);
        thread.updatedAt = Date.now();
        return { thread: projectThread(thread) };
      } catch (error) {
        if (thread.controller?.signal.aborted)
          return { thread: projectThread(thread), cancelled: true };
        return {
          thread: projectThread(thread),
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        thread.running = false;
        thread.controller = undefined;
      }
    }

    if (action === "cancel") {
      const thread = ownedThread(input.threadId, sessionId);
      thread.controller?.abort();
      return { thread: projectThread(thread) };
    }

    throw new Error("未知 /btw 操作");
  }

  function ownedThread(id, sessionId) {
    const thread = threads.get(String(id));
    if (!thread || thread.sessionId !== sessionId)
      throw new Error("侧问答已不存在或属于其他会话");
    return thread;
  }

  return { handle };
}

export function buildDesktopBtwContext(entries) {
  const sections = [];
  for (const entry of entries) {
    if (entry?.type && entry.type !== "message") continue;
    const message = entry?.message ?? entry;
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;
    // Pi's native branch stores `content`; Durable's public transcript
    // projection exposes equivalent text/tool blocks plus a plain `text` field.
    const content =
      message.content ??
      message.blocks ??
      (typeof message.text === "string" ? message.text : undefined);
    const lines = extractContextLines(content);
    if (lines.length)
      sections.push(
        `${role === "user" ? "User" : "Assistant"}: ${lines.join("\n")}`,
      );
  }
  const text = sections.join("\n\n");
  return text.length <= MAX_CONTEXT_CHARS
    ? text
    : `[Earlier context omitted; showing the last ${MAX_CONTEXT_CHARS} characters.]\n${text.slice(-MAX_CONTEXT_CHARS)}`;
}

function extractContextLines(content) {
  if (typeof content === "string")
    return content.trim() ? [content.trim()] : [];
  if (!Array.isArray(content)) return [];
  const lines = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string")
      lines.push(part.text.trim());
    else if (part.type === "toolCall" && typeof part.name === "string")
      lines.push(`Tool call: ${part.name}(${safeJson(part.arguments)})`);
    else if (part.type === "toolResult" && typeof part.name === "string")
      lines.push(`Tool result from ${part.name}: ${safeJson(part.result)}`);
  }
  return lines.filter(Boolean);
}

async function completeSideTurn(thread, question, signal) {
  const messages = [];
  if (!thread.turns.length) {
    messages.push(
      userMessage(buildInitialPrompt(question, thread.conversationContext)),
    );
  } else {
    const [first, ...rest] = thread.turns;
    messages.push(
      userMessage(
        buildInitialPrompt(first.question, thread.conversationContext),
      ),
      first.response,
    );
    for (const turn of rest)
      messages.push(
        userMessage(buildFollowUpPrompt(turn.question)),
        turn.response,
      );
    messages.push(userMessage(buildFollowUpPrompt(question)));
  }

  const options = { sessionId: thread.routingSessionId, signal };
  if (thread.thinkingLevel && thread.thinkingLevel !== "off")
    options.reasoning = thread.thinkingLevel;
  const context = { systemPrompt: SYSTEM_PROMPT, messages };
  const registry = thread.modelRegistry;
  if (typeof registry?.completeSimple === "function")
    return registry.completeSimple(thread.model, context, options);
  if (typeof registry?.streamSimple === "function")
    return registry.streamSimple(thread.model, context, options).result();
  throw new Error("当前 Pi 模型注册表不支持独立侧问答");
}

function buildInitialPrompt(question, conversationContext) {
  return [
    "Answer this side question without modifying the main conversation.",
    "",
    "<side_question>",
    question,
    "</side_question>",
    "",
    "<conversation_context>",
    conversationContext || "No prior conversation context was available.",
    "</conversation_context>",
  ].join("\n");
}

function buildFollowUpPrompt(question) {
  return [
    "Continue the same side conversation.",
    "",
    "<side_question>",
    question,
    "</side_question>",
  ].join("\n");
}

function userMessage(text) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function extractText(response) {
  return (response?.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function projectThread(thread) {
  return {
    id: thread.id,
    title: thread.title ?? "新侧问答",
    model: thread.model.name ?? thread.model.id,
    thinkingLevel: thread.thinkingLevel,
    turns: thread.turns.map(({ question, answer }) => ({ question, answer })),
    running: thread.running,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function truncate(text, length) {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function safeJson(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
