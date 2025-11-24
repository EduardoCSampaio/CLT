const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.removeMenu();

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on("open-page", (event, page) => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;

  if (page === "autorizador") {
    win.loadFile(path.join(__dirname, "renderer", "autorizador.html"));
  } else if (page === "margem") {
    win.loadFile(path.join(__dirname, "renderer", "margem.html"));
  } else if (page === "index") {
    win.loadFile(path.join(__dirname, "renderer", "index.html"));
  }
});

ipcMain.on("start-automation", async (event, payload) => {
  const filePath = typeof payload === "string" ? payload : payload && payload.filePath;
  let options = payload && payload.options ? payload.options : {};

  if (!filePath || typeof filePath !== "string") {
    return event.reply("automation-finished", "Erro: Nenhum arquivo recebido.");
  }

  const reportsPath = path.join(app.getPath('userData'), 'relatorios');
  if (!fs.existsSync(reportsPath)) {
      fs.mkdirSync(reportsPath, { recursive: true });
  }
  options = { ...options, reportsPath };

  try {
    const runAutorizador = require("./robo/autorizador.js");
    const progressCallback = (progress) => event.reply("automation-progress", progress);
    const logCallback = (log) => event.reply("automation-log", log);

    await runAutorizador(filePath, progressCallback, options, logCallback);

    event.reply("automation-finished", "Automação concluída com sucesso!");
  } catch (error) {
    event.reply("automation-log", { level: "error", message: "Erro na automação: " + (error && error.message), error: String(error && error.stack) });
    event.reply("automation-finished", "Erro ao executar a automação.");
  }
});

ipcMain.on("start-margem", async (event, payload) => {
  const reportsPath = path.join(app.getPath('userData'), 'relatorios');
  if (!fs.existsSync(reportsPath)) {
      fs.mkdirSync(reportsPath, { recursive: true });
  }

  const newPayload = { ...payload, reportsPath };

  event.reply("automation-log", { level: "info", message: `Payload final enviado para o robô: ${JSON.stringify(newPayload)}` });

  try {
    const runMargem = require("./robo/margem.js");
    const progressCb = (progress) => event.reply("automation-progress", progress);
    const logCb = (log) => event.reply("automation-log", log);

    await runMargem(newPayload, progressCb, logCb);

    event.reply("automation-finished", "Consulta de margem concluída com sucesso!");
  } catch (err) {
    event.reply("automation-log", { level: "error", message: "Erro na margem: " + (err && err.message), error: String(err && err.stack) });
    event.reply("automation-finished", "Erro ao executar consulta de margem.");
  }
});

ipcMain.on("open-csv-folder", (event) => {
    const reportsPath = path.join(app.getPath('userData'), 'relatorios');

    if (!fs.existsSync(reportsPath)) {
        fs.mkdirSync(reportsPath, { recursive: true });
    }

    shell.openPath(reportsPath);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});