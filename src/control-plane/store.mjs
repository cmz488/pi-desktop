import { validateApprovalMode } from "../agent/pi-permissions.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import {
  personalityPath,
  readPersonality,
  writePersonality,
} from "../resources/personality.mjs";
import { join, resolve, basename } from "node:path";
import lockfile from "proper-lockfile";
import {
  DeskError,
  readDocument,
  mutateDocument,
} from "../config/config-store.mjs";

const string = (value, max, label) => {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw new DeskError(422, `${label}无效`);
  return value;
};
export async function projectPath(value) {
  string(value, 4096, "项目目录");
  try {
    const path = await realpath(resolve(value));
    if (!(await stat(path)).isDirectory()) throw new Error();
    return path;
  } catch {
    throw new DeskError(422, "项目目录不存在或无法访问");
  }
}
// A single owner protects the catalog. Pi JSONL transcripts and SQLite archives
// are owned by the native-session adapter; Durable keeps the execution journal.
export async function openDesktopStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "workspace.json");
  let compromised = false;
  const release = await lockfile
    .lock(path, {
      realpath: false,
      stale: 10000,
      update: 2000,
      onCompromised: () => {
        compromised = true;
      },
    })
    .catch((error) => {
      if (error.code === "ELOCKED")
        throw new DeskError(409, "Desktop 数据目录已被另一个宿主占用");
      throw error;
    });
  let queue = Promise.resolve();
  const read = async () => {
    if (compromised) throw new DeskError(409, "Desktop 数据锁已失效");
    const doc = await readDocument(path);
    return {
      revision: doc.revision,
      projects: doc.data.projects ?? [],
      agents: doc.data.agents ?? [],
      promptProfiles: await Promise.all(
        (doc.data.promptProfiles ?? []).map(async (row) => {
          const document = await readPersonality(
            personalityPath(directory, row.id),
          );
          return {
            ...row,
            instructions: document.exists
              ? document.content
              : (row.instructions ?? ""),
            file: document.file,
            fileRevision: document.revision,
          };
        }),
      ),
    };
  };
  try {
    await read();
  } catch (error) {
    await release();
    throw error;
  }
  return {
    read,
    update(input, mutate) {
      const result = queue.then(async () => {
        const current = await read();
        if (input.revision !== undefined && input.revision !== current.revision)
          throw new DeskError(409, "项目清单已变化，请刷新后重试");
        return mutateDocument(path, current.revision, (data) => {
          data.version = 1;
          data.projects ??= [];
          data.agents ??= [];
          data.promptProfiles ??= [];
          mutate(data);
          return data;
        });
      });
      queue = result.catch(() => {});
      return result;
    },
    async project(input) {
      const cwd = await projectPath(input.cwd);
      if (input.injections !== undefined)
        throw new DeskError(422, "请使用 Pi Desktop 全局设置和人格配置");
      const name =
        string(input.name ?? basename(cwd), 120, "项目名称").trim() ||
        basename(cwd);
      let id = input.id ?? randomUUID();
      await this.update(input, (data) => {
        const sameDirectory = data.projects.find((row) => row.cwd === cwd);
        const prior = input.id
          ? data.projects.find((row) => row.id === id)
          : sameDirectory?.removedAt
            ? sameDirectory
            : undefined;
        if (input.id && !prior) throw new DeskError(404, "项目不存在");
        if (sameDirectory && sameDirectory !== prior)
          throw new DeskError(409, "该目录已添加为项目");
        if (prior && prior.cwd !== cwd)
          throw new DeskError(422, "已添加项目的目录不能修改");
        if (prior) {
          id = prior.id;
          Object.assign(prior, { name });
          delete prior.removedAt;
          delete prior.instructions;
        } else data.projects.push({ id, name, cwd });
      });
      return { id };
    },
    async removeProject(input) {
      await this.update(input, (data) => {
        const project = data.projects.find((row) => row.id === input.id);
        if (!project) throw new DeskError(404, "项目不存在");
        project.removedAt ??= new Date().toISOString();
        for (const agent of data.agents)
          if (agent.projectId === project.id) agent.desired = false;
      });
      return { id: input.id, removed: true };
    },
    async agent(input) {
      const catalog = await read();
      const prior =
        input.id && catalog.agents.find((row) => row.id === input.id);
      if (input.id && !prior) throw new DeskError(404, "Agent 不存在");
      const projectId = prior ? prior.projectId : (input.projectId ?? null);
      const project = catalog.projects.find((row) => row.id === projectId);
      if (projectId !== null && (!project || project.removedAt))
        throw new DeskError(404, "项目不存在");
      if (input.injections !== undefined)
        throw new DeskError(422, "请使用 Pi Desktop 全局设置和人格配置");
      const name =
        string(input.name ?? "新 Agent", 120, "Agent 名称").trim() ||
        "新 Agent";
      if (
        input.promptProfileId &&
        input.promptProfileId !== "standard" &&
        !catalog.promptProfiles.some((row) => row.id === input.promptProfileId)
      )
        throw new DeskError(404, "系统提示词不存在");
      const id = input.id ?? randomUUID();
      await this.update(input, (data) => {
        const existing = data.agents.find((row) => row.id === id);
        if (
          projectId !== null &&
          !data.projects.some((row) => row.id === projectId && !row.removedAt)
        )
          throw new DeskError(404, "项目不存在");
        if (existing) Object.assign(existing, { name });
        else
          data.agents.push({
            id,
            projectId,
            name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            approvalMode: validateApprovalMode(
              input.approvalMode ?? "ask-risky",
            ),
            promptProfileId: input.promptProfileId ?? "standard",
            desired: false,
            permissions: projectId === null ? "read-only" : "workspace-write",
          });
      });
      return { id };
    },
    async prompt(input) {
      const id = input.id ?? randomUUID();
      const name = string(input.name, 120, "提示词名称").trim();
      if (!name || id === "standard")
        throw new DeskError(422, "提示词名称无效");
      const instructions = string(
        input.instructions ?? "",
        64000,
        "系统提示词",
      );
      const current = await read();
      if (
        input.id &&
        !current.promptProfiles.some((row) => row.id === input.id)
      )
        throw new DeskError(404, "系统提示词不存在");
      if (input.revision !== undefined && input.revision !== current.revision)
        throw new DeskError(409, "项目清单已变化，请刷新后重试");
      const path = personalityPath(directory, id);
      const document = await readPersonality(path);
      await writePersonality(path, {
        content: instructions,
        revision: input.fileRevision ?? document.revision,
      });
      await this.update(input, (data) => {
        const prior = data.promptProfiles.find((row) => row.id === id);
        if (input.id && !prior) throw new DeskError(404, "系统提示词不存在");
        if (prior) {
          Object.assign(prior, { name });
          delete prior.instructions;
        } else data.promptProfiles.push({ id, name });
      });
      return { id };
    },
    async close() {
      await queue;
      await release();
    },
  };
}
