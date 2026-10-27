import DOMPurify from "./vendor/purify.mjs";

const catalogOrigin = "https://pi.dev";
const catalogForbiddenTags = [
  "script",
  "style",
  "link",
  "meta",
  "base",
  "iframe",
  "object",
  "embed",
  "img",
  "video",
  "audio",
  "source",
  "form",
  "input",
  "button",
];
function catalogDocument(result) {
  if (result.source !== "pi.dev" || typeof result.html !== "string")
    throw new Error("官方目录返回格式已变化，请查看 pi.dev");
  const clean = DOMPurify.sanitize(result.html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: catalogForbiddenTags,
    FORBID_ATTR: ["style", "src", "srcset"],
  });
  return new DOMParser().parseFromString(clean, "text/html");
}
function catalogPackageUrl(name) {
  return `${catalogOrigin}/packages/${encodeURIComponent(name).replaceAll("%2F", "/")}`;
}
export function parseCatalogPage(result) {
  const doc = catalogDocument(result);
  const count = doc.querySelector(".packages-count")?.textContent.trim();
  if (
    !count ||
    !/^\d+(?:\s*[-–]\s*\d+)?\s*\/\s*\d+(?:\s+\(of\s+\d+\))?$/.test(count)
  )
    throw new Error("官方目录列表结构已变化，请查看 pi.dev");
  const rows = [...doc.querySelectorAll("article[data-package-card]")].map(
    (card) => {
      const name = card.dataset.packageName;
      if (
        !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name ?? "") ||
        name.length > 214
      )
        throw new Error("官方目录包名无效");
      const monthly = Number(card.dataset.packageDownloads),
        published = Number(card.dataset.packageDate);
      let version;
      for (const link of card.querySelectorAll(".packages-links a[href]")) {
        try {
          version ??=
            new URL(link.getAttribute("href"), catalogOrigin).searchParams.get(
              "package-version",
            ) || undefined;
        } catch {}
      }
      return {
        name,
        source: `npm:${name}`,
        url: catalogPackageUrl(name),
        version,
        description:
          card.querySelector(".packages-desc")?.textContent.trim() ?? "",
        author:
          card.querySelector(".packages-meta span")?.textContent.trim() ?? "",
        types: (card.dataset.packageTypes ?? "").split(/\s+/).filter(Boolean),
        downloads:
          card.dataset.packageDownloads &&
          Number.isSafeInteger(monthly) &&
          monthly >= 0
            ? monthly
            : null,
        published:
          card.dataset.packageDate &&
          Number.isFinite(published) &&
          published > 0
            ? published
            : null,
      };
    },
  );
  if (!rows.length && Number(count.split("/").at(-1)) !== 0)
    throw new Error("官方目录列表不完整，未生成替代结果");
  const page = Number(
    doc.querySelector(".pagination-page.is-active")?.textContent ?? result.page,
  );
  const pages = new Set();
  for (const link of doc.querySelectorAll(".packages-pagination a[href]")) {
    try {
      const destination = new URL(link.getAttribute("href"), catalogOrigin);
      const value = Number(destination.searchParams.get("page") ?? "1");
      if (
        destination.origin === catalogOrigin &&
        destination.pathname === "/packages" &&
        Number.isSafeInteger(value) &&
        value >= 1 &&
        value <= 9999
      )
        pages.add(value);
    } catch {}
  }
  const previous = Math.max(0, ...[...pages].filter((value) => value < page));
  const next = [...pages]
    .filter((value) => value > page)
    .sort((a, b) => a - b)[0];
  return { rows, count, page, previous, next };
}

/**
 * 插件与市场：拥有唯一包清单、配置、更新检查、目录解析和第三方介绍的清理规则。
 *
 * 接口：setContext／applyInventory／update／handleClick／reloaded／dispose；
 *   见 docs/architecture/interfaces/chat-views.md。
 * 不变量：目录 HTML 必须清理；安装遵循原生 scope/revision/inventoryKey，不自动重载。
 * 错误：当前读取／操作失败提示使用者；离页撤读取，过期结果不覆盖新目标或对话框。
 */
