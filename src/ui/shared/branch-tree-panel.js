import { createSessionPanelLoader } from "./session-panel-loader.js";

/**
 * 分支树面板：展示 Host 读模型，动作复用会话命令，不推导或拥有历史。
 *
 * 接口：`createBranchTreePanel` 的 builtin.update/render 接收工作台上下文；
 *   setSession 指定目标，refresh、setActive／dispose 管理读取；见
 *   docs/architecture/interfaces/read-panels.md。
 * 不变量：拥有者与显示目标共同决定请求身份，晚到结果不能覆盖新身份；
 *   同一目标补刷保留折叠和滚动，命令捕获不可变目标，只读不提供管理。
 * 错误：当前读取失败显示，当前命令失败提示；unsupported 隐藏入口，过期结果不导航。
 */

const ROLE_LABELS = {
  user: "用户消息",
  assistant: "助手回复",
  toolResult: "工具结果",
  custom: "扩展消息",
};
const KIND_LABELS = {
  message: "消息",
  compaction: "压缩",
  session_info: "会话信息",
  model_change: "模型切换",
  thinking_level_change: "思考等级",
  label: "标记",
  custom: "扩展条目",
};

export function createBranchTreePanel({
  fetchTree,
  command,
  toast,
  switchSession,
}) {
  let owner = "";
  let target = "";
  let container;
  let repaint;
  const collapsed = new Set();
  let context = {};
  const loader = createSessionPanelLoader({
    read: fetchTree,
    onChange: render,
  });
  function updateContext(next) {
    const previousOwner = owner;
    context = next;
    owner = String(next.sessionId ?? "");
    if (owner !== previousOwner) collapsed.clear();
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

  const nodeLabel = (node) => {
    if (node.customType === "pi-desktop-rewind")
      return `退回标记 → 条目 ${node.rewindTo ?? "?"}`;
    if (node.role) return ROLE_LABELS[node.role] ?? node.role;
    return KIND_LABELS[node.type] ?? node.type;
  };

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function render() {
    // 工作台可能在刷新时重建内容节点；容器已脱离文档时请它重画，而不是写进旧节点。
    if (!container?.isConnected || !loader.available) {
      if (container) repaint?.();
      return;
    }
    const { data, error, loading } = loader;
    const sessionId = loader.context.sessionId;
    const identity = loader.capture();
    const root = element("div", "branch-tree");
    root.dataset.branchTree = sessionId;
    const header = element("header", "branch-tree-header");
    header.append(
      element("strong", "", data?.name ?? "分支树"),
      element(
        "small",
        "",
        data?.native
          ? `${data.native.nodes.length} 个条目 · ${data.branches?.length ?? 0} 个分支`
          : data
            ? `${data.branches?.length ?? 0} 个分支 · 无原生会话记录`
            : loading
              ? "读取中…"
              : "",
      ),
    );
    const refresh = element("button", "outline-button", "刷新");
    refresh.type = "button";
    refresh.dataset.branchRefresh = "true";
    refresh.onclick = () => void loader.refresh({ force: true });
    header.append(refresh);
    root.append(header);
    // 从会话栏的「打开分支树」进来时可能看的是另一个会话；显式标出并提供跟随当前会话的出口。
    if (target && owner && target !== owner) {
      const note = element("div", "branch-tree-target");
      note.append(element("small", "", `正在显示会话 ${data?.name ?? target}`));
      const follow = element("button", "outline-button", "跟随当前会话");
      follow.type = "button";
      follow.dataset.branchFollow = "true";
      follow.onclick = () => {
        if (!follow.isConnected || !loader.isCurrent(identity)) return;
        target = "";
        collapsed.clear();
        updateContext(context);
        render();
        void loader.refresh({ force: true });
      };
      note.append(follow);
      root.append(note);
    }
    if (error) root.append(element("p", "branch-tree-note", error));
    if (data && !data.native)
      root.append(
        element(
          "p",
          "branch-tree-note",
          loader.canManage
            ? "该会话没有绑定原生 Pi 记录：创建分支仍可用，退回需要原生记录。"
            : "该会话没有绑定原生 Pi 记录，当前仅可查看分支信息。",
        ),
      );

    const nodes = data?.native?.nodes ?? [];
    if (nodes.length) {
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const parentOf = (node) =>
        node.parentId ? byId.get(node.parentId) : undefined;
      const hidden = (node) => {
        for (let up = parentOf(node); up; up = parentOf(up))
          if (collapsed.has(up.id)) return true;
        return false;
      };
      const depth = (node) => {
        let value = 0;
        for (let up = parentOf(node); up; up = parentOf(up)) value++;
        return value;
      };
      const list = element("div", "branch-tree-list");
      for (const node of nodes) {
        if (hidden(node)) continue;
        const row = element(
          "div",
          `branch-tree-row${node.active ? " is-active" : " is-abandoned"}${node.leaf ? " is-leaf" : ""}${node.branchPoint ? " is-branch-point" : ""}`,
        );
        row.dataset.nodeId = node.id;
        row.dataset.active = String(!!node.active);
        row.dataset.leaf = String(!!node.leaf);
        row.style.setProperty("--branch-depth", String(depth(node)));
        const toggle = element(
          "button",
          "branch-tree-toggle",
          node.children ? (collapsed.has(node.id) ? "▸" : "▾") : "·",
        );
        toggle.type = "button";
        toggle.dataset.toggleNode = node.id;
        toggle.setAttribute("aria-expanded", String(!collapsed.has(node.id)));
        toggle.setAttribute(
          "aria-label",
          collapsed.has(node.id) ? "展开子条目" : "折叠子条目",
        );
        toggle.disabled = !node.children;
        toggle.onclick = () => {
          if (!toggle.isConnected || !loader.isCurrent(identity)) return;
          if (collapsed.has(node.id)) collapsed.delete(node.id);
          else collapsed.add(node.id);
          render();
        };
        row.append(
          toggle,
          element(
            "span",
            "branch-tree-marker",
            node.leaf ? "●" : node.active ? "○" : "·",
          ),
          element("span", "branch-tree-label", nodeLabel(node)),
        );
        if (node.preview) row.append(element("small", "", node.preview));
        const badges = element("span", "branch-tree-badges");
        if (node.leaf) badges.append(element("span", "tag", "当前位置"));
        if (node.branchPoint) badges.append(element("span", "tag", "分支点"));
        if (!node.active) badges.append(element("span", "tag", "已放弃"));
        if (node.rewindTo !== null && node.rewindTo !== undefined)
          badges.append(element("span", "tag", "退回点"));
        row.append(badges);
        const actions = element("span", "branch-tree-actions");
        if (typeof node.entryId === "number") {
          const fork = element("button", "outline-button", "创建分支");
          fork.type = "button";
          fork.dataset.branchAction = "fork";
          fork.dataset.entryId = String(node.entryId);
          fork.disabled = !loader.canManage;
          if (fork.disabled)
            fork.title = "当前会话只提供分支树查看，不提供管理操作";
          fork.onclick = () => {
            if (fork.isConnected) void act("fork", node.entryId, identity);
          };
          const rewind = element("button", "outline-button", "退回");
          rewind.type = "button";
          rewind.dataset.branchAction = "rewind";
          rewind.dataset.entryId = String(node.entryId);
          rewind.disabled = !loader.canManage;
          if (rewind.disabled)
            rewind.title = "当前会话只提供分支树查看，不提供管理操作";
          rewind.onclick = () => {
            if (rewind.isConnected) void act("rewind", node.entryId, identity);
          };
          actions.append(fork, rewind);
        } else {
          actions.append(
            element("small", "branch-tree-note", "该条目尚未写入会话存储"),
          );
        }
        row.append(actions);
        list.append(row);
      }
      root.append(list);
    } else if (data?.native) {
      root.append(element("p", "branch-tree-note", "还没有可显示的条目。"));
    }

    if (data?.branches?.length) {
      const branches = element("section", "branch-tree-branches");
      branches.append(element("strong", "", "分支会话"));
      for (const branch of data.branches) {
        const row = element(
          "button",
          `branch-tree-branch${branch.id === sessionId ? " active" : ""}`,
        );
        row.type = "button";
        row.dataset.branchSession = branch.id;
        row.append(
          element("span", "", branch.name),
          element(
            "small",
            "",
            `${branch.idle ? "空闲" : "运行中"} · 来自条目 ${branch.forkOf?.entryId ?? "?"}`,
          ),
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
  }

  async function act(kind, entryId, identity) {
    if (!loader.isCurrent(identity) || !loader.canManage) return;
    const input = Object.freeze({
      id: Number(identity.sessionId),
      entryId,
      sessionId: identity.sessionId,
    });
    try {
      const result = await command(kind, input);
      if (!loader.isCurrent(identity)) return;
      toast(kind === "fork" ? "已从该条目创建分支" : "已退回到该条目");
      if (kind === "fork" && result?.sessionId)
        await switchSession(result.sessionId);
      else await loader.refresh({ force: true });
    } catch (failure) {
      if (loader.isCurrent(identity)) toast(failure.message);
    }
  }

  return {
    key: "desktop:branch-tree",
    view: { label: "Desktop", title: "分支树", status: "" },
    get available() {
      return loader.available;
    },
    /* 显示别的会话时不能混用页面当前会话的命令目标。 */
    setSession(id) {
      const next = String(id ?? "");
      if (next === target) return;
      target = next;
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
