const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  startAutomation: (filePath, options) =>
    // send an object payload so we can include options in the future
    ipcRenderer.send("start-automation", { filePath, options }),

  startMargem: (payload) =>
    ipcRenderer.send("start-margem", payload),

  onAutomationFinished: (callback) =>
    ipcRenderer.on("automation-finished", (event, msg) => callback(msg)),

  onProgress: (callback) =>
    ipcRenderer.on("automation-progress", (event, data) => callback(data)),

  onLog: (callback) =>
    ipcRenderer.on("automation-log", (event, data) => callback(data)),

  openPage: (page) =>
    ipcRenderer.send("open-page", page)
});
