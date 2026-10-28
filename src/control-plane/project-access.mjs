import { isAbsolute, join, relative, sep } from "node:path";

import { validateDirectory } from "../desktop/directory-picker.mjs";
import { loadEmbeddedPiSdk } from "../agent/pi-sdk.mjs";
import { readWorkspaceFile } from "../workspace/workspace-files.mjs";
import { getGitRepository } from "../git/git-manager.mjs";
import {
  readMcpInventory,
  patchMcp,
  validMcpName,
} from "../resources/mcp-config.mjs";
import { DeskError, mutateDocument } from "../config/config-store.mjs";

const inside = (root, path) => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
};

/** Local, explicitly selected draft directories have no worker; discovery must not create one. */
export function createProjectAccess({ agentDir, catalog }) {
  async function context(cwd) {
    const directory = await validateDirectory(cwd);
    const sdk = await loadEmbeddedPiSdk();
    const policy = sdk.SettingsManager.create(directory, agentDir, {
      projectTrusted: false,
    });
    const trust = new sdk.ProjectTrustStore(agentDir);
    const trusted =
      !sdk.hasTrustRequiringProjectResources(directory) ||
      (trust.get(directory) ?? policy.getDefaultProjectTrust() === "always");
    return { cwd: directory, trusted, trust };
  }
  const inventory = (ctx) =>
    readMcpInventory({
      globalPath: join(agentDir, "mcp.json"),
      projectPath: join(ctx.cwd, ".pi", "mcp.json"),
      projectTrusted: ctx.trusted,
    });
  async function gitGuard(cwd) {
    const ctx = await context(cwd);
    if (!ctx.trusted)
      throw new DeskError(403, "请先在 Pi 信任项目，再执行 Git");
    return ctx;
  }
  return {
    async files(cwd, path) {
      const ctx = await context(cwd);
      return readWorkspaceFile(ctx.cwd, path);
    },
    async trusted(cwd) {
      return (await context(cwd)).trusted;
    },
    async trust(cwd) {
      const ctx = await context(cwd);
      ctx.trust.set(ctx.cwd, true);
      return true;
    },
    async git(cwd, input) {
      const ctx = await gitGuard(cwd),
        repo = await getGitRepository(ctx.cwd);
      if (!input) return repo.read();
      if (!input.token && input.action !== "switch")
        throw new DeskError(422, "草稿目录只提供切换分支");
      const guard = async () => {
        await gitGuard(ctx.cwd);
        const state = await catalog();
        const projectIds = new Set(
          state.projects
            .filter(
              (project) =>
                inside(repo.root, project.cwd) || inside(project.cwd, ctx.cwd),
            )
            .map((project) => project.id),
        );
        if (
          state.agents.some(
            (agent) =>
              projectIds.has(agent.projectId) &&
              (agent.desired ||
                ["running", "starting", "stopping"].includes(agent.status)),
          )
        )
          throw new DeskError(
            409,
            "项目会话已启动，请刷新后在所属会话中操作 Git",
          );
      };
      await guard();
      const binding = `draft:${ctx.cwd}`;
      const result = input.token
        ? await repo.confirm(input.token, binding, guard)
        : await repo.prepare(input, binding);
      if (!input.token) await guard();
      return result;
    },
    async mcp(cwd, input) {
      const ctx = await context(cwd);
      if (!input) return inventory(ctx);
      if (!["global", "project"].includes(input.scope))
        throw new DeskError(422, "配置范围无效");
      const current = await inventory(ctx);
      if (!validMcpName(input.name))
        throw new DeskError(422, "MCP 服务名称无效");
      if (
        input.action !== "remove" &&
        current.rows.some(
          (row) =>
            row.name !== input.name &&
            row.name.replaceAll("-", "_") === input.name.replaceAll("-", "_"),
        )
      )
        throw new DeskError(422, "MCP 命名空间与已有服务冲突");
      await mutateDocument(
        input.scope === "project" ? current.projectPath : current.globalPath,
        input.revision,
        (data) => patchMcp(data, input),
      );
      return inventory(ctx);
    },
  };
}
