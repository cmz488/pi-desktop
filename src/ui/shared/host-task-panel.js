import { createSessionPanelLoader } from "./session-panel-loader.js";
import { createTaskPanel, taskStatusLabel } from "./task-panel.js";
import { renderTaskDetail } from "./task-detail-view.js";

/**
 * 全 Host 任务窗口：适配聚合 API，复用会话任务面板的确认、等待租约与权限生命周期。
 *
 * 接口：createHostTaskPanel({ root, request }) 返回 open／dispose；request 与
 *   workspace api(path, input, signal) 相同，协议见 docs/architecture/interfaces/host-tasks.md。
 * 不变量：任务状态只来自 worker；每个面板固定 Agent／generation／原生 owner scope；
 *   关闭或隐藏仅撤销观察；表单与详情请求捕获不可变目标，不把历史 parent 当任务 owner。
 * 错误：局部 worker 错误可见；不确定的发起保留同一 requestId，失败不清空用户草稿。
 */
const REFRESH_MS = 2000;
const REQUEST_MS = 12000;
const WAIT_REQUEST_MS = 45000;
const STATES = {
  running: "运行中",
  stopped: "已停止",
  failed: "启动失败",
  starting: "启动中",
  stopping: "停止中",
  history: "Pi TUI · 记录",
};
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const workerKey = (worker) => `${worker.agentId}:${worker.generation}`;
const taskKey = (target) =>
  `${target.agentId}:${target.generation}:${target.conversationId}:${target.taskId}`;

