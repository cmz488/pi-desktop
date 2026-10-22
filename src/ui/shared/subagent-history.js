import { createSessionPanelLoader } from "./session-panel-loader.js";
import {
  renderTaskDetail,
  taskReceiptLabel,
  hasMessageFailure,
} from "./task-detail-view.js";
import { dshIcon } from "./dsh-icons.mjs";

/**
 * 对话分支中的子代理历史：只读查看原生终态委托，不把 owned 会话冒充历史 fork。
 *
 * 接口：createSubagentHistory 返回 update／render／setActive／dispose；
 *   读取与裁剪见 docs/architecture/interfaces/session-tree.md。
 * 不变量：折叠时不读取；记录按 owner／目标隔离；分页和详情晚到不得覆盖另一会话。
 * 错误：当前错误可重试；不把读取失败、实时图消失或 idle 当作原生终态。
 */
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
export function createSubagentHistory({ fetchHistory, fetchDetail }) {
  let root,
    list,
    detail,
    selected = "",
    open = false,
    enabled = false,
    active = true;
  let pages = [],
    moreRequest,
    moreError = "";
  const history = createSessionPanelLoader({
    read: (id, options) => fetchHistory(id, undefined, options),
    onChange: paint,
    onReset: clear,
  });
  const inspector = createSessionPanelLoader({
    read: (id, options) =>
      fetchDetail(history.context.sessionId, Number(id), options),
    onChange: paintDetail,
  });
  history.setActive(false);
  function retarget() {
    inspector.setContext({
      owner: JSON.stringify([history.context.owner, history.context.sessionId]),
      sessionId: selected,
      enabled: enabled && open && active && !!selected,
      canManage: false,
    });
  }
  function clear() {
    moreRequest?.abort();
    moreRequest = undefined;
    pages = [];
    selected = "";
    moreError = "";
    retarget();
  }
  function paintDetail() {
    if (!detail) return;
    detail.hidden = !selected;
    detail.setAttribute("aria-busy", String(inspector.loading));
    if (inspector.error) detail.textContent = inspector.error;
    else if (inspector.data) renderTaskDetail(detail, inspector.data);
    else detail.textContent = "读取已提交记录…";
  }
  function paint() {
    if (!list) return;
    const focused = list.contains(document.activeElement)
      ? document.activeElement.dataset.workbenchFocus
      : undefined;
    root.hidden = history.data?.supported === false;
    list.replaceChildren();
    if (history.error || moreError)
      list.append(element("p", "branch-tree-note", history.error || moreError));
    const refresh = element("button", "outline-button", "刷新记录");
    refresh.type = "button";
    refresh.dataset.workbenchFocus = "refresh";
    refresh.onclick = () => {
      if (refresh.isConnected) {
        pages = [];
        moreError = "";
        void history.refresh({ force: true });
      }
    };
    list.append(refresh);
    const data = history.data;
    if (!data)
      list.append(
        element(
          "p",
          "branch-tree-note",
          history.loading ? "读取中…" : "展开后读取原生终态记录。",
        ),
      );
    const records = [
      ...(data?.records ?? []),
      ...pages.flatMap((page) => page.records),
    ];
    for (const record of records.filter((row) => row.status === "terminal")) {
      const button = element("button", "subagent-history-record");
      const icon = element("span", "task-panel-marker");
      icon.innerHTML = dshIcon("branch");
      const name = element("span", "subagent-history-name", record.name);
      const status = element(
        "span",
        "subagent-history-status",
        taskReceiptLabel(record),
      );
      const reference = element("small", "", `#${record.id}`);
      button.append(icon, name, reference, status);
      button.dataset.outcome = record.outcome?.status ?? "";
      button.dataset.messageFailure = String(hasMessageFailure(record));
      button.type = "button";
      button.dataset.subagentRecord = String(record.id);
      button.dataset.workbenchFocus = `record:${record.id}`;
      button.setAttribute(
        "aria-pressed",
        String(selected === String(record.id)),
      );
      const identity = history.capture();
      button.onclick = () => {
        if (!button.isConnected || !history.isCurrent(identity)) return;
        selected = String(record.id);
        retarget();
        paint();
        void inspector.refresh({ force: true });
      };
      list.append(button);
    }
    if (data && !records.length && !history.error)
      list.append(element("p", "branch-tree-note", "暂无已结束的子代理委托。"));
    const next =
      pages.at(-1)?.nextBefore ?? (pages.length ? null : data?.nextBefore);
    if (next !== null && next !== undefined) {
      const more = element(
        "button",
        "outline-button",
        moreRequest ? "读取中…" : "更早记录",
      );
      more.type = "button";
      more.dataset.workbenchFocus = "more";
      more.disabled = !!moreRequest;
      more.onclick = async () => {
        const identity = history.capture();
        if (!more.isConnected || !history.isCurrent(identity) || moreRequest)
          return;
        const controller = new AbortController();
        moreRequest = controller;
        moreError = "";
        paint();
        const owner = history.context.sessionId;
        try {
          const page = await fetchHistory(owner, next, {
            signal: controller.signal,
          });
          if (controller.signal.aborted || !history.isCurrent(identity)) return;
          if (String(page.sessionId) !== owner)
            throw new Error("子代理历史目标不一致，请重新读取");
          pages.push(page);
        } catch (error) {
          if (!controller.signal.aborted && history.isCurrent(identity))
            moreError = error.message;
        } finally {
          if (moreRequest === controller) {
            moreRequest = undefined;
            paint();
          }
        }
      };
      list.append(more);
    }
    paintDetail();
    if (focused)
      [...list.querySelectorAll("[data-workbench-focus]")]
        .find((node) => node.dataset.workbenchFocus === focused)
        ?.focus({ preventScroll: true });
  }
  return {
    update(context, target) {
      enabled =
        typeof fetchHistory === "function" &&
        typeof fetchDetail === "function" &&
        context.capabilities?.taskDetails === true &&
        context.capabilities?.sessionTree === true &&
        context.capabilities?.remote !== true;
      const changed = history.setContext({
        owner: String(context.sessionId ?? ""),
        sessionId: String(target || context.sessionId || ""),
        enabled,
        canManage: false,
      });
      if (changed) {
        open = false;
        history.setActive(false);
        root = list = detail = undefined;
      }
      retarget();
    },
    render(node) {
      if (!enabled) return;
      if (!root) {
        root = element("details", "subagent-history");
        root.dataset.subagentHistory = "true";
        root.append(element("summary", "", "已结束的子代理记录"));
        list = element("div", "subagent-history-list");
        detail = element("div", "subagent-history-detail");
        root.append(list, detail);
        const panel = root;
        root.ontoggle = () => {
          if (!panel.isConnected || root !== panel) return;
          open = panel.open;
          history.setActive(active && open);
          retarget();
          if (open) void history.refresh();
        };
      }
      const focused = root.contains(document.activeElement)
        ? document.activeElement.dataset.workbenchFocus
        : undefined;
      const panel = root;
      node.append(root);
      paint();
      // 分支图会临时搬离历史区；挂载后才恢复焦点，不能抢走期间的新选择。
      if (focused)
        queueMicrotask(() => {
          if (
            root !== panel ||
            !panel.isConnected ||
            !active ||
            !open ||
            document.activeElement !== document.body
          )
            return;
          [...panel.querySelectorAll("[data-workbench-focus]")]
            .find((node) => node.dataset.workbenchFocus === focused)
            ?.focus({ preventScroll: true });
        });
    },
    setActive(value) {
      if (active === value) return;
      active = value;
      history.setActive(value && open);
      inspector.setActive(value);
      if (!value) moreRequest?.abort();
      retarget();
      if (value && open) void history.refresh();
    },
    dispose() {
      moreRequest?.abort();
      history.dispose();
      inspector.dispose();
      root = list = detail = undefined;
    },
  };
}
