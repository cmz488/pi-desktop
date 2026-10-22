import assert from "node:assert/strict";

const HOST_READ_TIMEOUT_MS = 10000;

/**
 * Host 面板兼容回归：通过公开 module、DOM 与真实 HTTP 验证旧调用方式。
 *
 * 接口：在 host-tasks-browser-check 的导航后、当前工作台检查前调用；复用其 fixture/driver/workers。
 * 不变量：仅观察调用方的两项挂起任务；发起测试使用独立输入，不拥有原两项任务的生命周期。
 * 错误：断言失败向上传播，finally 撤观察并移除测试 dialog，不改变后续工作台的选中会话。
 */
export async function checkHostTaskPanelCompatibility({
  driver,
  fixture,
  workers,
}) {
  assert.equal(workers.length, 2, "兼容检查需要两个已运行的 worker");
  assert.notEqual(workers[0].id, workers[1].id);
  assert.notEqual(workers[0].name, workers[1].name);
  assert.equal(workers[0].taskId, workers[1].taskId, "必须是真实同号任务");
  const readHost = (path) =>
    fixture.call(path, undefined, {
      signal: AbortSignal.timeout(HOST_READ_TIMEOUT_MS),
    });
  const initial = await readHost("/api/host/tasks");
  const targets = workers.map((worker) => {
    const row = initial.workers.find((item) => item.agentId === worker.id);
    assert.equal(row?.status, "running");
    assert.equal(row.data?.supported, true);
    return {
      agentId: worker.id,
      generation: row.generation,
      conversationId: Number(worker.parent),
      taskId: worker.taskId,
      marker: `SCOPED_CHILD_${worker.name}`,
    };
  });
  function assertLive(graph) {
    for (const target of targets) {
      const worker = graph.workers.find(
        (row) => row.agentId === target.agentId,
      );
      assert.equal(worker?.generation, target.generation);
      const task = worker?.data?.tasks.find((row) => row.id === target.taskId);
      assert.ok(task, "关闭/销毁观察不能让原任务离开实时图");
      assert.equal(task.scopeId, target.conversationId);
      assert.notEqual(task.status, "terminal");
      assert.notEqual(task.abortRequested, true, "不得误提交原生中止请求");
    }
  }
  assertLive(initial);
  const origin = new URL(fixture.app.url).origin;
  await driver.until(
    `location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete' && document.querySelector('#runtime')?.contentDocument?.querySelector('#connection-status')?.textContent === 'Pi 已连接'`,
    { timeoutMs: 15000 },
  );
  const errorCount = driver.errors.length;
  await driver.evaluate(
    `(${checkInBrowser.toString()})(${JSON.stringify(targets)})`,
  );
  assertLive(await readHost("/api/host/tasks"));
  for (const { marker, ...identity } of targets) {
    const detail = await readHost(
      `/api/host/tasks/detail?${new URLSearchParams(identity)}`,
    );
    assert.equal(detail.task.id, identity.taskId);
    assert.notEqual(
      detail.task.status,
      "terminal",
      `${marker} 必须留给后续原测试`,
    );
  }
  assert.deepEqual(driver.errors.slice(errorCount), []);
}

