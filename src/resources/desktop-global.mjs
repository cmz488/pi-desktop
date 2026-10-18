import { mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadEmbeddedPiSdk } from "../agent/pi-sdk.mjs";
import { DeskError, readDocument } from "../config/config-store.mjs";
import {
  installedPackageVersion,
  runNativePackageAction,
} from "./native-packages.mjs";
import { readPersonality, writePersonality } from "./personality.mjs";

// The supervisor owns the global write fence; Pi owns package identities,
// version pins, update selection and settings persistence.
export function createDesktopGlobal({
  agentDir,
  directory,
  supervisor,
  packageManagerFactory,
}) {
  const path = join(agentDir, "AGENTS.md");
  const cwd = join(directory, "global-context");
  const makeManager = async () => {
    const sdk = await loadEmbeddedPiSdk();
    const settings = sdk.SettingsManager.create(cwd, agentDir, {
      projectTrusted: false,
    });
    const manager = packageManagerFactory
      ? packageManagerFactory({ cwd, agentDir, settings })
      : new sdk.DefaultPackageManager({
          cwd,
          agentDir,
          settingsManager: settings,
        });
    return { settings, manager };
  };
  async function updates() {
    const document = await readDocument(join(agentDir, "settings.json"));
    const sources = (document.data.packages ?? []).map((row) =>
      typeof row === "string" ? row : row.source,
    );
    const { manager } = await makeManager();
    const versions = await Promise.all(
      sources.map(async (source) => ({
        source,
        ...(await installedPackageVersion(
          manager.getInstalledPath?.(source, "user"),
        )),
      })),
    );
    return {
      sources,
      versions,
      revision: document.revision,
      inventoryKey: createHash("sha256")
        .update(JSON.stringify({ sources, versions }))
        .digest("hex"),
      command: "pi update --extensions",
    };
  }
  const effectiveFile = async () => {
    const sdk = await loadEmbeddedPiSdk();
    return (
      sdk
        .loadProjectContextFiles({ cwd: agentDir, agentDir })
        .find((row) => dirname(row.path) === resolve(agentDir))?.path ?? path
    );
  };
  return {
    readPersonality: async () => ({
      ...(await readPersonality(path)),
      effectiveFile: await effectiveFile(),
    }),
    savePersonality: (input) =>
      supervisor.shared(async ({ reload }) => {
        const result = await writePersonality(path, input);
        const reloadRequired = await reload();
        return {
          ...result,
          effectiveFile: await effectiveFile(),
          reloadRequired,
        };
      }),
    updates,
    update: (input) =>
      supervisor.shared(async () => {
        const before = await updates();
        if (
          input.revision !== before.revision ||
          input.inventoryKey !== before.inventoryKey
        )
          throw new DeskError(409, "插件列表已变化，请重新读取并确认全量更新");
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        const { settings, manager } = await makeManager();
        await runNativePackageAction(manager, settings, {
          action: "update-all",
          scope: "global",
        });
        return { ok: true, command: before.command, reloadRequired: true };
      }),
  };
}
