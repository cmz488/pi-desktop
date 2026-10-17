/**
 * Desktop presentation seam for Pi extensions.
 *
 * Pi still owns extension loading and execution. Adapters only project
 * serializable messages into a bounded view model and render that model in
 * the conversation. Every registration is reversible, and session changes
 * are explicit so an adapter can release any session-scoped state.
 */
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

const asRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;

const goalStatuses = {
  active: "进行中",
  paused: "已暂停",
  complete: "已完成",
  budget_limited: "预算已用尽",
  aborted: "已取消",
  blocked: "受阻",
};
const taskStatuses = {
  pending: "待办",
  in_progress: "进行中",
  complete: "已完成",
  skipped: "已跳过",
};

function goalTasks(tasks, depth = 0, output = []) {
  if (!Array.isArray(tasks) || depth > 4 || output.length >= 40) return output;
  for (const task of tasks) {
    if (!asRecord(task)) continue;
    output.push({
      id: typeof task.id === "string" ? task.id.slice(0, 40) : "",
      title: String(task.title ?? "").slice(0, 240),
      status: taskStatuses[task.status] ?? "未知",
      depth,
    });
    goalTasks(task.subtasks, depth + 1, output);
    if (output.length >= 40) break;
  }
  return output;
}

function countGoalTasks(tasks, depth = 0, counts = { done: 0, total: 0 }) {
  if (!Array.isArray(tasks) || depth > 4 || counts.total >= 10000)
    return counts;
  for (const task of tasks) {
    if (!asRecord(task)) continue;
    counts.total++;
    if (["complete", "skipped"].includes(task.status)) counts.done++;
    countGoalTasks(task.subtasks, depth + 1, counts);
    if (counts.total >= 10000) break;
  }
  return counts;
}

function goalView(message) {
  const details = asRecord(message.details);
  if (
    message.role !== "toolResult" ||
    ![
      "create_goal",
      "get_goal",
      "update_goal",
      "set_goal_tasks",
      "update_goal_task",
    ].includes(message.toolName) ||
    details?.version !== 3 ||
    !Object.hasOwn(details, "goal") ||
    (details.goal !== null && !asRecord(details.goal))
  )
    return null;
  const goal = asRecord(details?.goal);
  if (!goal)
    return {
      adapterId: "pi-goal-x",
      version: 1,
      label: "目标进度",
      kind: "goal",
      title: "当前没有活动目标",
      status: "无活动目标",
      mode: "目标",
      done: 0,
      total: 0,
      progress: null,
      elapsedSeconds: null,
      tokens: null,
      tasks: [],
    };
  const taskList = asRecord(goal.taskList);
  const tasks = goalTasks(taskList?.tasks);
  const { done, total } = countGoalTasks(taskList?.tasks);
  const status = goalStatuses[goal.status] ?? "目标状态";
  const usage = asRecord(goal.usage);
  return {
    adapterId: "pi-goal-x",
    version: 1,
    label: "目标进度",
    kind: "goal",
    title: String(goal.objective ?? "目标").slice(0, 600),
    status,
    mode: goal.sisyphus ? "有序目标" : "目标",
    done,
    total,
    progress: total ? Math.round((done / total) * 100) : null,
    elapsedSeconds: Number.isFinite(usage?.activeSeconds)
      ? Math.max(0, Math.floor(usage.activeSeconds))
      : null,
    tokens: Number.isFinite(usage?.tokensUsed)
      ? Math.max(0, Math.floor(usage.tokensUsed))
      : null,
    tasks,
  };
}

function goalEventView(message) {
  const details = asRecord(message.details);
  if (message.customType !== "pi-goal-event" || !details) return null;
  const status =
    goalStatuses[details.currentStatus ?? details.status] ?? "状态已更新";
  return {
    adapterId: "pi-goal-x",
    version: 1,
    label: "目标",
    kind: "event",
    title: String(details.objective ?? message.content ?? "目标状态更新").slice(
      0,
      600,
    ),
    status,
    focus: details.focus === "sisyphus" ? "有序目标" : "目标",
  };
}