// 此函数序列化到真实 Chromium 执行；依赖全部在函数内，不能引用 Node 闭包。
async function checkInBrowser(targets) {
  const CHECK_TIMEOUT_MS = 45000;
  const STEP_TIMEOUT_MS = 8000;
  const REQUEST_TIMEOUT_MS = 15000;
  const POLL_MS = 50;
  // 超过公开 Host 面板的 2 秒补刷周期，观察关闭/销毁后的请求静默。
  const QUIET_MS = 2200;
  const SPAWN_PROMPT = "COMPAT_FORM_CHILD_DONE";
  const identityFields = ["agentId", "generation", "conversationId", "taskId"];
  const key = (target) =>
    identityFields.map((field) => target[field]).join(":");
  const matches = (value, target) =>
    identityFields.every(
      (field) => String(value[field]) === String(target[field]),
    );
  const expect = (condition, message) => {
    if (!condition) throw new Error(`Host 面板兼容检查：${message}`);
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const lifetime = new AbortController();
  const holds = [];
  const requests = [];
  const forbidden = [];
  let nextHold, panel;
  const deadline = setTimeout(() => {
    lifetime.abort(new Error("Host 面板兼容检查超过 45 秒"));
    for (const hold of holds) hold.release();
  }, CHECK_TIMEOUT_MS);
  const focus = document.activeElement;
  const scroll = [window.scrollX, window.scrollY];
  const runtime = document.querySelector("#runtime");
  const runtimeDocument = runtime.contentDocument;
  const workspaceUrl = location.href;
  const root = document.createElement("dialog");
  root.id = "host-task-panel-compat-dialog";
  root.setAttribute("aria-label", "旧 Host 任务面板兼容检查");
  root.style.cssText = "max-width:90vw;max-height:85vh;overflow:auto";
  // 生产页已撤下此 dialog；这里只保留旧调用者所需的公开 DOM interface。
  root.innerHTML = `
    <header><h2>Host 任务与子代理</h2>
      <button type="button" data-host-close>关闭</button>
      <button type="button" data-host-refresh>刷新</button>
      <button type="button" data-host-toggle-compose aria-expanded="false"
        aria-controls="host-subagent-form">新建子代理</button>
    </header>
    <p data-host-status role="status"></p>
    <p data-host-action-status role="status" hidden></p>
    <form id="host-subagent-form" hidden>
      <label>Agent<select name="agent"></select></label>
      <label>父会话<select name="conversation"></select></label>
      <label>名称<input name="name" maxlength="120"></label>
      <label>委托<textarea name="prompt" required maxlength="512000"></textarea></label>
      <label>模型<select name="model"></select></label>
      <label>思考等级<select name="thinkingLevel"><option value="">继承</option>
        <option value="off">off</option></select></label>
      <label>指令<textarea name="instructions"></textarea></label>
      <label>工具<input name="tools"></label>
      <button type="submit" data-host-spawn disabled>创建子代理</button>
      <p data-host-launch-status role="status"></p>
    </form>
    <div data-host-workers></div>
    <label>原生任务<select data-host-inspect></select></label>
    <section data-host-detail aria-live="polite" aria-busy="false"></section>`;
  const $ = (selector) => root.querySelector(selector);
  const detail = $("[data-host-detail]");
  const select = $("[data-host-inspect]");
  const waitButton = (target) =>
    $(
      `[data-host-agent="${target.agentId}"] [data-task-panel="${target.conversationId}"] [data-task-action="wait:${target.taskId}"]`,
    );
  async function until(predicate, message) {
    const end = Date.now() + STEP_TIMEOUT_MS;
    do {
      lifetime.signal.throwIfAborted();
      expect(!forbidden.length, forbidden.join("; "));
      if (predicate()) return;
      await pause(POLL_MS);
    } while (Date.now() < end);
    throw new Error(`Host 面板兼容检查超时：${message}\n${root.innerText}`);
  }
  function holdNextDetail(target) {
    expect(!nextHold, "不能同时布置两个未认领的详情延迟");
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    const hold = { target, promise, release, record: undefined };
    holds.push(hold);
    nextHold = hold;
    return hold;
  }
  async function request(path, input, signal) {
    const url = new URL(path, location.href);
    const allowedPath = [
      "/api/host/tasks",
      "/api/host/tasks/detail",
      "/api/host/tasks/command",
    ].includes(url.pathname);
    const allowedCommand =
      (input?.command === "wait" &&
        targets.some((target) => matches(input, target))) ||
      (input?.command === "subagent.spawn" &&
        input.prompt === SPAWN_PROMPT &&
        targets.some((target) =>
          ["agentId", "generation", "conversationId"].every(
            (field) => input[field] === target[field],
          ),
        ));
    // 回归也不能取消调用者的任务；拒绝危险写入并使检查失败，不伪造成功。
    if (
      url.origin !== location.origin ||
      !allowedPath ||
      (input !== undefined &&
        (url.pathname !== "/api/host/tasks/command" || !allowedCommand))
    ) {
      forbidden.push(`不允许的请求 ${path} / ${input?.command ?? "GET"}`);
      throw new Error(forbidden.at(-1));
    }
    const record = {
      path: url.pathname,
      input,
      signal,
      received: false,
      finished: false,
    };
    requests.push(record);
    const hold =
      url.pathname === "/api/host/tasks/detail" &&
      nextHold &&
      matches(Object.fromEntries(url.searchParams), nextHold.target)
        ? nextHold
        : undefined;
    if (hold) {
      nextHold = undefined;
      hold.record = record;
    }
    try {
      const response = await fetch(url, {
        method: input === undefined ? "GET" : "POST",
        ...(input === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(input),
            }),
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.any([
          lifetime.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]),
      });
      const value = await response.json();
      if (!response.ok)
        throw Object.assign(new Error(value.error), {
          status: response.status,
        });
      record.received = true;
      record.result = value;
      // 必须先读完真实 HTTP/JSON，再延迟交付；故意忽略后来的 abort，检验旧代发布门禁。
      if (hold) await hold.promise;
      return value;
    } finally {
      record.finished = true;
    }
  }
  function choose(target) {
    expect(
      [...select.options].some((option) => option.value === key(target)),
      "同号任务必须有独立选项",
    );
    select.value = key(target);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function showing(target) {
    return (
      select.value === key(target) &&
      detail.getAttribute("aria-busy") === "false" &&
      !!detail.querySelector("[data-task-detail-result]") &&
      detail.textContent.includes(target.marker) &&
      targets
        .filter((other) => other !== target)
        .every((other) => !detail.textContent.includes(other.marker))
    );
  }
  const ready = () =>
    targets.every(
      (target) =>
        [...select.options].some((option) => option.value === key(target)) &&
        waitButton(target) &&
        !waitButton(target).disabled,
    );
  async function releaseWithoutOverwrite(hold, current) {
    const stale = [];
    const observe = () => {
      if (detail.textContent.includes(hold.target.marker))
        stale.push(detail.textContent);
    };
    const observer = new MutationObserver(observe);
    observer.observe(detail, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    try {
      hold.release();
      await until(() => hold.record.finished, "旧详情应完成交付");
      await pause(POLL_MS);
      expect(
        stale.length === 0 && showing(current),
        "晚到详情不能覆盖后来选择的 worker",
      );
    } finally {
      observer.disconnect();
    }
  }
  async function startWait(target) {
    const before = requests.length;
    waitButton(target).click();
    let record;
    await until(() => {
      record = requests
        .slice(before)
        .find(
          (item) =>
            item.input?.command === "wait" && matches(item.input, target),
        );
      return record && waitButton(target)?.dataset.waiting === "true";
    }, "旧 wait 按钮应提交真实 Host 命令");
    for (const field of identityFields)
      expect(
        record.input[field] === target[field],
        `wait 的 ${field} 必须保留原生目标及类型`,
      );
    // 在关闭前再完成一次真实 Host 往返，不把仅渲染了 waiting 的按钮当作请求证据。
    await request("/api/host/tasks", undefined, lifetime.signal);
    expect(
      !record.finished && !record.signal.aborted,
      "挂起任务的 wait 必须仍在观察中",
    );
    return record;
  }
  async function quiet(message) {
    const count = requests.length;
    await pause(QUIET_MS);
    lifetime.signal.throwIfAborted();
    expect(requests.length === count, message);
    expect(!forbidden.length, forbidden.join("; "));
  }
  const [a, b] = targets;
  try {
    const { createHostTaskPanel } = await import("/host-task-panel.js");
    expect(
      typeof createHostTaskPanel === "function",
      "公开 URL 应导出 createHostTaskPanel",
    );
    expect(
      !document.querySelector("#host-subagent-form"),
      "生产 workspace 不应挂载旧表单",
    );
    document.body.append(root);
    panel = createHostTaskPanel({ root, request });
    expect(
      typeof panel.open === "function" && typeof panel.dispose === "function",
      "保留 open/dispose interface",
    );
    panel.open();
    panel.open();
    expect(root.open, "open 可重复调用并打开真实 dialog");
    await until(ready, "聚合两个 worker 的原生任务与操作");

    const form = $("#host-subagent-form");
    for (const name of [
      "agent",
      "conversation",
      "name",
      "prompt",
      "model",
      "thinkingLevel",
      "instructions",
      "tools",
    ])
      expect(form.elements.namedItem(name), `保留旧表单字段 ${name}`);
    form.elements.agent.value = `${b.agentId}:${b.generation}`;
    form.elements.agent.dispatchEvent(new Event("change", { bubbles: true }));
    expect(
      form.elements.conversation.value === String(b.conversationId),
      "Agent 改选应更新父会话",
    );
    expect(!$("[data-host-spawn]").disabled, "真实管理能力应启用旧发起按钮");
    const toggle = $("[data-host-toggle-compose]");
    toggle.click();
    expect(
      !form.hidden && toggle.getAttribute("aria-expanded") === "true",
      "公开切换按钮展开表单",
    );
    form.elements.prompt.value = "兼容检查草稿，不提交";
    toggle.click();
    expect(
      form.hidden && toggle.getAttribute("aria-expanded") === "false",
      "收起旧表单",
    );
    toggle.click();
    expect(
      form.elements.prompt.value === "兼容检查草稿，不提交",
      "收起不能丢弃草稿",
    );
    form.elements.name.value = "兼容表单委托";
    form.elements.prompt.value = SPAWN_PROMPT;
    form.requestSubmit();
    let spawned;
    await until(() => {
      spawned = requests.find((row) => row.input?.command === "subagent.spawn");
      return (
        spawned?.received &&
        $("[data-host-launch-status]").textContent.includes("已创建原生任务")
      );
    }, "旧发起表单应通过真实 Host 创建原生子代理");
    for (const field of ["agentId", "generation", "conversationId"])
      expect(
        spawned.input[field] === b[field],
        `发起的 ${field} 绑定所选 worker`,
      );
    expect(Number.isSafeInteger(spawned.result.taskId), "发起返回真实 task id");
    expect(
      typeof spawned.input.requestId === "string" &&
        spawned.input.requestId.length > 0,
      "发起具有稳定尝试标识",
    );
    await until(
      () =>
        detail.textContent.includes(SPAWN_PROMPT) &&
        detail.textContent.includes(`原生任务 #${spawned.result.taskId}`),
      "发起后的默认选择显示新任务详情",
    );
    toggle.click();
    const beforeRefresh = requests.length;
    $("[data-host-refresh]").click();
    await until(
      () =>
        requests
          .slice(beforeRefresh)
          .some((row) => row.path === "/api/host/tasks" && row.received),
      "公开刷新按钮读取真实 Host",
    );

    choose(a);
    await until(() => showing(a), "A 的详情只显示 SCOPED_CHILD_A");
    choose(b);
    await until(() => showing(b), "同号 B 的详情不得复用 A");
    const switched = holdNextDetail(a);
    choose(a);
    await until(() => switched.record?.received, "取得待延迟的真实 A 详情");
    choose(b);
    await until(() => showing(b), "A 旧读取不能阻塞 B");
    expect(switched.record.signal.aborted, "改选应撤销旧详情观察");
    await releaseWithoutOverwrite(switched, b);

    const closed = holdNextDetail(a);
    choose(a);
    await until(() => closed.record?.received, "关闭前挂起真实详情交付");
    const closingWait = await startWait(a);
    $("[data-host-close]").click();
    expect(!root.open, "公开关闭按钮应关闭 dialog");
    await until(
      () =>
        closingWait.signal.aborted &&
        closingWait.finished &&
        closed.record.signal.aborted,
      "关闭撤详情与 wait 观察",
    );
    expect(detail.getAttribute("aria-busy") === "false", "关闭后不遗留 busy");
    await quiet("关闭后的面板不得继续补刷");
    panel.open();
    await until(ready, "重新打开重建当前观察");
    choose(b);
    await until(() => showing(b), "重新打开后读取 B");
    await releaseWithoutOverwrite(closed, b);

    const disposed = holdNextDetail(a);
    choose(a);
    await until(() => disposed.record?.received, "销毁前挂起真实详情交付");
    const disposingWait = await startWait(b);
    panel.dispose();
    panel.dispose();
    await until(
      () =>
        disposingWait.signal.aborted &&
        disposingWait.finished &&
        disposed.record.signal.aborted,
      "dispose 撤两个 worker 的详情/wait 观察且可重复调用",
    );
    expect(detail.getAttribute("aria-busy") === "false", "销毁后不遗留 busy");
    const disposedContent = detail.innerHTML;
    disposed.release();
    await until(() => disposed.record.finished, "销毁后旧详情仍会交付");
    await pause(POLL_MS);
    expect(
      detail.innerHTML === disposedContent,
      "dispose 后的迟到结果不得重画 DOM",
    );
    root.close();
    panel.open();
    expect(!root.open, "dispose 后 open 不复活面板");
    await quiet("销毁后的面板不得继续补刷");
    expect(
      requests.filter((row) => row.input !== undefined).length === 3,
      "只提交两个 wait 和一次独立发起，不中止调用方任务",
    );
  } finally {
    try {
      panel?.dispose();
    } finally {
      lifetime.abort();
      for (const hold of holds) hold.release();
      clearTimeout(deadline);
      if (root.open) root.close();
      root.remove();
      if (focus?.isConnected) focus.focus({ preventScroll: true });
      window.scrollTo(...scroll);
      await pause(POLL_MS);
    }
  }
  expect(
    document.querySelector("#runtime") === runtime &&
      runtime.contentDocument === runtimeDocument &&
      location.href === workspaceUrl,
    "检查后保留正常 workspace/Agent/frame，供原测试继续使用",
  );
  expect(!document.getElementById(root.id), "必须移除测试 dialog");
}
