/**
 * 提供商设置：拥有提供商／模型清单、配置与认证入口，不复制模型选择器状态。
 *
 * 接口：setContext／applyInventory／update／handleClick／dispose 与 pickerModels 只读投影；
 *   见 docs/architecture/interfaces/chat-views.md。
 * 不变量：模型选择与认证继续走原生请求；保存使用打开时的 revision，身份变化清旧清单。
 * 错误：当前操作失败提示使用者，过期读取不打开新表单；凭据留空语义不变。
 */
export function createProviderSettings({
  live,
  root = document,
  api,
  esc,
  field,
  openDialog,
  toast,
  getState,
  refresh,
  pollInteractions,
  selectModel,
  setDefaults,
  openModels,
  onModelsChanged,
}) {
  const $ = (selector) => root.querySelector(selector);
  const listeners = new AbortController();
  let identity,
    disposed = false,
    providers = [],
    modelChoices = [],
    providerCatalog = [],
    providerRevision;
  let providerMarkup;
  const expandedProviders = new Set();
  const current = (target) => !disposed && target === identity;
  function openProviderCatalog() {
    openDialog(
      "添加模型提供商",
      `<div class="provider-catalog">${providerCatalog
        .filter((row) => row.auth.apiKey || row.auth.oauth)
        .map(
          (row) =>
            `<div class="resource-row"><strong>${esc(row.name)}</strong><div>${row.auth.apiKey ? `<button class="outline-button" data-login-provider="${esc(row.id)}" data-auth-type="api_key">API Key</button>` : ""}${row.auth.oauth ? `<button class="outline-button" data-login-provider="${esc(row.id)}" data-auth-type="oauth">登录账号</button>` : ""}</div></div>`,
        )
        .join(
          "",
        )}</div><button type="button" class="outline-button" data-action="custom-provider">自定义兼容服务</button>`,
      () => {},
      "关闭",
    );
  }

  function renderProviders() {
    const state = getState();
    const selected = state?.model;
    const q = $("#provider-search").value.toLowerCase();
    $("#default-model-label").textContent =
      `默认模型：${state?.defaults?.id ? `${state.defaults.provider} / ${state.defaults.id}` : "由 pi 自动选择"}`;
    const rows = providers
      .filter((row) => row.keyConfigured || row.custom)
      .filter((row) =>
        `${row.id} ${row.name} ${row.models.map((model) => model.id).join(" ")}`
          .toLowerCase()
          .includes(q),
      )
      .sort(
        (a, b) =>
          Number(b.custom || b.keyConfigured) -
          Number(a.custom || a.keyConfigured),
      );
    const markup =
      rows
        .map((row) => {
          const expanded = expandedProviders.has(row.id);
          return `<article class="provider-card"><div class="provider-summary"><span class="provider-symbol">${esc(row.name.slice(0, 1).toUpperCase())}</span><div class="provider-content"><div class="provider-heading"><h2>${esc(row.name)}</h2>${selected?.provider === row.id ? '<span class="tag">当前使用</span>' : ""}<span class="tag">${row.custom ? "自定义" : "Pi 原生"}</span></div><div class="provider-endpoint">${esc(row.baseUrl || row.api || "由提供商管理端点")}</div><div class="provider-status"><span class="dot ${row.keyConfigured ? "" : "inactive"}"></span>${row.keyConfigured ? "认证已配置" : "尚未配置认证"}<span>· ${row.models.length} 个模型</span></div></div><div class="provider-actions"><button class="outline-button" data-provider="${esc(row.id)}">配置</button>${row.auth?.apiKey ? `<button class="outline-button" data-login-provider="${esc(row.id)}" data-auth-type="api_key">API Key</button>` : ""}${row.auth?.oauth ? `<button class="outline-button" data-login-provider="${esc(row.id)}" data-auth-type="oauth">登录账号</button>` : ""}<button class="outline-button" data-expand-provider="${esc(row.id)}" aria-expanded="${expanded}">${expanded ? "收起模型" : "查看模型"} ${expanded ? "⌃" : "⌄"}</button></div></div><div class="provider-detail" ${expanded ? "" : "hidden"}><div class="provider-detail-toolbar"><strong>模型</strong><div>${row.keyConfigured && row.auth?.apiKey ? `<button class="outline-button" data-logout-provider="${esc(row.id)}">退出认证</button>` : ""}<button class="outline-button" data-default-provider="${esc(row.id)}">设为默认</button>${row.custom ? `<button class="outline-button" data-delete-provider="${esc(row.id)}">移除配置</button>` : ""}</div></div><div class="provider-models">${row.models
            .slice(0, 24)
            .map(
              (model) =>
                `<button data-model-provider="${esc(row.id)}" data-model-id="${esc(model.id)}" ${live && model.available === false ? "disabled" : ""} class="${selected?.provider === row.id && selected?.id === model.id ? "selected" : ""}">${esc(model.name)}</button>`,
            )
            .join(
              "",
            )}${row.models.length > 24 ? `<button data-all-models="${esc(row.id)}">全部 ${row.models.length} 个模型…</button>` : ""}</div></div></article>`;
        })
        .join("") || '<div class="empty">没有匹配的提供商</div>';
    if (providerMarkup !== markup) {
      providerMarkup = markup;
      $("#provider-list").innerHTML = markup;
    }
  }

  function configureProvider(id) {
    const target = identity;
    const row = providers.find((item) => item.id === id);
    const revision = providerRevision;
    openDialog(
      row ? `${row.name} 配置` : "添加提供商",
      field(
        "提供商 ID",
        "id",
        row?.id,
        "text",
        row
          ? "readonly required"
          : 'required pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*"',
      ) +
        field("服务端点", "baseUrl", row?.baseUrl, "url", "required") +
        `<label class="field-label">API 格式<select name="api">${[...new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", ...(row?.api ? [row.api] : [])])].map((value) => `<option ${row?.api === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>` +
        field(
          "密钥或环境变量引用（留空保留）",
          "apiKey",
          "",
          "password",
          'autocomplete="new-password"',
        ) +
        field(
          row ? "添加模型 ID（留空保持）" : "模型 ID",
          "modelId",
          "",
          "text",
          row ? "" : "required",
        ) +
        '<div class="dialog-note">保存到 models.json，只修改编辑的字段；已有密钥、兼容设置和模型元数据保持原样。原生账号认证使用提供商卡片上的登录入口。</div>',
      async (form) => {
        const data = Object.fromEntries(form);
        if (live) {
          await api("/api/provider", { ...data, revision });
          if (current(target)) await refresh();
        } else {
          let next = row;
          if (!next) {
            next = { id: data.id, name: data.id, custom: true, models: [] };
            providers.push(next);
          }
          Object.assign(next, {
            baseUrl: data.baseUrl,
            api: data.api,
            keyConfigured: next.keyConfigured || !!data.apiKey,
            custom: true,
          });
          if (
            data.modelId &&
            !next.models.some((model) => model.id === data.modelId)
          )
            next.models.push({ id: data.modelId, name: data.modelId });
          renderProviders();
        }
        if (current(target)) toast("提供商配置已保存");
      },
    );
  }

  async function act(button, target) {
    if (button.dataset.expandProvider) {
      const id = button.dataset.expandProvider;
      expandedProviders.has(id)
        ? expandedProviders.delete(id)
        : expandedProviders.add(id);
      renderProviders();
    } else if (button.dataset.provider)
      configureProvider(button.dataset.provider);
    else if (button.dataset.modelId) {
      await selectModel(button.dataset.modelProvider, button.dataset.modelId);
      if (current(target) && $("#dialog").open) $("#dialog").close();
    } else if (button.dataset.allModels)
      await openModels(button.dataset.allModels);
    else if (button.dataset.defaultProvider) {
      const row = providers.find(
        (item) => item.id === button.dataset.defaultProvider,
      );
      if (!row) return;
      const models = row.models.filter((model) => model.available !== false);
      openDialog(
        "选择默认模型",
        `<label class="field-label">${esc(row.name)}<select name="id">${models.map((model) => `<option value="${esc(model.id)}">${esc(model.name)}</option>`).join("")}</select></label>`,
        async (form) => {
          if (!form.get("id")) throw new Error("请先配置认证");
          if (live) {
            await api("/api/default-model", {
              provider: row.id,
              id: form.get("id"),
            });
            if (current(target)) await refresh();
          } else {
            setDefaults({ provider: row.id, id: form.get("id") });
            renderProviders();
          }
          if (current(target)) toast("默认模型已保存");
        },
      );
    } else if (button.dataset.loginProvider) {
      $("#dialog").close();
      if (live) {
        await api("/api/auth-start", {
          provider: button.dataset.loginProvider,
          type: button.dataset.authType,
        });
        if (current(target)) await pollInteractions();
      } else toast("认证演示不保存凭据");
    } else if (button.dataset.logoutProvider) {
      openDialog(
        "退出提供商认证",
        "<p>移除此提供商在 pi auth.json 中的凭据。环境变量和 models.json 中的密钥单独管理。</p>",
        async () => {
          await api("/api/auth-logout", {
            provider: button.dataset.logoutProvider,
          });
          if (current(target)) await refresh();
        },
        "退出认证",
      );
    } else if (button.dataset.deleteProvider) {
      openDialog(
        "移除自定义提供商配置",
        `<p>${esc(button.dataset.deleteProvider)}</p><p class="muted">删除 models.json 中此提供商的端点、密钥与模型配置。</p>`,
        async () => {
          if (live) {
            await api("/api/provider-remove", {
              id: button.dataset.deleteProvider,
              revision: providerRevision,
            });
            if (current(target)) await refresh();
          } else {
            providers = providers.filter(
              (row) => row.id !== button.dataset.deleteProvider,
            );
            renderProviders();
          }
        },
        "移除配置",
      );
    } else if (button.dataset.action === "custom-provider") {
      $("#dialog").close();
      configureProvider();
    } else if (button.dataset.action === "add-provider") openProviderCatalog();
    else {
      if (live) {
        await api("/api/refresh-models", {});
        if (current(target)) await refresh();
      }
      if (current(target)) toast("模型目录已刷新");
    }
  }
  const handles = (button) =>
    [
      "expandProvider",
      "provider",
      "modelId",
      "allModels",
      "defaultProvider",
      "loginProvider",
      "logoutProvider",
      "deleteProvider",
    ].some((key) => button.dataset[key] !== undefined) ||
    ["custom-provider", "add-provider", "refresh-models"].includes(
      button.dataset.action,
    );
  function handleClick(button) {
    if (disposed || !handles(button)) return false;
    const target = identity;
    void act(button, target).catch((error) => {
      if (current(target)) toast(error.message);
    });
    return true;
  }
  $("#view-providers").addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("button");
      if (button && handleClick(button)) event.stopPropagation();
    },
    { signal: listeners.signal },
  );
  $("#provider-search").addEventListener("input", renderProviders, {
    signal: listeners.signal,
  });
  return {
    setContext(next) {
      if (disposed || identity === next.identity) return;
      identity = next.identity;
      providers = [];
      modelChoices = [];
      providerCatalog = [];
      providerRevision = undefined;
      expandedProviders.clear();
      renderProviders();
      onModelsChanged();
    },
    applyInventory(kind, value) {
      if (disposed) return;
      if (kind === "modelChoices") modelChoices = value.rows;
      else {
        providers = value.rows;
        providerCatalog = value.catalog ?? [];
        providerRevision = value.revision;
        renderProviders();
      }
      onModelsChanged();
    },
    get pickerModels() {
      return modelChoices;
    },
    update: renderProviders,
    handleClick,
    dispose() {
      disposed = true;
      listeners.abort();
    },
  };
}
