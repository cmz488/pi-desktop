/* 内置「分支树」页：把 Host 的只读读模型（`GET /api/tree`）画成树。
 * 数据只读；创建分支与退回仍走 `POST /api/command`，与消息菜单、会话栏共用同一条命令路径。
 * 展开/折叠属于视图状态，保存在本模块里，因此工作台重绘或状态刷新都不会丢掉它。 */

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
  let data;
  let error = "";
  let loading = false;
  let lastLoaded = 0;
  let container;
  let repaint;
  let retry;
  const collapsed = new Set();
  const session = () => target || owner;

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
    if (!container?.isConnected) {
      repaint?.();
      return;
    }
    const sessionId = session();
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
    refresh.onclick = () => void load({ force: true });
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
        target = "";
        collapsed.clear();
        data = undefined;
        render();
        void load({ force: true });
      };
      note.append(follow);
      root.append(note);
    }
    if (error) root.append(element("p", "branch-tree-note", error));
    if (data?.supported === false)
      root.append(
        element("p", "branch-tree-note", "当前宿主不提供分支树读模型。"),
      );
    else if (data && !data.native)
      root.append(
        element(
          "p",
          "branch-tree-note",
          "该会话没有绑定原生 Pi 记录：创建分支仍可用，退回需要原生记录。",
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
          fork.onclick = () => void act("fork", node);
          const rewind = element("button", "outline-button", "退回");
          rewind.type = "button";
          rewind.dataset.branchAction = "rewind";
          rewind.dataset.entryId = String(node.entryId);
          rewind.onclick = () => void act("rewind", node);
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
        row.onclick = () => void switchSession(branch.id);
        branches.append(row);
      }
      root.append(branches);
    }
    container.replaceChildren(root);
  }

  async function act(kind, node) {
    const sessionId = session();
    try {
      if (kind === "fork") {
        const result = await command("fork", {
          id: Number(sessionId),
          entryId: node.entryId,
          sessionId,
        });
        toast("已从该条目创建分支");
        if (result?.sessionId) await switchSession(result.sessionId);
        else await load({ force: true });
      } else {
        await command("rewind", {
          id: Number(sessionId),
          entryId: node.entryId,
          sessionId,
        });
        toast("已退回到该条目");
        await load({ force: true });
      }
    } catch (failure) {
      toast(failure.message);
    }
  }

  async function load({ force = false } = {}) {
    const sessionId = session();
    if (!sessionId || loading) return;
    // 状态刷新会频繁触发：节流读取，避免把只读面板变成轮询器；被节流时稍后补一次，
    // 否则面板可能一直停在空态（只有节流触发过、没有后续刷新）。
    if (!force && Date.now() - lastLoaded < 1500) {
      clearTimeout(retry);
      retry = setTimeout(() => void load({ force: true }), 1600);
      return;
    }
    loading = true;
    lastLoaded = Date.now();
    try {
      data = await fetchTree(sessionId);
      error = "";
    } catch (failure) {
      error = failure.message;
    } finally {
      loading = false;
      render();
    }
  }

  return {
    key: "desktop:branch-tree",
    view: { label: "Desktop", title: "分支树", status: "" },
    /* 会话栏可以指定要看哪个会话；不带参数时跟随当前会话。 */
    setSession(id) {
      const next = String(id ?? "");
      if (next === target) return;
      target = next;
      collapsed.clear();
      data = undefined;
      render();
    },
    refresh() {
      return load();
    },
    builtin: {
      render(node, { sessionId: current, rerender }) {
        container = node;
        repaint = rerender;
        owner = String(current ?? owner ?? "");
        render();
        void load();
      },
    },
  };
}
