import { createSessionPanelLoader } from "./session-panel-loader.js";
import { renderTaskDetail } from "./task-detail-view.js";

/**
 * 内置任务面板管理区：当前会话的发起草稿与实时详情，不是另一个任务监控窗口。
 *
 * 接口：createTaskPanelManagement 返回 update／render／select／toggleCompose／reset／setActive／dispose；
 *   公共能力、不可变目标与生命周期见 docs/architecture/interfaces/read-panels.md。
 * 不变量：只观察固定 owner／task；离开面板或身份变化只撤读取，不中止工作；
 *   发起草稿及不确定尝试按会话隔离，晚到回执不能抢回用户改选的任务。
 * 错误：读取或发起失败可重试，失败保留草稿与幂等请求身份。
 */
const REFRESH_MS = 2000;
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
export function createTaskPanelManagement({
  fetchDetail,
  refresh,
  statusLabel,
  command,
  toast,
  capture,
  isCurrent,
  canManage,
}) {
  let owner = "",
    selected = "",
    enabled = false,
    root,
    detail,
    timer,
    active = true;
  let model,
    form,
    composeOpen = false,
    launching = false,
    launchRequest,
    inspectionEpoch = 0;
  const drafts = new Map();
  const inspector = createSessionPanelLoader({
    read: (id, options) => fetchDetail(owner, Number(id), options),
    onChange: paint,
  });
  function paint() {
    if (!detail) return;
    const data = inspector.data;
    detail.setAttribute("aria-busy", String(inspector.loading));
    if (inspector.error) detail.textContent = inspector.error;
    else if (data?.task.status === "terminal") {
      selected = "";
      retarget();
      detail.textContent = "任务已离开实时清单，已提交内容可在对话分支查看。";
      void refresh({ force: true });
    } else if (data) renderTaskDetail(detail, data, { statusLabel });
    else
      detail.textContent = selected
        ? "正在读取任务详情…"
        : "选择任务，查看子代理消息与实时输出。";
  }
  function retarget() {
    inspector.setContext({
      owner,
      sessionId: selected,
      enabled: enabled && !!selected,
      canManage: false,
    });
  }
  function stop() {
    clearInterval(timer);
    timer = undefined;
  }
  function values() {
    return form
      ? Object.fromEntries(
          [
            "name",
            "prompt",
            "model",
            "thinkingLevel",
            "instructions",
            "tools",
          ].map((key) => [key, form.elements.namedItem(key).value]),
        )
      : {};
  }
  function saveDraft() {
    if (form) drafts.set(owner, { ...drafts.get(owner), values: values() });
  }
  function field(parent, name, label, tag = "input") {
    const wrapper = element("label", "task-panel-field", label);
    const input = element(tag);
    input.name = name;
    if (tag === "input") input.type = "text";
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }
  function makeComposer(identity) {
    const node = element("form", "task-panel-composer");
    node.dataset.taskCompose = "true";
    const fields = element("fieldset");
    fields.append(element("legend", "", "创建后台子代理"));
    const name = field(fields, "name", "名称");
    name.maxLength = 120;
    name.placeholder = "子代理";
    const prompt = field(fields, "prompt", "委托任务", "textarea");
    prompt.required = true;
    prompt.maxLength = 512000;
    prompt.rows = 4;
    const advanced = element("details", "task-panel-advanced");
    advanced.append(element("summary", "", "高级配置"));
    const models = field(advanced, "model", "模型", "select");
    models.append(new Option("继承当前模型", ""));
    for (const row of model?.models ?? [])
      models.append(
        new Option(
          `${row.provider} / ${row.name ?? row.modelId}`,
          JSON.stringify({ provider: row.provider, modelId: row.modelId }),
        ),
      );
    const thinking = field(advanced, "thinkingLevel", "思考等级", "select");
    thinking.append(new Option("继承当前设置", ""));
    for (const level of [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
      thinking.append(new Option(level, level));
    const instructions = field(
      advanced,
      "instructions",
      "额外指令",
      "textarea",
    );
    instructions.maxLength = 64000;
    instructions.rows = 2;
    field(advanced, "tools", "工具名称（逗号分隔；留空继承）");
    fields.append(advanced);
    const actions = element("div", "task-panel-actions");
    const submit = element("button", "outline-button", "创建子代理");
    submit.type = "submit";
    const close = element("button", "outline-button", "收起");
    close.type = "button";
    close.onclick = () => {
      if (!node.isConnected || !isCurrent(identity)) return;
      composeOpen = false;
      node.hidden = true;
      saveDraft();
      syncComposeToggle()?.focus();
    };
    actions.append(submit, close);
    fields.append(actions);
    node.append(fields, element("p", "task-panel-note"));
    for (const [key, value] of Object.entries(drafts.get(owner)?.values ?? {}))
      node.elements.namedItem(key).value = value;
    node.oninput = saveDraft;
    node.onsubmit = async (event) => {
      event.preventDefault();
      if (
        !node.isConnected ||
        !isCurrent(identity) ||
        !canManage() ||
        launching
      )
        return;
      saveDraft();
      const targetOwner = owner;
      const epoch = inspectionEpoch;
      const value = values();
      const config = {};
      if (value.model) config.model = JSON.parse(value.model);
      for (const key of ["thinkingLevel", "instructions"])
        if (value[key]) config[key] = value[key];
      if (value.tools.trim())
        config.tools = value.tools
          .split(/[,\n]/)
          .map((name) => name.trim())
          .filter(Boolean);
      const input = {
        command: "subagent.spawn",
        id: Number(targetOwner),
        sessionId: targetOwner,
        name: value.name,
        prompt: value.prompt,
        ...(Object.keys(config).length ? { config } : {}),
      };
      const signature = JSON.stringify(input);
      const previous = drafts.get(targetOwner)?.attempt;
      const attempt =
        previous?.signature === signature
          ? previous
          : { signature, requestId: crypto.randomUUID() };
      drafts.set(targetOwner, { values: value, attempt });
      const controller = new AbortController();
      launchRequest = controller;
      launching = true;
      fields.disabled = true;
      const note = node.querySelector(".task-panel-note");
      note.textContent = "正在提交委托…";
      try {
        const result = await command(
          Object.freeze({ ...input, requestId: attempt.requestId }),
          { signal: controller.signal },
        );
        if (controller.signal.aborted || !isCurrent(identity)) return;
        drafts.delete(targetOwner);
        composeOpen = false;
        syncComposeToggle();
        form = undefined;
        node.remove();
        toast("子代理任务已创建");
        await refresh({ force: true });
        if (isCurrent(identity) && inspectionEpoch === epoch)
          select(result.taskId);
      } catch (error) {
        if (!controller.signal.aborted && isCurrent(identity))
          note.textContent = error.message;
      } finally {
        if (launchRequest === controller) {
          launchRequest = undefined;
          launching = false;
          fields.disabled = false;
        }
      }
    };
    return node;
  }
  function syncComposeToggle() {
    const toggle = root
      ?.closest(".task-panel")
      ?.querySelector("[data-task-compose-toggle]");
    toggle?.setAttribute("aria-expanded", String(composeOpen));
    return toggle;
  }
  function select(id) {
    if (!enabled) return;
    inspectionEpoch++;
    selected = String(id);
    retarget();
    paint();
    void inspector.refresh({ force: true });
  }
  return {
    update(context, data) {
      owner = String(context.sessionId ?? "");
      model = data;
      enabled =
        typeof fetchDetail === "function" &&
        context.capabilities?.taskDetails === true &&
        context.capabilities?.remote !== true;
      if (
        selected &&
        data &&
        !data.tasks?.some((row) => String(row.id) === selected)
      )
        selected = "";
      retarget();
      if (!enabled) stop();
      return enabled;
    },
    render(node) {
      if (!enabled) return;
      if (!root) {
        root = element("aside", "task-panel-management");
        root.append(element("h3", "", "实时详情"));
        detail = element("div", "task-panel-detail");
        detail.setAttribute("aria-live", "polite");
        root.append(detail);
      }
      if (form) {
        form.hidden = !composeOpen;
        root.prepend(form);
      }
      node.append(root);
      syncComposeToggle();
      paint();
      if (active && !timer)
        timer = setInterval(() => {
          if (!root?.isConnected || document.hidden || !active) return stop();
          void refresh();
          if (selected) void inspector.refresh();
        }, REFRESH_MS);
    },
    select,
    toggleCompose() {
      const identity = capture();
      if (!enabled || !identity || !canManage()) return;
      composeOpen = !composeOpen;
      syncComposeToggle();
      if (composeOpen && !form) {
        form = makeComposer(identity);
        root.prepend(form);
      }
      if (form) {
        form.hidden = !composeOpen;
        if (composeOpen) form.elements.namedItem("prompt").focus();
      }
    },
    reset() {
      saveDraft();
      launchRequest?.abort();
      launchRequest = undefined;
      launching = false;
      inspectionEpoch++;
      composeOpen = false;
      selected = "";
      stop();
      retarget();
      root = detail = form = undefined;
    },
    setActive(value) {
      if (active === value) return;
      active = value;
      if (!value) {
        stop();
        saveDraft();
        launchRequest?.abort();
        launchRequest = undefined;
        launching = false;
        if (form) form.querySelector("fieldset").disabled = false;
      }
      inspector.setActive(value);
      if (value && selected) void inspector.refresh();
    },
    dispose() {
      this.reset();
      inspector.dispose();
      drafts.clear();
    },
  };
}
