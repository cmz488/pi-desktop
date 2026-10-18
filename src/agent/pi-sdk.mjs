import { realpath, readFile } from "node:fs/promises";
import { dirname, join, delimiter } from "node:path";
import { pathToFileURL } from "node:url";

const packageName = "@earendil-works/pi-coding-agent";
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

/* The coding SDK is one large module graph (measured ~460 ms cold here). Only
 * the hosts that really need its namespace may pay for it, so instead of a
 * top-level import this module exposes memoized loaders plus live bindings.
 * Accessing a binding before it was loaded fails loudly instead of returning
 * undefined deep inside a session. */
const unloaded = (key) => {
  // A constructible function so `new sdk.Theme()` fails with this message too.
  const fail = function piSdkNotLoaded() {
    throw new Error(
      `Pi SDK 尚未加载（${String(key)}）；请先 await loadEmbeddedPiSdk()`,
    );
  };
  // Also fail on nested access (sdk.SettingsManager.create) with the same
  // actionable message instead of "is not a function".
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
        // Never rebind: classes keep their static methods (SessionManager.create)
        // and the SDK namespace is used as a value, not a receiver.
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
  messagesPromise;

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

/* Two internal submodules carry the startup-critical work: settings feed the
 * HTTP dispatcher before any model request, and the session manager opens the
 * native transcript. Loading them separately keeps a fresh host from paying
 * for the whole SDK graph just to start. */
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

export const piSdk = lazyNamespace(() => loadedPiSdk ?? loadedEmbeddedPiSdk);
export const embeddedPiSdk = lazyNamespace(() => loadedEmbeddedPiSdk);

// The coding SDK does not export its template expander. Keep this native
// compatibility adapter alongside the existing scoped MCP adapter.
export async function expandNativePrompt(message, templates, entry = sdkEntry) {
  const { expandPromptTemplate } = await import(
    new URL("./core/prompt-templates.js", entry)
  );
  return expandPromptTemplate(message, templates);
}

// Pi's dispatcher setup is not a public export. Keep its narrow compatibility
// seam here: Pi applies httpProxy only as a fallback for unset proxy env vars,
// then owns the dispatcher and TLS defaults. Do not create a second HTTP stack.
// A moved internal module must not prevent the extension from loading.
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

// Pi currently keeps the scoped MCP credential backend internal. Normal launches
// use its native default. Custom --agent-dir must never write to the user's profile.
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
