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

const [mode, directory, cwd] = process.argv.slice(2);
const models = createModels(),
  faux = fauxProvider({ tokensPerSecond: 10000 });
models.setProvider(faux.provider);
let started = 0;
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
      if (mode === "start") {
        if (++started === 2) process.send({ kind: "started" });
        return new Promise(() => {});
      }
      return { content: [{ type: "text", text: "read recovered" }] };
    },
  }),
);
faux.setResponses(
  mode === "start"
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
      ]
    : [fauxAssistantMessage("Recovered result")],
);
const workspace = await openAgentWorkspace({
  storagePath: join(directory, "agents.sqlite"),
  models,
  extensions: [defineExtension({ name: "recovery", tools })],
});
if (mode === "start") {
  const { id } = await workspace.execute("create", {
    cwd,
    model: { provider: faux.provider.id, modelId: faux.models[0].id },
  });
  await workspace.execute("send", {
    id,
    message: "exercise recovery",
    requestId: "crash-request",
  });
} else {
  const [{ id }] = (await workspace.read()).agents;
  for (let index = 0; index < 400; index++) {
    const state = await workspace.read(id);
    if (
      state.active.idle &&
      state.active.messages.some((row) => row.text === "Recovered result")
    ) {
      process.send({ kind: "recovered", active: state.active });
      await workspace.close();
      process.disconnect();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
