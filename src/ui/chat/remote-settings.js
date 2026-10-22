/**
 * 远程设置：拥有远程页的读取、局部动作与可见期间的补刷。
 *
 * 接口：setContext({identity,active})／refresh／dispose；进入 active 自动 prepare 刷新，
 *   见 docs/architecture/interfaces/chat-views.md。
 * 不变量：撤只读观察不停止共享；迟到 GET 不发布或发起 prepare，POST 保留原生语义。
 * 错误：当前读取／操作失败提示使用者，refresh 的错误交给调用方；过期读取忽略。
 */
const STARTING_REFRESH_MS = 1000;
const IDLE_REFRESH_MS = 3000;
const REMOTE_ACTIONS = {
  "start-remote": "start",
  "stop-remote": "stop",
  "rotate-remote": "rotate",
};

export function createRemoteSettings({ live, api, esc, toast, getAgent }) {
  const root = document.querySelector("#view-remote");
  const $ = (selector) => root.querySelector(selector);
  let context = { identity: undefined, active: false };
  let disposed = false,
    request,
    refreshTimer;

  const currentContext = (owner) =>
    !disposed && context === owner && context.active;
  const currentRequest = (reading) =>
    request === reading && currentContext(reading.context);

  function cancelRead() {
    const previous = request;
    request = undefined;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
    previous?.controller.abort();
  }

  async function refresh({ address, prepare = false } = {}) {
    if (!currentContext(context)) return;
    cancelRead();
    if (!live) {
      $("#network-status").textContent = "预览";
      return;
    }
    const reading = {
      context,
      controller: new AbortController(),
    };
    request = reading;
    try {
      const agent = getAgent();
      let info;
      try {
        info = await api(
          `/api/remote?${new URLSearchParams({ ...(address ? { address } : {}), ...(agent !== undefined ? { agent } : {}) })}`,
          undefined,
          { signal: reading.controller.signal },
        );
      } catch (error) {
        // api 自己的超时也可能叫 AbortError；只能忽略本模块撤销的 GET。
        if (error.name === "AbortError" && reading.controller.signal.aborted)
          return;
        throw error;
      }
      if (!currentRequest(reading)) return;
      if (
        !info.remoteClient &&
        info.tunnel?.prepareSupported &&
        ["off", "error"].includes(info.tunnel.phase) &&
        (prepare || info.tunnel.runtime?.phase === "off")
      )
        // prepare 是共享动作，不把只读观察的 signal 传给 POST。
        info = await api("/api/remote", { action: "prepare" });
      if (!currentRequest(reading)) return;
      const tunnel = info.tunnel;
      const checking = tunnel?.phase === "checking";
      const starting = ["preparing", "starting", "checking"].includes(
          tunnel?.phase,
        ),
        ready = tunnel?.phase === "ready";
      $("#network-status").textContent = info.remoteClient
        ? "远程已连接"
        : ready
          ? "共享已开启"
          : starting
            ? checking
              ? "验证公网连接"
              : tunnel?.phase === "preparing"
                ? "启动 Tailscale"
                : tunnel?.runtime?.phase === "login"
                  ? "等待登录"
                  : "正在连接"
            : tunnel?.phase === "error"
              ? "连接失败"
              : info.lan
                ? "局域网共享"
                : tunnel?.runtime?.backendState === "Running"
                  ? "Tailscale 已就绪"
                  : tunnel?.runtime?.backendState === "NeedsLogin"
                    ? "需要登录 Tailscale"
                    : "未开启";
      $("#connection-title").textContent = info.remoteClient
        ? "已连接电脑上的 Pi"
        : ready
          ? "扫码即可远程操作"
          : "手机扫码连接";
      $("#connection-description").textContent = info.remoteClient
        ? "你可以发送消息、查看进度和切换 Agent。远程连接由电脑管理。"
        : checking
          ? "正在验证公网 HTTPS 入口。首次开启的 DNS 更新可能需要最多 10 分钟；验证通过后显示二维码，可以随时取消。"
          : "开启连接后，手机扫码即可在浏览器操作。Tailscale 由 Desktop 维护；首次使用请完成账号与 HTTPS／Funnel 授权。";
      $("#connection-actions").hidden = info.remoteClient || !tunnel;
      $("#start-remote").hidden = ready;
      $("#start-remote").disabled = starting;
      $("#start-remote").textContent = starting
        ? checking
          ? "验证公网连接…"
          : "正在连接…"
        : tunnel?.runtime?.backendState === "NeedsLogin"
          ? "登录并开启远程连接"
          : "开启远程连接";
      $("#stop-remote").hidden = !starting && !ready;
      $("#rotate-remote").hidden = !ready;
      $("#connection-error").hidden = !tunnel?.error;
      $("#connection-error").textContent = tunnel?.error ?? "";
      $("#connection-setup").hidden = !tunnel || ready || info.remoteClient;
      $("#connection-setup").href =
        tunnel?.setupUrl ??
        "https://tailscale.com/docs/features/tailscale-funnel";
      $("#connection-approval").hidden = !tunnel?.approvalUrl;
      $("#connection-approval").href = tunnel?.approvalUrl ?? "";
      if (info.qr && (ready || info.lan || !tunnel)) {
        const image = document.createElement("img");
        image.src = info.qr;
        image.alt = "手机扫码打开同一 Pi 会话";
        $("#connection-qr").replaceChildren(image);
      } else {
        const placeholder = document.createElement("p");
        placeholder.className = "connection-placeholder";
        placeholder.textContent = info.remoteClient
          ? "远程已连接"
          : starting
            ? checking
              ? "正在验证手机扫码入口，成功后显示二维码…"
              : "正在建立远程连接…"
            : "开启后显示二维码";
        $("#connection-qr").replaceChildren(placeholder);
      }
      $("#connection-url").hidden = !ready && !info.lan && !info.remoteClient;
      $("#connection-url").textContent =
        ready && tunnel.url ? tunnel.url : info.url;
      $("#connection-url").href = info.url;
      $("#connection-addresses").innerHTML = info.urls
        .map(
          (url) =>
            `<button class="outline-button" data-connection-address="${esc(url)}" aria-pressed="${url === info.url}">${esc(new URL(url).hostname)}</button>`,
        )
        .join("");
      $("#connection-addresses").hidden = ready;
      $("#connection-port").textContent = `端口 ${info.port}`;
      $("#connection-port").hidden = ready || info.remoteClient;
      if (tunnel && !info.remoteClient) {
        const timer = setTimeout(
          () => {
            if (refreshTimer !== timer || !currentContext(reading.context))
              return;
            refreshTimer = undefined;
            void refresh().catch((error) => toast(error.message));
          },
          starting ? STARTING_REFRESH_MS : IDLE_REFRESH_MS,
        );
        refreshTimer = timer;
      }
    } catch (error) {
      if (currentRequest(reading)) throw error;
    } finally {
      if (request === reading) request = undefined;
    }
  }

  async function onClick(event) {
    const button = event.target.closest("button");
    if (!button || !root.contains(button)) return;
    const address = button.dataset.connectionAddress;
    const action = button.dataset.action;
    if (
      address === undefined &&
      action !== "refresh-connection" &&
      !Object.hasOwn(REMOTE_ACTIONS, action)
    )
      return;
    // 在任何 await／active 检查前拦截，不能让 document 再执行同一动作。
    event.stopPropagation();
    if (!currentContext(context) || button.disabled) return;
    try {
      if (address !== undefined) await refresh({ address });
      else if (action === "refresh-connection")
        await refresh({ prepare: true });
      else {
        const owner = context;
        await api("/api/remote", { action: REMOTE_ACTIONS[action] });
        if (currentContext(owner)) await refresh();
      }
    } catch (error) {
      toast(error.message);
    }
  }

  root.addEventListener("click", onClick);
  return {
    setContext({ identity, active }) {
      if (
        disposed ||
        (identity === context.identity && active === context.active)
      )
        return;
      context = { identity, active };
      cancelRead();
      if (active)
        void refresh({ prepare: true }).catch((error) => toast(error.message));
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelRead();
      root.removeEventListener("click", onClick);
    },
  };
}
