import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  Type,
} from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openAgentWorkspace } from "../src/agent/agent-workspace.mjs";

/* Five modes share one fixture so the counters stay comparable:
 *   control      — the same run with no interrupt (baseline counters);
 *   start-answer — the owner that is killed while the answer generation streams;
 *   resume-answer— the owner that reopens the storage after that kill;
 *   start-tools  — the owner that is killed with both tool calls in flight;
 *   resume-tools — the owner that reopens the storage after that kill.
 * The answer generation uses a paced stream so the interrupt lands inside it,
 * and the tool fixture is replay-safe, so a legitimate rerun of a tool call
 * differs from a duplicate model request. */

const [mode, directory, cwd] = process.argv.slice(2);
const paced = mode === "start-answer";
const models = createModels(),
  faux = fauxProvider({ tokensPerSecond: paced ? 4 : 10000 });
models.setProvider(faux.provider);
const answer = "Recovered result. The interrupted generation finished here.";
let workspace;
let agentId;
let toolStarts = 0;

const partText = (message) => {
  if (typeof message.text === "string") return message.text;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content))
    return message.content.map((part) => part.text ?? part.type).join("|");
  return "";
};

async function stateNow() {
  const state = await workspace.read(agentId);
  return {
    usage: state.active?.usage ?? null,
    recovery: state.recovery ?? null,
    entryCount: state.active?.entryCount ?? 0,
    streaming: !!state.active?.partial,
    toolResults: (state.active?.messages ?? []).filter(
      (row) => row.role === "toolResult",
    ).length,
    callCount: faux.state.callCount,
  };
}

const tools = ["safe_read", "unsafe_effect"].map((name) =>
  defineTool({
    name,
    description: name,
    parameters: Type.Object({}),
    ...(name === "safe_read" ? { replay: "safe" } : {}),
    execute: async () => {
      const path = join(directory, `${name}.txt`);
      let attempts = "";
      try {
        attempts = await readFile(path, "utf8");
      } catch {
        /* first invocation */
      }
      await writeFile(path, attempts + "invoked\n");
      if (mode === "start-tools") {
        toolStarts += 1;
        if (toolStarts === 2)
          process.send?.({ kind: "started", ...(await stateNow()) });
        return new Promise(() => {});
      }
      return { content: [{ type: "text", text: "read recovered" }] };
    },
  }),
);
faux.setResponses(
  mode === "control" || mode === "start-answer" || mode === "start-tools"
    ? [
        fauxAssistantMessage(
          tools.map((tool, index) => ({
            type: "toolCall",
            id: `call-${index}`,
            name: tool.name,
            arguments: {},
          })),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(answer),
      ]
    : [fauxAssistantMessage(answer)],
);
workspace = await openAgentWorkspace({
  storagePath: join(directory, "agents.sqlite"),
  models,
  extensions: [defineExtension({ name: "recovery", tools })],
});

async function summary(id) {
  const final = await workspace.read(id);
  const { entries } = await workspace.transcript(id);
  return {
    usage: final.active?.usage ?? null,
    recovery: final.recovery ?? null,
    entryCount: final.active?.entryCount ?? 0,
    transcriptEntries: entries.length,
    kinds: entries.map((entry) => entry.kind),
    assistantEntries: entries.filter((entry) =>
      entry.model?.some((message) => message.role === "assistant"),
    ).length,
    text: entries
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "assistant")
      .map((message) => partText(message)),
    // 投影里 assistant 消息带 text；entry 只存 content 块，所以按投影计数。
    answers: (final.active?.messages ?? []).filter((row) => row.text === answer)
      .length,
    unsafeError:
      final.active?.messages?.some(
        (row) => row.toolName === "unsafe_effect" && row.isError,
      ) ?? false,
    callCount: faux.state.callCount,
  };
}

async function waitForAnswer(id) {
  for (let index = 0; index < 500; index++) {
    const state = await workspace.read(id);
    if (
      state.active?.idle &&
      state.active.messages.some((row) => row.text === answer)
    )
      return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function createAndSend(requestId) {
  agentId = (
    await workspace.execute("create", {
      cwd,
      model: { provider: faux.provider.id, modelId: faux.models[0].id },
    })
  ).id;
  await workspace.execute("send", {
    id: agentId,
    message: "exercise recovery",
    requestId,
  });
}

if (mode === "start-tools") {
  await createAndSend("crash-tools");
} else if (mode === "start-answer") {
  await createAndSend("crash-answer");
  // Signal once the answer generation is streaming, so the parent kills the
  // owner with the generation genuinely in flight.
  for (let index = 0; index < 500; index++) {
    const state = await stateNow();
    // 等待两轮工具结果都提交后的那次生成，确保中断落在回答生成里。
    if (state.toolResults >= 2 && state.streaming) {
      process.send?.({ kind: "started", ...state });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
} else if (mode === "control") {
  await createAndSend("control");
  await waitForAnswer(agentId);
  process.send?.({ kind: "control", ...(await summary(agentId)) });
  await workspace.close();
  process.disconnect();
} else {
  const opened = await workspace.read();
  agentId = opened.agents[0]?.id;
  process.send?.({
    kind: "opened",
    recovery: opened.recovery ?? null,
    agents: opened.agents.length,
    ...(await stateNow()),
  });
  await waitForAnswer(agentId);
  process.send?.({
    kind: mode === "resume-tools" ? "recovered" : "resumed",
    ...(await summary(agentId)),
  });
  await workspace.close();
  process.disconnect();
}
