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
const PATCHED = Symbol.for("pi-desktop.durable-committed-boundary-patch");
/**
 * 已核实的 Durable 发布版本 → 受影响源码摘要。
 *
 * 只接受逐字节核对过的发布文件：同版本号不同内容（篡改、被打过补丁、非官方源）一律拒绝，
 * 不猜测锚点。升级版本必须重新跑 test/durable-boundaries.test.mjs 全绿后才能登记。
 */
const SUPPORTED_VERSIONS = {
  "1.4.0": {
    generation:
      "b7b8c610e23f100edd9cde336c28f70ae8c82f6e988f4b4564e1a732a2e1b531",
    compaction:
      "96daba50b8e169864371dc93879cd9ee42cb60aec1864b380cee84db24253f99",
    harness:
      "472fe31f5525045ec4b27437a2049236f4f58cce4920aa9bd49e41445097574d",
    inbox:
      "f4de5603e1dd5f1072b24757a057074a3360a20720327ef58152e067f16d2454",
  },
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
  if (Harness.capabilities?.entryInput !== API_VERSION)
    throw new DeskError(
      501,
      "当前 Durable SDK 缺少 entry 输入准入接口",
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
  const SOURCE_HASHES = SUPPORTED_VERSIONS[manifest.version];
  if (!SOURCE_HASHES)
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
    const url = `pi-desktop-durable:${manifest.version}/${name}.js`;
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
