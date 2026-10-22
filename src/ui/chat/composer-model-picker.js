// DSH ModelSelect interaction: an upward root menu, provider-grouped model
// search and a separate effort pane. Pi remains the authority for choices.
export function createComposerModelPicker({
  trigger,
  getData,
  selectModel,
  selectThinking,
  loadModels = async () => {},
  reload,
  onError,
}) {
  const panel = document.createElement("div");
  panel.id = "composer-model-popover";
  panel.className = "composer-model-popover";
  panel.hidden = true;
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", "模型与思考强度");
  document.body.append(panel);
  let pane = "root",
    query = "",
    pending = false,
    generation = 0,
    signature = "";
  let loadingModels = false;
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  function close(focus = false) {
    ++generation;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (focus) trigger.focus();
  }
  function position() {
    const rect = trigger.getBoundingClientRect();
    const area = trigger.closest(".composer").getBoundingClientRect();
    panel.style.width = `${Math.min(350, innerWidth - 24, area.width - 8)}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.bottom = `${Math.max(12, innerHeight - rect.top + 10)}px`;
    panel.style.maxHeight = `${Math.max(100, Math.min(380, rect.top - 24))}px`;
  }
  const choices = () => [
    ...panel.querySelectorAll(
      pane === "root"
        ? "button:not(:disabled)"
        : ".model-menu-options button:not(:disabled)",
    ),
  ];
  function focusCurrent() {
    if (pane === "model" && panel.querySelector("input"))
      panel.querySelector("input").focus();
    else (panel.querySelector("[aria-checked=true]") ?? choices()[0])?.focus();
  }
  async function choose(run) {
    if (pending) return;
    pending = true;
    trigger.classList.add("model-selecting");
    const current = ++generation;
    render();
    try {
      await run();
      if (current === generation) close(true);
    } catch (error) {
      onError(error);
      if (current === generation) {
        render();
        focusCurrent();
      }
    } finally {
      pending = false;
      trigger.classList.remove("model-selecting");
      if (!panel.hidden) render();
    }
  }
  function button(label, detail, action, selected = false, disabled = false) {
    const row = node("button", undefined, "model-menu-row");
    row.type = "button";
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", String(selected));
    row.disabled = disabled || pending;
    row.append(node("span", label), node("small", detail));
    row.onclick = action;
    return row;
  }
  function renderModels(host, data) {
    const providers = data.providers ?? [];
    let count = 0;
    for (const provider of providers) {
      const models = provider.models.filter((model) =>
        `${provider.name} ${provider.id} ${model.name} ${model.id}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      );
      if (!models.length) continue;
      host.append(
        node("div", provider.name || provider.id, "model-menu-heading"),
      );
      for (const model of models) {
        const selected =
          data.model?.provider === provider.id &&
          (data.model.id ?? data.model.modelId) === model.id;
        host.append(
          button(
            model.name || model.id,
            selected ? "✓" : model.available === false ? "不可用" : "",
            () => choose(() => selectModel(provider.id, model.id)),
            selected,
            model.available === false || !data.editable,
          ),
        );
        count++;
      }
    }
    if (!count) {
      host.append(
        node(
          "p",
          loadingModels
            ? "加载模型…"
            : query
              ? "没有匹配的模型"
              : "暂无模型，请检查提供商配置",
          "model-menu-empty",
        ),
      );
      if (!query) {
        const retry = button("刷新模型列表", "", async () => {
          try {
            await reload();
            update();
          } catch (error) {
            onError(error);
          }
        });
        host.append(retry);
      }
    }
  }
  function render() {
    const data = getData();
    panel.replaceChildren();
    if (pane === "root") {
      panel.append(
        button(
          "模型",
          data.model?.name ?? data.model?.id ?? "选择模型",
          async () => {
            pane = "model";
            loadingModels = true;
            render();
            focusCurrent();
            try {
              await loadModels();
            } catch (error) {
              onError(error);
            } finally {
              loadingModels = false;
              if (!panel.hidden && pane === "model") {
                render();
                focusCurrent();
              }
            }
          },
        ),
        button(
          "思考强度",
          data.effortLabel ?? data.thinkingLevel ?? "默认",
          () => {
            pane = "effort";
            render();
            focusCurrent();
          },
        ),
      );
    } else {
      const back = node("button", undefined, "model-menu-back");
      back.type = "button";
      back.append(node("span", "‹"));
      back.append(node("span", pane === "model" ? "选择模型" : "思考强度"));
      back.onclick = () => {
        pane = "root";
        render();
        focusCurrent();
      };
      panel.append(back);
      if (pane === "model") {
        const search = node("input");
        search.type = "search";
        search.placeholder = "搜索模型或提供商";
        search.setAttribute("aria-label", "搜索模型或提供商");
        search.value = query;
        search.disabled = pending;
        search.oninput = () => {
          query = search.value;
          const host = panel.querySelector(".model-menu-options");
          host.replaceChildren();
          renderModels(host, getData());
          position();
        };
        panel.append(search);
      }
      const host = node("div", undefined, "model-menu-options");
      host.setAttribute("role", "group");
      panel.append(host);
      if (pane === "model") renderModels(host, data);
      else
        for (const level of data.levels ?? [])
          host.append(
            button(
              level.label,
              level.value === data.thinkingLevel ? "✓" : "",
              () => choose(() => selectThinking(level.value)),
              level.value === data.thinkingLevel,
              !data.thinkingEditable,
            ),
          );
    }
    position();
  }
  function open() {
    if (!panel.hidden) {
      close();
      return;
    }
    pane = "root";
    query = "";
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    render();
    focusCurrent();
  }
  async function openModels(provider = "") {
    pane = "model";
    query = provider;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    loadingModels = true;
    const current = ++generation;
    render();
    focusCurrent();
    try {
      await loadModels();
    } catch (error) {
      if (current === generation) onError(error);
    } finally {
      if (current === generation) {
        loadingModels = false;
        render();
        focusCurrent();
      }
    }
  }
  function update() {
    const data = getData();
    trigger.querySelector(".model-trigger-label").textContent =
      data.model?.name ?? data.model?.id ?? data.model?.modelId ?? "选择模型";
    trigger.querySelector(".model-trigger-effort").textContent =
      data.effortLabel ?? "";
    trigger.title = `${data.model?.provider ?? ""} / ${data.model?.name ?? data.model?.id ?? "选择模型"} · ${data.effortLabel ?? ""}`;
    if (panel.hidden) return;
    const next = JSON.stringify([
      data.model,
      data.providers,
      data.thinkingLevel,
      data.levels,
      data.editable,
    ]);
    if (!panel.hidden && next !== signature) {
      const input = panel.querySelector("input");
      if (pane === "model" && document.activeElement === input) {
        const host = panel.querySelector(".model-menu-options");
        host.replaceChildren();
        renderModels(host, data);
        position();
      } else render();
    }
    signature = next;
  }
  trigger.onclick = open;
  document.addEventListener("pointerdown", (event) => {
    if (!panel.contains(event.target) && !trigger.contains(event.target))
      close();
  });
  document.addEventListener("keydown", (event) => {
    if (panel.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (pane !== "root") {
        pane = "root";
        render();
        focusCurrent();
      } else close(true);
    } else if (event.key === "Tab") {
      close();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const rows = choices();
      const index = rows.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : event.key === "ArrowDown"
              ? (index + 1) % rows.length
              : (index - 1 + rows.length) % rows.length;
      rows[next]?.focus();
    }
  });
  window.addEventListener("resize", () => {
    if (!panel.hidden) position();
  });
  return { update, close, open, openModels };
}