function goalAuditView(message) {
  const details = asRecord(message.details);
  if (message.customType !== "pi-goal-audit-event" || !details) return null;
  const phases = {
    started: ["验收中", "running"],
    approved: ["验收通过", "success"],
    rejected: ["需要完善", "warning"],
    skipped: ["已跳过", "muted"],
  };
  const [status, tone] = phases[details.phase] ?? ["验收结果", "muted"];
  return {
    adapterId: "pi-goal-x",
    version: 1,
    label: "目标验收",
    kind: "audit",
    title: String(message.content ?? `目标验收：${status}`).slice(0, 1200),
    status,
    tone,
  };
}

/**
 * @typedef {object} ExtensionCard
 * @property {string} title
 * @property {string} [label]
 * @property {string} [status]
 * @property {string} [body] Plain text, never HTML.
 * @property {{label: string, status?: string, detail?: string, depth?: number}[]} [items]
 * @property {{value: number, total: number}} [progress]
 * @property {string[]} [metrics]
 * @property {"neutral"|"muted"|"running"|"success"|"warning"} [tone]
 * @property {string} [detailsLabel] Fold the body and items when supplied.
 * @property {{mode: "state", key: string}|{mode: "message"}} [presentation]
 */

// Both built-in adapters emit this bounded schema. No plugin-specific fields
// escape into the conversation layout or its renderer.
const text = (value, limit) => String(value ?? "").slice(0, limit);
const tones = new Set(["neutral", "muted", "running", "success", "warning"]);
function presentation(value) {
  return value?.mode === "state" &&
    typeof value.key === "string" &&
    value.key.trim()
    ? { mode: "state", key: value.key.slice(0, 160) }
    : { mode: "message" };
}
function normalizeCard(card) {
  if (!asRecord(card) || typeof card.title !== "string") return null;
  const items = Array.isArray(card.items)
    ? card.items.slice(0, 40).flatMap((item) =>
        asRecord(item) && typeof item.label === "string"
          ? [
              {
                label: text(item.label, 240),
                status: text(item.status, 40),
                detail: text(item.detail, 500),
                depth: Number.isInteger(item.depth)
                  ? Math.max(0, Math.min(4, item.depth))
                  : 0,
              },
            ]
          : [],
      )
    : [];
  const total = card.progress?.total;
  const value = card.progress?.value;
  const progress =
    Number.isFinite(total) && total > 0 && Number.isFinite(value)
      ? { value: Math.max(0, Math.min(total, value)), total }
      : null;
  return {
    kind: "card",
    label: text(card.label ?? "扩展", 48),
    title: text(card.title, 1200),
    status: text(card.status, 48),
    body: text(card.body, 1200),
    items,
    progress,
    metrics: Array.isArray(card.metrics)
      ? card.metrics.slice(0, 8).map((value) => text(value, 80))
      : [],
    tone: tones.has(card.tone) ? card.tone : "neutral",
    presentation: presentation(card.presentation),
    detailsLabel: text(card.detailsLabel, 48),
    itemCount: Number.isInteger(card.itemCount)
      ? Math.max(items.length, Math.min(10000, card.itemCount))
      : items.length,
  };
}

function goalAdapterView(message) {
  if (
    message.role === "custom" &&
    message.customType === "pi-goal-draft" &&
    message.details?.version === 1 &&
    !message.details.clearedAt
  )
    return {
      adapterId: "pi-goal-x",
      version: 1,
      kind: "card",
      label: "目标",
      title: String(message.details.seed || "正在与你确认目标和计划"),
      status: "起草中",
      presentation: { mode: "state", key: "current" },
    };
  if (
    message.role === "custom" &&
    message.customType === "pi-widget" &&
    message.details?.key === "goal" &&
    Array.isArray(message.details.lines)
  )
    return {
      adapterId: "pi-goal-x",
      version: 1,
      kind: "card",
      label: "目标",
      title: String(message.details.lines[0] ?? "目标概览"),
      body: message.details.lines.slice(1).join("\n"),
      detailsLabel: "查看目标详情",
      presentation: { mode: "state", key: "current" },
    };
  return goalView(message) ?? goalAuditView(message) ?? goalEventView(message);
}

