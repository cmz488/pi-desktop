import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createProvider, lazyApi } from "@earendil-works/pi-ai";
import {
  readDocument,
  mutateDocument,
  patchProvider,
  DeskError,
} from "../config/config-store.mjs";

const implementations = {
  "openai-completions": () =>
    import("@earendil-works/pi-ai/api/openai-completions"),
  "openai-responses": () =>
    import("@earendil-works/pi-ai/api/openai-responses"),
  "anthropic-messages": () =>
    import("@earendil-works/pi-ai/api/anthropic-messages"),
  "google-generative-ai": () =>
    import("@earendil-works/pi-ai/api/google-generative-ai"),
};
function resolveKey(value) {
  if (typeof value !== "string" || value.startsWith("!")) return undefined;
  const reference =
    /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(value);
  return reference ? process.env[reference[1] ?? reference[2]] : value;
}

// Models and credential persistence are one module. Inherited Pi files are read;
// OAuth refreshes and new configuration are written in Desktop's own directory.
export async function openDurableModels({ agentDir, directory }) {
  const authPath = join(directory, "auth.json"),
    modelPath = join(directory, "models.json");
  const credentialViews = new AsyncLocalStorage();
  let mutation = Promise.resolve();
  function serial(run) {
    const result = mutation.then(run);
    mutation = result.catch(() => {});
    return result;
  }
  async function credential(id) {
    const view = credentialViews.getStore();
    let value;
    if (view) value = view[id];
    else {
      const own = (await readDocument(authPath)).data;
      value = Object.hasOwn(own, id)
        ? own[id]
        : (await readDocument(join(agentDir, "auth.json"))).data[id];
    }
    if (value?.type === "api_key")
      return { ...value, key: resolveKey(value.key) };
    return value?.type === "oauth" ? value : undefined;
  }
  async function credentialView() {
    const [inherited, own] = await Promise.all([
      readDocument(join(agentDir, "auth.json")),
      readDocument(authPath),
    ]);
    return { ...inherited.data, ...own.data };
  }
  async function withCredentialView(read) {
    // 同一次目录读取不必为每个提供商重读文件；作用域外的模型认证和写操作仍取新值。
    return credentialViews.run(await credentialView(), read);
  }
  const credentials = {
    read: credential,
    list: async () => {
      const view = credentialViews.getStore() ?? (await credentialView());
      return Object.entries(view)
        .filter(([, value]) => value?.type)
        .map(([providerId, value]) => ({ providerId, type: value.type }));
    },
    modify: (id, change) =>
      serial(() =>
        credentialViews.run(undefined, async () => {
          const next = await change(await credential(id));
          const document = await readDocument(authPath);
          await mutateDocument(authPath, document.revision, (data) => {
            data[id] = next ?? null;
            return data;
          });
          return next;
        }),
      ),
    delete: (id) =>
      serial(async () => {
        const document = await readDocument(authPath);
        await mutateDocument(authPath, document.revision, (data) => {
          data[id] = null;
          return data;
        });
      }),
  };
  const modelsStorePath = join(directory, "model-cache.json");
  const modelsStore = {
    read: async (id) =>
      (await readDocument(modelsStorePath)).data[id] ??
      (await readDocument(join(agentDir, "models-store.json"))).data[id],
    write: (id, value) =>
      serial(async () => {
        const doc = await readDocument(modelsStorePath);
        await mutateDocument(modelsStorePath, doc.revision, (data) => {
          data[id] = value;
          return data;
        });
      }),
    delete: (id) =>
      serial(async () => {
        const doc = await readDocument(modelsStorePath);
        await mutateDocument(modelsStorePath, doc.revision, (data) => {
          delete data[id];
          return data;
        });
      }),
  };
  const models = builtinModels({ credentials, modelsStore });
  let customIds = new Set();
  async function reload({ network = false } = {}) {
    const inherited =
      (await readDocument(join(agentDir, "models.json"))).data.providers ?? {};
    const own = (await readDocument(modelPath)).data.providers ?? {};
    for (const id of customIds) models.deleteProvider(id);
    customIds = new Set();
    // Re-register builtins before applying deliberate custom overrides.
    for (const provider of builtinModels({
      credentials,
      modelsStore,
    }).getProviders())
      models.setProvider(provider);
    for (const [id, config] of Object.entries({ ...inherited, ...own })) {
      if (config?.disabled) {
        models.deleteProvider(id);
        continue;
      }
      if (
        !implementations[config.api] ||
        !Array.isArray(config.models) ||
        !config.baseUrl
      )
        continue;
      const url = new URL(config.baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        continue;
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      const provider = createProvider({
        id,
        name: id,
        baseUrl: config.baseUrl,
        headers: config.headers,
        auth: {
          apiKey: {
            name: id,
            resolve: async ({ credential: saved }) => {
              const apiKey = saved?.key ?? resolveKey(config.apiKey);
              return apiKey || local
                ? {
                    auth: { apiKey: apiKey || "local" },
                    source: apiKey ? "configured" : "local server",
                  }
                : undefined;
            },
          },
        },
        models: config.models.map((row) => ({
          ...row,
          id: row.id,
          name: row.name ?? row.id,
          provider: id,
          api: row.api ?? config.api,
          baseUrl: config.baseUrl,
          reasoning: row.reasoning ?? false,
          input: row.input ?? ["text"],
          contextWindow: row.contextWindow ?? 128000,
          maxTokens: row.maxTokens ?? 8192,
          cost: row.cost ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        })),
        api: lazyApi(implementations[config.api]),
      });
      models.setProvider(provider);
      customIds.add(id);
    }
    return models.refresh({ allowNetwork: network });
  }
  async function save(input) {
    if (input.revision !== (await readDocument(modelPath)).revision)
      throw new DeskError(409, "提供商配置已变化，请刷新");
    const inherited =
      (await readDocument(join(agentDir, "models.json"))).data.providers ?? {};
    await mutateDocument(modelPath, input.revision, (data) => {
      data.providers ??= {};
      if (!Object.hasOwn(data.providers, input.id) && inherited[input.id])
        data.providers[input.id] = structuredClone(inherited[input.id]);
      return patchProvider(data, input, {
        allowEmptyModels: !!models.getProvider(input.id),
        additionalApi: models.getProvider(input.id)?.getModels()[0]?.api,
      });
    });
    await reload();
  }
  async function inventory() {
    const document = await readDocument(modelPath);
    const own = document.data.providers ?? {};
    const inherited =
      (await readDocument(join(agentDir, "models.json"))).data.providers ?? {};
    return {
      revision: document.revision,
      rows: Object.entries({ ...inherited, ...own }).map(([id, value]) => ({
        id,
        baseUrl: value.baseUrl,
        api: value.api,
        inherited: !Object.hasOwn(own, id),
        models: (value.models ?? []).map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
        })),
      })),
    };
  }
  await reload();
  const availableModels = () => withCredentialView(() => models.getAvailable());
  const desktopInventory = () => withCredentialView(readDesktopInventory);
  async function readDesktopInventory() {
    const document = await readDocument(modelPath);
    const inherited =
      (await readDocument(join(agentDir, "models.json"))).data.providers ?? {};
    const configs = { ...inherited, ...document.data.providers };
    const available = await models.getAvailable();
    const catalog = models.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      auth: {
        apiKey: !!provider.auth?.apiKey?.login,
        oauth: !!provider.auth?.oauth,
      },
    }));
    const rows = [];
    for (const provider of models.getProviders()) {
      const config = configs[provider.id] ?? {},
        saved = await credential(provider.id);
      if (!saved && !Object.hasOwn(configs, provider.id)) continue;
      let baseUrl = "";
      try {
        const url = new URL(config.baseUrl ?? provider.baseUrl);
        if (!url.username && !url.password && !url.search && !url.hash)
          baseUrl = url.href;
      } catch {}
      rows.push({
        id: provider.id,
        name: provider.name,
        baseUrl,
        api: config.api ?? provider.getModels()[0]?.api ?? "openai-completions",
        keyConfigured: !!saved || !!config.apiKey,
        editable: true,
        custom: Object.hasOwn(configs, provider.id),
        inherited: !Object.hasOwn(document.data.providers ?? {}, provider.id),
        auth: catalog.find((row) => row.id === provider.id).auth,
        models: provider.getModels().map((model) => ({
          id: model.id,
          name: model.name,
          available: available.some(
            (row) => row.provider === provider.id && row.id === model.id,
          ),
        })),
      });
    }
    return { revision: document.revision, rows, catalog };
  }
  async function remove(input) {
    await mutateDocument(modelPath, input.revision, (data) => {
      data.providers ??= {};
      data.providers[input.id] = { disabled: true };
      return data;
    });
    await reload();
  }
  return {
    models,
    availableModels,
    resourceOptions: () => ({
      credentials,
      modelsStore,
      modelsPath: modelPath,
      refreshOnCreate: false,
    }),
    save,
    remove,
    inventory,
    desktopInventory,
    reload,
    refresh: () => reload({ network: true }),
  };
}
