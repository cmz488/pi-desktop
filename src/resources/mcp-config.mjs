import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeskError } from "../config/config-store.mjs";

export const exposures = ["codemode", "deferred", "direct", "hidden"];
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
export const validMcpName = (name) =>
  typeof name === "string" &&
  /^[A-Za-z0-9_-]{1,128}$/.test(name) &&
  !["__proto__", "prototype", "constructor"].includes(name);
export function validateMcp(name, value, scope) {
  const fail = (message) => {
    throw new DeskError(422, message);
  };
  if (!validMcpName(name) || !record(value))
    fail("MCP 名称只能包含字母、数字、下划线和连字符");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    fail("enabled 必须是布尔值");
  if (value.description !== undefined && typeof value.description !== "string")
    fail("description 必须是文本");
  if (
    value.timeout !== undefined &&
    (!Number.isFinite(value.timeout) || value.timeout <= 0)
  )
    fail("超时应为正数，单位为秒");
  const validExposure = (entry) =>
    exposures.includes(entry) || entry === "codemode-deferred";
  if (value.exposure !== undefined && !validExposure(value.exposure))
    fail("工具暴露方式无效");
  if (
    value.toolExposure !== undefined &&
    (!record(value.toolExposure) ||
      Object.values(value.toolExposure).some((entry) => !validExposure(entry)))
  )
    fail("单个工具的暴露方式无效");
  const stringMap = (entry) =>
    record(entry) &&
    Object.values(entry).every((item) => typeof item === "string");
  if (value.url !== undefined) {
    if (typeof value.url !== "string") fail("请输入 MCP HTTP URL");
    let url;
    try {
      url = new URL(value.url);
    } catch {
      fail("请输入有效的 MCP HTTP URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      fail("MCP URL 应为 HTTP 或 HTTPS，认证请使用请求头");
    if (
      value.type !== undefined &&
      !["http", "streamable-http"].includes(value.type)
    )
      fail("Pi 使用 Streamable HTTP，不支持旧式 SSE");
    if (value.command !== undefined) fail("请选择一种传输方式");
    if (value.headers !== undefined && !stringMap(value.headers))
      fail("请求头必须是文本键值对象");
    if (
      value.auth !== undefined &&
      (scope !== "global" ||
        !record(value.auth) ||
        typeof value.auth.provider !== "string" ||
        !value.auth.provider ||
        (url.protocol !== "https:" &&
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
      fail("提供商认证仅适用于用户配置及 HTTPS／回环端点");
    if (value.oauth !== undefined) {
      if (!record(value.oauth)) fail("OAuth 配置必须是对象");
      for (const key of ["clientId", "clientSecret", "clientName", "scope"])
        if (
          value.oauth[key] !== undefined &&
          typeof value.oauth[key] !== "string"
        )
          fail("OAuth 参数必须是文本");
      if (
        value.oauth.clientName !== undefined &&
        !value.oauth.clientName.trim()
      )
        fail("OAuth 客户端名称不能为空");
      const port = value.oauth.callbackPort;
      if (
        port !== undefined &&
        (!Number.isInteger(port) || port < 1 || port > 65535)
      )
        fail("OAuth 回调端口无效");
      if (value.oauth.callbackUrl !== undefined) {
        let callback;
        try {
          callback = new URL(value.oauth.callbackUrl);
        } catch {
          fail("OAuth 回调 URL 无效");
        }
        if (
          callback.protocol !== "http:" ||
          !["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname) ||
          callback.search ||
          callback.hash ||
          (callback.port &&
            port !== undefined &&
            Number(callback.port) !== port)
        )
          fail("OAuth 回调应为本机 HTTP URL，且端口应一致");
      }
    }
  } else {
    if (
      typeof value.command !== "string" ||
      !value.command.trim() ||
      (value.type !== undefined && value.type !== "stdio")
    )
      fail("stdio 服务需要启动命令");
    if (
      value.args !== undefined &&
      (!Array.isArray(value.args) ||
        value.args.some((item) => typeof item !== "string"))
    )
      fail("命令参数应为文本数组");
    if (value.env !== undefined && !stringMap(value.env))
      fail("环境变量必须是文本键值对象");
    if (value.cwd !== undefined && typeof value.cwd !== "string")
      fail("工作目录必须是文本");
  }
  return value;
}

// The native extension owns transport, discovery and OAuth. This adapter only
// provides the documented mcp.json shape through its public loadConfig option.
export function loadWebMcp({ agentDir, cwd, projectTrusted }) {
  const servers = new Map(),
    errors = [];
  let autoEnableCodemode;
  for (const scope of projectTrusted ? ["global", "project"] : ["global"]) {
    const source =
      scope === "global"
        ? join(agentDir, "mcp.json")
        : join(cwd, ".pi", "mcp.json");
    try {
      const data = JSON.parse(readFileSync(source, "utf8"));
      if (
        !record(data) ||
        (data.mcpServers !== undefined && !record(data.mcpServers))
      )
        throw new Error("mcpServers must be an object");
      if (data.autoEnableCodemode !== undefined) {
        if (typeof data.autoEnableCodemode !== "boolean")
          throw new Error("autoEnableCodemode must be boolean");
        autoEnableCodemode = data.autoEnableCodemode;
      }
      for (const [name, raw] of Object.entries(data.mcpServers ?? {})) {
        try {
          validateMcp(name, raw, scope);
          if (
            [...servers.keys()].some(
              (other) =>
                other !== name &&
                other.replaceAll("-", "_") === name.replaceAll("-", "_"),
            )
          )
            throw new Error("MCP namespace collision");
          const config = { ...raw };
          if (config.exposure === "codemode-deferred")
            config.exposure = "codemode";
          if (config.toolExposure)
            config.toolExposure = Object.fromEntries(
              Object.entries(config.toolExposure).map(([key, value]) => [
                key,
                value === "codemode-deferred" ? "codemode" : value,
              ]),
            );
          servers.set(name, { name, config, scope, source });
        } catch {
          errors.push(`${scope} MCP server ${name}: invalid configuration`);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        errors.push(`${scope} mcp.json could not be loaded`);
    }
  }
  return { servers: [...servers.values()], errors, autoEnableCodemode };
}

const publicKeys = [
  "type",
  "command",
  "args",
  "cwd",
  "url",
  "description",
  "timeout",
  "enabled",
  "exposure",
  "toolExposure",
  "auth",
];
export function mcpProjection(config) {
  const result = Object.fromEntries(
    publicKeys
      .filter((key) => Object.hasOwn(config, key))
      .map((key) => [key, config[key]]),
  );
  if (record(config.auth)) result.auth = { provider: config.auth.provider };
  for (const key of ["env", "headers"])
    if (record(config[key]))
      result[key] = Object.fromEntries(
        Object.keys(config[key]).map((name) => [name, ""]),
      );
  if (record(config.oauth))
    result.oauth = Object.fromEntries(
      [
        "clientId",
        "clientName",
        "scope",
        "callbackPort",
        "callbackUrl",
        "clientSecret",
      ]
        .filter((key) => Object.hasOwn(config.oauth, key))
        .map((key) => [key, key === "clientSecret" ? "" : config.oauth[key]]),
    );
  return result;
}
export function patchMcp(data, input) {
  if (!validMcpName(input.name)) throw new DeskError(422, "MCP 服务名称无效");
  const servers = data.mcpServers ?? {};
  if (!record(servers))
    throw new DeskError(422, "mcpServers 格式无效，请先修复原生配置文件");
  const old = servers[input.name];
  if (input.action === "remove") {
    if (!Object.hasOwn(servers, input.name))
      throw new DeskError(404, "MCP 服务不存在");
    delete servers[input.name];
  } else {
    if (!["save", "toggle"].includes(input.action))
      throw new DeskError(422, "MCP 操作无效");
    const patch =
      input.action === "toggle" ? { enabled: input.enabled } : input.config;
    if (
      !record(patch) ||
      Object.keys(patch).some(
        (key) => ![...publicKeys, "env", "headers", "oauth"].includes(key),
      )
    )
      throw new DeskError(422, "MCP 配置参数无效");
    if (input.action === "toggle" && !old)
      throw new DeskError(404, "MCP 服务不存在");
    const next = { ...old };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete next[key];
        continue;
      }
      if (["env", "headers"].includes(key)) {
        if (!record(value)) throw new DeskError(422, "凭据映射格式无效");
        next[key] = Object.create(null);
        for (const [name, item] of Object.entries(value)) {
          if (item === "" && Object.hasOwn(old?.[key] ?? {}, name))
            next[key][name] = old[key][name];
          else {
            if (typeof item !== "string" || item.startsWith("!"))
              throw new DeskError(
                422,
                "使用明文或 $环境变量，不支持新增命令型凭据",
              );
            next[key][name] = item;
          }
        }
      } else if (key === "oauth" && record(value)) {
        const known = [
          "clientId",
          "clientSecret",
          "clientName",
          "scope",
          "callbackPort",
          "callbackUrl",
        ];
        if (Object.keys(value).some((key) => !known.includes(key)))
          throw new DeskError(422, "OAuth 参数无效");
        next.oauth = { ...old?.oauth };
        for (const key of known)
          if (!Object.hasOwn(value, key)) delete next.oauth[key];
        Object.assign(next.oauth, value);
        if (value.clientSecret === "" && old?.oauth?.clientSecret)
          next.oauth.clientSecret = old.oauth.clientSecret;
      } else if (key === "auth" && record(value))
        next.auth = { ...old?.auth, ...value };
      else next[key] = value;
    }
    validateMcp(input.name, next, input.scope);
    if (
      Object.keys(servers).some(
        (other) =>
          other !== input.name &&
          other.replaceAll("-", "_") === input.name.replaceAll("-", "_"),
      )
    )
      throw new DeskError(422, "名称与已有 MCP 工具命名空间冲突");
    servers[input.name] = next;
  }
  data.mcpServers = servers;
  return data;
}
