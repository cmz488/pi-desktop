import { build } from "esbuild";

// 编译真实 Percho 纯消费者，验证边界数据能被它们使用，而非再写一套形状断言。
let compiled;
export function perchoConsumers() {
  return (compiled ??= build({
    stdin: {
      contents: `
      export { CHANNEL_TABLE, SUBSCRIPTION_TABLE } from "./src/ui-next/percho/shared/ipc-channels.ts";
      export { getExecutionApi } from "./src/ui-next/percho/renderer/src/environment-api.ts";
      export { environmentEntityKey } from "./src/ui-next/percho/shared/environment.ts";
      export { parseEnvironmentUiState } from "./src/ui-next/percho/shared/environment-ui-state.ts";
      export { messagesToUIMessages } from "./src/ui-next/percho/shared/transcript/mapping.ts";
      export { filterCommands } from "./src/ui-next/percho/renderer/src/components/composer/slash-filter.ts";
      export { buildChatRows } from "./src/ui-next/percho/shared/transcript/chat-rows.ts";
      export { reduceEvent } from "./src/ui-next/percho/shared/transcript/reducer.ts";
      export { emptyTranscript } from "./src/ui-next/percho/shared/transcript/types.ts";
      export { applyFrame, seedSessions, initialLanState } from "./src/ui-next/percho/lan-web/src/store-pure.ts";
    `,
      resolveDir: process.cwd(),
    },
    alias: {
      "@percho/shared": `${process.cwd()}/src/ui-next/percho/shared/index.ts`,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
  }).then(
    (result) =>
      import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
      ),
  ));
}

/** Node 测试中消费真实 HTTP SSE，生命周期与浏览器 EventSource 相同。 */
export function eventSourceAt(origin) {
  return class {
    controller = new AbortController();
    constructor(path) {
      this.ready = this.read(new URL(path, origin));
    }
    async read(url) {
      try {
        const response = await fetch(url, { signal: this.controller.signal });
        if (!response.ok) throw new Error(`SSE ${response.status}`);
        this.onopen?.();
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .map((line) => line.slice(6))
              .join("\n");
            if (data) this.onmessage?.({ data });
          }
        }
      } catch (error) {
        if (!this.controller.signal.aborted) this.onerror?.(error);
      }
    }
    close() {
      this.controller.abort();
    }
  };
}
