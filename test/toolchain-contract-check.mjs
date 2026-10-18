import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  stat,
  copyFile,
} from "node:fs/promises";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire, registerHooks } from "node:module";

/**
 * 本次工具契约的隔离核验：只调用参数校验与历史解析，不调用任何子代理工具或执行器。
 *
 * 接口：PI_SUBAGENTS_ROOT、PI_TOOL_HOST_PACKAGE 后运行本脚本；说明见
 *   docs/guides/review-handoff.md，0.77.0 以外版本需重新审计。
 * 不变量：外部包只读；所有新文件在临时目录；Git 仅用于父会话准备不可变审查交接。
 * 错误：环境／版本不符明确失败；E3 只验证条件模型，不证明实际事件已修复或任务已停止。
 */
if (!process.env.PI_SUBAGENTS_ROOT || !process.env.PI_TOOL_HOST_PACKAGE)
  throw new Error(
    "请提供 PI_SUBAGENTS_ROOT 与 PI_TOOL_HOST_PACKAGE 的绝对路径",
  );
const installed = resolve(process.env.PI_SUBAGENTS_ROOT);
const hostRequire = createRequire(resolve(process.env.PI_TOOL_HOST_PACKAGE));
const packageInfo = JSON.parse(
  await readFile(join(installed, "package.json"), "utf8"),
);
assert.equal(
  packageInfo.version,
  "0.77.0",
  "工具链版本已变化，请重新核对 schema 与生命周期实现",
);
const peers = [
  "typebox",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (
        error.code !== "ERR_MODULE_NOT_FOUND" ||
        !peers.some(
          (peer) => specifier === peer || specifier.startsWith(peer + "/"),
        )
      )
        throw error;
      return {
        url: pathToFileURL(hostRequire.resolve(specifier)).href,
        shortCircuit: true,
      };
    }
  },
});
const temp = await mkdtemp("/tmp/pi-toolchain-check-");
process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
await mkdir(process.env.PI_CODING_AGENT_DIR);
const { flattenSubagentToolOptions: flatten } = await import(
  pathToFileURL(join(installed, "src/extension/subagent-options.js"))
);
assert.throws(
  () => flatten({ options: { progress: false } }),
  /unknown options key 'progress'/,
);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guide = await readFile(
  join(source, "docs/guides/review-handoff.md"),
  "utf8",
);
const example = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1]);
assert.doesNotThrow(
  () => flatten(example),
  "指南使用当前声明的参数，不沿用过期示例",
);
assert.deepEqual(flatten(example), {
  includeProgress: false,
  chatProgress: "off",
});
assert.throws(
  () => flatten({ options: { chatProgress: false } }),
  /chatProgress/,
);
console.log(
  'E1 校验通过：progress 被拒绝；includeProgress:false / chatProgress:"off" 有效；chatProgress 布尔值被拒绝。未调用执行器或启动子代理。',
);

const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const git = (args) =>
  execFileSync("git", args, { cwd: source, maxBuffer: ARTIFACT_MAX_BYTES });
const base = git(["rev-parse", "--verify", "147eced^{commit}"])
  .toString()
  .trim();
const head = git(["rev-parse", "--verify", "bc1ed7a^{commit}"])
  .toString()
  .trim();
