import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

// npm run desktop -- --extension ./examples/desk-extension.mjs
export default defineExtension({
  name: "project-info",
  tools: [
    defineTool({
      name: "project_info",
      description: "Read the current project's package name",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, context) => {
        const env = api.env;
        const result = await env.readTextFile("package.json", context);
        if (!result.ok)
          throw new Error("No readable package.json in this project");
        return {
          content: [
            {
              type: "text",
              text: String(JSON.parse(result.value).name ?? "unnamed project"),
            },
          ],
        };
      },
    }),
  ],
});
