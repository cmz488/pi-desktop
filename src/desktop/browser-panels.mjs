import { WebContentsView } from "electron";

const securedSessions = new WeakSet();
const urlOf = (input) => {
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("网页仅支持不含凭据的 HTTP / HTTPS 地址");
  return url.href;
};
// Remote pages have no preload or Node bridge and use a separate browser session.
export function createBrowserPanels(window) {
  const tabs = new Map();

  const send = (tab) => {
    if (window.isDestroyed() || tab.view.webContents.isDestroyed()) return;
    const wc = tab.view.webContents;
    const state = {
      owner: tab.owner,
      id: tab.id,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      back: wc.navigationHistory.getActiveIndex() > 0,
      forward:
        wc.navigationHistory.getActiveIndex() <
        wc.navigationHistory.length() - 1,
      error: tab.error,
    };
    window.webContents.send("pi-desk:browser-state", state);
    return state;
  };
  const hide = () => {
    for (const tab of tabs.values()) tab.view.setVisible(false);
  };
  const close = (tab) => {
    tabs.delete(`${tab.owner}:${tab.id}`);
    if (!window.isDestroyed()) window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed())
      tab.view.webContents.close({ waitForBeforeUnload: false });
  };
  window.on("closed", () => {
    for (const tab of [...tabs.values()]) close(tab);
  });
  // Hide until renderer supplies fresh bounds after any window resize.
  window.on("resize", hide);
  return {
    execute(input) {
      if (!input || typeof input !== "object") throw new Error("网页操作无效");
      if (input.action === "hide") {
        hide();
        return;
      }
      if (!/^[a-f0-9-]{36}$/.test(input.owner ?? ""))
        throw new Error("网页会话无效");
      if (input.action === "release") {
        for (const tab of [...tabs.values()])
          if (tab.owner === input.owner) close(tab);
        return;
      }
      if (!/^[a-f0-9-]{36}$/.test(input.id ?? ""))
        throw new Error("网页标签无效");
      const key = `${input.owner}:${input.id}`;
      let tab = tabs.get(key);
      if (input.action === "navigate") {
        const url = urlOf(input.url);
        if (!tab) {
          if (tabs.size >= 12)
            throw new Error("最多保留 12 个网页标签，请先关闭部分标签");
          const view = new WebContentsView({
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              webSecurity: true,
              partition: "persist:pi-desktop-browser",
            },
          });
          view.setVisible(false);
          tab = { owner: input.owner, id: input.id, view };
          tabs.set(key, tab);
          window.contentView.addChildView(view);
          const browserSession = view.webContents.session;
          if (!securedSessions.has(browserSession)) {
            securedSessions.add(browserSession);
            browserSession.setPermissionRequestHandler(
              (_wc, _permission, done) => done(false),
            );
            browserSession.setPermissionCheckHandler(() => false);
            browserSession.on("will-download", (event) =>
              event.preventDefault(),
            );
          }
          view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          for (const event of ["will-navigate", "will-redirect"])
            view.webContents.on(event, (event, address) => {
              try {
                urlOf(event.url ?? address);
              } catch {
                event.preventDefault();
              }
            });
          for (const event of [
            "did-navigate",
            "did-navigate-in-page",
            "page-title-updated",
            "did-start-loading",
            "did-stop-loading",
          ])
            view.webContents.on(event, () => send(tab));
          view.webContents.on(
            "did-fail-load",
            (_event, code, message, _url, main) => {
              if (main && code !== -3) {
                tab.error = message;
                send(tab);
              }
            },
          );
        }
        tab.error = undefined;
        void tab.view.webContents.loadURL(url).catch((error) => {
          tab.error = error.message;
          send(tab);
        });
        return send(tab);
      }
      if (!tab) throw new Error("网页标签已关闭");
      const wc = tab.view.webContents;
      if (input.action === "close") {
        close(tab);
        return;
      }
      if (input.action === "layout") {
        const { width, height } = window.getContentBounds(),
          box = input.bounds;
        if (
          !box ||
          ![box.x, box.y, box.width, box.height].every(Number.isFinite)
        )
          throw new Error("网页区域无效");
        hide();
        const x = Math.max(0, Math.min(width, Math.round(box.x))),
          y = Math.max(0, Math.min(height, Math.round(box.y)));
        const w = Math.max(0, Math.min(width - x, Math.round(box.width))),
          h = Math.max(0, Math.min(height - y, Math.round(box.height)));
        tab.view.setBounds({ x, y, width: w, height: h });
        tab.view.setVisible(w > 0 && h > 0);
      } else if (input.action === "back") {
        // Chromium skips entries without page activation on goBack(). Our
        // address bar lives in another renderer, so use the actual history index.
        const index = wc.navigationHistory.getActiveIndex();
        if (index > 0) wc.navigationHistory.goToIndex(index - 1);
      } else if (input.action === "forward") {
        const index = wc.navigationHistory.getActiveIndex();
        if (index < wc.navigationHistory.length() - 1)
          wc.navigationHistory.goToIndex(index + 1);
      } else if (input.action === "reload") {
        tab.error = undefined;
        wc.reload();
      } else if (input.action !== "state") throw new Error("网页操作无效");
      return send(tab);
    },
  };
}
