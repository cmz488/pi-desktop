// Display the upstream Chromium session, never load a site's scripts in our UI.
export function createAgentBrowserView({
  viewport,
  request,
  onState,
  onError,
  onResolution = () => {},
}) {
  const canvas = document.createElement("canvas");
  canvas.id = "agent-browser-canvas";
  canvas.className = "agent-browser-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute(
    "aria-label",
    "Agent 共享的 Chromium 浏览器，点击后可输入和滚动",
  );
  const textForm = document.createElement("form");
  textForm.className = "agent-browser-text";
  const textInput = document.createElement("input");
  textInput.placeholder = "输入到网页…";
  textInput.setAttribute("aria-label", "向网页当前焦点输入文字");
  const textSend = document.createElement("button");
  textSend.textContent = "↵";
  textSend.setAttribute("aria-label", "输入到网页");
  textForm.append(textInput, textSend);
  textForm.onsubmit = (event) => {
    event.preventDefault();
    if (textInput.value) {
      send({
        type: "input_keyboard",
        eventType: "char",
        text: textInput.value.slice(0, 8000),
      });
      textInput.value = "";
    }
  };
  let enabled = false,
    visible = false,
    disposed = false,
    refreshing,
    controller,
    frameId = "",
    width = 1280,
    height = 720;
  let inputs = [],
    sending = false,
    inputTimer;
  let viewportSize = "",
    reportedSize = "",
    resizeTimer;
  let intersecting = false;
  const intersection = new IntersectionObserver(([entry]) => {
    intersecting = entry.isIntersecting;
    if (intersecting) void frames();
    else controller?.abort();
  });
  intersection.observe(canvas);
  const root = /^\/agents\/[a-f0-9-]{36}/.exec(location.pathname)?.[0] ?? "";
  async function refresh() {
    if (!enabled || !visible || disposed || document.hidden) return;
    refreshing ??= request("/api/browser")
      .then((value) => {
        if (visible && !document.hidden) onState(value);
      })
      .catch(onError)
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  }
  async function frames() {
    if (
      !enabled ||
      !visible ||
      !intersecting ||
      disposed ||
      document.hidden ||
      controller
    )
      return;
    controller = new AbortController();
    const current = controller;
    try {
      const response = await fetch(
        `${root}/_browser/frame?after=${encodeURIComponent(frameId)}`,
        { cache: "no-store", signal: current.signal },
      );
      if (response.status === 204) return;
      if (!response.ok) throw new Error("浏览器画面暂时无法连接");
      const image = await createImageBitmap(await response.blob());
      try {
        if (!visible || !enabled || disposed) return;
        canvas.width = image.width;
        canvas.height = image.height;
        canvas.getContext("2d").drawImage(image, 0, 0);
        frameId = response.headers.get("X-Pi-Frame") ?? "";
        width = Number(response.headers.get("X-Pi-Width")) || image.width;
        height = Number(response.headers.get("X-Pi-Height")) || image.height;
        const size = `${width}×${height}`;
        if (size !== reportedSize) {
          reportedSize = size;
          onResolution({ width, height, scale: 2 });
        }
      } finally {
        image.close();
      }
    } catch (error) {
      if (!current.signal.aborted) onError(error);
    } finally {
      if (controller === current) controller = undefined;
    }
  }
  async function sendInputs() {
    if (sending || !inputs.length || disposed) return;
    sending = true;
    try {
      await request("/api/browser", {
        action: "input",
        id: canvas.dataset.tabId,
        events: inputs.splice(0, 128),
      });
    } catch (error) {
      inputs = [];
      onError(error);
    } finally {
      sending = false;
      if (inputs.length) void sendInputs();
    }
  }
  function send(event) {
    if (!visible || !enabled) return;
    if (inputs.length >= 256) {
      onError(new Error("浏览器输入等待过多，请等待网络恢复"));
      return;
    }
    inputs.push(event);
    clearTimeout(inputTimer);
    inputTimer = setTimeout(() => void sendInputs(), 16);
  }
  const point = (event) => {
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(width, ((event.clientX - box.left) / box.width) * width),
      ),
      y: Math.max(
        0,
        Math.min(height, ((event.clientY - box.top) / box.height) * height),
      ),
    };
  };
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    canvas.focus();
    if (event.isTrusted) canvas.setPointerCapture(event.pointerId);
    send({
      type: "input_mouse",
      eventType: "mousePressed",
      ...point(event),
      button: ["left", "middle", "right"][event.button] ?? "left",
      clickCount: 1,
    });
  });
  canvas.addEventListener("pointerup", (event) =>
    send({
      type: "input_mouse",
      eventType: "mouseReleased",
      ...point(event),
      button: ["left", "middle", "right"][event.button] ?? "left",
    }),
  );
  canvas.addEventListener("pointermove", (event) => {
    send({
      type: "input_mouse",
      eventType: "mouseMoved",
      ...point(event),
      button: event.buttons & 1 ? "left" : "none",
    });
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      send({
        type: "input_mouse",
        eventType: "mouseWheel",
        ...point(event),
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
    },
    { passive: false },
  );
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  for (const [name, eventType] of [
    ["keydown", "keyDown"],
    ["keyup", "keyUp"],
  ])
    canvas.addEventListener(name, (event) => {
      if (event.key === "Tab") event.preventDefault();
      if (
        !event.isComposing &&
        !["Control", "Shift", "Alt", "Meta"].includes(event.key)
      ) {
        event.preventDefault();
        send({
          type: "input_keyboard",
          eventType,
          key: event.key,
          code: event.code,
          modifiers:
            (event.altKey ? 1 : 0) |
            (event.ctrlKey ? 2 : 0) |
            (event.metaKey ? 4 : 0) |
            (event.shiftKey ? 8 : 0),
          ...(eventType === "keyDown" && event.key.length === 1
            ? { text: event.key }
            : {}),
        });
      }
    });
  canvas.addEventListener("paste", (event) => {
    event.preventDefault();
    send({
      type: "input_keyboard",
      eventType: "char",
      text: (event.clipboardData?.getData("text") ?? "").slice(0, 8000),
    });
  });
  canvas.addEventListener("compositionend", (event) => {
    if (event.data)
      send({
        type: "input_keyboard",
        eventType: "char",
        text: event.data.slice(0, 8000),
      });
  });
  const timer = setInterval(() => {
    if (!document.hidden) {
      void frames();
    }
  }, 700);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) controller?.abort();
  });
  return {
    configure(value) {
      enabled = value;
      if (enabled && visible) void refresh();
      if (!enabled) controller?.abort();
    },
    attach(value) {
      const wasVisible = visible;
      visible = value;
      if (visible) {
        if (!wasVisible) void refresh();
        if (canvas.parentElement !== viewport)
          viewport.replaceChildren(canvas, textForm);
        const box = viewport.getBoundingClientRect();
        const width = Math.max(320, Math.min(1600, Math.round(box.width)));
        const height = Math.max(240, Math.min(1200, Math.round(box.height)));
        const size = `${width},${height}`;
        if (size !== viewportSize) {
          viewportSize = size;
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            if (visible && intersecting && enabled && !disposed)
              void request("/api/browser", {
                action: "resize",
                width,
                height,
              }).catch(onError);
          }, 200);
        }
        void frames();
      } else controller?.abort();
    },
    refresh,
    async execute(action, extra = {}) {
      const value = await request("/api/browser", { action, ...extra });
      onState(value);
      return value;
    },
    select(id) {
      canvas.dataset.tabId = id;
    },
    close() {
      disposed = true;
      clearInterval(timer);
      clearTimeout(inputTimer);
      clearTimeout(resizeTimer);
      intersection.disconnect();
      controller?.abort();
    },
  };
}