// Also accepts the previous Goal view carried by an already-running Host.
function normalizeGoalCard(view) {
  if (view.kind === "card") return normalizeCard(view);
  if (view.kind !== "goal")
    return normalizeCard({
      label: view.focus ?? view.label,
      title: view.title,
      status: view.status,
      tone: view.tone,
    });
  const metrics = [];
  if (Number.isFinite(view.elapsedSeconds))
    metrics.push(`${Math.floor(view.elapsedSeconds / 60)} 分钟`);
  if (Number.isFinite(view.tokens))
    metrics.push(`${view.tokens.toLocaleString("en-US")} tokens`);
  return normalizeCard({
    label: view.mode,
    title: view.title,
    status: view.status,
    progress: { value: view.done, total: view.total },
    metrics,
    items: (view.tasks ?? []).map((task) => ({
      label: task.title || task.id,
      status: task.status,
      depth: task.depth,
    })),
    itemCount: view.total,
    detailsLabel: "查看任务",
    presentation: { mode: "state", key: "current" },
  });
}

/** Extensions can emit details.piDesktop v1 without registering UI code. */
function genericCardView(message) {
  const card = asRecord(asRecord(message.details)?.piDesktop);
  return card?.version === 1 ? normalizeCard(card) : null;
}

function renderCard(view, { disclosures } = {}) {
  const progress = view.progress;
  const percent = progress
    ? Math.round((progress.value / progress.total) * 100)
    : 0;
  const items = view.items
    .map(
      (item) =>
        `<li style="--task-depth:${item.depth}"><span>${escapeHtml(item.status)}</span><strong>${escapeHtml(item.label)}</strong>${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ""}</li>`,
    )
    .join("");
  const content = `${view.body ? `<p>${escapeHtml(view.body)}</p>` : ""}${items ? `<ul>${items}</ul>` : ""}`;
  const lazy = view.lazyMessageId
    ? `data-lazy-messages="${escapeHtml(JSON.stringify([view.lazyMessageId]))}"`
    : "";
  const disclosure = view.disclosureKey
    ? `data-disclosure="${escapeHtml(view.disclosureKey)}"`
    : "";
  const expanded = disclosures?.get(view.disclosureKey) ? "open" : "";
  const details =
    view.detailsLabel && (content || view.lazyMessageId || view.itemCount)
      ? `<details ${lazy} ${disclosure} ${expanded}><summary>${escapeHtml(view.lazyMessageId ? "展开以加载详情" : view.detailsLabel)}${view.itemCount ? ` · ${view.itemCount}` : ""}</summary>${content}</details>`
      : content;
  return `<section class="extension-card extension-generic tone-${view.tone}"><header><span>${escapeHtml(view.label)}${view.status ? ` · ${escapeHtml(view.status)}` : ""}</span>${progress ? `<strong>${progress.value}/${progress.total}</strong>` : ""}</header><p class="extension-card-title">${escapeHtml(view.title)}</p>${progress ? `<div class="extension-progress" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${percent}%"></span></div>` : ""}${details}${view.metrics.length ? `<small class="extension-card-metrics">${view.metrics.map(escapeHtml).join(" · ")}</small>` : ""}</section>`;
}

const builtins = [
  {
    id: "pi-desktop-card",
    version: 1,
    project: genericCardView,
    normalize: normalizeCard,
    render: renderCard,
  },
  {
    id: "pi-goal-x",
    version: 1,
    project: goalAdapterView,
    normalize: normalizeGoalCard,
    render: renderCard,
  },
];

/**
 * One presentation interface for native messages, timeline placement and HTML.
 * Existing project/render adapters remain valid. Callers do not inspect plugin
 * IDs or card kinds. Every registration owns its own cleanup, never an ID slot.
 */
