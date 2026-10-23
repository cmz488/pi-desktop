import { realpath, readFile } from "node:fs/promises";
import { dirname, join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const packageName = "@earendil-works/pi-coding-agent";

/**
 * Desktop 与 `@earendil-works/pi-coding-agent` 之间的唯一适配层。
 *
 * 接口：`resolvePiSdk`／`sdkEntry`／`embeddedSdkEntry`、`checkPiSdk`、六个 memoized
 *   loader、两个懒命名空间与四个窄兼容函数；深路径表、顺序与错误模式见
 *   docs/architecture/interfaces/pi-sdk-adapter.md。
 * 不变量：按需且 memoize；未加载时读取得到可失败的占位函数，调用或构造才报错；
 *   懒绑定不 rebind；深路径只出现在本文件；网络只有一条栈。
 * 错误：内嵌命名空间缺具名导出、未加载就调用、上游移走内部模块时的降级行为见接口文档。
 */
export async function resolvePiSdk(nativePi = process.env.PI_WEB_NATIVE_PI) {
  const candidates = nativePi
    ? [nativePi]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter((path) => !/node_modules[\\/]\.bin$/.test(path))
        .map((path) => join(path, "pi"));
  for (const candidate of candidates) {
    try {
      let executable = await realpath(candidate);
      const launcher = await readFile(executable, "utf8");
      if (launcher.includes("// pi-desktop-extension launcher v1")) {
        const original = JSON.parse(
          launcher.match(/const nativePi=(.*);/)?.[1] ?? "null",
        );
        if (!original) continue;
        executable = await realpath(original);
      }
      let directory = dirname(executable);
      while (dirname(directory) !== directory) {
        try {
          const manifest = JSON.parse(
            await readFile(join(directory, "package.json"), "utf8"),
          );
          if (manifest.name === packageName) {
            const entry = manifest.exports?.["."];
            const file =
              typeof entry === "string"
                ? entry
                : (entry?.import ?? entry?.default ?? manifest.main);
            if (typeof file !== "string")
              throw new Error("Pi SDK entry is missing");
            return pathToFileURL(join(directory, file)).href;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        directory = dirname(directory);
      }
    } catch (error) {
      if (nativePi)
        throw new Error("Cannot resolve SDK from PI_WEB_NATIVE_PI", {
          cause: error,
        });
      if (error.code !== "ENOENT") throw error;
    }
  }
  return import.meta.resolve(packageName);
}

export function checkPiSdk(sdk) {
  for (const name of [
    "SettingsManager",
    "SessionManager",
    "DefaultPackageManager",
    "createAgentSessionServices",
    "createAgentSessionFromServices",
    "createAgentSessionRuntime",
    "ProjectTrustStore",
    "hasTrustRequiringProjectResources",
    "getAgentDir",
    "createCodemodeExtension",
    "createToolSearchExtension",
    "createMcpExtension",
    "loadSkills",
    "Theme",
    "detectSupportedImageMimeTypeFromFile",
    "convertToPng",
    "resizeImage",
    "formatDimensionNote",
  ]) {
    if (typeof sdk[name] !== "function")
      throw new Error(
        `Installed Pi SDK does not provide ${name}; update pi-desktop-extension`,
      );
  }
  return sdk;
}
export const sdkEntry = await resolvePiSdk();
export const embeddedSdkEntry = import.meta.resolve(packageName);

/* coding SDK 是一个大模块图（本机实测冷加载 ~460 ms）。只有真正需要它的宿主才应付出
 * 这份代价，所以本模块不做顶层 import，而暴露 memoized loader 加 live binding。
 * 在加载前使用绑定会立即报错，而不是在会话深处得到 undefined。 */
const unloaded = (key) => {
  // 做成可构造的函数，使 `new sdk.Theme()` 也得到这条消息。
  const fail = function piSdkNotLoaded() {
    throw new Error(
      `Pi SDK 尚未加载（${String(key)}）；请先 await loadEmbeddedPiSdk()`,
    );
  };
  // 嵌套访问（sdk.SettingsManager.create）也报同一条可执行消息，
  // 而不是 “is not a function”。
  return new Proxy(fail, {
    get: () => fail,
    apply: fail,
    construct: fail,
  });
};
const lazyNamespace = (get) =>
  new Proxy(
    {},
    {
      get(_target, key) {
        const sdk = get();
        if (!sdk) return unloaded(key);
        // 永不重绑：类保留静态方法（SessionManager.create），
        // 且 SDK 命名空间是作为值使用，而不是接收者。
        return sdk[key];
      },
      has(_target, key) {
        const sdk = get();
        return sdk ? key in sdk : false;
      },
      ownKeys() {
        return get() ? Reflect.ownKeys(get()) : [];
      },
      getOwnPropertyDescriptor(_target, key) {
        const sdk = get();
        return sdk
          ? { value: sdk[key], configurable: true, enumerable: true }
          : undefined;
      },
    },
  );

let loadedPiSdk,
  loadedEmbeddedPiSdk,
  piSdkPromise,
  embeddedSdkPromise,
  settingsManagerPromise,
  sessionManagerPromise,
  messagesPromise,
  toolPipelinePromise;

export function loadPiSdk() {
  if (loadedPiSdk) return Promise.resolve(loadedPiSdk);
  piSdkPromise ??= import(sdkEntry).then((sdk) => (loadedPiSdk = sdk));
  return piSdkPromise;
}

export function loadEmbeddedPiSdk() {
  if (loadedEmbeddedPiSdk) return Promise.resolve(loadedEmbeddedPiSdk);
  embeddedSdkPromise ??= import(embeddedSdkEntry).then(
    (sdk) => (loadedEmbeddedPiSdk = checkPiSdk(sdk)),
  );
  return embeddedSdkPromise;
}

/* 两个内部子模块承担启动关键工作：settings 在任何模型请求前喂给 HTTP dispatcher，
 * session manager 打开原生 transcript。单独加载它们，使新宿主不必为启动付出整个
 * SDK 图的代价。 */
export function loadPiSettingsManager(entry = embeddedSdkEntry) {
  settingsManagerPromise ??= import(
    new URL("./core/settings-manager.js", entry)
  );
  return settingsManagerPromise;
}
export function loadPiSessionManager(entry = embeddedSdkEntry) {
  sessionManagerPromise ??= import(new URL("./core/session-manager.js", entry));
  return sessionManagerPromise;
}
export function loadPiMessages(entry = embeddedSdkEntry) {
  messagesPromise ??= import(new URL("./core/messages.js", entry));
  return messagesPromise;
}

// 按 coding SDK 自己的依赖解析公开 core 工具 helper，不依赖 npm 的顶层提升布局。
// core 为 ESM-only；package.json 是公开入口，读取其 import 导出而非用 require 条件解析主入口。
export function loadPiToolPipeline(entry = embeddedSdkEntry) {
  toolPipelinePromise ??= (async () => {
    const path = createRequire(entry).resolve(
      "@earendil-works/pi-agent-core/package.json",
    );
    const manifest = JSON.parse(await readFile(path, "utf8"));
    const root = manifest.exports?.["."];
    const file = typeof root === "string" ? root : root?.import;
    if (typeof file !== "string")
      throw new Error("Pi core 未提供标准 ESM 工具接口");
    return import(new URL(file, pathToFileURL(path)).href);
  })();
  return toolPipelinePromise;
}

export const piSdk = lazyNamespace(() => loadedPiSdk ?? loadedEmbeddedPiSdk);
export const embeddedPiSdk = lazyNamespace(() => loadedEmbeddedPiSdk);

// coding SDK 不导出它的模板展开器。把这个原生兼容适配器与既有的作用域 MCP 适配器
// 放在一起。
export async function expandNativePrompt(message, templates, entry = sdkEntry) {
  const { expandPromptTemplate } = await import(
    new URL("./core/prompt-templates.js", entry)
  );
  return expandPromptTemplate(message, templates);
}

// Pi 的 dispatcher 初始化不是公开导出。它只在这条窄兼容 seam 上：Pi 仅把 httpProxy
// 当作未设置代理环境变量时的回退，随后由 Pi 拥有 dispatcher 与 TLS 默认值。
// 不要再建第二条 HTTP 栈。内部模块被移走时不得阻止扩展加载。
export async function configurePiNetwork(settings, entry = sdkEntry) {
  try {
    const network = await import(new URL("./core/http-dispatcher.js", entry));
    network.applyHttpProxySettings(settings.getGlobalSettings().httpProxy);
    network.configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
    return true;
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND" && !(error instanceof TypeError))
      throw error;
    return false;
  }
}

export function webTerminalTheme(sdk) {
  const target = sdk ?? loadedPiSdk ?? loadedEmbeddedPiSdk;
  if (!target)
    throw new Error("Pi SDK 尚未加载；请先 await loadEmbeddedPiSdk()");
  const names =
    "accent border borderAccent borderMuted success error warning muted dim text thinkingText scrollbarTrack scrollbarThumb searchMatchText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh thinkingMax bashMode".split(
      " ",
    );
  return new target.Theme(
    Object.fromEntries(names.map((name) => [name, "#d5d8db"])),
    Object.fromEntries(
      "selectedBg searchMatchBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg"
        .split(" ")
        .map((name) => [name, "#161d27"]),
    ),
    "truecolor",
    { name: "pi-web", appearance: "dark" },
  );
}

// Pi 目前把作用域 MCP 凭据后端保持为内部。正常启动使用它的原生默认值；
// 自定义 --agent-dir 绝不能写入用户 profile。
export async function scopedMcpCredentials(agentDir, entry = sdkEntry, sdk) {
  const target = sdk ?? (await loadPiSdk());
  if (agentDir === target.getAgentDir()) return undefined;
  const [{ McpOAuthCredentialStore }, { FileAuthStorageBackend }] =
    await Promise.all([
      import(new URL("./extensions/mcp/oauth.js", entry)),
      import(new URL("./core/auth-storage.js", entry)),
    ]);
  return new McpOAuthCredentialStore(
    new FileAuthStorageBackend(join(agentDir, "mcp-auth.json")),
    agentDir,
  );
}
