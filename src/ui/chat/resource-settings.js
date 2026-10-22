import { createSessionPanelLoader } from "./session-panel-loader.js";

/**
 * 资源设置：拥有技能清单、MCP 表单与可见期间的资源观察，命令目录仍由聊天协调器拥有。
 *
 * 接口：setContext／update／handleClick／dispose；见 docs/architecture/interfaces/chat-views.md。
 * 不变量：所有请求沿用注入的会话请求；身份失效及离页撤只读观察，不中止原生工作。
 * 错误：当前读取显示错误；交互与写入失败提示使用者，过期结果不发布。
 */
export function createResourceSettings({
  live,
  api,
  esc,
  icon,
  field,
  openDialog,
  toast,
  getState,
  getCommands,
  loadCommands,
  useCommand,
  beginInteraction,
  refresh,
}) {
  const $ = (selector) => document.querySelector(selector);
  const listeners = new AbortController();
  let context = {},
    disposed = false,
    timer,
    observation,
    resourceRevision,
    pollTick = 0;
  let skillsMarkup, mcpMarkup;
  const current = (identity) => !disposed && context.identity === identity;
  const skillsLoader = createSessionPanelLoader({
    read: async (_id, { signal }) => {
      await loadCommands();
      if (signal.aborted) return;
      return live ? api("/api/skills", undefined, { signal }) : { rows: [] };
    },
    onChange() {
      if (skillsLoader.error) {
        skillsMarkup = undefined;
        $("#skill-list").textContent = skillsLoader.error;
      } else renderSkills();
    },
  });
  const mcpLoader = createSessionPanelLoader({
    read: (_id, { signal }) =>
      live
        ? api("/api/mcp", undefined, { signal })
        : { rows: [], revisions: {} },
    onChange() {
      if (mcpLoader.error) {
        mcpMarkup = undefined;
        $("#mcp-list").textContent = mcpLoader.error;
      } else renderMcp();
    },
  });
  function renderSkills() {
    const skillsInventory = skillsLoader.data?.rows ?? [];
    const commands = getCommands();
    const query = $("#skill-search").value.toLowerCase();
    const inventoryCommands = skillsInventory.length
      ? [
          ...skillsInventory.map((row) => ({
            ...row,
            name: `skill:${row.name}`,
            label: row.name,
            source: "skill",
            skillId: row.id,
          })),
          ...commands.filter((row) => row.source !== "skill"),
        ]
      : commands;
    const rows = inventoryCommands.filter(
      (row) =>
        ["skill", "prompt", "extension"].includes(row.source) &&
        `${row.name} ${row.description}`.toLowerCase().includes(query),
    );
    const markup =
      ["skill", "prompt", "extension"]
        .map((source) => {
          const items = rows.filter((row) => row.source === source);
          if (!items.length) return "";
          return `<section class="settings-card"><h2>${{ skill: "技能", prompt: "提示模板", extension: "扩展命令" }[source]} <span class="scope-tag">${items.length}</span></h2>${items.map((row) => `<div class="resource-row"><div><strong>${esc(row.label || row.name)}</strong><small>${esc(row.description)}</small><code>/${esc(row.name)}</code></div>${row.source === "skill" && row.skillId ? `<span class="scope-tag">${row.scope === "project" ? "项目" : "用户"}</span><button class="switch" role="switch" aria-label="启用技能 ${esc(row.label)}" aria-checked="${row.enabled}" data-toggle-skill="${esc(row.skillId)}"></button>` : ""}<button class="outline-button" data-use-command="${esc(row.name)}" ${row.enabled === false ? "disabled" : ""}>使用</button></div>`).join("")}</section>`;
        })
        .join("") ||
      '<div class="empty">pi 尚未加载匹配的技能或模板。可在 Pi 配置中检查资源路径与过滤规则，然后重载。</div>';
    if (skillsMarkup !== markup) {
      skillsMarkup = markup;
      $("#skill-list").innerHTML = markup;
    }
  }

  function renderMcp() {
    const mcpInventory = mcpLoader.data ?? { rows: [], revisions: {} };
    const query = $("#mcp-search").value.toLowerCase();
    $("#mcp-pending").hidden = !mcpInventory.pending;
    const markup =
      mcpInventory.rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) =>
          `${row.name} ${row.config.description ?? ""}`
            .toLowerCase()
            .includes(query),
        )
        .map(
          ({ row, index }) =>
            `<article class="provider-card mcp-card"><div class="provider-main"><span class="provider-logo">${icon("layers")}</span><div class="provider-info"><h2>${esc(row.name)} <span class="scope-tag">${row.scope === "project" ? "项目" : row.scope === "extension" ? "扩展注册" : "用户"}</span></h2><p>${esc(row.config.description || (row.config.url ? row.config.url : [row.config.command, ...(row.config.args ?? [])].join(" ")))}</p><div class="provider-status"><span class="dot"></span>${row.overridden ? "被项目配置覆盖" : !row.trusted ? "项目信任后加载" : !row.enabled ? "已停用" : row.tools.length ? `已发现 ${row.tools.length} 个工具` : "已配置 · 查看连接状态"} · ${esc(row.config.exposure ?? "codemode")}</div></div>${row.scope !== "extension" ? `<button class="switch" role="switch" aria-label="启用 MCP ${esc(row.name)}" aria-checked="${row.enabled}" data-toggle-mcp="${index}"></button>` : ""}</div><div class="mcp-actions"><button class="outline-button" data-edit-mcp="${index}">${row.scope === "extension" ? "创建用户覆盖" : "配置"}</button><button data-mcp-action="reconnect" data-mcp-name="${esc(row.name)}" ${!row.enabled || row.overridden || !row.trusted ? "disabled" : ""}>重新连接</button>${row.config.url ? `<button data-mcp-action="login" data-mcp-name="${esc(row.name)}">登录</button><button data-mcp-action="logout" data-mcp-name="${esc(row.name)}">退出认证</button>` : ""}${row.scope !== "extension" ? `<button data-remove-mcp="${index}">卸载</button>` : ""}</div>${row.tools.length ? `<details class="mcp-tools"><summary>工具 · ${row.tools.length}</summary>${row.tools.map((tool) => `<p><code>${esc(tool.name)}</code><small>${esc(tool.description)}</small></p>`).join("")}</details>` : ""}</article>`,
        )
        .join("") ||
      '<div class="empty">连接一个 MCP 服务，为 pi 添加工具和资源。</div>';
    if (mcpMarkup !== markup) {
      mcpMarkup = markup;
      $("#mcp-list").innerHTML = markup;
    }
  }

  function jsonField(label, name, value) {
    return `<label class="field-label">${esc(label)}<textarea name="${esc(name)}" rows="3" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea></label>`;
  }
  function configureMcp(row) {
    const target = context.identity;
    const mcpInventory = mcpLoader.data ?? { rows: [], revisions: {} };
    const config = row?.config ?? {},
      scope = row?.scope === "project" ? "project" : "global";
    openDialog(
      row ? `${row.name} 配置` : "添加 MCP 服务",
      `<div class="field-grid">${field("名称", "name", row?.name ?? "", "text", row ? "readonly" : 'pattern="[A-Za-z0-9_-]+" required')}<label class="field-label">保存范围<select name="scope" ${row && row.scope !== "extension" ? "disabled" : ""}><option value="global" ${scope === "global" ? "selected" : ""}>用户</option><option value="project" ${scope === "project" ? "selected" : ""}>当前项目</option></select></label></div><label class="field-label">连接方式<select name="transport" id="mcp-transport"><option value="stdio" ${!config.url ? "selected" : ""}>本地进程 · stdio</option><option value="http" ${config.url ? "selected" : ""}>远程服务 · HTTP</option></select></label>${field("描述", "description", config.description ?? "")}<div id="mcp-stdio" ${config.url ? "hidden" : ""}>${field("启动命令", "command", config.command ?? "", "text", 'placeholder="npx"')}${jsonField("命令参数（JSON 数组）", "args", config.args ?? [])}${field("工作目录（可选）", "cwd", config.cwd ?? "")}${jsonField("环境变量（JSON 对象）", "env", config.env ?? {})}</div><div id="mcp-http" ${!config.url ? "hidden" : ""}>${field("服务 URL", "url", config.url ?? "", "text", 'placeholder="https://example.com/mcp"')}${jsonField("请求头（JSON 对象）", "headers", config.headers ?? {})}${field("使用模型提供商的认证（可选）", "authProvider", config.auth?.provider ?? "")}${jsonField("OAuth 参数（JSON 对象，可选）", "oauth", config.oauth ?? {})}</div><div class="dialog-note">已保存的环境变量、请求头和 OAuth 密钥以空值显示；留空保留对应凭据。支持 $环境变量。删除键可清除对应值。</div><div class="field-grid"><label class="field-label">工具暴露<select name="exposure">${["codemode", "deferred", "direct", "hidden"].map((value) => `<option ${value === (config.exposure ?? "codemode") ? "selected" : ""}>${value}</option>`).join("")}</select></label>${field("调用超时（秒）", "timeout", config.timeout ?? 60, "number", 'min="1" required')}</div>${jsonField("单个工具的暴露方式（JSON 对象，可选）", "toolExposure", config.toolExposure ?? {})}`,
      async (data) => {
        if (!live) {
          toast("MCP 管理需要连接 pi web");
          return;
        }
        const name = data.get("name"),
          selectedScope = data.get("scope") ?? scope;
        const parse = (key, fallback) => {
          try {
            return JSON.parse(data.get(key) || fallback);
          } catch {
            throw new Error(`${key} 不是有效 JSON`);
          }
        };
        const value = {
          description: data.get("description"),
          exposure: data.get("exposure"),
          timeout: Number(data.get("timeout")),
          toolExposure: parse("toolExposure", "{}"),
        };
        if (data.get("transport") === "http")
          Object.assign(value, {
            type: "http",
            url: data.get("url"),
            headers: parse("headers", "{}"),
            oauth: parse("oauth", "{}"),
            auth: data.get("authProvider")
              ? { provider: data.get("authProvider") }
              : null,
            command: null,
            args: null,
            env: null,
            cwd: null,
          });
        else
          Object.assign(value, {
            type: "stdio",
            command: data.get("command"),
            args: parse("args", "[]"),
            env: parse("env", "{}"),
            cwd: data.get("cwd") || null,
            url: null,
            headers: null,
            oauth: null,
            auth: null,
          });
        await api("/api/mcp", {
          action: "save",
          name,
          scope: selectedScope,
          revision:
            row && row.scope !== "extension"
              ? row.revision
              : mcpInventory.revisions[selectedScope],
          config: value,
        });
        if (!current(target)) return;
        await mcpLoader.refresh({ force: true });
        if (!current(target)) return;
        await refresh();
        toast("MCP 配置已保存，重载后生效");
      },
    );
    $("#mcp-transport").addEventListener("change", (event) => {
      $("#mcp-http").hidden = event.target.value !== "http";
      $("#mcp-stdio").hidden = event.target.value !== "stdio";
    });
  }

  async function act(button, target) {
    const skillsInventory = skillsLoader.data?.rows ?? [];
    const mcpInventory = mcpLoader.data ?? { rows: [], revisions: {} };
    if (button.dataset.useCommand) return useCommand(button.dataset.useCommand);
    if (button.dataset.toggleSkill) {
      const row = skillsInventory.find(
        (item) => item.id === button.dataset.toggleSkill,
      );
      if (!row) return;
      await api("/api/skill", {
        id: row.id,
        revision: row.revision,
        enabled: !row.enabled,
      });
      if (!current(target)) return;
      await skillsLoader.refresh({ force: true });
      if (!current(target)) return;
      await refresh();
      if (current(target)) toast("技能配置已保存，重载后生效");
    } else if (button.dataset.editMcp) {
      configureMcp(mcpInventory.rows[Number(button.dataset.editMcp)]);
    } else if (button.dataset.toggleMcp || button.dataset.removeMcp) {
      const row =
        mcpInventory.rows[
          Number(button.dataset.toggleMcp ?? button.dataset.removeMcp)
        ];
      if (!row) return;
      if (button.dataset.removeMcp) {
        openDialog(
          "移除 " + row.name,
          "<p>将从该范围的 mcp.json 移除此服务。</p>",
          async () => {
            await api("/api/mcp", {
              action: "remove",
              name: row.name,
              scope: row.scope,
              revision: row.revision,
            });
            if (!current(target)) return;
            await mcpLoader.refresh({ force: true });
            if (current(target)) await refresh();
          },
          "移除",
        );
      } else {
        await api("/api/mcp", {
          action: "toggle",
          name: row.name,
          scope: row.scope,
          revision: row.revision,
          enabled: !row.enabled,
        });
        if (!current(target)) return;
        await mcpLoader.refresh({ force: true });
        if (current(target)) await refresh();
      }
    } else if (button.dataset.mcpAction) {
      const job = await api("/api/mcp-action", {
        action: button.dataset.mcpAction,
        name: button.dataset.mcpName,
      });
      if (current(target)) await beginInteraction(job);
    } else configureMcp();
  }
  const handles = (button) =>
    [
      "toggleSkill",
      "editMcp",
      "toggleMcp",
      "removeMcp",
      "mcpAction",
      "useCommand",
    ].some((key) => button.dataset[key] !== undefined) ||
    button.dataset.action === "add-mcp";
  function handleClick(button) {
    if (disposed || !handles(button)) return false;
    const target = context.identity;
    void act(button, target).catch((error) => {
      if (current(target)) toast(error.message);
    });
    return true;
  }
  for (const root of [$("#view-skills"), $("#view-mcp")])
    root.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest("button");
        if (button && handleClick(button)) event.stopPropagation();
      },
      { signal: listeners.signal },
    );
  $("#skill-search").addEventListener("input", renderSkills, {
    signal: listeners.signal,
  });
  $("#mcp-search").addEventListener("input", renderMcp, {
    signal: listeners.signal,
  });
  async function poll(token) {
    if (!token || observation !== token || token.signal.aborted) return;
    try {
      const value = await api("/api/revision", undefined, {
        signal: token.signal,
      });
      if (observation !== token || token.signal.aborted) return;
      pollTick++;
      const changed =
        !value?.supported ||
        value.resources === undefined ||
        value.resources !== resourceRevision ||
        pollTick % 3 === 0;
      resourceRevision = value.resources;
      if (changed) await mcpLoader.refresh();
    } catch (error) {
      if (observation === token && !token.signal.aborted) {
        resourceRevision = undefined;
        await mcpLoader.refresh();
      }
    } finally {
      if (observation === token && !token.signal.aborted)
        timer = setTimeout(() => void poll(token), 1500);
    }
  }
  return {
    setContext(next) {
      if (disposed) return;
      const changed = ["identity", "view", "active"].some(
        (key) => context[key] !== next[key],
      );
      context = { ...next };
      if (!changed) return;
      clearTimeout(timer);
      observation?.abort();
      observation = undefined;
      resourceRevision = undefined;
      const sessionId = getState()?.sessionId ?? "preview";
      for (const [name, loader] of [
        ["skills", skillsLoader],
        ["mcp", mcpLoader],
      ]) {
        loader.setActive(next.active);
        loader.setContext({
          owner: next.identity,
          sessionId,
          enabled: next.active && next.view === name,
          canManage: false,
        });
        if (next.active && next.view === name)
          void loader.refresh({ force: true });
      }
      if (live && next.active && next.view === "mcp") {
        observation = new AbortController();
        timer = setTimeout(() => void poll(observation), 1500);
      }
    },
    update() {
      renderSkills();
    },
    handleClick,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      observation?.abort();
      listeners.abort();
      skillsLoader.dispose();
      mcpLoader.dispose();
    },
  };
}
