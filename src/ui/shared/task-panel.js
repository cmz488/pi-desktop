import { createSessionPanelLoader } from "./session-panel-loader.js";
import { dshIcon } from "./dsh-icons.mjs";
import { createTaskPanelManagement } from "./task-panel-management.js";
import { hasMessageFailure, taskReceiptLabel } from "./task-detail-view.js";

/**
 * 任务面板：展示 Host 的会话范围读模型，不另持有任务状态。
 *
 * 接口：`createTaskPanel` 的 builtin.update/render 接收工作台上下文，refresh、
 *   setActive／dispose 管理读取；taskStatusLabel 共享原生活跃态文案，未知值原样返回。
 *   命令与权限见 docs/architecture/interfaces/read-panels.md。
 * 不变量：来源、确认与命令目标绑定同一代不可变身份；切会话立即清数据和确认；
 *   只读管理禁用，远程本会话操作不额外禁用；等待只拥有一个可取消观察，不拥有任务。
 * 错误：当前读取／命令失败可见，408 仅续租；取消／到期明确保留任务，过期结果忽略。
 */

const WAIT_TOTAL_MS = 5 * 60 * 1000;
const STATUS_LABELS = {
  pending: "排队",
  running: "运行中",
  waiting: "等待",
  completing: "收尾",
};
const OUTCOME_NOTICES = {
  completed: "任务已完成",
  failed: "任务失败",
  aborted: "任务已中止",
  orphaned: "任务无法恢复",
  faulted: "任务执行故障",
};
const receiptNotice = (result, fallback) => {
  if (result?.task && hasMessageFailure(result.task))
    return `${taskReceiptLabel(result.task)}，请查看子代理记录`;
  const outcome =
    result?.task?.status === "terminal" ? result.task.outcome?.status : null;
  return (
    OUTCOME_NOTICES[outcome] ??
    (result?.abortStatus === "marked"
      ? "已提交任务中止请求，尚未确认终态"
      : result?.abortStatus === "terminal"
        ? "任务此前已结束，请查看原生结果"
        : fallback)
  );
};
const KIND_LABELS = {
  "pi.generation": "模型回合",
  "pi.tool": "工具调用",
  "desk.subagent-run": "子代理",
  "desk.subagent-message": "子代理消息",
};

export function taskStatusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

