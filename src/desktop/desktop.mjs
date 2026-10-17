// Window isolation and external-navigation policy adapted from Harness main.ts.
// Managed mode owns the Durable host. URL mode attaches to the existing TUI host.
import { app, BrowserWindow, shell, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { launchService } from "../control-plane/process.mjs";
import { createBrowserPanels } from "./browser-panels.mjs";

const managed = process.argv.includes("--managed");
const address =
  process.argv.find((argument) => /^https?:\/\//.test(argument)) ??
  (managed ? undefined : process.env.PI_DESK_URL);
let target = address ? new URL(address) : undefined;
if (target && !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
  throw new Error("桌面壳只连接本机 pi extension");
if (target && !["http:", "https:"].includes(target.protocol))
  throw new Error("不支持的协议");
if (target && (target.username || target.password))
  throw new Error("URL 不能包含凭据");
app.setName("Pi Desk");
app.setPath("userData", join(app.getPath("appData"), "pi-desk"));
let ownedHost,
  quitting = false;
const browserPanels = new Map();
function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 780,
    minHeight: 600,
    title: "Pi Desk",
    backgroundColor: "#161d27",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: fileURLToPath(new URL("./desktop-preload.cjs", import.meta.url)),
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).protocol === "https:") void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== target.origin) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.removeMenu();
  const contentsId = window.webContents.id;
  browserPanels.set(contentsId, createBrowserPanels(window));
  window.on("closed", () => browserPanels.delete(contentsId));
  void window.loadURL(target.href);
}
ipcMain.handle("pi-desk:directory", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (
    !window ||
    event.senderFrame !== event.sender.mainFrame ||
    new URL(event.senderFrame.url).origin !== target.origin
  )
    throw new Error("目录选择只能由本机 Desktop 页面发起");
  const result = await dialog.showOpenDialog(window, {
    title: "选择项目文件夹",
    properties: ["openDirectory"],
  });
  return result.canceled ? undefined : result.filePaths[0];
});
function localWindow(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (
    !window ||
    event.senderFrame !== event.sender.mainFrame ||
    new URL(event.senderFrame.url).origin !== target.origin
  )
    throw new Error("文件上下文只能由本机 Desktop 页面发起");
  return window;
}
ipcMain.handle("pi-desk:files", async (event) => {
  const result = await dialog.showOpenDialog(localWindow(event), {
    title: "添加本地文件引用",
    properties: ["openFile", "multiSelections"],
  });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle("pi-desk:context-file", async (event, file) => {
  localWindow(event);
  // Pasted blobs have no original path. Persist locally so Pi can read them
  // later, including after a session resume; never pass bytes through HTTP.
  if (
    typeof file?.name !== "string" ||
    !file.name ||
    [".", ".."].includes(file.name) ||
    file.name.length > 200 ||
    /[\\/\x00-\x1f]/.test(file.name) ||
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength > 4 * 1024 * 1024
  )
    throw new Error("剪贴板附件无效或超过 4 MiB，请先保存文件再选择");
  const directory = join(
    app.getPath("userData"),
    "context-files",
    randomUUID(),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, file.name);
  await writeFile(path, file.bytes, { mode: 0o600, flag: "wx" });
  return path;
});
ipcMain.handle("pi-desk:browser", (event, input) => {
  if (
    event.senderFrame !== event.sender.mainFrame ||
    new URL(event.senderFrame.url).origin !== target.origin
  )
    throw new Error("网页面板只能由本机 Desktop 页面控制");
  const panels = browserPanels.get(event.sender.id);
  if (!panels) throw new Error("桌面窗口已关闭");
  return panels.execute(input);
});
// Register readiness work without blocking evaluation of the Electron main module.
void app
  .whenReady()
  .then(async () => {
    if (!target) {
      const index = process.argv.indexOf("--managed");
      const options =
        index >= 0 ? JSON.parse(process.argv[index + 1] ?? "{}") : {};
      if (options.singleProcess) {
        const { startDurableDesk } = await import(
          "../server/durable-server.mjs"
        );
        ownedHost = await startDurableDesk(options);
      } else {
        ownedHost = launchService(
          fileURLToPath(new URL("./host-worker.mjs", import.meta.url)),
          options,
        );
        const ready = await ownedHost.ready;
        ownedHost.url = ready.url;
        ownedHost.child.once("exit", () => {
          if (!quitting) {
            console.error("Desktop 宿主已退出");
            app.quit();
          }
        });
      }
      target = new URL(ownedHost.url);
    }
    createWindow();
  })
  .catch((error) => {
    console.error("Pi Desk 启动失败：", error.message);
    app.quit();
  });
app.on("before-quit", (event) => {
  if (!ownedHost || quitting) return;
  event.preventDefault();
  void ownedHost.stop().then(
    () => {
      quitting = true;
      app.quit();
    },
    (error) => {
      console.error("Agent 存储关闭失败：", error.message);
      quitting = true;
      app.exit(1);
    },
  );
});
app.on("activate", () => {
  if (target && !BrowserWindow.getAllWindows().length) createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
