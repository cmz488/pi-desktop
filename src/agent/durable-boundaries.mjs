import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import {
  GenerationTask,
  CompactionTask,
  Harness,
  InboxDoc,
} from "@earendil-works/pi-durable";
import { DeskError } from "../config/config-store.mjs";
import { patchGenerationSource } from "./durable-boundary-source.mjs";
import { patchEntrySource } from "./durable-entry-source.mjs";

/**
 * Durable 原生衔接的兼容入口：优先原生能力，否则安装已核实版本的进程内补丁。
 *
 * 接口：ensureDurableBoundaries／ensureDurableRequests／ensureDurableInputs 在 Harness 创建前 await；
 *   见 docs/architecture/interfaces/durable-boundaries.md、durable-request-runtime.md、durable-entry-inputs.md。
 * 不变量：不写 node_modules，不另建任务、队列、writer 或执行循环；公开 token／definition 身份保留。
 * 错误：未知版本、摘要、能力或迁移契约抛 DeskError(501)，不对未知 SDK 猜测式修改。
 */
const API_VERSION = 1;
const MIN_NATIVE_GENERATION_VERSION = 2;
const MIN_NATIVE_INBOX_VERSION = 2;
const PATCHED = Symbol.for("pi-desktop.durable-committed-boundary-patch");
const SOURCE_HASHES = {
  generation:
    "76e00ccac9f54fd61d0bffc1bfb8adb97ad462b428874a5100928f82e7ff1c94",
  compaction:
    "de7eed72f40ca9f571d03374020f1b4f47dc609aae374f13388831ccdbd8c88d",
  harness: "bccc40887ec3b24e7d015cd3e05aa8bce4e41eab67150b7301de8dbf9b7ab1b3",
  submissions:
    "1aa0780fee380912ba8123f0da003a087f7bee7a8b20b4157f99b60d42e68dd2",
  inbox: "082751494dda99eeab21d74a2207912ad409055fa504d370089807d7c0421d85",
};
let pending;
export async function ensureDurableBoundaries() {
  return (pending ??= install());
}
export async function ensureDurableRequests() {
  const support = await ensureDurableBoundaries();
  if (
    GenerationTask.definition.capabilities?.requestRuntime !== API_VERSION ||
    CompactionTask.definition.capabilities?.requestRuntime !== API_VERSION
  )
    throw new DeskError(
      501,
      "当前 Durable SDK 缺少会话模型运行时与请求级适配接口",
    );
  return support;
}
export async function ensureDurableInputs() {
  const support = await ensureDurableRequests();
  if (
    Harness.capabilities?.entryInput !== API_VERSION ||
    InboxDoc.definition.version < MIN_NATIVE_INBOX_VERSION ||
    typeof InboxDoc.definition.migrate !== "function"
  )
    throw new DeskError(
      501,
      "当前 Durable SDK 缺少 entry 输入准入与 inbox 迁移接口",
    );
  return support;
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
  const sources = new Map(),
    origins = new Map(),
    redirects = new Map(),
    urls = {};
  // 这几个原生 module 相互引用；稳定的内存 URL 保留其依赖图，而不是复制准入／队列规则。
  for (const [name, hash] of Object.entries(SOURCE_HASHES)) {
    const original = new URL(`./harness/${name}.js`, entry).href;
    let source = await readFile(new URL(original), "utf8");
    if (createHash("sha256").update(source).digest("hex") !== hash)
      throw new DeskError(
        501,
        "当前 Durable SDK 源码与已核实补丁不同，未安装兼容补丁",
      );
    source = source.replace(`//# sourceMappingURL=${name}.js.map`, "");
    if (name === "generation") source = patchGenerationSource(source);
    if (name === "inbox" || name === "submissions")
      source = patchEntrySource(name, source);
    if (name === "harness")
      source +=
        "\nHarness.capabilities = { ...Harness.capabilities, entryInput: 1 };\n";
    const url = `pi-desktop-durable:1.0.2/${name}.js`;
    urls[name] = url;
    sources.set(url, source);
    origins.set(url, original);
    redirects.set(original, url);
  }
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (sources.has(specifier)) return { url: specifier, shortCircuit: true };
      const origin = origins.get(context.parentURL);
      if (!origin) return nextResolve(specifier, context);
      const resolved = nextResolve(specifier, {
        ...context,
        parentURL: origin,
      });
      const url = redirects.get(resolved.url);
      return url ? { ...resolved, url, shortCircuit: true } : resolved;
    },
    load(url, context, nextLoad) {
      return sources.has(url)
        ? { format: "module", source: sources.get(url), shortCircuit: true }
        : nextLoad(url, context);
    },
  });
  let modules;
  try {
    // 从原生 Harness 根装载，保持 generation／compaction／submission 的原有循环依赖。
    await import(urls.harness);
    modules = Object.fromEntries(
      await Promise.all(
        Object.entries(urls).map(async ([name, url]) => [
          name,
          await import(url),
        ]),
      ),
    );
  } finally {
    loader.deregister();
  }
  for (const [token, patched] of [
    [GenerationTask, modules.generation.GenerationTask],
    [CompactionTask, modules.compaction.CompactionTask],
    [InboxDoc, modules.inbox.InboxDoc],
  ]) {
    const definition = token.definition;
    Object.assign(definition, patched.definition);
    patched.definition = definition;
  }
  modules.generation.installRequestRuntime(CompactionTask);
  Object.assign(Harness, modules.harness.Harness);
  Object.defineProperty(GenerationTask.definition, PATCHED, { value: true });
  return Object.freeze({ apiVersion: API_VERSION, implementation: "patch" });
}
