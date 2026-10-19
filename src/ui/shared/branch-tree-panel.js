import { createSessionPanelLoader } from "./session-panel-loader.js";
import {
  projectRoundTree,
  DEFAULT_ROUND_LIMIT,
  MAX_ROUND_LIMIT,
} from "./round-tree-view.js";

/**
 * 分支树面板：SVG 轨道与节点内 HTML 按钮展示轮次；历史只退回，当前位置才分支。
 *
 * 接口：createBranchTreePanel 的 builtin.update/render 接收工作台上下文；
 *   setSession、refresh、setActive／dispose 见 docs/architecture/interfaces/read-panels.md。
 * 不变量：展示聚合不替代 SDK 原生 parent／leaf 与上下文；最近 N 轮仅是视图窗口；
 *   命令绑定不可变目标，晚到结果不可导航；只读禁用管理，同一目标补刷保留选择与折叠。
 * 错误：读取／命令失败可见；unsupported 隐藏；过期结果忽略；偏好无法持久化时仍可临时使用。
 */
const SVG_NS = "http://www.w3.org/2000/svg";
const LIMIT_KEY = "pi-desktop:branch-round-limit";
const ROW_HEIGHT = 68;
const GRAPH_WIDTH = 460;
const MIN_GRAPH_WIDTH = 280;
const MAX_GRAPH_WIDTH = 760;
const MAX_LANES = 4;
const clampGraphWidth = (width) =>
  Math.max(MIN_GRAPH_WIDTH, Math.min(MAX_GRAPH_WIDTH, width));

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const vector = (tag, attributes = {}, text) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes))
    node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
};
export function createBranchTreePanel({
  fetchTree,
  command,
  toast,
  switchSession,
}) {
  let owner = "",
    target = "",
    selected;
  let container, repaint, resizeObserver;
  let graphWidth = GRAPH_WIDTH;
  let previewOpen = false;
  let context = {};
  let limit = DEFAULT_ROUND_LIMIT;
  // 隐私模式可能禁用偏好存储；它不能阻止只读面板打开。
  try {
    const saved = Number(localStorage.getItem(LIMIT_KEY));
    if (Number.isSafeInteger(saved) && saved >= 1 && saved <= MAX_ROUND_LIMIT)
      limit = saved;
  } catch {}
  const collapsed = new Set();
  const loader = createSessionPanelLoader({
    read: fetchTree,
    onChange: render,
  });
  function updateContext(next) {
    if (owner !== String(next.sessionId ?? "")) {
      selected = undefined;
      previewOpen = false;
      collapsed.clear();
    }
    context = next;
    owner = String(next.sessionId ?? "");
    return loader.setContext({
      owner,
      sessionId: target || owner,
      enabled: next.capabilities?.sessionTree === true,
      canManage:
        next.sessionCommands === true &&
        next.capabilities?.readOnly !== true &&
        next.capabilities?.remote !== true,
    });
  }
  function choose(id) {
    selected = id;
    render();
    [...(container?.querySelectorAll("[data-round-node]") ?? [])]
      .find((node) => node.dataset.roundNode === id)
      ?.focus();
  }
  function toggle(id, identity) {
    if (!loader.isCurrent(identity)) return;
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    render();
  }
  function renderGraph(rounds, identity) {
    const byId = new Map(rounds.map((round) => [round.id, round]));
    const hidden = (round) => {
      const seen = new Set();
      for (
        let parent = byId.get(round.parentId);
        parent && !seen.has(parent.id);
        parent = byId.get(parent.parentId)
      ) {
        if (collapsed.has(parent.id)) return true;
        seen.add(parent.id);
      }
      return false;
    };
    const visible = rounds.filter((round) => !hidden(round));
    if (!visible.some((round) => round.id === selected))
      selected =
        visible.find((round) => round.current)?.id ?? visible.at(-1)?.id;
    graphWidth = clampGraphWidth(container.clientWidth || GRAPH_WIDTH);
    const svg = vector("svg", {
      "data-round-tree": "true",
      role: "tree",
      "aria-label": "对话轮次与分支路径",
      viewBox: `0 0 ${graphWidth} ${visible.length * ROW_HEIGHT + 8}`,
      class: "branch-round-graph",
    });
    const positions = new Map();
    const usedParents = new Set();
    let nextLane = 1;
    for (const [index, round] of visible.entries()) {
      const parent = positions.get(round.parentId);
      let lane = parent?.lane ?? 0;
      if (parent && usedParents.has(round.parentId))
        lane = nextLane++ % MAX_LANES;
      usedParents.add(round.parentId);
      positions.set(round.id, {
        lane,
        x: 16 + lane * 10,
        y: 34 + index * ROW_HEIGHT,
      });
    }
    for (const [index, round] of visible.entries()) {
      const point = positions.get(round.id);
      const parent = positions.get(round.parentId);
      if (parent)
        svg.append(
          vector("path", {
            d: `M ${parent.x} ${parent.y} C ${parent.x} ${point.y - 32}, ${point.x} ${point.y - 32}, ${point.x} ${point.y}`,
            class: `branch-round-edge${round.active ? " is-active" : ""}`,
            "aria-hidden": "true",
            fill: "none",
          }),
        );
      svg.append(
        vector("path", {
          d: `M ${point.x} ${point.y} H 60`,
          class: "branch-round-stem",
          "aria-hidden": "true",
        }),
      );
      const row = vector("g", {
        "data-round-node": round.id,
        "data-node-id": round.id,
        "data-active": String(round.active),
        "data-current": String(round.current),
        role: "treeitem",
        tabindex: round.id === selected ? 0 : -1,
        "aria-selected": String(round.id === selected),
        "aria-label": `第 ${round.number} 轮，${round.prompt}${round.current ? "，当前位置" : "，历史节点"}`,
        class: `branch-round-node${round.id === selected ? " is-selected" : ""}${round.current ? " is-current" : ""}${round.active ? " is-active" : ""}`,
      });
      row.append(vector("title", {}, round.prompt));
      row.append(
        vector("circle", {
          cx: point.x,
          cy: point.y,
          r: round.current ? 7 : 5,
          class: "branch-round-dot",
        }),
      );
      row.append(
        vector("rect", {
          x: 60,
          y: point.y - 28,
          width: graphWidth - 68,
          height: 58,
          rx: 10,
          class: "branch-round-card",
        }),
      );
      const label = vector("foreignObject", {
        x: 70,
        y: point.y - 26,
        width: graphWidth - 88,
        height: 54,
      });
      const content = element("div", "branch-round-label");
      const copy = element("div", "branch-round-copy");
      const meta = element(
        "div",
        "branch-round-number",
        `第 ${round.number} 轮`,
      );
      if (round.current || !round.active)
        meta.append(
          element(
            "span",
            "branch-round-state",
            round.current ? "当前位置" : "历史路径",
          ),
        );
      copy.append(
        meta,
        element("div", "branch-round-question", round.prompt),
        element(
          "div",
          "branch-round-answer",
          round.answer || "本轮尚无文本回复",
        ),
      );
      const actions = element("div", "branch-round-actions");
      const kind = round.current ? "fork" : "rewind";
      const action = element(
        "button",
        "branch-round-action",
        kind === "fork" ? "创建分支" : "退回",
      );
      action.type = "button";
      action.tabIndex = round.id === selected ? 0 : -1;
      action.dataset.branchAction = kind;
      action.dataset.entryId = String(round.entryId ?? "");
      action.disabled =
        !loader.canManage ||
        !Number.isSafeInteger(round.entryId) ||
        (kind === "rewind" && loader.data?.idle === false);
      action.title = !loader.canManage
        ? "当前会话只提供分支树查看，不提供管理操作"
        : kind === "rewind" && loader.data?.idle === false
          ? "请等待当前任务结束"
          : !Number.isSafeInteger(round.entryId)
            ? "这一轮尚未映射到会话记录"
            : kind === "fork"
              ? "创建继承当前位置的新会话，原会话保持不变"
              : "退回到这一轮的最后一条已提交消息";
      action.setAttribute(
        "aria-label",
        kind === "fork" ? "从当前位置创建分支" : `退回到第 ${round.number} 轮`,
      );
      action.onclick = (event) => {
        event.stopPropagation();
        if (action.isConnected) void act(kind, round.entryId, identity);
      };
      actions.append(action);
      content.append(copy, actions);
      label.append(content);
      row.append(label);
      row.onclick = () => {
        if (row.isConnected && loader.isCurrent(identity)) choose(round.id);
      };
      const children = rounds.filter((child) => child.parentId === round.id);
      if (children.length) {
        row.setAttribute("aria-expanded", String(!collapsed.has(round.id)));
        const disclosure = vector("g", {
          "data-toggle-node": round.id,
          role: "button",
          "aria-label": collapsed.has(round.id)
            ? "展开后续轮次"
            : "折叠后续轮次",
          "aria-expanded": String(!collapsed.has(round.id)),
          class: "branch-round-disclosure",
        });
        disclosure.append(
          vector("rect", {
            x: point.x - 12,
            y: point.y - 12,
            width: 24,
            height: 24,
            rx: 4,
          }),
        );
        disclosure.append(
          vector("path", {
            d: collapsed.has(round.id)
              ? `M ${point.x - 4} ${point.y} H ${point.x + 4} M ${point.x} ${point.y - 4} V ${point.y + 4}`
              : `M ${point.x - 4} ${point.y} H ${point.x + 4}`,
            fill: "none",
          }),
        );
        disclosure.onclick = (event) => {
          event.stopPropagation();
          if (disclosure.isConnected) toggle(round.id, identity);
        };
        row.append(disclosure);
      }
      row.onkeydown = (event) => {
        if (!loader.isCurrent(identity)) return;
        if (
          event.target.closest?.("[data-branch-action]") &&
          ["Enter", " "].includes(event.key)
        )
          return;
        const keys = [
          "ArrowDown",
          "ArrowUp",
          "Home",
          "End",
          "Enter",
          " ",
          "ArrowLeft",
          "ArrowRight",
        ];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        if (
          event.key === "ArrowLeft" &&
          children.length &&
          !collapsed.has(round.id)
        )
          toggle(round.id, identity);
        else if (event.key === "ArrowRight" && collapsed.has(round.id))
          toggle(round.id, identity);
        else if (event.key === "ArrowLeft" && byId.has(round.parentId))
          choose(round.parentId);
        else {
          const next =
            event.key === "Home"
              ? visible[0]
              : event.key === "End"
                ? visible.at(-1)
                : event.key === "ArrowDown"
                  ? visible[index + 1]
                  : event.key === "ArrowUp"
                    ? visible[index - 1]
                    : round;
          if (next) choose(next.id);
        }
      };
      svg.append(row);
    }
    return {
      svg,
      selectedRound: visible.find((round) => round.id === selected),
    };
  }
  function render() {
    if (!container?.isConnected || !loader.available) {
      if (container) repaint?.();
      return;
    }
    const activeElement = container.contains(document.activeElement)
      ? document.activeElement
      : undefined;
    const focused =
      activeElement?.closest?.("[data-round-node]")?.dataset.roundNode;
    const focusedAction = activeElement?.dataset.branchAction;
    const { data, error, loading } = loader;
    const identity = loader.capture();
    const sessionId = loader.context.sessionId;
    const view = projectRoundTree(data, limit);
    const root = element("div", "branch-tree");
    root.dataset.branchTree = sessionId;
    const header = element("header", "branch-tree-header");
    const heading = element("div", "branch-tree-heading");
    heading.append(
      element("strong", "", data?.name ?? "对话分支"),
      element(
        "small",
        "",
        data
          ? `${view.total} 轮对话 · ${data.branches?.length ?? 0} 个分支`
          : loading
            ? "读取中…"
            : "",
      ),
    );
    header.append(heading);
    const settings = element("label", "branch-round-limit", "最近");
    const input = element("input");
    input.type = "number";
    input.min = "1";
    input.max = String(MAX_ROUND_LIMIT);
    input.value = String(limit);
    input.dataset.roundLimit = "true";
    input.setAttribute("aria-label", "分支树显示的最近对话轮数");
    input.onchange = () => {
      if (!input.isConnected || !loader.isCurrent(identity)) return;
      const value = Number(input.value);
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > MAX_ROUND_LIMIT
      ) {
        input.value = String(limit);
        toast(`显示轮数须为 1 到 ${MAX_ROUND_LIMIT} 的整数`);
        return;
      }
      limit = value;
      try {
        localStorage.setItem(LIMIT_KEY, String(limit));
      } catch {
        toast("无法保存显示偏好，本次页面仍使用所选轮数");
      }
      render();
    };
    settings.append(input, document.createTextNode("轮"));
    header.append(settings);
    const refresh = element("button", "outline-button", "刷新");
    refresh.type = "button";
    refresh.dataset.branchRefresh = "true";
    refresh.onclick = () => {
      if (refresh.isConnected) void loader.refresh({ force: true });
    };
    header.append(refresh);
    root.append(header);
    if (target && owner && target !== owner) {
      const note = element("div", "branch-tree-target");
      note.append(element("small", "", `正在显示会话 ${data?.name ?? target}`));
      const follow = element("button", "outline-button", "跟随当前会话");
      follow.type = "button";
      follow.dataset.branchFollow = "true";
      follow.onclick = () => {
        if (!follow.isConnected || !loader.isCurrent(identity)) return;
        target = "";
        selected = undefined;
        previewOpen = false;
        collapsed.clear();
        updateContext(context);
        render();
        void loader.refresh({ force: true });
      };
      note.append(follow);
      root.append(note);
    }
    if (error) root.append(element("p", "branch-tree-note", error));
    if (view.rounds.length) {
      const { svg, selectedRound } = renderGraph(view.rounds, identity);
      const canvas = element("div", "branch-round-canvas");
      canvas.append(svg);
      root.append(canvas);
      if (selectedRound) {
        const detail = element("details", "branch-round-detail");
        detail.open = previewOpen;
        detail.append(
          element("summary", "", `查看第 ${selectedRound.number} 轮摘要`),
        );
        detail.ontoggle = () => {
          if (detail.isConnected && loader.isCurrent(identity))
            previewOpen = detail.open;
        };
        detail.append(
          element("p", "branch-round-prompt", selectedRound.prompt),
        );
        if (selectedRound.answer)
          detail.append(
            element("p", "branch-round-reply", selectedRound.answer),
          );
        root.append(detail);
      }
    } else if (data)
      root.append(
        element(
          "p",
          "branch-tree-note",
          data.native
            ? "还没有可显示的对话轮次。"
            : "该会话没有原生树记录，可从会话栏创建当前位置的分支。",
        ),
      );
    if (data?.branches?.length) {
      const branches = element("section", "branch-tree-branches");
      branches.append(element("strong", "", "独立分支会话"));
      for (const branch of data.branches) {
        const row = element(
          "button",
          `branch-tree-branch${String(branch.id) === sessionId ? " active" : ""}`,
        );
        row.type = "button";
        row.dataset.branchSession = branch.id;
        row.append(
          element("span", "", branch.name),
          element("small", "", branch.idle ? "空闲" : "运行中"),
        );
        row.onclick = () => {
          if (row.isConnected && loader.isCurrent(identity))
            void switchSession(branch.id);
        };
        branches.append(row);
      }
      root.append(branches);
    }
    container.replaceChildren(root);
    if (focused) {
      const row = [...root.querySelectorAll("[data-round-node]")].find(
        (node) => node.dataset.roundNode === focused,
      );
      (focusedAction
        ? row?.querySelector(`[data-branch-action="${focusedAction}"]`)
        : row
      )?.focus({ preventScroll: true });
    }
  }
  async function act(kind, entryId, identity) {
    if (!loader.isCurrent(identity) || !loader.canManage) return;
    const input = Object.freeze({
      id: Number(identity.sessionId),
      entryId,
      sessionId: identity.sessionId,
      ...(kind === "fork" ? { mode: "tail", expectedEntryId: entryId } : {}),
    });
    try {
      const result = await command(kind, input);
      if (!loader.isCurrent(identity)) return;
      toast(kind === "fork" ? "已从当前位置创建分支" : "已退回到所选轮次");
      if (kind === "fork" && result?.sessionId)
        await switchSession(result.sessionId);
      else await loader.refresh({ force: true });
    } catch (failure) {
      if (loader.isCurrent(identity)) toast(failure.message);
    }
  }
  return {
    key: "desktop:branch-tree",
    view: { label: "Desktop", title: "对话分支", status: "" },
    get available() {
      return loader.available;
    },
    setSession(id) {
      const next = String(id ?? "");
      if (next === target) return;
      target = next;
      selected = undefined;
      previewOpen = false;
      collapsed.clear();
      updateContext(context);
      render();
    },
    refresh: loader.refresh,
    setActive: loader.setActive,
    dispose() {
      resizeObserver?.disconnect();
      loader.dispose();
    },
    builtin: {
      update: updateContext,
      render(node, next) {
        if (container !== node) {
          resizeObserver?.disconnect();
          resizeObserver = new ResizeObserver(() => {
            if (!container?.isConnected || !container.clientWidth) return;
            const width = clampGraphWidth(container.clientWidth);
            if (width !== graphWidth) render();
          });
          resizeObserver.observe(node);
        }
        container = node;
        repaint = next.rerender;
        updateContext(next);
        render();
        if (!loader.data && !loader.loading && !loader.error)
          void loader.refresh();
      },
    },
  };
}
