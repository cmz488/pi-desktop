/* 内置「任务与子代理」页：把 Host 的任务读模型（`GET /api/tasks`）画成任务树，
 * 并列出在跑工具与被任务拥有的子会话。操作（等待／取消／后台取消）走 `/api/command`，
 * 取消类动作需要两步确认；面板本身只读，不持有任务状态。 */

const STATUS_LABELS = {
  pending: "排队",
  running: "运行中",
  waiting: "等待",
  completing: "收尾",
};
const KIND_LABELS = {
  "pi.generation": "模型回合",
  "pi.tool": "工具调用",
};

export function createTaskPanel({
  fetchTasks,
  command,
  toast,
  currentSession,
}) {
  const CONFIRM_MS = 4000;
  let sessionId = "";
  let data;
  let error = "";
  let loading = false;
  let lastLoaded = 0;
  let pending = false;
  let retry;
  let armed;
  let armTimer;
  let container;
  let repaint;

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* 会话以页面当前选择为准：工作台不会因为会话切换而重画内置页，面板自己跟随。 */
  const session = () => {
    const fromPage = String(currentSession?.() ?? "");
    if (fromPage) sessionId = fromPage;
    return sessionId;
  };
  const kindLabel = (kind) => KIND_LABELS[kind] ?? kind;
  const statusLabel = (status) => STATUS_LABELS[status] ?? status;

  function arm(key) {
    armed = key;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      armed = undefined;
      render();
    }, CONFIRM_MS);
    render();
  }
  function disarm() {
    armed = undefined;
    clearTimeout(armTimer);
  }
  /* 两步确认：第一次点击只进入待确认状态，第二次才执行；4 秒后自动撤销。 */
  function confirmButton(key, label, title, run) {
    const button = element(
      "button",
      "outline-button",
      armed === key ? `${label}（再次点击确认）` : label,
    );
    button.type = "button";
    button.dataset.taskAction = key;
    if (title) button.title = title;
    if (armed === key) button.dataset.armed = "true";
    button.onclick = () => {
      if (armed !== key) return arm(key);
      disarm();
      render();
      void run();
    };
    return button;
  }

  async function act(input, message) {
    try {
      const result = await command(input);
      toast(message);
      await load({ force: true });
      return result;
    } catch (failure) {
      toast(failure.message);
      return undefined;
    }
  }

  function render() {
    if (!container?.isConnected) {
      repaint?.();
      return;
    }
    const root = element("div", "task-panel");
    root.dataset.taskPanel = session();
    const tasks = data?.tasks ?? [];
    const tools = data?.tools ?? [];
    const children = data?.conversations ?? [];
    const header = element("header", "task-panel-header");
    header.append(
      element("strong", "", "任务与子代理"),
      element(
        "small",
        "",
        data
          ? `${tasks.length} 个运行中任务 · ${tools.length} 个在跑工具 · ${children.length} 个子会话`
          : loading
            ? "读取中…"
            : "",
      ),
    );
    const actions = element("span", "task-panel-actions");
    const refresh = element("button", "outline-button", "刷新");
    refresh.type = "button";
    refresh.dataset.taskRefresh = "true";
    refresh.onclick = () => void load({ force: true });
    actions.append(refresh);
    if (tasks.some((task) => task.background))
      actions.append(
        confirmButton(
          "background",
          "取消后台任务",
          "只取消带后台标记的任务，不影响前台工作",
          () =>
            act(
              {
                command: "cancel",
                id: Number(sessionId),
                sessionId,
                background: true,
              },
              "已取消后台任务",
            ),
        ),
      );
    header.append(actions);
    root.append(header);
    if (error) root.append(element("p", "task-panel-note", error));
    if (data?.supported === false)
      root.append(
        element("p", "task-panel-note", "当前宿主不提供任务读模型。"),
      );
    if (data && !tasks.length)
      root.append(
        element(
          "p",
          "task-panel-empty",
          "本 Agent 当前没有运行中的任务：发起一次提问或让扩展派生任务后，任务树会出现在这里。",
        ),
      );

    if (tasks.length) {
      const byId = new Map(tasks.map((task) => [String(task.id), task]));
      const childrenOf = (owner) =>
        tasks.filter((task) => String(task.owner ?? "") === owner);
      const row = (task, depth) => {
        const node = element("div", "task-panel-row");
        node.dataset.taskId = String(task.id);
        node.dataset.kind = task.kind;
        node.dataset.status = task.status;
        node.style.setProperty("--task-depth", String(depth));
        node.append(
          element("span", "task-panel-marker", task.background ? "◆" : "◆"),
          element("span", "task-panel-label", kindLabel(task.kind)),
          element("span", "tag", statusLabel(task.status)),
        );
        if (task.background) node.append(element("span", "tag", "后台"));
        if (task.waitingOn?.length)
          node.append(
            element(
              "small",
              "",
              `等待 ${task.waitingOn.map((id) => `#${id}`).join("、")}`,
            ),
          );
        node.append(
          element(
            "small",
            "",
            task.owner === null || task.owner === undefined
              ? "由会话拥有"
              : `父任务 #${task.owner}`,
          ),
        );
        const rowActions = element("span", "task-panel-row-actions");
        const wait = element("button", "outline-button", "等待");
        wait.type = "button";
        wait.dataset.taskAction = `wait:${task.id}`;
        wait.onclick = () =>
          void act(
            {
              command: "wait",
              id: Number(sessionId),
              sessionId,
              taskId: Number(task.id),
            },
            "任务已结束",
          );
        rowActions.append(wait);
        rowActions.append(
          confirmButton(
            `cancel:${task.id}`,
            "取消",
            "中止这个任务；被中止的工作放开后命令才会返回",
            () =>
              act(
                {
                  command: "cancel",
                  id: Number(sessionId),
                  sessionId,
                  taskId: Number(task.id),
                },
                "已取消该任务",
              ),
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
      root.append(tree);
    }

    if (tools.length) {
      const list = element("section", "task-panel-list");
      list.append(element("strong", "", "在跑工具"));
      for (const tool of tools) {
        const node = element("div", "task-panel-row");
        node.dataset.toolName = tool.name;
        node.append(
          element("span", "task-panel-label", tool.name),
          element("span", "tag", statusLabel(tool.status) ?? tool.status),
          element("small", "", `会话 ${tool.conversationId}`),
        );
        list.append(node);
      }
      root.append(list);
    }

    if (children.length) {
      const list = element("section", "task-panel-list");
      list.append(element("strong", "", "子会话（子代理）"));
      for (const child of children) {
        const node = element("div", "task-panel-row");
        node.dataset.childId = String(child.id);
        node.append(
          element("span", "task-panel-label", child.name ?? `会话 ${child.id}`),
          element("span", "tag", child.idle ? "空闲" : "运行中"),
          element(
            "small",
            "",
            child.owner?.taskId === undefined
              ? `会话 ${child.id}`
              : `由任务 #${child.owner.taskId} 创建`,
          ),
        );
        list.append(node);
      }
      root.append(list);
    }
    container.replaceChildren(root);
  }

  async function load({ force = false } = {}) {
    const requested = session();
    if (!requested) return;
    // 状态刷新会频繁触发：进行中或刚读过时记下待刷新，结束后补一次，
    // 否则切会话后的那次刷新可能被丢掉，面板停在旧会话。
    if (loading) {
      pending = true;
      return;
    }
    if (!force && Date.now() - lastLoaded < 1500) {
      pending = true;
      clearTimeout(retry);
      retry = setTimeout(() => void load({ force: true }), 1600);
      return;
    }
    loading = true;
    lastLoaded = Date.now();
    try {
      data = await fetchTasks(requested);
      error = "";
    } catch (failure) {
      error = failure.message;
    } finally {
      loading = false;
      render();
      if (pending) {
        pending = false;
        void load({ force: true });
      }
    }
  }

  return {
    key: "desktop:task-panel",
    view: { label: "Desktop", title: "任务与子代理", status: "" },
    refresh() {
      return load();
    },
    builtin: {
      render(node, { sessionId: current, rerender }) {
        container = node;
        repaint = rerender;
        const next = String(current ?? "");
        if (next && next !== sessionId && !String(currentSession?.() ?? "")) {
          sessionId = next;
          data = undefined;
          disarm();
        }
        render();
        void load();
      },
    },
  };
}