const patch = git([
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--binary",
  "--full-index",
  "--no-color",
  base,
  head,
  "--",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifact = join(temp, "handoff");
await mkdir(artifact, { mode: 0o700 });
const manifest = {
  version: 1,
  kind: "committed-range",
  base,
  head,
  commitCount: Number(git(["rev-list", "--count", `${base}..${head}`])),
  patch: "changes.patch",
  sha256: sha256(patch),
  bytes: patch.length,
};
await writeFile(join(artifact, "changes.patch"), patch, { mode: 0o444 });
await writeFile(
  join(artifact, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { mode: 0o444 },
);
await writeFile(
  join(artifact, "name-status.txt"),
  git(["diff", "--name-status", base, head, "--"]),
  { mode: 0o444 },
);
// 上下文也由父会话固定到同一提交，避免只读审查者误读已变更的当前工作树。
for (const [name, ref] of [
  ["base", base],
  ["head", head],
]) {
  const modes = git(["ls-tree", "-r", ref]).toString().split("\n");
  assert.equal(
    modes.some((row) => row.startsWith("120000 ")),
    false,
    "审查快照不能暴露符号链接的外部目标",
  );
  const target = join(artifact, name);
  await mkdir(target);
  execFileSync("tar", ["-xf", "-", "-C", target], {
    input: git(["archive", "--format=tar", ref]),
    maxBuffer: ARTIFACT_MAX_BYTES,
  });
}
async function preflight(directory) {
  const item = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  assert.equal(item.version, 1);
  assert.equal(item.kind, "committed-range");
  assert.equal(item.patch, "changes.patch", "补丁路径不得越出交接目录");
  assert.match(item.base, /^[0-9a-f]{40}$/);
  assert.match(item.head, /^[0-9a-f]{40}$/);
  const bytes = await readFile(join(directory, item.patch));
  assert.equal(bytes.length, item.bytes);
  assert.equal(sha256(bytes), item.sha256);
  assert.match(bytes.toString(), /^diff --git /);
  return item;
}
assert.equal((await preflight(artifact)).commitCount, 10);
const bad = join(temp, "corrupt-handoff");
await mkdir(bad);
await copyFile(join(artifact, "manifest.json"), join(bad, "manifest.json"));
await writeFile(
  join(bad, "changes.patch"),
  Buffer.concat([patch, Buffer.from("\n")]),
);
await assert.rejects(() => preflight(bad), assert.AssertionError);
const corrupted = Buffer.from(patch);
corrupted[corrupted.length - 1] ^= 1;
await writeFile(join(bad, "changes.patch"), corrupted);
await assert.rejects(() => preflight(bad), assert.AssertionError);
const invalid = join(temp, "invalid-handoff");
await mkdir(invalid);
await writeFile(join(invalid, "changes.patch"), patch);
for (const changes of [
  { version: 2 },
  { kind: "working-tree" },
  { patch: "../handoff/changes.patch" },
  { base: "invalid" },
  { head: "invalid" },
  { bytes: patch.length + 1 },
]) {
  await writeFile(
    join(invalid, "manifest.json"),
    JSON.stringify({ ...manifest, ...changes }),
  );
  await assert.rejects(() => preflight(invalid), assert.AssertionError);
}
async function seal(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await seal(file);
    else await chmod(file, 0o444);
  }
  await chmod(directory, 0o500);
}
await seal(artifact);
assert.equal((await stat(join(artifact, "changes.patch"))).mode & 0o222, 0);
assert.equal(
  (await stat(join(artifact, "head/package.json"))).mode & 0o222,
  0,
  "上下文快照同样只读",
);
await assert.rejects(
  () => writeFile(join(artifact, "changes.patch"), "mutation"),
  { code: "EACCES" },
);
console.log(
  "E2 校验通过：固定 10 个提交的 diff 与两端源码快照可读，摘要核验通过，篡改失败，产物只读；审查者无需 Git 或 Shell。",
);
console.log("E2_MANIFEST=" + JSON.stringify({ ...manifest, artifact }));

const { persistForegroundRunHistory, restoreForegroundRunHistory } =
  await import(
    pathToFileURL(join(installed, "src/runs/foreground/foreground-history.js"))
  );
const { resolveSubagentRunId } = await import(
  pathToFileURL(join(installed, "src/runs/background/run-id-resolver.js"))
);
const resultsDir = join(temp, "results"),
  asyncDirRoot = join(temp, "async");
await mkdir(resultsDir);
await mkdir(asyncDirRoot);
const runId = "02bf8b81-9988-4128-954e-d57d6bc496d1";
const empty = () => ({
  currentSessionId: "fixture-A",
  foregroundRuns: new Map(),
  foregroundControls: new Map(),
  asyncJobs: new Map(),
});
const state = empty();
const run = {
  runId,
  mode: "single",
  cwd: temp,
  sessionId: "fixture-A",
  updatedAt: 1,
  children: [{ agent: "reviewer", index: 0, status: "detached" }],
};
state.foregroundRuns.set(runId, run);
const deps = (value) => ({
  state: value,
  resultsDir,
  asyncDirRoot,
  nested: { routes: [] },
});
assert.equal(resolveSubagentRunId(runId, deps(state)).kind, "foreground");
persistForegroundRunHistory(state, { resultsDir });
assert.equal(
  JSON.parse(
    await readFile(join(resultsDir, "foreground-history.json"), "utf8"),
  ).runs.length,
  0,
);
const restored = empty();
assert.equal(restoreForegroundRunHistory(restored, { resultsDir }), 0);
assert.equal(resolveSubagentRunId(runId, deps(restored)), undefined);
run.children[0].status = "completed";
persistForegroundRunHistory(state, { resultsDir });
const completed = empty();
assert.equal(restoreForegroundRunHistory(completed, { resultsDir }), 1);
assert.equal(resolveSubagentRunId(runId, deps(completed)).kind, "foreground");
completed.currentSessionId = "fixture-B";
assert.equal(resolveSubagentRunId(runId, deps(completed)), undefined);
console.log(
  "E3 条件模型：detached 前台记录内存中可查，但不进入可恢复历史；新状态不可查。completed 可恢复，其他父会话仍被隔离。这不是本次历史事件的根因或任务停止证据，E3 未修复。",
);
console.log("TEMP=" + temp);
