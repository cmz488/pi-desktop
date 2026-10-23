import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEmbeddedPiSdk } from "../src/agent/pi-sdk.mjs";
import { runNativePackageAction } from "../src/resources/native-packages.mjs";
import { desktopFixture, until } from "./desktop-fixture.mjs";

/**
 * 标准扩展测试夹具：通过真实 Pi 包管理、发现与绑定建立隔离的 Host 和原生对照。
 *
 * 接口：installStandardExtensions、standardExtensionFixture、readExtensionTrace、standardModelReply；
 *   证据与运行范围见 docs/references/pi-extension-compatibility-baseline.md。
 * 不变量：扩展源码仅使用标准 Pi API；安装配置、日志与模型都在临时目录／本机；不注入工厂。
 * 错误：安装／加载／执行失败原样抛出；调用者须 close() 释放 Host 与模型服务。
 */
export async function installStandardExtensions({ cwd, agentDir, root }) {
  const sdk = await loadEmbeddedPiSdk();
  await mkdir(agentDir, { recursive: true });
  let data;
  try {
    data = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    data = {};
  }
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ ...data, enableInstallTelemetry: false }),
  );
  const settings = sdk.SettingsManager.create(cwd, agentDir, {
    projectTrusted: true,
  });
  const manager = new sdk.DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager: settings,
  });
  const sources = [];
  for (const name of ["notes", "review"]) {
    const source = join(root, name);
    await cp(
      fileURLToPath(
        new URL(`./fixtures/standard-extensions/${name}/`, import.meta.url),
      ),
      source,
      { recursive: true },
    );
    for (const file of ["package.json", "extension.ts"])
      assert.doesNotMatch(
        await readFile(join(source, file), "utf8"),
        /piDesktop|registerExtensionAdapter|extension-adapters/,
      );
    await runNativePackageAction(manager, settings, {
      action: "install",
      source,
      scope: "global",
    });
    sources.push(source);
  }
  const persisted = JSON.parse(
    await readFile(join(agentDir, "settings.json"), "utf8"),
  );
  assert.deepEqual(
    persisted.packages.map((source) =>
      manager.getInstalledPath(source, "user"),
    ),
    sources,
    "由真实 Pi installAndPersist 写入并解析原生 packages",
  );
  return { sources, sdk };
}

export async function readExtensionTrace(cwd, name = "notes") {
  try {
    return (await readFile(join(cwd, `${name}-events.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export function standardModelReply(input) {
  const lastUser = input.messages.findLastIndex(
    (message) => message.role === "user",
  );
  const content = input.messages[lastUser]?.content;
  const prompt =
    typeof content === "string"
      ? content
      : content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  if (
    !input.messages
      .slice(lastUser + 1)
      .some((message) => message.role === "tool")
  ) {
    const notes =
      /^RUN_NOTES_(STREAM|PING|BLOCK|THROW|NESTED|USAGE|LATE)$/.exec(prompt);
    if (notes)
      return {
        toolCalls: [
          {
            id: `notes-${notes[1].toLowerCase()}`,
            type: "function",
            function: {
              name: "compat_notes",
              arguments: JSON.stringify({
                op: notes[1].toLowerCase(),
                text: "fixture-note",
              }),
            },
          },
        ],
      };
    if (prompt === "RUN_REVIEW_CHECK")
      return {
        toolCalls: [
          {
            id: "review-check",
            type: "function",
            function: {
              name: "compat_check",
              arguments: JSON.stringify({ target: "fixture-target" }),
            },
          },
        ],
      };
  }
  return {
    text:
      prompt === "MESSAGE_REPLACEMENT_PROBE"
        ? "REPLACE_THIS_ANSWER"
        : "STANDARD_EXTENSION_MODEL_DONE",
  };
}

export async function standardExtensionFixture(options = {}) {
  const f = await desktopFixture({
    modelReply: standardModelReply,
    ...options,
  });
  try {
    const { sources, sdk } = await installStandardExtensions({
      cwd: f.cwd,
      agentDir: f.agentDir,
      root: join(f.root, "packages"),
    });
    const project = (await f.call("/api/workspace")).projects.find(
      (row) => row.cwd === f.cwd,
    );
    const actor = await f.command("conversation.create", {
      projectId: project.id,
      name: "Standard extension compatibility",
    });
    const prefix = `/agents/${actor.id}`;
    const state = await f.call(`${prefix}/api/state`);
    const id = state.sessionId;
    const api = (path, input) => {
      const url = new URL(`/api/${path}`, "http://fixture.invalid");
      url.searchParams.set("sessionId", id);
      return f.call(`${prefix}${url.pathname}${url.search}`, input);
    };
    const settled = async () => {
      const state = await until(
        () => api("state"),
        (value) => value.idle,
      );
      await until(
        () => readExtensionTrace(f.cwd),
        (rows) => rows.at(-1)?.type === "agent_settled",
      );
      return state;
    };
    return Object.assign(f, { sources, sdk, actor, prefix, id, api, settled });
  } catch (error) {
    await f.close();
    throw error;
  }
}