export function createPackageSettings({
  live,
  root = document,
  api,
  esc,
  icon,
  field,
  openDialog,
  isDialogCurrent,
  toast,
  getState,
  getConnected,
  refresh,
  refreshInventories,
}) {
  const $ = (selector) => root.querySelector(selector);
  const listeners = new AbortController();
  const reads = new Map();
  let pluginMarkup,
    marketMarkup,
    autoCheckRequested = false;
  let context = {},
    disposed = false,
    plugins = [],
    pluginRevision,
    pluginInventory = { writable: false, updatesSupported: false },
    checkingPackageUpdates = false,
    demoPending = false,
    filter = "all",
    marketLoaded = false,
    marketQuery = "",
    marketGeneration = 0,
    marketPage = 1,
    marketRows = [];
  const current = (identity) => !disposed && context.identity === identity;
  function cancelReads() {
    marketGeneration++;
    for (const job of reads.values()) job.controller.abort();
    reads.clear();
  }
  async function read(path, channel) {
    reads.get(channel)?.controller.abort();
    const job = {
      identity: context.identity,
      controller: new AbortController(),
    };
    reads.set(channel, job);
    try {
      const result = await api(path, undefined, {
        signal: job.controller.signal,
      });
      if (job.controller.signal.aborted || !current(job.identity))
        throw new DOMException("读取已失效", "AbortError");
      return result;
    } finally {
      if (reads.get(channel) === job) reads.delete(channel);
    }
  }
  function renderPlugins() {
    const state = getState();
    const connected = getConnected();
    const pending = state?.pending || demoPending;
    const q = $("#plugin-search").value.toLowerCase();
    const writable =
      !live ||
      (connected &&
        !checkingPackageUpdates &&
        pluginInventory.writable &&
        state?.packageManagement);
    const rows = plugins.filter(
      (row) =>
        (filter === "all" ||
          (filter === "enabled" && row.enabled) ||
          (filter === "pending" && row.pending) ||
          (filter === "updates" && row.updateAvailable === true)) &&
        `${row.name} ${row.source}`.toLowerCase().includes(q),
    );
    $("#plugin-permissions").hidden = !state?.capabilities?.readOnly;
    const markup =
      rows
        .map((row) => {
          const version =
            row.type === "package"
              ? `<p class="package-version">${row.installedVersion ? "已安装 v" + esc(row.installedVersion) : "已安装版本未读取"}${row.versionError ? " · " + esc(row.versionError) : ""}</p>`
              : "";
          const update =
            row.type !== "package"
              ? ""
              : `<span class="tag ${row.updateAvailable ? "amber" : ""}">${row.updateAvailable === true ? "Pi 原生报告有更新" : row.updateAvailable === false ? "原生检查未报告更新" : "尚未检查更新"}</span>`;
          return `<article class="plugin-card"><div class="plugin-card-head"><span class="plugin-icon">${icon("plugin")}</span><div><h2>${esc(row.name)}</h2><small>${esc(row.source)}</small></div><button class="switch" role="switch" aria-checked="${row.enabled}" aria-label="${row.enabled ? "停用" : "启用"} ${esc(row.name)}" data-toggle-plugin="${esc(row.id)}"></button></div><p>${esc(row.description)}</p>${version}<div class="catalog-types">${update}</div><div class="plugin-card-footer"><span class="tag ${row.pending ? "amber" : ""}">${row.pending ? "待重载" : row.enabled ? "配置启用" : "配置停用"}</span><div><button data-config-plugin="${esc(row.id)}">${row.adapted ? "配置" : "详情"}</button>${row.packageName ? `<button data-market-detail="${esc(row.packageName)}">目录完整介绍</button>` : ""}${row.type === "package" ? `<button data-plugin-resources="${esc(row.id)}">资源过滤</button><button data-package-action="update" data-package-source="${esc(row.source)}" data-package-scope="${esc(row.scope ?? "global")}" ${writable ? "" : "disabled"}>${row.updateAvailable ? "有更新 · 更新" : "原生更新"}</button><button data-package-action="remove" data-package-source="${esc(row.source)}" data-package-scope="${esc(row.scope ?? "global")}" ${writable ? "" : "disabled"}>卸载</button>` : ""}</div></div></article>`;
        })
        .join("") || '<div class="empty">没有匹配的插件</div>';
    if (pluginMarkup !== markup) {
      pluginMarkup = markup;
      $("#plugin-grid").innerHTML = markup;
    }
    $('#plugin-filter [data-filter="all"] span').textContent = plugins.length;
    $('#plugin-filter [data-filter="updates"] span').textContent =
      plugins.filter((row) => row.updateAvailable === true).length;
    const button = $('[data-action="check-package-updates"]');
    button.disabled =
      checkingPackageUpdates ||
      (live &&
        (!connected ||
          !pluginInventory.writable ||
          !pluginInventory.updatesSupported));
    button.textContent = checkingPackageUpdates ? "检查中…" : "检查更新";
    $("#package-update-status").textContent = checkingPackageUpdates
      ? "正在使用 Pi 原生接口检查，不安装／更新／重载…"
      : !live
        ? "演示模式；不生成可更新包。"
        : !pluginInventory.updatesSupported
          ? "当前宿主未提供原生更新检查，请等任务结束后授权更新宿主。"
          : `${pluginInventory.updatesCheckedAt ? "上次原生检查：" + new Date(pluginInventory.updatesCheckedAt).toLocaleString() : "尚未检查；点击检查更新"}。遵循 Pi 的固定版本、范围和项目覆盖规则；离线或网络失败可能不报告更新，未报告不等于已是最新。`;
    const count = plugins.filter((row) => row.pending).length;
    $("#reload-notice").hidden = !pending && !count;
    $("#pending-label").textContent = state?.capabilities?.readOnly
      ? "无项目会话只运行读取与网页工具；插件配置可在项目 Agent 重载后应用。"
      : "配置已保存，重载后应用扩展变更。其他运行中的 Agent 也需要重载。";
  }

  async function configurePlugin(id) {
    const target = context.identity;
    const row = plugins.find((item) => item.id === id);
    if (!row) return;
    if (!row.adapted) {
      openDialog(
        row.name,
        `<p class="muted">${esc(row.source)}</p><p>${esc(row.description)}</p><div class="dialog-note">可在这里启停扩展、管理包来源和资源路径。此插件没有声明 Web 配置表单；它的私有参数由插件自己的配置接口定义。</div><button type="button" class="outline-button" data-view="general" data-action="close-dialog">管理资源配置</button>`,
        () => {},
        "关闭",
      );
      return;
    }
    const doc = live
      ? await read(`/api/plugin-config?id=${encodeURIComponent(id)}`, "config")
      : {
          data: row.config,
          fields: Object.keys(row.config).map((key) => ({
            key,
            type: "boolean",
            label: key,
          })),
        };
    if (!current(target)) return;
    openDialog(
      `${row.name} 配置`,
      doc.fields
        .map((spec) => {
          const value = doc.data[spec.key];
          return `<label class="field-label">${esc(spec.label ?? spec.key)}${spec.type === "boolean" || spec.type === "enum" ? `<select name="${esc(spec.key)}">${(spec.type === "boolean" ? [true, false] : spec.options).map((option) => `<option value="${esc(JSON.stringify(option))}" ${option === value ? "selected" : ""}>${esc(option === true ? "开启" : option === false ? "关闭" : option)}</option>`).join("")}</select>` : `<input name="${esc(spec.key)}" type="${spec.secret ? "password" : spec.type === "number" ? "number" : "text"}" value="${esc(spec.secret ? "" : value)}" ${spec.secret ? 'autocomplete="new-password" placeholder="留空保留"' : ""}>`}</label>`;
        })
        .join(""),
      async (form) => {
        const patch = Object.fromEntries(
          [...form].map(([key, value]) => {
            const spec = doc.fields.find((item) => item.key === key);
            return [
              key,
              spec.type === "boolean" || spec.type === "enum"
                ? JSON.parse(value)
                : spec.type === "number"
                  ? Number(value)
                  : value,
            ];
          }),
        );
        if (live) {
          await api("/api/plugin-config", {
            id,
            revision: doc.revision,
            patch,
          });
          if (current(target)) await refresh();
        } else {
          row.config = { ...row.config, ...patch };
          row.pending = true;
          demoPending = true;
          renderPlugins();
        }
        if (current(target)) toast("配置已保存，重载后应用");
      },
    );
  }

  function installedMarketPackage(name) {
    return plugins.find(
      (plugin) =>
        plugin.packageName === name ||
        plugin.source?.replace(/@[^@/]+$/, "") === `npm:${name}`,
    );
  }
  function renderMarket() {
    const state = getState();
    const connected = getConnected();
    const writable =
      !live ||
      (connected &&
        !checkingPackageUpdates &&
        pluginInventory.writable &&
        state?.packageManagement);
    const markup =
      marketRows
        .map((row) => {
          const installed = installedMarketPackage(row.name);
          const needsUpdate = installed?.updateAvailable === true;
          return `<article class="plugin-card"><div class="plugin-card-head"><span class="plugin-icon">${icon("plugin")}</span><div><h2><button type="button" class="catalog-name" data-market-detail="${esc(row.name)}">${esc(row.name)}</button></h2><small>${row.version ? "目录 v" + esc(row.version) : "目录未提供版本"}${row.author ? " · " + esc(row.author) : ""}</small></div></div><p>${esc(row.description)}</p><div class="catalog-types">${row.types.map((type) => `<span class="tag">${esc(type)}</span>`).join("") || '<span class="muted">官方类型未标记</span>'}</div><div class="catalog-metrics"><span>${row.downloads === null ? "月下载量未提供" : row.downloads.toLocaleString() + " 次/月"}</span><span>${row.published ? "版本发布 " + esc(new Date(row.published).toLocaleDateString()) : "发布时间未提供"}</span></div><div class="plugin-card-footer"><button type="button" data-market-detail="${esc(row.name)}">完整介绍</button><a href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">pi.dev ↗</a><button class="outline-button" data-package-action="${needsUpdate ? "update" : "install"}" data-package-source="${esc(needsUpdate ? installed.source : row.source)}" data-package-scope="${esc(installed?.scope ?? "global")}" ${!writable || (installed && !needsUpdate) ? "disabled" : ""}>${needsUpdate ? "有更新 · 更新" : installed ? "已安装" : "安装"}</button></div></article>`;
        })
        .join("") || '<div class="empty">没有匹配的官方目录包</div>';
    if (marketMarkup !== markup) {
      marketMarkup = markup;
      $("#market-grid").innerHTML = markup;
    }
  }
  async function loadMarket({ page = 1, refresh = false } = {}) {
    const state = getState();
    const generation = ++marketGeneration;
    marketMarkup = undefined;
    const filters = {
      q: $("#market-search").value,
      type: $("#market-type").value,
      sort: $("#market-sort").value,
    };
    const query = JSON.stringify(filters);
    if (query !== marketQuery) page = 1;
    $("#market-pages").replaceChildren();
    if (!live || !state?.marketplaceOfficial) {
      marketRows = [];
      marketLoaded = true;
      $("#market-status").textContent = live
        ? "当前宿主未加载官方目录接口；请等任务结束后授权更新原宿主。"
        : "演示模式；真实宿主从 pi.dev 官方目录读取，不生成假插件。";
      $("#market-grid").innerHTML =
        '<div class="empty">可从上方链接直接阅读 pi.dev 官方目录</div>';
      return;
    }
    $("#market-status").textContent = refresh
      ? "正在刷新 pi.dev 官方目录…"
      : "正在读取 pi.dev 官方目录…";
    $("#market-grid").innerHTML = '<div class="empty">正在加载…</div>';
    try {
      const parameters = new URLSearchParams({
        ...filters,
        page: String(page),
        refresh: refresh ? "1" : "0",
      });
      const result = await read(`/api/package-catalog?${parameters}`, "market");
      if (generation !== marketGeneration) return;
      const catalog = parseCatalogPage(result);
      marketRows = catalog.rows;
      marketPage = catalog.page;
      marketLoaded = true;
      marketQuery = query;
      $("#market-status").textContent =
        `pi.dev 官方目录 · ${catalog.count} · 读取于 ${new Date(result.fetchedAt).toLocaleTimeString()}`;
      $("#market-pages").innerHTML =
        `<button type="button" class="outline-button" data-market-page="${catalog.previous}" ${catalog.previous ? "" : "disabled"}>上一页</button><span>第 ${catalog.page} 页</span><button type="button" class="outline-button" data-market-page="${catalog.next ?? ""}" ${catalog.next ? "" : "disabled"}>下一页</button>`;
      renderMarket();
    } catch (error) {
      if (generation !== marketGeneration) return;
      marketLoaded = false;
      $("#market-status").textContent = error.message;
      $("#market-grid").innerHTML =
        '<div class="empty"><button class="outline-button" data-action="retry-market">重试</button></div>';
    }
  }
  function safeCatalogReadme(html, sourceUrl) {
    const node = document.createElement("div");
    node.innerHTML = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      FORBID_TAGS: catalogForbiddenTags,
      FORBID_ATTR: ["id", "name", "class", "style", "src", "srcset"],
    });
    for (const link of node.querySelectorAll("a")) {
      try {
        const href = link.getAttribute("href");
        if (!href) throw new Error();
        const destination = new URL(href, sourceUrl);
        if (
          !["https:", "http:"].includes(destination.protocol) ||
          destination.username ||
          destination.password
        )
          throw new Error();
        link.href = destination.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      } catch {
        link.replaceWith(document.createTextNode(link.textContent));
      }
    }
    return node.innerHTML;
  }
  async function showPackageDetails(name) {
    const target = context.identity;
    const state = getState();
    if (live && !state?.marketplaceOfficial) {
      toast("当前宿主未提供 pi.dev 完整介绍，请授权更新后使用");
      return;
    }
    const dialogToken = openDialog(
      `${name} · 完整介绍`,
      '<p class="muted">正在读取 pi.dev 官方详情…</p>',
      () => {},
      "关闭",
    );
    try {
      const result = await read(
        `/api/package-details?name=${encodeURIComponent(name)}`,
        "detail",
      );
      if (!current(target) || !isDialogCurrent(dialogToken)) return;
      const doc = catalogDocument(result);
      if (doc.querySelector("h1.content-title")?.textContent.trim() !== name)
        throw new Error("官方详情身份或结构已变化，请查看 pi.dev");
      const labels = {
        Package: "包名",
        Version: "目录版本",
        Published: "版本发布时间",
        Downloads: "下载量",
        Author: "作者",
        License: "许可证",
        Types: "官方类型",
        Size: "体积",
        Dependencies: "依赖",
      };
      const metadata = [...doc.querySelectorAll("dl.detail-grid dt")]
        .map((key) => {
          const value = key.nextElementSibling;
          return value?.tagName === "DD"
            ? `<dt>${esc(labels[key.textContent.trim()] ?? key.textContent)}</dt><dd>${esc(value.textContent.trim())}</dd>`
            : "";
        })
        .join("");
      const readme = doc.querySelector(".packages-readme");
      const manifest = doc.querySelector(".raw-data-panel");
      const installed = installedMarketPackage(name);
      $("#dialog-body").innerHTML =
        `<div class="package-details"><p>${esc(doc.querySelector(".content-description")?.textContent ?? "")}</p>${installed?.installedVersion ? `<p>本机已安装 v${esc(installed.installedVersion)}${installed.updateAvailable ? " · Pi 原生检查报告有更新" : ""}</p>` : ""}<dl class="package-metadata">${metadata}</dl><p><a href="${esc(catalogPackageUrl(name))}" target="_blank" rel="noopener noreferrer">查看 pi.dev 原始页面 ↗</a></p><p class="dialog-note">第三方包可执行代码并影响 Agent。介绍由作者提供，不代表官方审核；保留完整文字，不自动加载图片／视频，可在原始页面查看媒体。安装／更新需另行确认，不会自动重载。</p>${manifest ? `<details><summary>Pi manifest</summary><pre>${esc(manifest.textContent)}</pre></details>` : ""}<h3>完整 README</h3><div class="markdown-body catalog-readme">${readme ? safeCatalogReadme(readme.innerHTML, result.sourceUrl) : '<p class="muted">官方页面未提供 README；不会用摘要冒充完整介绍。</p>'}</div></div>`;
    } catch (error) {
      if (current(target) && isDialogCurrent(dialogToken))
        $("#dialog-body").innerHTML =
          `<p class="dialog-note">${esc(error.message)}</p>`;
    }
  }
  async function checkPackageUpdates() {
    if (checkingPackageUpdates) return;
    if (!live || !pluginInventory.updatesSupported) {
      toast("此宿主未提供 Pi 原生更新检查");
      return;
    }
    const target = context.identity;
    const state = getState();
    const owner = state?.sessionId;
    checkingPackageUpdates = true;
    renderPlugins();
    try {
      const result = await api("/api/package-updates", { sessionId: owner });
      if (!current(target)) return;
      plugins = result.rows;
      pluginRevision = result.revision;
      pluginInventory = result;
      renderPlugins();
      if (marketLoaded) renderMarket();
      toast(
        `原生检查报告 ${plugins.filter((row) => row.updateAvailable).length} 个可更新包；未报告不代表已是最新`,
      );
    } catch (error) {
      if (current(target)) toast(error.message);
    } finally {
      if (current(target)) {
        checkingPackageUpdates = false;
        renderPlugins();
        if (marketLoaded) renderMarket();
      }
    }
  }

  async function packageAction(action, sourceValue, scope = "global") {
    const state = getState();
    const identity = context.identity;
    if (
      live &&
      !(state?.packageManagement ?? state?.capabilities?.marketplace)
    ) {
      toast("当前宿主未提供原生包管理，请等任务结束后授权更新宿主");
      return;
    }
    const target = { sessionId: state?.sessionId, cwd: state?.cwd };
    const inventoryKey = pluginInventory.inventoryKey;
    const row = plugins.find(
      (item) =>
        item.type === "package" &&
        item.source === sourceValue &&
        item.scope === scope,
    );
    const revision = action === "install" ? undefined : row?.revision;
    openDialog(
      { install: "安装插件", update: "更新插件", remove: "移除插件" }[action],
      `<p>${esc(sourceValue)}</p>${row?.installedVersion ? `<p>本机已安装 v${esc(row.installedVersion)}${row.updateAvailable ? " · Pi 原生报告有更新" : ""}</p>` : ""}<label class="field-label">配置范围<select name="scope" ${action === "install" ? "" : "disabled"}><option value="global">用户配置</option><option value="project" ${live && !state?.projectTrusted ? "disabled" : ""}>当前项目</option></select></label><div class="dialog-note">使用 Pi 原生包管理器。${action === "install" ? "第三方包可以执行代码并影响 Agent；请先阅读完整介绍与源码。目录安装遵循官方未固定版本的来源，更新由 Pi 原生规则决定。" : action === "update" ? "update(source) 按 Pi 原生来源匹配，可能同时匹配用户与当前受信任项目声明；遵循覆盖与固定版本规则，不解除固定版本。" : "只移除所示范围的声明；保留其他原生资源过滤和配置。"}不会自动 reload；重载前请保存草稿和附件。</div>`,
      async (form) => {
        if (live) {
          if (!current(identity))
            throw new Error("当前会话或工作区已变化，请重新确认插件操作");
          await api("/api/package", {
            action,
            source: sourceValue,
            scope: action === "install" ? form.get("scope") : scope,
            sessionId: target.sessionId,
            revision,
            inventoryKey,
          });
          if (!current(identity)) return;
          await refresh();
          if (current(identity) && marketLoaded) renderMarket();
        } else {
          demoPending = true;
          if (action === "install")
            plugins.push({
              id: sourceValue,
              name: sourceValue,
              source: sourceValue,
              type: "package",
              enabled: true,
              pending: true,
              description: "演示安装",
              adapted: false,
            });
          if (action === "remove")
            plugins = plugins.filter((item) => item.source !== sourceValue);
          renderPlugins();
        }
        toast("原生包操作已完成；未自动重载，请按需保存草稿后应用");
      },
      "确认" + { install: "安装", update: "更新", remove: "移除" }[action],
    );
    $('#dialog-body select[name="scope"]').value = scope;
  }

  async function updateAllExtensions() {
    const target = context.identity;
    const preview = await read("/api/packages/update-all", "preview");
    if (!current(target)) return;
    openDialog(
      "全量更新 Pi 插件",
      `<p>使用 Pi 原生 <code>${esc(preview.command)}</code> 逻辑更新全部用户插件。遵循固定版本规则，更新后需重载各 Agent。</p><p>${preview.sources.map(esc).join("<br>") || "没有配置用户插件"}</p>`,
      async () => {
        await api("/api/packages/update-all", {
          revision: preview.revision,
          inventoryKey: preview.inventoryKey,
        });
        if (!current(target)) return;
        toast("全量更新完成，重载 Agent 后应用");
        await refreshInventories();
        renderPlugins();
      },
      "更新全部插件",
    );
  }

  async function act(button, target) {
    if (button.dataset.filter) {
      filter = button.dataset.filter;
      for (const tab of $("#plugin-filter").querySelectorAll("button"))
        tab.classList.toggle("selected", tab === button);
      renderPlugins();
    } else if (button.dataset.togglePlugin) {
      const row = plugins.find(
        (item) => item.id === button.dataset.togglePlugin,
      );
      if (!row) return;
      if (live) {
        await api("/api/plugin", {
          id: row.id,
          enabled: !row.enabled,
          revision: row.revision ?? pluginRevision,
        });
        if (current(target)) await refresh();
      } else {
        row.enabled = !row.enabled;
        row.pending = true;
        demoPending = true;
        renderPlugins();
      }
      if (current(target)) toast("扩展配置已保存");
    } else if (button.dataset.pluginResources) {
      const row = plugins.find(
        (item) => item.id === button.dataset.pluginResources,
      );
      if (!row) return;
      const doc = live
        ? await read(
            "/api/plugin-resources?id=" + encodeURIComponent(row.id),
            "config",
          )
        : { values: {}, revision: pluginRevision };
      if (!current(target)) return;
      openDialog(
        "包资源过滤",
        `<p>${esc(row.source)}</p>` +
          ["extensions", "skills", "prompts", "themes"]
            .map(
              (key) =>
                `<label class="field-label">${esc(key)}<textarea name="${key}" placeholder="继承包默认资源；输入 [] 停用此类资源">${esc(Object.hasOwn(doc.values, key) ? JSON.stringify(doc.values[key], null, 2) : "")}</textarea></label>`,
            )
            .join("") +
          `<label class="field-label">自动加载<select name="autoload"><option value="inherit" ${doc.values.autoload === undefined ? "selected" : ""}>包默认</option><option value="true" ${doc.values.autoload === true ? "selected" : ""}>开启</option><option value="false" ${doc.values.autoload === false ? "selected" : ""}>关闭，仅加载显式资源</option></select></label>`,
        async (form) => {
          const patch = {};
          for (const key of ["extensions", "skills", "prompts", "themes"]) {
            const raw = form.get(key).trim(),
              parsed = raw ? JSON.parse(raw) : null;
            if (
              JSON.stringify(parsed) !== JSON.stringify(doc.values[key] ?? null)
            )
              patch[key] = parsed;
          }
          const autoload =
            form.get("autoload") === "inherit"
              ? null
              : form.get("autoload") === "true";
          if (autoload !== (doc.values.autoload ?? null))
            patch.autoload = autoload;
          if (live) {
            await api("/api/plugin-resources", {
              id: row.id,
              revision: doc.revision,
              patch,
            });
            if (current(target)) await refresh();
          } else {
            row.pending = true;
            demoPending = true;
            renderPlugins();
          }
          if (current(target)) toast("资源过滤已保存");
        },
      );
    } else if (button.dataset.configPlugin)
      await configurePlugin(button.dataset.configPlugin);
    else if (button.dataset.marketDetail)
      await showPackageDetails(button.dataset.marketDetail);
    else if (button.dataset.marketPage)
      await loadMarket({ page: Number(button.dataset.marketPage) });
    else if (button.dataset.packageAction)
      await packageAction(
        button.dataset.packageAction,
        button.dataset.packageSource,
        button.dataset.packageScope,
      );
    else
      switch (button.dataset.action) {
        case "install-source":
          openDialog(
            "从来源安装",
            field(
              "npm、Git 或本地路径",
              "source",
              "",
              "text",
              'required placeholder="npm:包名、git:https://github.com/owner/repo 或 /本地路径"',
            ) +
              '<label class="field-label">范围<select name="scope"><option value="global">用户配置</option><option value="project">当前项目</option></select></label>',
            async (form) => {
              if (live) {
                await api("/api/package", {
                  action: "install",
                  source: form.get("source"),
                  scope: form.get("scope"),
                });
                if (current(target)) await refresh();
              }
              if (current(target)) toast("安装已完成，重载后应用");
            },
            "安装",
          );
          break;
        case "refresh-market":
          await loadMarket({ page: marketPage, refresh: true });
          break;
        case "retry-market":
          await loadMarket({ refresh: true });
          break;
        case "search-market-mcp":
          $("#market-search").value = "mcp";
          $("#market-type").value = "";
          await loadMarket();
          break;
        case "check-package-updates":
          await checkPackageUpdates();
          break;
        case "update-all-extensions":
          await updateAllExtensions();
          break;
      }
  }
  function maybeCheckUpdates() {
    if (
      context.active &&
      context.view === "plugins" &&
      live &&
      pluginInventory.updatesSupported &&
      pluginInventory.writable &&
      !pluginInventory.updatesCheckedAt &&
      !autoCheckRequested
    ) {
      autoCheckRequested = true;
      void checkPackageUpdates();
    }
  }
  function handleClick(button) {
    if (
      disposed ||
      !(
        [
          "filter",
          "togglePlugin",
          "pluginResources",
          "configPlugin",
          "marketDetail",
          "marketPage",
          "packageAction",
        ].some((key) => button.dataset[key] !== undefined) ||
        [
          "install-source",
          "refresh-market",
          "retry-market",
          "search-market-mcp",
          "check-package-updates",
          "update-all-extensions",
        ].includes(button.dataset.action)
      )
    )
      return false;
    const target = context.identity;
    void act(button, target).catch((error) => {
      if (current(target) && error.name !== "AbortError") toast(error.message);
    });
    return true;
  }
  for (const root of [$("#view-plugins"), $("#view-marketplace")])
    root.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest("button");
        if (button && handleClick(button)) event.stopPropagation();
      },
      { signal: listeners.signal },
    );
  $("#plugin-search").addEventListener("input", renderPlugins, {
    signal: listeners.signal,
  });
  $("#market-search-form").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      void loadMarket();
    },
    { signal: listeners.signal },
  );
  for (const id of ["market-type", "market-sort"])
    $("#" + id).addEventListener("change", () => void loadMarket(), {
      signal: listeners.signal,
    });
  return {
    setContext(next) {
      if (disposed) return;
      const changed = next.identity !== context.identity;
      const left = !next.active || next.view !== context.view;
      if (changed || next.view !== context.view) autoCheckRequested = false;
      context = { ...next };
      if (changed || left) cancelReads();
      if (changed) {
        plugins = [];
        pluginRevision = undefined;
        pluginInventory = { writable: false, updatesSupported: false };
        checkingPackageUpdates = false;
        marketLoaded = false;
        marketRows = [];
        demoPending = false;
      }
      if (
        next.active &&
        next.view === "marketplace" &&
        !marketLoaded &&
        !reads.has("market")
      )
        void loadMarket();
      renderPlugins();
      if (marketLoaded) renderMarket();
      maybeCheckUpdates();
    },
    applyInventory(value) {
      if (disposed) return;
      plugins = value.rows;
      pluginRevision = value.revision;
      pluginInventory = value;
      renderPlugins();
      if (marketLoaded) renderMarket();
      maybeCheckUpdates();
    },
    handleClick,
    reloaded() {
      if (!live) {
        demoPending = false;
        plugins.forEach((row) => (row.pending = false));
        renderPlugins();
      }
    },
    dispose() {
      disposed = true;
      cancelReads();
      listeners.abort();
    },
  };
}
