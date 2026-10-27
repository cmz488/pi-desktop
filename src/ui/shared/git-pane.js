export function createGitPane({
  root,
  request,
  snapshot,
  confirm,
  reveal,
  esc,
}) {
  const $ = (selector) => root.querySelector(selector);
  let owner,
    data,
    generation = 0,
    loading,
    pending = false,
    expanded,
    diffCache,
    analyzing = false,
    attempted = false,
    historyData,
    historySelection,
    historyLoading = false,
    diagnostics;
  const drafts = new Map();
  const panel = $("#workspace-right");
  const source = () => $("#git-source").value;
  const validOwner = () => owner === snapshot().sessionId;
  const output = (text = "") => {
    $("#git-output").textContent = text;
    $("#git-output").hidden = !text;
    $("#git-manage-output").textContent = text;
    $("#git-manage-output").hidden = !text;
  };
  function reset() {
    generation++;
    data =
      expanded =
      diffCache =
      diagnostics =
      historyData =
      historySelection =
        undefined;
    historyLoading = false;
    $("#git-history-list").replaceChildren();
    $("#git-history-scope").value = "current";
    $("#git-history-detail").textContent = "";
    $("#git-history-detail").hidden = true;
    $("#git-ref").value = "HEAD";
    $("#git-new-name").value = $("#git-tag-message").value = "";
    $("#git-files").innerHTML =
      '<div class="git-review-empty"><strong>尚未读取变更</strong><p>刷新状态后开始审查</p></div>';
    $("#git-branch-select").replaceChildren();
    $("#git-remote-select").replaceChildren();
    $("#git-diagnostics").hidden = true;
    $("#git-status").textContent = "";
    $("#git-card-count").textContent = "";
    $("#git-card-stats").innerHTML =
      '<span class="git-added">+—</span><span class="git-removed">−—</span>';
    output();
  }
  function bulkStagePaths(action) {
    const unstage = action === "unstage";
    const paths = [];
    let skipped = 0;
    const limits = data?.limits;
    const maxPaths = Number.isSafeInteger(limits?.stagePaths)
      ? limits.stagePaths
      : 0;
    const maxBytes = Number.isSafeInteger(limits?.stageBytes)
      ? limits.stageBytes
      : 0;
    let budget = maxBytes;
    for (const file of data?.files ?? []) {
      if (unstage ? !file.staged : !file.unstaged) continue;
      if (paths.length >= maxPaths) {
        skipped++;
        continue;
      }
      // Only selected untracked inputs consume the confirmation byte budget.
      if (!unstage && file.index === "?" && file.size != null) {
        if (file.size > budget) {
          skipped++;
          continue;
        }
        budget -= file.size;
      }
      paths.push(file.path);
    }
    return { paths, skipped };
  }
  function controls() {
    const state = snapshot();
    const supported = state.live && state.gitManagement;
    const readable =
      supported &&
      state.connected &&
      state.projectTrusted === true &&
      validOwner() &&
      !!data &&
      !loading &&
      !historyLoading &&
      !pending;
    const permitted = new Set(data?.permittedActions ?? []);
    const allowed = (action) => permitted.has(action);
    const writable =
      readable && !data.busy && (state.gitWritable ?? state.idle);
    // Bulk staging mirrors the single-file actions; the limits come from the
    // server's read() result and prepare() remains the authority.
    const bulk = {
      "stage-all": { action: "stage", ...bulkStagePaths("stage") },
      "unstage-all": { action: "unstage", ...bulkStagePaths("unstage") },
    };
    const notice = !state.sessionId
      ? "请先连接 Pi"
      : !supported
        ? "当前宿主尚未加载 Git 管理；仅显示现有分支。请等任务结束后确认更新原宿主。"
        : !state.connected
          ? "连接恢复后再操作 Git"
          : state.projectTrusted !== true
            ? "请先在设置中信任项目，再读取 Git；仓库过滤器可能执行程序。"
            : loading
              ? ""
              : !data
                ? "尚未读取到仓库信息，请刷新重试。"
                : data.operations?.length
                  ? "仓库有未完成的合并／变基，请先在终端处理。"
                  : !writable
                    ? "所有会话任务和配置操作结束后才可写入；仍可审查差异。"
                    : "";
    $("#git-notice").textContent = notice;
    $("#git-notice").hidden = !notice;
    $("#git-review-notice").textContent = notice;
    $("#git-review-notice").hidden = !notice;
    // The bulk action follows the reviewed side, so the toolbar stays one row
    // even in a narrow docked panel.
    const stagedView = source() === "staged";
    for (const button of panel.querySelectorAll("[data-git-action]")) {
      const action = button.dataset.gitAction;
      if (bulk[action])
        button.hidden = action !== (stagedView ? "unstage-all" : "stage-all");
      button.disabled =
        action === "refresh"
          ? pending || !!loading
          : action === "analyze"
            ? !readable ||
              !expanded ||
              analyzing ||
              !state.gitAnalysis ||
              !/\.(?:[cm]?[jt]sx?|jsonc?)$/i.test(expanded.path)
            : bulk[action]
              ? !writable ||
                !allowed(bulk[action].action) ||
                !bulk[action].paths.length
              : [
                    "diff",
                    "log",
                    "show",
                    "pick-tag",
                    "history-prev",
                    "history-next",
                  ].includes(action)
                ? !readable ||
                  (action === "show" && !state.gitExtended) ||
                  (action === "history-prev" &&
                    (!historyData || historyData.page <= 1)) ||
                  (action === "history-next" && !historyData?.nextPage)
                : !writable ||
                  (action !== "manage" && !allowed(action)) ||
                  (action === "manage" && !state.gitExtended) ||
                  (action === "commit" &&
                    (!data.files.some((file) => file.staged) ||
                      !$("#git-message").value.trim())) ||
                  (action === "switch" &&
                    (!data.branches.length || data.files.length > 0)) ||
                  (["fetch", "pull", "push"].includes(action) &&
                    (!data.remotes.length ||
                      (action !== "fetch" &&
                        (!data.head || !data.branches.includes(data.branch))) ||
                      (action === "pull" && data.files.length > 0)));
      button.title = button.disabled
        ? notice ||
          (action === "analyze"
            ? "仅 JS/TS 与 JSON；宿主须支持 LSP，分析当前工作树，不分析已暂存快照"
            : "当前没有可执行的文件／分支／远端或提交说明")
        : bulk[action]
          ? `对 ${bulk[action].paths.length} 个文件执行 git ${bulk[action].action}${bulk[action].skipped ? `；另有 ${bulk[action].skipped} 个超出单次额度` : ""}`
          : "";
    }
    $("#git-manage-notice").textContent = state.gitExtended
      ? "目标解析成真实提交 SHA 后确认；不执行任意 shell 或修订表达式。" +
        (notice ? " " + notice : "")
      : "当前宿主尚未加载 merge/checkout/reset/tag 管理；任务结束后确认更新宿主。";
    const selectedAction = $("#git-manage-action").value;
    for (const field of panel.querySelectorAll("[data-git-field]"))
      field.hidden = field.dataset.gitField !== selectedAction;
    $("#git-name-field").hidden = !(
      selectedAction === "tag" ||
      (selectedAction === "checkout" &&
        $("#git-checkout-mode").value === "create")
    );
    $("#git-history-scope").disabled = !state.gitGraph || !readable;
    $("#git-message").disabled = !supported || !validOwner() || pending;
    $("#git-branch-select").disabled = !writable || !data.branches.length;
    $("#git-remote-select").disabled = !writable || !data.remotes.length;
  }
  function showDiagnostics() {
    $("#git-diagnostics").hidden = !expanded;
    if (!expanded) return;
    const state = snapshot();
    $("#git-diagnostics-note").textContent = analyzing
      ? "正在运行本地语言服务器…"
      : !state.gitAnalysis
        ? "当前宿主尚未接入 LSP；不会显示模拟诊断。"
        : !diagnostics
          ? "手动分析当前工作树文件，不自动改写、安装或下载。已暂存 diff 可能与工作树不同。"
          : "本次 LSP 诊断仅针对当前工作树；不是完整审查或编译通过证明。";
    $("#git-diagnostics-list").innerHTML = !diagnostics
      ? ""
      : diagnostics.error
        ? `<p>${esc(diagnostics.error)}</p>`
        : `<p class="muted">${esc(diagnostics.executable)} · ${diagnostics.diagnostics.length} 条诊断${diagnostics.truncated ? "（已截取前 200 条）" : ""}</p>` +
          diagnostics.diagnostics
            .map(
              (item) =>
                `<div class="diagnostic-row"><span class="diagnostic-severity severity-${item.severity}">${{ 1: "错误", 2: "警告", 3: "信息", 4: "提示" }[item.severity]}</span><span class="diagnostic-location">${item.line}:${item.column}${item.code == null ? "" : " · " + esc(item.code)}</span><p>${esc(item.message)}</p></div>`,
            )
            .join("");
  }
  function render() {
    if (!data) {
      controls();
      return;
    }
    const state = snapshot(),
      staged = source() === "staged";
    $("#git-root").textContent = data.root;
    $("#git-branch").textContent = data.branch;
    $("#git-branch").title = data.branch;
    $("#git-status").textContent = data.busy
      ? "Git 操作运行中"
      : data.files.length
        ? ""
        : "工作区干净";
    const oldBranch = $("#git-branch-select").value,
      oldRemote = $("#git-remote-select").value;
    const branch = data.branches.includes(oldBranch) ? oldBranch : data.branch;
    const remote = data.remotes.includes(oldRemote)
      ? oldRemote
      : (data.upstream?.remote ??
        (data.remotes.includes("origin") ? "origin" : data.remotes[0]));
    $("#git-branch-select").innerHTML = data.branches
      .map(
        (name) =>
          `<option ${name === branch ? "selected" : ""} value="${esc(name)}">${esc(name)}</option>`,
      )
      .join("");
    $("#git-remote-select").innerHTML = data.remotes
      .map(
        (name) =>
          `<option ${name === remote ? "selected" : ""} value="${esc(name)}">${esc(name)}</option>`,
      )
      .join("");
    let added = 0,
      removed = 0,
      unknown = 0;
    for (const file of data.files) {
      for (const key of ["staged", "unstaged"]) {
        if (!file[key]) continue;
        const stats = file.stats?.[key];
        if (stats?.added == null || stats?.removed == null) unknown++;
        else {
          added += stats.added;
          removed += stats.removed;
        }
      }
    }
    $("#git-card-count").textContent = data.files.length
      ? String(data.files.length)
      : "";
    $("#git-card-stats").innerHTML =
      `<span class="git-added">+${added}</span><span class="git-removed">−${removed}</span>${unknown ? '<span class="git-unknown">*</span>' : ""}`;
    $("#git-card-stats").title = unknown
      ? "部分二进制／大文件或旧宿主未提供行统计；不是零变更"
      : "已暂存和未暂存行统计（分层计算）";
    const files = data.files.filter(
      (file) => file[staged ? "staged" : "unstaged"],
    );
    if (
      expanded &&
      !files.some(
        (file) => file.path === expanded.path && expanded.staged === staged,
      )
    ) {
      expanded = diagnostics = undefined;
    }
    $("#git-files").innerHTML = files.length
      ? files
          .map((file) => {
            const isOpen =
              expanded?.path === file.path && expanded.staged === staged;
            const stats = file.stats?.[staged ? "staged" : "unstaged"];
            const name = file.path.split("/").pop(),
              directory = file.path.slice(0, -(name.length + 1));
            const kind = /\.(?:tsx?|jsx?|[mc][jt]s)$/i.test(name)
              ? "code"
              : /\.jsonc?$/i.test(name)
                ? "json"
                : /\.(?:md|txt)$/i.test(name)
                  ? "text"
                  : "file";
            return `<article class="git-change-card"><div class="git-file-head"><button class="git-file-name" type="button" data-git-action="diff" data-git-path="${esc(file.path)}" data-git-staged="${staged}" aria-expanded="${isOpen}"><span class="git-file-icon kind-${kind}">${kind === "code" ? "⌘" : kind === "json" ? "{}" : kind === "text" ? "▤" : "◇"}</span><span class="git-file-path"><strong>${esc(name)}</strong>${directory ? `<span class="git-file-directory">${esc(directory)}</span>` : ""}</span><span class="git-file-stats"><span class="git-added">${stats?.added == null ? "+—" : "+" + stats.added}</span><span class="git-removed">${stats?.removed == null ? "−—" : "−" + stats.removed}</span></span><span class="git-chevron">${isOpen ? "⌃" : "⌄"}</span></button><button class="git-file-stage" type="button" data-git-action="${staged ? "unstage" : "stage"}" data-git-path="${esc(file.path)}" title="${staged ? "git restore --staged" : "git add"} -- ${esc(file.path)}" aria-label="${staged ? "取消暂存" : "暂存"} ${esc(file.path)}">${staged ? "−" : "+"}</button></div>${isOpen ? `<div class="git-file-actions"><span>${esc(staged ? "已暂存差异" : "工作树差异")}</span></div><pre class="git-file-diff" tabindex="0" aria-label="${esc(file.path)} 差异"></pre>` : ""}</article>`;
          })
          .join("")
      : `<div class="git-review-empty"><strong>${staged ? "没有已暂存变更" : "没有未暂存变更"}</strong><p>${staged ? "从未暂存审查中选择文件暂存" : "工作树与索引一致"}</p></div>`;
    const diff = $("#git-files .git-file-diff");
    if (diff)
      diff.textContent =
        diffCache?.path === expanded.path &&
        diffCache.staged === expanded.staged &&
        diffCache.revision === data.revision
          ? diffCache.output
          : "正在读取差异…";
    $("#git-tag-list").innerHTML =
      (data.tags ?? [])
        .map(
          (name) =>
            `<button type="button" class="text-button" data-git-action="pick-tag" data-git-tag="${esc(name)}">${esc(name)}</button>`,
        )
        .join("") ||
      '<p class="muted">没有本地 tag（旧宿主可能未提供列表）</p>';
    $("#git-commit-summary").textContent =
      `仅包含 ${data.files.filter((file) => file.staged).length} 个已暂存文件；未暂存文件不会自动加入。`;
    showDiagnostics();
    controls();
  }
  async function read(action = "status", path, staged = false, extra = {}) {
    const target = owner,
      serial = ++generation;
    const query = new URLSearchParams({
      sessionId: target,
      action,
      staged: String(staged),
      ...extra,
    });
    if (path) query.set("path", path);
    const result = await request("/api/git?" + query);
    if (target !== owner || !validOwner() || serial !== generation)
      throw new Error("Git 读取已过期，请刷新重试");
    return result;
  }
  async function refresh() {
    const state = snapshot();
    if (
      !state.live ||
      !state.gitManagement ||
      !state.connected ||
      state.projectTrusted !== true
    ) {
      controls();
      return;
    }
    if (loading) return loading;
    const target = owner;
    const operation = (async () => {
      try {
        const result = await read();
        if (target !== owner || !validOwner()) return;
        if (data && data.root !== result.root) {
          $("#git-branch-select").replaceChildren();
          $("#git-remote-select").replaceChildren();
        }
        if (data && data.revision !== result.revision)
          expanded = diagnostics = undefined;
        if (diffCache?.revision !== result.revision) diffCache = undefined;
        data = result;
        render();
      } catch (error) {
        if (target === owner && validOwner()) {
          $("#git-status").textContent = error.message;
          if (error.message.includes("16 MiB") && !state.gitReview)
            $("#git-status").textContent +=
              " · 旧宿主读取规则尚未更新；任务结束后确认更新宿主。";
        }
      } finally {
        if (loading === operation) loading = undefined;
        controls();
      }
    })();
    loading = operation;
    controls();
    return operation;
  }
  async function toggle(path, staged) {
    output();
    if (expanded?.path === path && expanded.staged === staged) {
      expanded = diagnostics = undefined;
      render();
      return;
    }
    const selection = { path, staged },
      target = owner;
    expanded = selection;
    diagnostics = undefined;
    render();
    if (
      diffCache?.path === path &&
      diffCache.staged === staged &&
      diffCache.revision === data.revision
    )
      return;
    try {
      const result = await read("diff", path, staged);
      if (selection !== expanded || target !== owner) return;
      diffCache = {
        path,
        staged,
        revision: result.revision,
        output: result.output,
      };
      data = result;
      render();
    } catch (error) {
      if (selection === expanded && target === owner) {
        const node = $("#git-files .git-file-diff");
        if (node) node.textContent = error.message;
      }
    }
  }
  async function mutation(input, note = "") {
    if (pending) throw new Error("Git 操作正在运行");
    const target = owner;
    if (!validOwner()) throw new Error("当前会话已变化，请重新预览");
    const plan = await request("/api/git", input);
    if (target !== owner || !validOwner())
      throw new Error("当前会话已变化，请重新预览");
    confirm(
      plan,
      async () => {
        if (target !== owner || !validOwner())
          throw new Error("当前会话已变化，请重新预览");
        pending = true;
        controls();
        $("#git-status").textContent = "Git 操作执行中…";
        try {
          const result = await request("/api/git", { token: plan.token });
          if (target !== owner || !validOwner()) return;
          await refresh();
          output(result.output || "Git 操作已完成");
          if (result.conflict) $("#git-status").textContent = result.output;
        } finally {
          pending = false;
          controls();
        }
      },
      note,
    );
  }
  async function analyze() {
    if (!expanded || analyzing || !snapshot().gitAnalysis) return;
    const selection = expanded,
      target = owner;
    analyzing = true;
    diagnostics = undefined;
    showDiagnostics();
    controls();
    try {
      const result = await request("/api/git-analysis", {
        path: selection.path,
      });
      if (target === owner && selection === expanded && validOwner())
        diagnostics = result;
    } catch (error) {
      if (target === owner && selection === expanded)
        diagnostics = { error: error.message };
    } finally {
      analyzing = false;
      showDiagnostics();
      controls();
    }
  }
  function historyMarkup(result) {
    const graph = result.graph;
    $("#git-history-list").style.setProperty(
      "--git-graph-width",
      (graph?.width ?? 24) + "px",
    );
    return result.commits
      .map((commit, index) => {
        const row = graph?.rows[index];
        const drawing = row
          ? `<svg class="git-graph" aria-hidden="true" viewBox="0 0 ${graph.width} ${graph.height}" width="${graph.width}" height="${graph.height}">${row.edges.map((edge) => `<path class="graph-color-${edge.color}" data-edge="${edge.kind}" d="${esc(edge.path)}"/>`).join("")}<circle class="graph-node graph-color-${row.node.color}" data-kind="${row.kind}" cx="${row.node.x}" cy="${row.node.y}" r="${row.kind === "commit" ? 3 : 5}"/>${row.kind === "merge" ? `<circle class="graph-merge-dot graph-color-${row.node.color}" cx="${row.node.x}" cy="${row.node.y}" r="2"/>` : ""}</svg>`
          : "";
        const refs = commit.references ?? [];
        const title = [
          commit.subject,
          commit.id,
          commit.author,
          commit.date,
          ...refs.map((ref) => ref.id),
        ]
          .filter(Boolean)
          .join(" · ");
        return `<button type="button" class="git-history-row ${row ? "git-graph-row" : ""}" data-git-action="show" data-git-ref="${esc(commit.id)}" title="${esc(title)}" aria-label="${esc(title)}${row?.kind === "head" ? " · 当前 HEAD" : ""}${commit.parentIds?.length > 1 ? " · 合并提交" : ""}">${drawing}<span class="git-history-subject">${esc(commit.subject)}</span><span class="git-history-author">${esc(commit.author || commit.shortId)}</span><span class="git-history-refs">${refs
          .slice(0, 3)
          .map(
            (ref) =>
              `<span class="git-ref git-ref-${esc(ref.type)}" title="${esc(ref.id)}">${ref.current ? "◎ " : ref.type === "tag" ? "◇ " : ref.type === "remote" ? "↗ " : "⑂ "}${esc(ref.name)}</span>`,
          )
          .join(
            "",
          )}${refs.length > 3 ? `<span class="git-ref">+${refs.length - 3}</span>` : ""}</span></button>`;
      })
      .join("");
  }
  async function showHistory(page = 1) {
    const target = owner;
    reveal("history");
    const operation = {};
    historyLoading = operation;
    historySelection = undefined;
    controls();
    $("#git-history-list").textContent = "正在读取历史…";
    $("#git-history-detail").hidden = true;
    try {
      const result = await read("log", undefined, false, {
        page: String(page),
        ...(snapshot().gitGraph
          ? { scope: $("#git-history-scope").value }
          : {}),
      });
      if (target !== owner || !validOwner()) return;
      historyData = { page: result.page ?? 1, nextPage: result.nextPage };
      data = result;
      render();
      $("#git-history-list").innerHTML = Array.isArray(result.commits)
        ? result.commits.length
          ? historyMarkup(result)
          : '<p class="muted">尚无提交</p>'
        : `<pre>${esc(result.output || "旧宿主未返回历史")}</pre>`;
      $("#git-history-page").textContent = "第 " + historyData.page + " 页";
    } catch (error) {
      if (target === owner && historyLoading === operation)
        $("#git-history-list").textContent = error.message;
    } finally {
      if (historyLoading === operation) historyLoading = false;
      controls();
    }
  }
  async function showCommit(ref) {
    const target = owner,
      selection = { ref };
    historySelection = selection;
    reveal("history");
    if (!snapshot().gitExtended)
      throw new Error("当前宿主尚未加载提交详情，请在任务结束后更新");
    for (const row of panel.querySelectorAll(".git-history-row")) {
      const selected = row.dataset.gitRef === ref;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-pressed", String(selected));
    }
    $("#git-history-detail").hidden = false;
    $("#git-history-detail").textContent = "正在读取提交…";
    try {
      const result = await read("show", undefined, false, { ref });
      if (target !== owner || !validOwner() || selection !== historySelection)
        return;
      $("#git-history-detail").textContent = result.output;
      $("#git-history-detail").scrollIntoView({ block: "nearest" });
    } catch (error) {
      if (target === owner && selection === historySelection)
        $("#git-history-detail").textContent = error.message;
    }
  }
  function managementInput() {
    const action = $("#git-manage-action").value,
      ref = $("#git-ref").value.trim();
    if (action === "checkout")
      return {
        action,
        mode: $("#git-checkout-mode").value,
        ref,
        branch:
          $("#git-checkout-mode").value === "create"
            ? $("#git-new-name").value.trim()
            : undefined,
      };
    if (action === "reset")
      return { action, mode: $("#git-reset-mode").value, ref };
    if (action === "tag")
      return {
        action,
        operation: $("#git-tag-operation").value,
        name: $("#git-new-name").value.trim(),
        ref,
        message: $("#git-tag-message").value,
      };
    return { action, ref };
  }
  async function open(args = "", mode = "review") {
    const target = owner;
    reveal(mode);
    await refresh();
    if (target !== owner || !data || !validOwner()) return;
    const { parseGitCommand, gitActions, gitExtendedActions, gitHelp } =
      await import("./git-command.mjs");
    if (target !== owner || !validOwner()) return;
    const input = parseGitCommand(args);
    if (
      (gitExtendedActions.includes(input.action) ||
        ["show", "tags"].includes(input.action)) &&
      !snapshot().gitExtended
    )
      throw new Error("当前宿主尚未加载扩展 Git 管理；任务结束后确认更新宿主");
    if (input.action === "log") {
      await showHistory(input.page);
      return;
    }
    if (input.action === "show") {
      await showCommit(input.ref);
      return;
    }
    if (input.action === "tags") {
      reveal("manage");
      const result = await read("tags");
      $("#git-manage-notice").textContent =
        result.output || "当前宿主未提供 tag 列表；任务结束后确认更新宿主";
      return;
    }
    if (input.action === "help") output(gitHelp);
    else if (gitActions.includes(input.action)) await mutation(input);
    else if (input.action === "diff" && input.path) {
      $("#git-source").value = input.staged ? "staged" : "unstaged";
      await toggle(input.path, Boolean(input.staged));
    } else if (input.action === "branches") {
      output(data.branches.join("\n") || "没有本地分支");
    } else if (["log", "diff"].includes(input.action)) {
      const result = await read(input.action, undefined, Boolean(input.staged));
      if (data && data.revision !== result.revision)
        expanded = diagnostics = diffCache = undefined;
      data = result;
      render();
      output(result.output);
    }
  }
  function update() {
    const state = snapshot();
    if (state.sessionId !== owner) {
      if (owner) drafts.set(owner, $("#git-message").value);
      owner = state.sessionId;
      loading = undefined;
      attempted = false;
      reset();
      $("#git-message").value = drafts.get(owner) ?? "";
    }
    if (!state.gitManagement) {
      attempted = false;
      if (data) reset();
    }
    if (!data) {
      $("#git-branch").textContent = state.git?.branch ?? "分支 —";
      $("#git-branch").title = state.git?.branch ?? "";
    }
    controls();
    if (
      owner &&
      !data &&
      !loading &&
      !attempted &&
      state.live &&
      state.gitManagement &&
      state.connected &&
      state.projectTrusted === true
    ) {
      attempted = true;
      void refresh();
    }
  }
  $("#git-source").addEventListener("change", () => {
    expanded = diagnostics = undefined;
    render();
  });
  $("#git-message").addEventListener("input", controls);
  $("#git-history-scope").addEventListener("change", () => void showHistory());
  for (const id of [
    "git-manage-action",
    "git-checkout-mode",
    "git-tag-operation",
  ])
    $("#" + id).addEventListener("change", controls);
  panel.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-git-action]");
    if (!button || button.disabled) return;
    try {
      const action = button.dataset.gitAction;
      if (action === "refresh") {
        expanded = diagnostics = diffCache = undefined;
        await refresh();
        return;
      }
      if (!validOwner()) throw new Error("当前会话已变化，请刷新");
      if (action === "diff") {
        await toggle(
          button.dataset.gitPath,
          button.dataset.gitStaged === "true",
        );
        return;
      }
      if (action === "analyze") {
        await analyze();
        return;
      }
      if (action === "stage-all" || action === "unstage-all") {
        const unstage = action === "unstage-all";
        const { paths, skipped } = bulkStagePaths(
          unstage ? "unstage" : "stage",
        );
        if (!paths.length) return;
        await mutation(
          { action: unstage ? "unstage" : "stage", paths },
          skipped
            ? `另有 ${skipped} 个文件未包含：一次最多 ${data?.limits?.stagePaths ?? 0} 个，且所选未跟踪文件须在 ${Math.round((data?.limits?.stageBytes ?? 0) / 1024 / 1024)} MiB 内；可分批暂存。`
            : "",
        );
        return;
      }
      const menu = button.closest("details");
      if (menu) menu.open = false;
      if (action === "log") {
        await showHistory();
        return;
      }
      if (action === "show") {
        await showCommit(button.dataset.gitRef);
        return;
      }
      if (action === "history-prev" || action === "history-next") {
        await showHistory(
          action === "history-prev"
            ? historyData.page - 1
            : historyData.nextPage,
        );
        return;
      }
      if (action === "pick-tag") {
        $("#git-new-name").value = button.dataset.gitTag;
        $("#git-ref").value = button.dataset.gitTag;
        return;
      }
      if (action === "manage") {
        await mutation(managementInput());
        return;
      }
      await mutation({
        action,
        paths: button.dataset.gitPath ? [button.dataset.gitPath] : undefined,
        message: $("#git-message").value,
        branch: $("#git-branch-select").value,
        remote: $("#git-remote-select").value || undefined,
      });
    } catch (error) {
      $("#git-status").textContent = error.message;
    }
  });
  return { update, open, history: showHistory };
}
