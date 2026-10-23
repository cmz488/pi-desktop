import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { GenerationTask } from "@earendil-works/pi-durable";
import { DeskError } from "../config/config-store.mjs";
import { patchGenerationSource } from "./durable-boundary-source.mjs";

/**
 * Durable 提交后边界的兼容入口：优先原生能力，否则安装已核实版本的进程内补丁。
 *
 * 接口：ensureDurableBoundaries() 在 Harness 创建／恢复之前 await；契约见
 *   docs/architecture/interfaces/durable-boundaries.md。
 * 不变量：不写 node_modules、不另建任务种类或执行循环；原生 API v1 出现后不再打补丁。
 * 错误：未知版本／摘要／能力抛 DeskError(501)，不对未知 SDK 猜测式修改。
 */
const API_VERSION = 1;
const MIN_NATIVE_GENERATION_VERSION = 2;
const PATCHED = Symbol.for("pi-desktop.durable-committed-boundary-patch");
const SOURCE_HASH =
  "76e00ccac9f54fd61d0bffc1bfb8adb97ad462b428874a5100928f82e7ff1c94";
let pending;
export async function ensureDurableBoundaries() {
  return (pending ??= install());
}
async function install() {
  if (
    GenerationTask.definition.capabilities?.committedBoundary === API_VERSION
  ) {
    if (
      GenerationTask.definition.version < MIN_NATIVE_GENERATION_VERSION ||
      typeof GenerationTask.definition.migrate !== "function"
    )
      throw new DeskError(
        501,
        "当前 Durable SDK 的边界能力声明缺少检查点迁移契约",
      );
    return Object.freeze({
      apiVersion: API_VERSION,
      implementation: GenerationTask.definition[PATCHED] ? "patch" : "native",
    });
  }
  const entry = import.meta.resolve("@earendil-works/pi-durable");
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", entry), "utf8"),
  );
  if (manifest.version !== "1.0.2")
    throw new DeskError(
      501,
      "当前 Durable SDK 未提供提交后边界接口，也不在兼容补丁支持范围；请先核对 SDK 版本",
    );
  const originalUrl = new URL("./harness/generation.js", entry).href;
  const source = await readFile(new URL(originalUrl), "utf8");
  if (createHash("sha256").update(source).digest("hex") !== SOURCE_HASH)
    throw new DeskError(
      501,
      "当前 Durable SDK 源码与已核实补丁不同，未安装边界补丁",
    );
  const patched =
    patchGenerationSource(
      source.replace("//# sourceMappingURL=generation.js.map", ""),
    ) + "\n//# sourceURL=pi-durable-committed-boundary-v1.mjs";
  const url =
    "data:text/javascript;base64," + Buffer.from(patched).toString("base64");
  // 仅临时调整这一个已核实模块的 parent，依赖仍按原 SDK 的位置与 Node 规则解析。
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(
        specifier,
        context.parentURL === url
          ? { ...context, parentURL: originalUrl }
          : context,
      );
    },
  });
  let module;
  try {
    module = await import(url);
  } finally {
    loader.deregister();
  }
  const definition = GenerationTask.definition;
  Object.assign(definition, module.GenerationTask.definition);
  module.GenerationTask.definition = definition;
  Object.defineProperty(definition, PATCHED, { value: true });
  return Object.freeze({ apiVersion: API_VERSION, implementation: "patch" });
}
