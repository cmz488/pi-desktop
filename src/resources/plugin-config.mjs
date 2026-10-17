import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute, join } from "node:path";
import {
  DeskError,
  readDocument,
  mutateDocument,
} from "../config/config-store.mjs";

const inside = (root, path) => {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
};
async function configPath(root, file) {
  if (typeof file !== "string" || !file.endsWith(".json"))
    throw new DeskError(422, "插件配置文件必须为 JSON");
  const path = resolve(root, file);
  if (!inside(root, path)) throw new DeskError(422, "插件配置不能越过声明目录");
  const canonicalRoot = await realpath(root);
  let current = path;
  while (true) {
    try {
      const actual = await realpath(current);
      if (!inside(canonicalRoot, actual))
        throw new DeskError(422, "插件配置不能指向目录外部");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  return path;
}
function validateSchema(schema) {
  if (!schema || !Array.isArray(schema.fields) || schema.fields.length > 100)
    return false;
  return schema.fields.every(
    (field) =>
      typeof field.key === "string" &&
      /^[a-zA-Z][\w.-]{0,100}$/.test(field.key) &&
      !field.key
        .split(".")
        .some((part) =>
          ["constructor", "prototype", "__proto__"].includes(part),
        ) &&
      ["boolean", "string", "number", "enum"].includes(field.type) &&
      (!field.secret || field.type === "string") &&
      (field.type !== "enum" ||
        (Array.isArray(field.options) &&
          field.options.every((item) =>
            ["boolean", "number", "string"].includes(typeof item),
          ))),
  );
}
const get = (data, key) =>
  key.split(".").reduce((value, part) => value?.[part], data);
export async function discoverPluginConfig(row, agentDir, packagePath) {
  if (
    /^npm:pi-rtk-optimizer(?:@[^\s]+)?$/.test(row.source) ||
    row.name === "pi-rtk-optimizer"
  )
    return {
      path: join(agentDir, "extensions", "pi-rtk-optimizer", "config.json"),
      fields: [
        {
          key: "guardWhenRtkMissing",
          label: "RTK 不存在时保护",
          type: "boolean",
          default: true,
        },
        {
          key: "showRewriteNotifications",
          label: "显示命令重写通知",
          type: "boolean",
          default: true,
        },
      ],
    };
  const root = row.type === "file" ? dirname(row.source) : packagePath;
  if (!root) return null;
  let schema;
  try {
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    schema = manifest.pi?.webConfig;
  } catch (error) {
    if (
      !["ENOENT", "ENOTDIR"].includes(error.code) &&
      !(error instanceof SyntaxError)
    )
      throw error;
  }
  if (!schema)
    try {
      schema = JSON.parse(
        await readFile(join(root, "pi-web.config.json"), "utf8"),
      );
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR"].includes(error.code) &&
        !(error instanceof SyntaxError)
      )
        throw error;
    }
  if (!validateSchema(schema)) return null;
  try {
    return { path: await configPath(root, schema.file), fields: schema.fields };
  } catch (error) {
    if (error instanceof DeskError) return null;
    throw error;
  }
}
export async function pluginConfigDocument(adapter) {
  const doc = await readDocument(adapter.path);
  return {
    revision: doc.revision,
    fields: adapter.fields,
    data: Object.fromEntries(
      adapter.fields.map((field) => [
        field.key,
        field.secret
          ? { configured: Boolean(get(doc.data, field.key)) }
          : (get(doc.data, field.key) ??
            field.default ??
            (field.type === "boolean"
              ? false
              : field.type === "number"
                ? 0
                : "")),
      ]),
    ),
  };
}
export async function savePluginConfig(adapter, input) {
  if (
    !input.patch ||
    Array.isArray(input.patch) ||
    typeof input.patch !== "object"
  )
    throw new DeskError(422, "插件配置修改无效");
  const fields = new Map(adapter.fields.map((field) => [field.key, field]));
  await mutateDocument(adapter.path, input.revision, (data) => {
    for (const [key, value] of Object.entries(input.patch)) {
      const field = fields.get(key);
      if (!field) throw new DeskError(422, "不支持的配置字段");
      if (field.secret && value === "") continue;
      const valid =
        field.type === "enum"
          ? field.options.includes(value)
          : field.type === "number"
            ? Number.isFinite(value) &&
              value >= (field.min ?? -Infinity) &&
              value <= (field.max ?? Infinity)
            : typeof value === field.type;
      if (!valid || (typeof value === "string" && value.length > 8192))
        throw new DeskError(422, "插件配置字段值无效");
      const parts = key.split(".");
      let target = data;
      for (const part of parts.slice(0, -1)) {
        target[part] ??= {};
        if (
          !target[part] ||
          typeof target[part] !== "object" ||
          Array.isArray(target[part])
        )
          throw new DeskError(422, "已有嵌套配置格式不兼容");
        target = target[part];
      }
      target[parts.at(-1)] = value;
    }
    return data;
  });
}
