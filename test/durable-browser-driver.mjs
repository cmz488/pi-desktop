import { readFile } from "node:fs/promises";
import { join } from "node:path";
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function browserDriver(profile, debugPort, pageUrl) {
  let address = debugPort;
  if (!address) {
    for (let index = 0; index < 150; index++) {
      try {
        address = Number(
          (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
            "\n",
          )[0],
        );
        break;
      } catch {
        await pause(50);
      }
    }
  }
  if (!address) throw new Error("browser did not open debugging port");
  let page;
  for (let index = 0; index < 150; index++) {
    const pages = await (
      await fetch(`http://127.0.0.1:${address}/json/list`)
    ).json();
    page = pages.find(
      (item) => item.type === "page" && (!pageUrl || item.url === pageUrl),
    );
    if (page) break;
    await pause(50);
  }
  if (!page) throw new Error("browser did not create a page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map(),
    errors = [];
  ws.addEventListener("message", (event) => {
    const value = JSON.parse(event.data);
    if (value.id) {
      const item = pending.get(value.id);
      pending.delete(value.id);
      value.error
        ? item.reject(new Error(value.error.message))
        : item.resolve(value.result);
    }
    if (value.method === "Runtime.exceptionThrown")
      errors.push(
        value.params.exceptionDetails.exception?.description ??
          value.params.exceptionDetails.text,
      );
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result.value;
  }
  async function until(expression, { timeoutMs = 8000 } = {}) {
    for (let index = 0; index < Math.ceil(timeoutMs / 50); index++) {
      if (await evaluate(expression)) return;
      await pause(50);
    }
    throw new Error(
      `Browser timeout: ${expression}; ` +
        (await evaluate("document.body.innerText")),
    );
  }
  await call("Runtime.enable");
  await call("Page.enable");
  return { call, evaluate, until, errors, close: () => ws.close() };
}