export function createHostTaskPanel({ root, request }) {
  const $ = (selector) => root.querySelector(selector);
  const form = $("#host-subagent-form");
  const field = (name) => form.elements.namedItem(name);
  const panels = new Map();
  const inspectionTargets = new Map();
  let timer,
    published,
    inspection,
    detailRequest,
    launchRequest,
    attempt,
    detailSignature;
  let alive = true,
    initialized = false,
    launching = false,
    inspectionEpoch = 0;
  const visible = () => alive && root.open && !document.hidden;
  const notify = (message) => {
    const note = $("[data-host-action-status]");
    note.textContent = message;
    note.hidden = false;
  };
  async function fetchHost(path, input, signal) {
    const deadline = new AbortController();
    const timeout = setTimeout(
      () => deadline.abort(),
      input?.command === "wait" ? WAIT_REQUEST_MS : REQUEST_MS,
    );
    try {
      return await request(
        path,
        input,
        signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
      );
    } catch (error) {
      if (deadline.signal.aborted && !signal?.aborted)
        throw new Error("连接超时，请刷新确认原生任务状态");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  function cancelDetail() {
    detailSignature = undefined;
    detailRequest?.abort();
    detailRequest = undefined;
    $("[data-host-detail]").setAttribute("aria-busy", "false");
  }
  function showComposer(open) {
    form.hidden = !open;
    const toggle = $("[data-host-toggle-compose]");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "收起表单" : "新建子代理";
  }
  function clearPanels() {
    for (const entry of panels.values()) entry.panel.dispose();
    panels.clear();
    published = undefined;
    cancelDetail();
    $("[data-host-workers]").replaceChildren();
    $("[data-host-spawn]").disabled = true;
    showComposer(false);
    $("[data-host-action-status]").hidden = true;
    $("[data-host-detail]").textContent = "选择任务查看结果与子会话。";
  }
  const monitor = createSessionPanelLoader({
    read: (_id, { signal }) => fetchHost("/api/host/tasks", undefined, signal),
    onChange: render,
    onReset: clearPanels,
  });
  monitor.setContext({
    owner: "host",
    sessionId: "host",
    enabled: true,
    canManage: false,
  });
  monitor.setActive(false);

  function options(select, rows, placeholder) {
    const previous = select.value;
    const nodes = rows.map((row) => {
      const node = new Option(row.label, row.value);
      node.disabled = row.disabled === true;
      return node;
    });
    select.replaceChildren(new Option(placeholder, ""), ...nodes);
    select.value = rows.some((row) => row.value === previous) ? previous : "";
  }
  function selectedWorker() {
    return monitor.data?.workers.find(
      (worker) => workerKey(worker) === field("agent").value,
    );
  }
  function selectedParent() {
    return selectedWorker()?.data?.conversations.find(
      (row) =>
        String(row.id) === field("conversation").value &&
        !row.owner &&
        row.managed,
    );
  }
  function updateParents() {
    const worker = selectedWorker();
    const previous = field("conversation").value;
    options(
      field("conversation"),
      (worker?.data?.conversations ?? [])
        .filter((row) => !row.owner && row.managed)
        .map((row) => ({
          value: String(row.id),
          label: `${row.name} · #${row.id}`,
        })),
      "请选择父会话",
    );
    if (!previous && field("conversation").options.length > 1)
      field("conversation").selectedIndex = 1;
    options(
      field("model"),
      (worker?.data?.models ?? []).map((model) => ({
        value: JSON.stringify([model.provider, model.modelId]),
        label: `${model.provider} / ${model.name ?? model.modelId}`,
      })),
      "继承父会话模型",
    );
    $("[data-host-spawn]").disabled =
      launching ||
      !selectedParent() ||
      worker?.status !== "running" ||
      worker?.data?.capabilities.spawnSubagent !== true;
  }
  function updateForm(workers) {
    options(
      field("agent"),
      workers.map((worker) => ({
        value: workerKey(worker),
        label: `${worker.name}${worker.data?.capabilities.spawnSubagent === true ? "" : "（未运行或只读）"}`,
        disabled: worker.data?.capabilities.spawnSubagent !== true,
      })),
      "请选择 Agent",
    );
    if (!initialized) {
      const first = [...field("agent").options].find(
        (option) => option.value && !option.disabled,
      );
      if (first) field("agent").value = first.value;
      initialized = true;
    }
    updateParents();
  }
  function graph(worker, scopeId) {
    const data = worker?.data;
    return {
      supported: data?.supported === true,
      sessionId: String(scopeId),
      tasks: (data?.tasks ?? []).filter((task) => task.scopeId === scopeId),
      tools: (data?.tools ?? []).filter((tool) => tool.scopeId === scopeId),
      conversations: (data?.conversations ?? []).filter(
        (row) => row.owner && row.scopeId === scopeId,
      ),
    };
  }
  function renderWorkers(workers) {
    const focused = document.activeElement;
    const focusScope = focused?.closest(".host-task-scope");
    const focusKey = [...panels].find(
      ([, entry]) => entry.node === focusScope,
    )?.[0];
    const focusAction = focused?.dataset.taskAction;
    const focusRefresh = focused?.dataset.taskRefresh;
    const container = $("[data-host-workers]");
    const retained = new Set();
    container.replaceChildren();
    if (!workers.length)
      container.append(
        element(
          "p",
          "host-task-note",
          "没有 Agent。请先在工作区创建会话；查看监控不会启动进程。",
        ),
      );
    for (const worker of workers) {
      const block = element("article", "host-task-worker");
      block.dataset.hostAgent = worker.agentId;
      block.dataset.generation = String(worker.generation);
      const header = element("header", "host-task-worker-heading");
      header.append(
        element("h3", "", worker.name),
        element(
          "span",
          "host-task-badge",
          STATES[worker.status] ?? worker.status,
        ),
      );
      block.append(header);
      container.append(block);
      const data = worker.data;
      if (worker.error || !data?.supported) {
        block.append(
          element(
            "p",
            "host-task-note",
            worker.error ??
              (worker.status === "running"
                ? "此 worker 未声明原生任务监控能力"
                : "进程未运行，不推断其任务终态。"),
          ),
        );
        continue;
      }
      const roots = data.conversations.filter(
        (row) =>
          !row.owner &&
          row.managed &&
          (data.tasks.some((task) => task.scopeId === row.id) ||
            data.conversations.some(
              (child) => child.owner && child.scopeId === row.id,
            )),
      );
      if (!roots.length)
        block.append(
          element("p", "host-task-note", "暂无运行任务或子代理会话。"),
        );
      for (const scope of roots) {
        const key = `${workerKey(worker)}:${scope.id}`;
        retained.add(key);
        let entry = panels.get(key);
        const existing = !!entry;
        if (!entry) {
          entry = {
            node: element("section", "host-task-scope"),
            source: undefined,
            reading: false,
          };
          const target = Object.freeze({
            agentId: worker.agentId,
            generation: worker.generation,
            conversationId: scope.id,
          });
          entry.panel = createTaskPanel({
            currentSession: () => String(scope.id),
            toast: notify,
            fetchTasks: async () => {
              entry.reading = true;
              try {
                if (entry.source === monitor.data)
                  await monitor.refresh({ force: true });
                entry.source = monitor.data;
                return graph(
                  monitor.data?.workers.find(
                    (row) => workerKey(row) === workerKey(worker),
                  ),
                  scope.id,
                );
              } finally {
                entry.reading = false;
              }
            },
            command: (input, { signal } = {}) =>
              fetchHost(
                "/api/host/tasks/command",
                {
                  ...target,
                  command: input.command,
                  ...(input.background === true
                    ? { background: true }
                    : { taskId: input.taskId }),
                },
                signal,
              ),
          });
          panels.set(key, entry);
        }
        const title = element("h4", "", `${scope.name} · 会话 #${scope.id}`);
        block.append(title, entry.node);
        entry.panel.builtin.render(entry.node, {
          sessionId: String(scope.id),
          taskCommands: data.capabilities.manageTasks === true,
          capabilities: {
            tasks: data.capabilities.taskInspection === true,
            readOnly: data.capabilities.manageTasks !== true,
          },
          rerender: () => {},
        });
        if (existing && !entry.reading)
          void entry.panel.refresh({ force: true });
      }
      const unknown = data.tasks.filter((task) => task.scopeId === null);
      for (const task of unknown)
        block.append(
          element(
            "p",
            "host-task-note",
            `未绑定管理会话 · ${task.kind} #${task.id} · ${task.status}（仅监控）`,
          ),
        );
    }
    for (const [key, entry] of panels)
      if (!retained.has(key)) {
        entry.panel.dispose();
        panels.delete(key);
      }
    if (focusKey) {
      const node = panels.get(focusKey)?.node;
      const control = focusAction
        ? [...(node?.querySelectorAll("[data-task-action]") ?? [])].find(
            (button) => button.dataset.taskAction === focusAction,
          )
        : focusRefresh
          ? node?.querySelector("[data-task-refresh]")
          : undefined;
      if (control && !control.disabled) control.focus({ preventScroll: true });
    }
  }
  function updateInspection(workers) {
    inspectionTargets.clear();
    for (const worker of workers) {
      const data = worker.data;
      if (!data?.supported) continue;
      for (const child of data.conversations.filter(
        (row) => row.owner && row.scopeId !== null,
      )) {
        const target = Object.freeze({
          agentId: worker.agentId,
          generation: worker.generation,
          conversationId: child.scopeId,
          taskId: child.owner.taskId,
          label: `${worker.name} / ${child.name} · #${child.owner.taskId}`,
        });
        inspectionTargets.set(taskKey(target), target);
      }
      for (const task of data.tasks.filter((row) => row.scopeId !== null)) {
        const target = Object.freeze({
          agentId: worker.agentId,
          generation: worker.generation,
          conversationId: task.scopeId,
          taskId: task.id,
          label: `${worker.name} / ${task.name ?? task.kind} · #${task.id}`,
        });
        if (!inspectionTargets.has(taskKey(target)))
          inspectionTargets.set(taskKey(target), target);
      }
    }
    if (
      inspection &&
      workers.some(
        (worker) =>
          workerKey(worker) ===
          `${inspection.agentId}:${inspection.generation}`,
      )
    )
      inspectionTargets.set(taskKey(inspection), inspection);
    const previousKey = inspection && taskKey(inspection);
    options(
      $("[data-host-inspect]"),
      [...inspectionTargets].map(([value, target]) => ({
        value,
        label: target.label,
      })),
      "选择原生任务",
    );
    if (previousKey && inspectionTargets.has(previousKey))
      $("[data-host-inspect]").value = previousKey;
    if (inspectionTargets.size && !$("[data-host-inspect]").value)
      $("[data-host-inspect]").selectedIndex = 1;
    inspection = inspectionTargets.get($("[data-host-inspect]").value);
    if ((inspection && taskKey(inspection)) !== previousKey) {
      cancelDetail();
      $("[data-host-detail]").textContent = inspection
        ? "读取原生回执…"
        : "选择任务查看结果与子会话。";
    }
    void inspect();
  }
  function render() {
    if (!visible()) return;
    const data = monitor.data;
    $("[data-host-status]").setAttribute("aria-busy", String(monitor.loading));
    const status = monitor.error
      ? `读取失败：${monitor.error}；不推断任务已停止。`
      : data
        ? `${data.workers.length} 个 Agent · ${data.workers.reduce((n, row) => n + (row.data?.tasks.length ?? 0), 0)} 项任务${data.partial ? " · 部分 Agent 暂不可读" : ""}`
        : "读取中…";
    if ($("[data-host-status]").textContent !== status)
      $("[data-host-status]").textContent = status;
    if (!data) return;
    if (data === published) {
      // 任务图的 ETag 不涵盖 pi.live 片段；图未变不代表所选子会话没有新输出。
      if (!monitor.loading) void inspect();
      return;
    }
    published = data;
    updateForm(data.workers);
    renderWorkers(data.workers);
    updateInspection(data.workers);
  }
  function renderDetail(data, label) {
    renderTaskDetail($("[data-host-detail]"), data, {
      label,
      statusLabel: taskStatusLabel,
    });
  }
  async function inspect() {
    if (!visible() || !inspection || detailRequest) return;
    const target = inspection;
    const controller = new AbortController();
    detailRequest = controller;
    $("[data-host-detail]").setAttribute("aria-busy", "true");
    try {
      const { label, ...identity } = target;
      const data = await fetchHost(
        `/api/host/tasks/detail?${new URLSearchParams(identity)}`,
        undefined,
        controller.signal,
      );
      if (!visible() || inspection !== target || controller.signal.aborted)
        return;
      renderDetail(data, label);
    } catch (error) {
      if (visible() && inspection === target && !controller.signal.aborted) {
        detailSignature = undefined;
        $("[data-host-detail]").textContent = error.message;
      }
    } finally {
      if (detailRequest === controller) {
        detailRequest = undefined;
        $("[data-host-detail]").setAttribute("aria-busy", "false");
      }
    }
  }
  async function launch(event) {
    event.preventDefault();
    const worker = selectedWorker(),
      parent = selectedParent();
    if (
      launching ||
      !visible() ||
      !parent ||
      worker?.data?.capabilities.spawnSubagent !== true
    )
      return;
    const config = {};
    if (field("model").value) {
      const [provider, modelId] = JSON.parse(field("model").value);
      config.model = { provider, modelId };
    }
    for (const key of ["thinkingLevel", "instructions"])
      if (field(key).value) config[key] = field(key).value;
    if (field("tools").value.trim())
      config.tools = field("tools")
        .value.split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    const payload = Object.freeze({
      command: "subagent.spawn",
      agentId: worker.agentId,
      generation: worker.generation,
      conversationId: parent.id,
      name: field("name").value,
      prompt: field("prompt").value,
      config,
    });
    const signature = JSON.stringify(payload);
    if (attempt?.signature !== signature)
      attempt = { signature, requestId: crypto.randomUUID() };
    const controller = new AbortController();
    const epoch = inspectionEpoch;
    launchRequest = controller;
    launching = true;
    updateParents();
    $("[data-host-launch-status]").textContent =
      `正在为 ${worker.name} 创建原生任务…`;
    try {
      const result = await fetchHost(
        "/api/host/tasks/command",
        { ...payload, requestId: attempt.requestId },
        controller.signal,
      );
      if (!visible() || controller.signal.aborted) return;
      $("[data-host-launch-status]").textContent =
        `${worker.name} · 已创建原生任务 #${result.taskId}，尚不表示执行完成。`;
      attempt = undefined;
      // 发起不拥有用户后续的查看选择，晚到回执只更新自己的准入提示。
      if (inspectionEpoch === epoch) {
        inspection = Object.freeze({
          agentId: worker.agentId,
          generation: worker.generation,
          conversationId: parent.id,
          taskId: result.taskId,
          label: `${worker.name} / ${payload.name || "子代理"} · #${result.taskId}`,
        });
        cancelDetail();
        $("[data-host-detail]").textContent = "读取原生回执…";
      }
      await monitor.refresh({ force: true });
    } catch (error) {
      if (visible() && !controller.signal.aborted)
        $("[data-host-launch-status]").textContent = error.message;
    } finally {
      if (launchRequest === controller) {
        launchRequest = undefined;
        launching = false;
        updateParents();
      }
    }
  }
  async function poll() {
    clearTimeout(timer);
    if (!visible()) return;
    await monitor.refresh({ force: true });
    if (visible()) timer = setTimeout(poll, REFRESH_MS);
  }
  function activity() {
    clearTimeout(timer);
    monitor.setActive(visible());
    if (visible()) void poll();
    else pause();
  }
  field("agent").onchange = () => {
    field("conversation").value = "";
    updateParents();
  };
  field("conversation").onchange = updateParents;
  $("[data-host-inspect]").onchange = () => {
    inspectionEpoch++;
    cancelDetail();
    inspection = inspectionTargets.get($("[data-host-inspect]").value);
    $("[data-host-detail]").textContent = "读取原生回执…";
    void inspect();
  };
  form.onsubmit = launch;
  $("[data-host-toggle-compose]").onclick = () => {
    showComposer(form.hidden);
    if (!form.hidden) field("prompt").focus();
  };
  $("[data-host-refresh]").onclick = () =>
    void monitor.refresh({ force: true });
  $("[data-host-close]").onclick = () => {
    pause();
    root.close();
  };
  root.addEventListener("cancel", pause);
  root.addEventListener("close", activity);
  document.addEventListener("visibilitychange", activity);
  function pause() {
    monitor.setActive(false);
    clearTimeout(timer);
    launchRequest?.abort();
    launchRequest = undefined;
    launching = false;
  }
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", activity);
  return {
    open() {
      if (!alive) return;
      if (!root.open) {
        // close 事件异步派发；快速重开必须先失效旧代，不能借用上一窗口的观察。
        pause();
        root.showModal();
      }
      activity();
    },
    dispose() {
      if (!alive) return;
      alive = false;
      monitor.dispose();
      clearTimeout(timer);
      launchRequest?.abort();
      root.removeEventListener("cancel", pause);
      root.removeEventListener("close", activity);
      document.removeEventListener("visibilitychange", activity);
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("pageshow", activity);
    },
  };
}
