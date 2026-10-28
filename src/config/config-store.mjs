import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { CUSTOM_PROVIDER_APIS } from "../shared/resource-options.mjs";

export class DeskError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const revision = (text) => createHash("sha256").update(text).digest("hex");
export async function readDocument(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    text = "{}";
  }
  const data = JSON.parse(text);
  if (!data || Array.isArray(data) || typeof data !== "object")
    throw new DeskError(422, "配置文件必须是 JSON 对象");
  return { data, revision: revision(text) };
}

// Serializes extension writers; revision fencing also catches changes made in another editor.
export async function mutateDocument(path, expectedRevision, mutate) {
  if (typeof expectedRevision !== "string")
    throw new DeskError(422, "缺少配置版本，请重新读取");
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.pi-desk-lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new DeskError(409, "另一项配置修改正在进行，请稍后重试");
    throw error;
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const current = await readDocument(path);
    if (current.revision !== expectedRevision)
      throw new DeskError(409, "配置已被其他窗口修改，请重新读取后再保存");
    const data = mutate(structuredClone(current.data));
    const nextText = `${JSON.stringify(data, null, 2)}\n`;
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(nextText);
      await file.sync();
    } finally {
      await file.close();
    }
    if ((await readDocument(path)).revision !== current.revision)
      throw new DeskError(409, "保存前配置发生变化，请重新读取");
    await rename(temp, path);
    return { data, revision: revision(nextText) };
  } finally {
    try {
      await unlink(temp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await lock.close();
    await unlink(lockPath);
  }
}

export function patchProvider(data, input, options = {}) {
  if (!/^[a-zA-Z0-9][\w.-]{0,79}$/.test(input.id ?? ""))
    throw new DeskError(422, "服务 ID 只能包含字母、数字、点、横线和下划线");
  const resetEndpoint = input.baseUrl === "" && options.allowDefaultEndpoint;
  const endpoint = resetEndpoint ? undefined : new URL(input.baseUrl);
  if (
    endpoint &&
    (!["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash)
  )
    throw new DeskError(422, "端点必须是无凭据和查询参数的 HTTP(S) 地址");
  const apis = CUSTOM_PROVIDER_APIS;
  if (
    (input.api === undefined && !options.allowDefaultEndpoint) ||
    (input.api !== undefined &&
      (typeof input.api !== "string" ||
        (!apis.includes(input.api) && input.api !== options.additionalApi)))
  )
    throw new DeskError(422, "不支持的 API 类型");
  data.providers ??= {};
  const prior = data.providers[input.id] ?? {};
  if (
    input.name !== undefined &&
    (typeof input.name !== "string" ||
      input.name.length > 256 ||
      /[\x00-\x1f]/.test(input.name))
  )
    throw new DeskError(422, "提供商名称无效");
  const next = {
    ...prior,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.api === undefined ? {} : { api: input.api }),
  };
  if (resetEndpoint) delete next.baseUrl;
  else next.baseUrl = endpoint.href.replace(/\/$/, "");
  if (input.apiKey) {
    if (
      typeof input.apiKey !== "string" ||
      input.apiKey.length > 8192 ||
      input.apiKey.startsWith("!")
    )
      throw new DeskError(422, "请使用密钥或环境变量引用，不支持命令式密钥");
    next.apiKey = input.apiKey;
  }
  if (input.models !== undefined) {
    if (
      !Array.isArray(input.models) ||
      !input.models.length ||
      input.models.length > 256
    )
      throw new DeskError(422, "自定义服务需要 1 至 256 个模型");
    const ids = new Set();
    next.models = input.models.map((model) => {
      if (
        !model ||
        typeof model.id !== "string" ||
        !model.id ||
        model.id.length > 256 ||
        /[\x00-\x1f]/.test(model.id) ||
        ids.has(model.id)
      )
        throw new DeskError(422, "模型 ID 无效或重复");
      ids.add(model.id);
      if (
        (model.name !== undefined &&
          (typeof model.name !== "string" || model.name.length > 256)) ||
        ["contextWindow", "maxTokens"].some(
          (key) =>
            model[key] !== undefined &&
            (!Number.isSafeInteger(model[key]) || model[key] <= 0),
        ) ||
        ["reasoning", "imageInput"].some(
          (key) => model[key] !== undefined && typeof model[key] !== "boolean",
        )
      )
        throw new DeskError(422, "模型参数无效");
      const previous = prior.models?.find((row) => row.id === model.id) ?? {};
      return {
        ...previous,
        id: model.id,
        ...Object.fromEntries(
          ["name", "reasoning", "contextWindow", "maxTokens"]
            .filter((key) => model[key] !== undefined)
            .map((key) => [key, model[key]]),
        ),
        ...(model.imageInput === undefined
          ? {}
          : { input: model.imageInput ? ["text", "image"] : ["text"] }),
      };
    });
  }
  if (input.modelId) {
    if (
      typeof input.modelId !== "string" ||
      input.modelId.length > 256 ||
      /[\x00-\x1f]/.test(input.modelId)
    )
      throw new DeskError(422, "模型 ID 无效");
    const models = [...(prior.models ?? [])];
    if (!models.some((model) => model.id === input.modelId))
      models.push({ id: input.modelId });
    next.models = models;
  }
  if (!prior.baseUrl && !next.models?.length && !options.allowEmptyModels)
    throw new DeskError(422, "新服务至少需要一个模型 ID");
  data.providers[input.id] = next;
  return data;
}
