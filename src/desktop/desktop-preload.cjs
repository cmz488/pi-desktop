const { contextBridge, ipcRenderer, webUtils } = require("electron");
contextBridge.exposeInMainWorld("piDesk", {
  pickDirectory: () => ipcRenderer.invoke("pi-desk:directory"),
  pickFiles: () => ipcRenderer.invoke("pi-desk:files"),
  filePath: (file) => webUtils.getPathForFile(file),
  cacheContextFile: (file) => ipcRenderer.invoke("pi-desk:context-file", file),
  browserCommand: (input) => ipcRenderer.invoke("pi-desk:browser", input),
  onBrowserState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("pi-desk:browser-state", listener);
    return () => ipcRenderer.removeListener("pi-desk:browser-state", listener);
  },
});