export function createExtensionAdapterRegistry(adapters = builtins) {
  const registered = new Map();
  let sessionId;
  const report = (adapter, phase, error) => {
    globalThis.console?.error?.(
      `[Pi Desktop] 扩展适配器 ${adapter.id} 的 ${phase} 生命周期失败`,
      error,
    );
  };
  const cleanup = (entry, callback, phase) => {
    try {
      callback?.();
    } catch (error) {
      report(entry.adapter, phase, error);
    }
  };
  const release = (entry) => {
    if (!entry.active) return;
    entry.active = false;
    if (registered.get(entry.id) === entry) registered.delete(entry.id);
    const callback = entry.cleanup;
    entry.cleanup = undefined;
    cleanup(entry, callback, "cleanup");
    cleanup(entry, () => entry.adapter.onDispose?.(), "dispose");
  };
  const normalize = (entry, source) => {
    const view = entry.adapter.normalize
      ? entry.adapter.normalize(source)
      : asRecord(source);
    return view
      ? { ...view, adapterId: entry.id, version: entry.version }
      : undefined;
  };
  const resolve = (source) => {
    const entry = registered.get(source?.adapterId);
    if (!entry?.active || source.version !== entry.version) return undefined;
    try {
      const view = normalize(entry, source);
      // Detail references belong to the containing message, not the schema.
      return view
        ? {
            entry,
            view: {
              ...view,
              disclosureKey: source.disclosureKey,
              lazyMessageId: source.lazyMessageId,
            },
          }
        : undefined;
    } catch (error) {
      report(entry.adapter, "normalize", error);
    }
  };
  const registry = {
    register(adapter) {
      if (
        !adapter ||
        typeof adapter.id !== "string" ||
        !adapter.id.trim() ||
        !Number.isInteger(adapter.version) ||
        adapter.version < 1 ||
        typeof adapter.project !== "function" ||
        typeof adapter.render !== "function"
      )
        throw new TypeError(
          "扩展适配器必须提供非空 id、正整数 version、project 和 render",
        );
      if (registered.has(adapter.id))
        throw new Error(`扩展适配器已注册：${adapter.id}`);
      const entry = {
        id: adapter.id,
        version: adapter.version,
        adapter,
        active: true,
        cleanup: undefined,
      };
      registered.set(entry.id, entry);
      try {
        const callback = adapter.onRegister?.({ sessionId });
        if (typeof callback === "function") {
          if (entry.active) entry.cleanup = callback;
          else cleanup(entry, callback, "cleanup");
        }
        if (entry.active && sessionId !== undefined)
          adapter.onSessionChanged?.(sessionId, undefined);
      } catch (error) {
        release(entry);
        throw error;
      }
      return () => release(entry);
    },
    project(message) {
      for (const entry of [...registered.values()]) {
        if (!entry.active) continue;
        try {
          const source = entry.adapter.project(message);
          const view = source && normalize(entry, source);
          if (view) return view;
        } catch (error) {
          report(entry.adapter, "project", error);
        }
      }
      return undefined;
    },
    summary(source) {
      const view = resolve(source)?.view;
      if (!view) return "";
      return [
        view.label,
        view.status,
        view.progress ? `${view.progress.value}/${view.progress.total}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 100);
    },
    render(source, options = {}) {
      const result = resolve(source);
      if (
        !result ||
        (options.placement === "tool" &&
          presentation(result.view.presentation).mode === "state")
      )
        return "";
      try {
        return result.entry.adapter.render(result.view, options);
      } catch (error) {
        report(result.entry.adapter, "render", error);
        return "";
      }
    },
    layout(rows, { sessionId: owner = "" } = {}) {
      const messages = [],
        states = new Map();
      for (const row of rows) {
        const result = resolve(row.extensionView);
        if (!result || (row.role === "custom" && row.display === false)) {
          messages.push(row);
          continue;
        }
        const policy = presentation(result.view.presentation);
        const identity = JSON.stringify([
          String(owner ?? ""),
          result.view.adapterId,
          policy.mode === "state" ? policy.key : String(row.id),
        ]);
        const view = {
          ...result.view,
          disclosureKey: `extension:${identity}`,
          lazyMessageId: row.lazy ? String(row.id) : undefined,
        };
        const message = { ...row, extensionView: view };
        if (policy.mode === "state") {
          states.delete(identity);
          states.set(identity, {
            role: "custom",
            id: `extension:state:${identity}`,
            extensionState: true,
            text: row.text ?? "",
            display: true,
            extensionView: view,
            blocks: [{ type: "extension", view, text: row.text ?? "" }],
          });
          if (row.role === "custom") continue;
        }
        messages.push(message);
      }
      return { messages, states: [...states.values()] };
    },
    setSession(nextSessionId) {
      const next = nextSessionId == null ? "" : String(nextSessionId);
      if (next === sessionId) return;
      const previous = sessionId;
      sessionId = next;
      for (const entry of [...registered.values()]) {
        if (!entry.active) continue;
        try {
          entry.adapter.onSessionChanged?.(next, previous);
        } catch (error) {
          report(entry.adapter, "session-change", error);
        }
      }
    },
    dispose() {
      sessionId = undefined;
      for (const entry of [...registered.values()].reverse()) release(entry);
    },
  };
  try {
    for (const adapter of adapters) registry.register(adapter);
  } catch (error) {
    registry.dispose();
    throw error;
  }
  return registry;
}

export const extensionAdapterRegistry = createExtensionAdapterRegistry();
