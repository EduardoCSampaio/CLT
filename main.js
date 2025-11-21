const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

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

  // Remove barra de menu para visual mais profissional
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

// Abrir telas
ipcMain.on("open-page", (event, page) => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;

  if (page === "autorizador") {
    win.loadFile(path.join(__dirname, "renderer", "autorizador.html"));
  }

  if (page === "margem") {
    win.loadFile(path.join(__dirname, "renderer", "margem.html"));
  }

  if (page === "index") {
    win.loadFile(path.join(__dirname, "renderer", "index.html"));
  }
});

// Iniciar automação
ipcMain.on("start-automation", async (event, payload) => {
  // payload can be a string (legacy) or an object { filePath, options }
  const filePath = typeof payload === "string" ? payload : payload && payload.filePath;
  const options = payload && payload.options ? payload.options : {};

  console.log("📄 Arquivo recebido:", filePath, "opções:", options);

  if (!filePath || typeof filePath !== "string") {
    return event.reply("automation-finished", "Erro: Nenhum arquivo recebido.");
  }

  try {
    const runAutorizador = require("./robo/autorizador.js");

    const progressCallback = (progress) => {
      event.reply("automation-progress", progress);
    };

    const logCallback = (log) => {
      // forward any detailed logs to the renderer
      event.reply("automation-log", log);
    };

    await runAutorizador(filePath, progressCallback, options, logCallback);

    event.reply("automation-finished", "Automação concluída com sucesso!");
  } catch (error) {
    console.error("❌ Erro na automação:", error);
    event.reply("automation-log", { level: "error", message: "Erro na automação: " + (error && error.message), error: String(error && error.stack) });
    event.reply("automation-finished", "Erro ao executar a automação.");
  }
});

ipcMain.on("start-margem", async (event, payload) => {
  // A correção é simplesmente passar o payload ORIGINAL e COMPLETO para o robô.
  // O robo/margem.js já está preparado para encontrar o filePath dentro dele.
  
  event.reply("automation-log", { level: "info", message: `Payload recebido e encaminhado para o robô: ${JSON.stringify(payload)}` });

  try {
    const runMargem = require("./robo/margem.js");

    const progressCb = (progress) => event.reply("automation-progress", progress);
    const logCb = (log) => event.reply("automation-log", log);

    // Agora, o payload completo é passado, incluindo o precioso filePath.
    await runMargem(payload, progressCb, logCb);

    event.reply("automation-finished", "Consulta de margem concluída com sucesso!");
  } catch (err) {
    console.error("Erro na margem:", err);
    event.reply("automation-log", { level: "error", message: "Erro na margem: " + (err && err.message), error: String(err && err.stack) });
    event.reply("automation-finished", "Erro ao executar consulta de margem.");
  }
});

// Fechar app
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
