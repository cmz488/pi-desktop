import { createSessionPanelLoader } from "./session-panel-loader.js";
import {
  projectRoundTree,
  DEFAULT_ROUND_LIMIT,
  MAX_ROUND_LIMIT,
} from "./round-tree-view.js";

/**
 * 分支树面板：以 SVG 展示对话轮次，历史只提供退回，当前位置才提供创建分支。
 *
 * 接口：createBranchTreePanel 的 builtin.update/render 接收工作台上下文；
 *   setSession、refresh、setActive／dispose 见 docs/architecture/interfaces/read-panels.md。
 * 不变量：展示聚合不替代 SDK 原生 parent／leaf 与上下文；最近 N 轮仅是视图窗口；
 *   命令绑定不可变目标，晚到结果不可导航；只读禁用管理，同一目标补刷保留选择与折叠。
 * 错误：读取／命令失败可见；unsupported 隐藏；过期结果忽略；偏好无法持久化时仍可临时使用。
 */
const SVG_NS = "http://www.w3.org/2000/svg";
const LIMIT_KEY = "pi-desktop:branch-round-limit";
const ROW_HEIGHT = 86;
const GRAPH_WIDTH = 460;
const MAX_LANES = 4;

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
const clipped = (text, length = 22) =>
  text.length > length ? `${text.slice(0, length)}…` : text;

export function createBranchTreePanel({
  fetchTree,
  command,
  toast,
  switchSession,
}) {
  let owner = "",
    target = "",
    selected;
  let container, repaint;
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
    const svg = vector("svg", {
      "data-round-tree": "true",
      role: "tree",
      "aria-label": "对话轮次与分支路径",
      viewBox: `0 0 ${GRAPH_WIDTH} ${visible.length * ROW_HEIGHT + 16}`,
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
        x: 24 + lane * 18,
        y: 42 + index * ROW_HEIGHT,
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
          d: `M ${point.x} ${point.y} H 102`,
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
          x: 102,
          y: point.y - 32,
          width: 342,
          height: 66,
          rx: 12,
          class: "branch-round-card",
        }),
      );
      row.append(
        vector(
          "text",
          { x: 116, y: point.y - 13, class: "branch-round-number" },
          `第 ${round.number} 轮${round.current ? " · 当前位置" : round.active ? "" : " · 历史路径"}`,
        ),
      );
      row.append(
        vector(
          "text",
          { x: 116, y: point.y + 7, class: "branch-round-question" },
          clipped(round.prompt),
        ),
      );
      row.append(
        vector(
          "text",
          { x: 116, y: point.y + 24, class: "branch-round-answer" },
          clipped(round.answer || "本轮尚无文本回复", 28),
        ),
      );
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
            x: 410,
            y: point.y - 28,
            width: 30,
            height: 28,
            rx: 6,
          }),
        );
        disclosure.append(
          vector("path", {
            d: collapsed.has(round.id)
              ? `M 419 ${point.y - 14} H 431 M 425 ${point.y - 20} V ${point.y - 8}`
              : `M 419 ${point.y - 14} H 431`,
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
    const focused = container.contains(document.activeElement)
      ? document.activeElement.dataset.roundNode
      : undefined;
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
      root.append(
        element(
          "p",
          "branch-tree-note",
          `显示 ${view.rounds.length} 轮；选择历史节点可退回，只有当前位置可创建分支。原始记录不会被删除。`,
        ),
      );
      const { svg, selectedRound } = renderGraph(view.rounds, identity);
      const canvas = element("div", "branch-round-canvas");
      canvas.append(svg);
      root.append(canvas);
      if (selectedRound) {
        const detail = element("section", "branch-round-detail");
        detail.append(
          element(
            "strong",
            "",
            `第 ${selectedRound.number} 轮${selectedRound.current ? " · 当前位置" : ""}`,
          ),
        );
        detail.append(
          element("p", "branch-round-prompt", selectedRound.prompt),
        );
        if (selectedRound.answer)
          detail.append(
            element("p", "branch-round-reply", selectedRound.answer),
          );
        const kind = selectedRound.current ? "fork" : "rewind";
        const action = element(
          "button",
          "outline-button",
          kind === "fork" ? "从当前位置创建分支" : "退回到这一轮",
        );
        action.type = "button";
        action.dataset.branchAction = kind;
        action.dataset.entryId = String(selectedRound.entryId ?? "");
        action.disabled =
          !loader.canManage ||
          !Number.isSafeInteger(selectedRound.entryId) ||
          (kind === "rewind" && data?.idle === false);
        action.title = !loader.canManage
          ? "当前会话只提供分支树查看，不提供管理操作"
          : kind === "rewind" && data?.idle === false
            ? "请等待当前任务结束"
            : !Number.isSafeInteger(selectedRound.entryId)
              ? "这一轮尚未映射到会话记录"
              : "";
        action.onclick = () => {
          if (action.isConnected)
            void act(kind, selectedRound.entryId, identity);
        };
        detail.append(action);
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
    if (focused)
      [...root.querySelectorAll("[data-round-node]")]
        .find((node) => node.dataset.roundNode === focused)
        ?.focus({ preventScroll: true });
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
      collapsed.clear();
      updateContext(context);
      render();
    },
    refresh: loader.refresh,
    setActive: loader.setActive,
    dispose: loader.dispose,
    builtin: {
      update: updateContext,
      render(node, next) {
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