export function createTaskPanel({
  fetchTasks,
  fetchDetail,
  command,
  toast,
  currentSession,
}) {
  const CONFIRM_MS = 4000;
  let armed;
  let armTimer;
  let waiting;
  let container;
  let repaint;
  let panelContext = {};
  let filter = "all",
    query = "",
    composingInput;
  let active = true,
    visible = true;
  const management = createTaskPanelManagement({
    fetchDetail,
    refresh: (options) => loader.refresh(options),
    statusLabel: taskStatusLabel,
    command,
    toast,
    capture: () => loader.capture(),
    isCurrent: (identity) => loader.isCurrent(identity),
    canManage: () => loader.canManage,
  });

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const loader = createSessionPanelLoader({
    read: fetchTasks,
    onChange: render,
    onReset: (reason) => {
      composingInput = undefined;
      if (reason === "identity") {
        filter = "all";
        query = "";
      }
      disarm();
      cancelWaiting();
      management.reset();
    },
  });
  function updateContext(context) {
    const owner = String(context.sessionId ?? currentSession?.() ?? "");
    panelContext = context;
    const changed = loader.setContext({
      owner,
      sessionId: owner,
      enabled: context.capabilities?.tasks === true,
      canManage:
        (context.taskCommands ?? context.sessionCommands) === true &&
        context.capabilities?.readOnly !== true,
    });
    management.update(context, loader.data);
    return changed;
  }
  const kindLabel = (kind) => KIND_LABELS[kind] ?? kind;

  function arm(key, identity) {
    armed = Object.freeze({ key, identity });
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      if (armed?.identity !== identity) return;
      disarm();
      render();
    }, CONFIRM_MS);
    render();
  }
  function disarm() {
    armed = undefined;
    clearTimeout(armTimer);
    armTimer = undefined;
  }
  /* 破坏性取消需要两次独立点击；重画本身不能授予第二次执行资格。 */
  function confirmButton(key, label, title, run, identity) {
    const confirming = armed?.key === key && armed.identity === identity;
    const button = element(
      "button",
      key.startsWith("cancel:") && !confirming
        ? "outline-button task-panel-icon-button task-panel-stop"
        : "outline-button task-panel-stop",
      confirming ? "确认中止" : key.startsWith("cancel:") ? undefined : label,
    );
    if (key.startsWith("cancel:") && !confirming)
      button.innerHTML = dshIcon("stop");
    button.type = "button";
    button.dataset.taskAction = key;
    const targetLabel = key.startsWith("cancel:")
      ? `${label}任务 #${key.slice(7)}`
      : label;
    button.setAttribute(
      "aria-label",
      confirming ? `再次点击确认${targetLabel}` : targetLabel,
    );
    if (title) button.title = title;
    button.disabled = !loader.canManage;
    if (button.disabled)
      button.title = "当前会话只提供任务查看，不提供管理操作";
    if (confirming) button.dataset.armed = "true";
    button.onclick = () => {
      if (
        !button.isConnected ||
        !loader.isCurrent(identity) ||
        !loader.canManage
      )
        return;
      if (!confirming || armed?.identity !== identity || armed.key !== key)
        return arm(key, identity);
      disarm();
      render();
      void run();
    };
    return button;
  }

  function cancelWaiting(notify = false) {
    const previous = waiting;
    if (!previous) return;
    waiting = undefined;
    clearTimeout(previous.timer);
    previous.controller.abort();
    if (notify && loader.isCurrent(previous.identity))
      toast("已取消等待，任务继续运行");
  }

  async function waitForTask(input, identity) {
    if (!loader.isCurrent(identity) || !loader.canManage) return;
    cancelWaiting();
    disarm();
    const entry = {
      input: Object.freeze(input),
      identity,
      controller: new AbortController(),
      timer: undefined,
    };
    waiting = entry;
    entry.timer = setTimeout(() => {
      if (waiting !== entry) return;
      cancelWaiting();
      if (loader.isCurrent(identity)) {
        toast("等待时间已到，任务继续运行，可重新等待");
        render();
      }
    }, WAIT_TOTAL_MS);
    render();
    const { signal } = entry.controller;
    try {
      let result;
      for (;;) {
        if (signal.aborted) return;
        try {
          result = await command(entry.input, { signal });
          break;
        } catch (failure) {
          // 租约到期不是任务终态；只续当前这一项观察，不重发工作或中止命令。
          if (failure.status !== 408 || signal.aborted) throw failure;
          if (waiting !== entry || !loader.isCurrent(identity)) return;
        }
      }
      if (signal.aborted || waiting !== entry || !loader.isCurrent(identity))
        return;
      waiting = undefined;
      clearTimeout(entry.timer);
      render();
      toast(receiptNotice(result, "任务已结束"));
      await loader.refresh({ force: true });
      return result;
    } catch (failure) {
      if (!signal.aborted && waiting === entry && loader.isCurrent(identity))
        toast(failure.message);
      return undefined;
    } finally {
      clearTimeout(entry.timer);
      if (waiting === entry) {
        waiting = undefined;
        render();
      }
    }
  }

  async function act(input, message, identity) {
    if (!loader.isCurrent(identity) || !loader.canManage) return;
    try {
      const result = await command(Object.freeze(input));
      if (!loader.isCurrent(identity)) return result;
      toast(receiptNotice(result, message));
      await loader.refresh({ force: true });
      return result;
    } catch (failure) {
      if (loader.isCurrent(identity)) toast(failure.message);
      return undefined;
    }
  }

  function render() {
    if (!loader.available) cancelWaiting();
    if (!container?.isConnected || !loader.available) {
      if (container) repaint?.();
      return;
    }
    const focusedElement = container.contains(document.activeElement)
      ? document.activeElement
      : undefined;
    // 输入法组合期间不替换搜索框；后台读模型仍更新，结束组合后再呈现最新快照。
    if (composingInput?.isConnected && focusedElement === composingInput) {
      container
        .querySelector(".task-panel")
        ?.setAttribute("aria-busy", String(loader.loading));
      return;
    }
    composingInput = undefined;
    const focused = focusedElement?.dataset.taskAction;
    const focusedBuiltin = focusedElement?.dataset.workbenchFocus;
    const selection =
      focusedElement?.type === "search"
        ? [focusedElement.selectionStart, focusedElement.selectionEnd]
        : undefined;
    const { data, error, loading } = loader;
    const sessionId = loader.context.sessionId;
    const identity = loader.capture();
    const root = element("div", "task-panel");
    root.dataset.taskPanel = sessionId;
    root.setAttribute("aria-busy", String(loading));
    const content = element("div", "task-panel-content");
    const tasks = data?.tasks ?? [];
    const tools = data?.tools ?? [];
    const activeTaskIds = new Set(tasks.map((task) => task.id));
    const activeConversations = new Set(
      tasks.map((task) => task.conversationId),
    );
    const children = (data?.conversations ?? []).filter(
      (child) =>
        activeTaskIds.has(child.owner?.taskId) ||
        activeConversations.has(child.id),
    );
    const detailed = management.update(panelContext, data);
    const delegates = tasks.filter((task) => task.kind === "desk.subagent-run");
    const entries = [];
    let filterEmpty;
    function applyFilter() {
      const term = query.trim().toLocaleLowerCase();
      for (const { node, task, depth, haystack } of entries) {
        const matchesKind =
          filter === "all" ||
          (filter === "agents") === (task.kind === "desk.subagent-run");
        node.hidden = !matchesKind || !haystack.includes(term);
        node.style.setProperty(
          "--task-depth",
          String(filter === "all" && !term ? depth : 0),
        );
      }
      for (const button of root.querySelectorAll("[data-task-filter]"))
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.taskFilter === filter),
        );
      if (filterEmpty)
        filterEmpty.hidden = entries.some(({ node }) => !node.hidden);
    }
    root.classList.toggle("task-panel-workbench", detailed);
    const header = element("header", "task-panel-header");
    const heading = element("div", "task-panel-heading");
    heading.append(
      element("h2", "", "任务与子代理"),
      element(
        "small",
        "",
        data
          ? tasks.length
            ? `${delegates.length} 个子代理，${tasks.length} 项任务进行中`
            : tools.length
              ? "正在执行工具"
              : "当前没有进行中的任务"
          : loading
            ? "读取中…"
            : "",
      ),
    );
    header.append(heading);
    const actions = element("span", "task-panel-actions");
    const refresh = element("button", "outline-button task-panel-icon-button");
    refresh.innerHTML = dshIcon("refresh");
    refresh.setAttribute("aria-label", "刷新任务");
    refresh.title = "刷新任务";
    refresh.type = "button";
    refresh.dataset.taskRefresh = "true";
    refresh.dataset.workbenchFocus = "task-refresh";
    refresh.onclick = () => void loader.refresh({ force: true });
    actions.append(refresh);
    if (detailed) {
      const compose = element("button", "outline-button task-panel-create");
      compose.innerHTML = dshIcon("plus");
      compose.append(element("span", "", "新建子代理"));
      compose.type = "button";
      compose.dataset.taskComposeToggle = "true";
      compose.dataset.workbenchFocus = "task-compose-toggle";
      compose.disabled = !identity || !loader.canManage;
      if (compose.disabled)
        compose.title = "当前会话只提供查看，不提供子代理管理";
      compose.onclick = () => {
        if (compose.isConnected && loader.isCurrent(identity))
          management.toggleCompose();
      };
      actions.append(compose);
    }
    header.append(actions);
    root.append(header);
    const composer = element("div", "task-panel-compose-slot");
    root.append(composer);
    if (tasks.length) {
      const toolbar = element("div", "task-panel-toolbar");
      const filters = element("div", "task-panel-filters");
      filters.setAttribute("role", "group");
      filters.setAttribute("aria-label", "任务类型");
      for (const [key, label, count] of [
        ["all", "全部", tasks.length],
        ["agents", "子代理", delegates.length],
        ["execution", "其他任务", tasks.length - delegates.length],
      ]) {
        const button = element("button", "task-panel-filter");
        button.type = "button";
        button.dataset.taskFilter = key;
        button.dataset.workbenchFocus = `task-filter:${key}`;
        button.setAttribute("aria-pressed", String(filter === key));
        button.append(
          element("span", "", label),
          element("span", "task-panel-count", String(count)),
        );
        button.onclick = () => {
          if (!button.isConnected || !loader.isCurrent(identity)) return;
          filter = key;
          applyFilter();
        };
        filters.append(button);
      }
      const search = element("label", "task-panel-search");
      search.innerHTML = dshIcon("search");
      const input = element("input");
      input.type = "search";
      input.setAttribute("aria-label", "搜索任务");
      input.placeholder = "搜索名称或编号";
      input.value = query;
      input.dataset.workbenchFocus = "task-search";
      input.oninput = () => {
        if (!input.isConnected || !loader.isCurrent(identity)) return;
        query = input.value;
        applyFilter();
      };
      input.addEventListener("compositionstart", () => {
        if (input.isConnected && loader.isCurrent(identity))
          composingInput = input;
      });
      input.addEventListener("compositionend", () => {
        if (composingInput === input) composingInput = undefined;
        if (!input.isConnected || !loader.isCurrent(identity)) return;
        query = input.value;
        render();
      });
      search.append(input);
      toolbar.append(filters, search);
      root.append(toolbar);
    }
    const body = element("div", "task-panel-body");
    body.append(content);
    root.append(body);
    if (error)
      content.append(element("p", "task-panel-note task-panel-error", error));
    if (data && !tasks.length && !tools.length && !children.length) {
      const empty = element("div", "task-panel-empty");
      const mark = element("span", "task-panel-empty-mark");
      mark.innerHTML = dshIcon("tasks");
      empty.append(
        mark,
        element("strong", "", "当前会话暂无进行中的任务"),
        element(
          "p",
          "",
          detailed
            ? "新建子代理开始委托；已结束的记录可在「对话分支」查看。"
            : "发送提问后，可在这里查看执行进度。",
        ),
      );
      content.append(empty);
    }

    if (tasks.length) {
      const byId = new Map(tasks.map((task) => [String(task.id), task]));
      const childrenOf = (owner) =>
        tasks.filter((task) => String(task.owner ?? "") === owner);
      const row = (task, depth) => {
        const taskId = Number(task.id);
        const node = element("div", "task-panel-row");
        node.dataset.taskId = String(task.id);
        node.dataset.kind = task.kind;
        node.dataset.status = task.status;
        const haystack = [
          task.id,
          `#${task.id}`,
          task.name,
          kindLabel(task.kind),
          taskStatusLabel(task.status),
          children.find(
            (child) =>
              child.owner?.taskId === taskId ||
              child.id === task.conversationId,
          )?.name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase();
        entries.push({ node, task, depth, haystack });
        const marker = element("span", "task-panel-marker");
        marker.innerHTML = dshIcon(
          task.kind === "desk.subagent-run" ? "branch" : "tasks",
        );
        const copy = element(detailed ? "button" : "div", "task-panel-copy");
        if (detailed) {
          copy.type = "button";
          copy.classList.add("task-panel-select");
          copy.dataset.taskInspect = String(task.id);
          copy.dataset.taskAction = `inspect:${task.id}`;
          copy.onclick = () => {
            if (copy.isConnected && loader.isCurrent(identity))
              management.select(task.id);
          };
        }
        const title = element("span", "task-panel-title");
        title.append(
          element(
            "span",
            "task-panel-label",
            task.name ??
              children.find((child) => child.owner?.taskId === taskId)?.name ??
              kindLabel(task.kind),
          ),
          element("span", "task-panel-state", taskStatusLabel(task.status)),
        );
        if (task.abortRequested)
          title.append(element("span", "task-panel-state", "中止中"));
        if (task.schedulerState === "blocked") {
          const note = element("span", "task-panel-state", "无法调度");
          note.title = task.blockedReason ?? "";
          title.append(note);
        }
        const child = children.find((row) => row.id === task.conversationId);
        const metadata = [
          `#${task.id}`,
          ...(task.kind !== "desk.subagent-run" && child?.name
            ? [child.name]
            : []),
          ...(task.background ? ["后台"] : []),
          ...(task.owner === null || task.owner === undefined
            ? []
            : [`父任务 #${task.owner}`]),
          ...(task.waitingOn?.length
            ? [`等待 ${task.waitingOn.map((id) => `#${id}`).join("、")}`]
            : []),
        ];
        copy.append(
          title,
          element("small", "task-panel-meta", metadata.join(" · ")),
        );
        node.append(marker, copy);
        const rowActions = element("span", "task-panel-row-actions");
        const pending = waiting;
        const isWaiting =
          !!pending &&
          pending.identity === identity &&
          pending.input.taskId === taskId;
        const wait = element(
          "button",
          isWaiting
            ? "outline-button"
            : "outline-button task-panel-icon-button",
          isWaiting ? "取消等待" : undefined,
        );
        if (!isWaiting) wait.innerHTML = dshIcon("clock");
        wait.type = "button";
        wait.dataset.taskAction = `wait:${task.id}`;
        wait.dataset.waiting = String(isWaiting);
        wait.setAttribute(
          "aria-label",
          `${isWaiting ? "取消等待" : "等待"}任务 #${task.id}`,
        );
        wait.disabled = !loader.canManage;
        wait.title = wait.disabled
          ? "当前会话只提供任务查看，不提供管理操作"
          : isWaiting
            ? "只取消观察请求，任务继续运行"
            : "等待任务真正结束";
        wait.onclick = () => {
          if (
            !wait.isConnected ||
            !loader.isCurrent(identity) ||
            !loader.canManage
          )
            return;
          if (isWaiting) {
            if (waiting !== pending) return;
            cancelWaiting(true);
            render();
            return;
          }
          void waitForTask(
            { command: "wait", id: Number(sessionId), sessionId, taskId },
            identity,
          );
        };
        rowActions.append(wait);
        rowActions.append(
          confirmButton(
            `cancel:${task.id}`,
            "中止",
            "通过原生中止协议取消这个任务及其拥有的工作",
            () =>
              act(
                {
                  command: "cancel",
                  id: Number(sessionId),
                  sessionId,
                  taskId,
                },
                "已提交任务中止请求",
                identity,
              ),
            identity,
          ),
        );
        node.append(rowActions);
        return node;
      };
      const tree = element("div", "task-panel-tree");
      const walk = (task, depth) => {
        tree.append(row(task, depth));
        for (const child of childrenOf(String(task.id))) walk(child, depth + 1);
      };
      for (const task of tasks.filter(
        (row) => row.owner === null || row.owner === undefined,
      ))
        walk(task, 0);
      // 拥有者不在列表里的任务（例如父任务刚刚结束）也要显示出来，避免面板漏行。
      for (const task of tasks)
        if (
          !byId.has(String(task.owner ?? "")) &&
          tree.querySelector(`[data-task-id="${task.id}"]`) === null
        )
          tree.append(row(task, 0));
      content.append(tree);
      filterEmpty = element(
        "p",
        "task-panel-filter-empty",
        "没有符合条件的任务，请调整筛选或搜索。",
      );
      filterEmpty.setAttribute("role", "status");
      content.append(filterEmpty);
      applyFilter();
    }

    const extraChildren = children.filter(
      (child) =>
        !delegates.some(
          (task) => String(task.id) === String(child.owner?.taskId),
        ),
    );
    if (tools.length || extraChildren.length) {
      const activity = element("details", "task-panel-activity");
      const previous = container.querySelector(".task-panel-activity");
      activity.open = previous?.open ?? false;
      activity.append(
        element(
          "summary",
          "",
          `执行活动（${tools.length + extraChildren.length}）`,
        ),
      );
      for (const tool of tools) {
        const node = element("div", "task-panel-row");
        node.dataset.toolName = tool.name;
        node.append(
          element("span", "task-panel-label", tool.name),
          element("span", "task-panel-state", taskStatusLabel(tool.status)),
          element("small", "task-panel-meta", `会话 #${tool.conversationId}`),
        );
        activity.append(node);
      }
      for (const child of extraChildren) {
        const node = element("div", "task-panel-row");
        node.dataset.childId = String(child.id);
        node.append(
          element("span", "task-panel-label", child.name ?? `会话 ${child.id}`),
          element("span", "task-panel-state", child.idle ? "空闲" : "运行中"),
          element("small", "task-panel-meta", `会话 #${child.id}`),
        );
        activity.append(node);
      }
      content.append(activity);
    }
    if (tasks.some((task) => task.background)) {
      const footer = element("footer", "task-panel-footer");
      footer.append(
        confirmButton(
          "background",
          "中止后台",
          "只取消带后台标记的任务，不影响前台工作",
          () =>
            act(
              {
                command: "cancel",
                id: Number(sessionId),
                sessionId,
                background: true,
              },
              "已提交后台任务中止请求",
              identity,
            ),
          identity,
        ),
      );
      content.append(footer);
    }
    management.render(root);
    container.replaceChildren(root);
    if (focused || focusedBuiltin) {
      const key = focused ? "taskAction" : "workbenchFocus";
      const target = [
        ...root.querySelectorAll("[data-task-action],[data-workbench-focus]"),
      ].find(
        (node) =>
          node.dataset[key] === (focused ?? focusedBuiltin) && !node.disabled,
      );
      target?.focus({ preventScroll: true });
      if (target && selection) target.setSelectionRange(...selection);
    } else if (focusedElement?.isConnected)
      focusedElement.focus({ preventScroll: true });
  }

  return {
    key: "desktop:task-panel",
    view: { label: "Desktop", title: "任务与子代理", status: "" },
    get available() {
      return loader.available;
    },
    refresh: loader.refresh,
    setActive(value) {
      if (!value) composingInput = undefined;
      loader.setActive(value);
      active = value;
      management.setActive(active && visible);
    },
    dispose() {
      management.dispose();
      loader.dispose();
    },
    builtin: {
      setVisible(value) {
        visible = value;
        if (!value) {
          composingInput = undefined;
          cancelWaiting();
          disarm();
        }
        management.setActive(active && visible);
      },
      update: updateContext,
      render(node, context) {
        container = node;
        repaint = context.rerender;
        updateContext(context);
        render();
        if (!loader.data && !loader.loading && !loader.error)
          void loader.refresh();
      },
    },
  };
}
