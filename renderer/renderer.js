// This renderer script is used by multiple pages (index.html and autorizador.html).
// Guard access to DOM elements so the script doesn't throw when an element is
// absent on a particular page.

const fileInput = document.getElementById("fileInput");
const startBtn = document.getElementById("startAutomation");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const btnAutorizador = document.getElementById("btnAutorizador");
const logArea = document.getElementById("logArea");
const backToIndexBtn = document.getElementById("backToIndex");
const btnMargem = document.getElementById("btn-margem");
const startMargemBtn = document.getElementById("startMargem");
const margemEmail = document.getElementById("margemEmail");
const margemPassword = document.getElementById("margemPassword");
const margemHeadless = document.getElementById("margemHeadless");
const margemFile = document.getElementById("margemFile");

// Navigation from index -> autorizador
if (btnAutorizador && window.electronAPI && typeof window.electronAPI.openPage === "function") {
  btnAutorizador.addEventListener("click", () => {
    window.electronAPI.openPage("autorizador");
  });
}

if (btnMargem && window.electronAPI && typeof window.electronAPI.openPage === "function") {
  btnMargem.addEventListener("click", () => {
    window.electronAPI.openPage("margem");
  });
}

// Start automation (only present on autorizador.html)
if (startBtn) {
  // Voltar para index.html
  if (backToIndexBtn && window.electronAPI && typeof window.electronAPI.openPage === "function") {
    backToIndexBtn.addEventListener("click", () => {
      window.electronAPI.openPage("index");
    });
  }

  
  startBtn.addEventListener("click", () => {
    if (!fileInput || !fileInput.files.length) {
      alert("Selecione um arquivo primeiro!");
      return;
    }

    const filePath = fileInput.files[0].path;

    if (progressBar) progressBar.style.width = "0%";
    if (progressText) progressText.textContent = "Iniciando...";

    // Collect options from UI
    const headlessCheckbox = document.getElementById("headlessCheckbox");
    const minTypingInput = document.getElementById("minTypingSec");
    const maxTypingInput = document.getElementById("maxTypingSec");

    const headless = headlessCheckbox ? !!headlessCheckbox.checked : false;
    let minTypingSec = minTypingInput ? parseFloat(minTypingInput.value) : 1;
    let maxTypingSec = maxTypingInput ? parseFloat(maxTypingInput.value) : 5;

    if (isNaN(minTypingSec) || minTypingSec < 0) minTypingSec = 1;
    if (isNaN(maxTypingSec) || maxTypingSec < minTypingSec) maxTypingSec = Math.max(minTypingSec, 5);

    const options = {
      headless,
      typingRangeSeconds: { minSeconds: minTypingSec, maxSeconds: maxTypingSec }
    };


  // Clear log for this session and log the start
  if (logArea) logArea.textContent = "";
  if (logArea) appendLog(`Iniciando automação — arquivo: ${filePath} — headless: ${headless} — typing: ${minTypingSec}s to ${maxTypingSec}s`);

    if (window.electronAPI && typeof window.electronAPI.startAutomation === "function") {
      window.electronAPI.startAutomation(filePath, options);
    } else {
      console.error("electronAPI.startAutomation não disponível");
      if (logArea) appendLog("Erro: electronAPI.startAutomation não disponível");
    }
  });


  // Recebe progresso
  if (window.electronAPI && typeof window.electronAPI.onProgress === "function") {
    window.electronAPI.onProgress((data) => {
      if (progressBar) progressBar.style.width = data.percent + "%";
      if (progressText) progressText.textContent = `${data.current}/${data.total} — ${data.message}`;
      if (logArea) appendLog(`${data.current}/${data.total} — ${data.message}`);
    });
  }

  // Recebe logs detalhados do main/robo
  if (window.electronAPI && typeof window.electronAPI.onLog === "function") {
    window.electronAPI.onLog((log) => {
      try {
        // log can be { level, message, meta }
        const meta = log && log.meta ? ` ${JSON.stringify(log.meta)}` : "";
        appendLog(`${(log && log.level) || "info"}: ${log && log.message}${meta}`);
      } catch (e) {
        appendLog(`log: ${JSON.stringify(log)}`);
      }
    });
  }

  // Finalização
  if (window.electronAPI && typeof window.electronAPI.onAutomationFinished === "function") {
    window.electronAPI.onAutomationFinished((msg) => {
      if (progressText) progressText.textContent = msg;
      if (logArea) appendLog(`Finalizado: ${msg}`);
    });
  }
}

// Helper to append timestamped logs to the UI area
function appendLog(text) {
  try {
    const now = new Date();
    const ts = now.toLocaleTimeString();
    logArea.textContent += `[${ts}] ${text}\n`;
    // auto-scroll to bottom
    logArea.scrollTop = logArea.scrollHeight;
  } catch (e) {
    // ignore if logArea not present
  }
}

// Auto-focus email field when on margem page to prompt credentials
try {
  if (margemEmail) {
    margemEmail.focus();
  }
} catch (e) {}

// Attach start handler for margem page independently so it works when margem.html is loaded
if (startMargemBtn) {
  startMargemBtn.addEventListener("click", () => {
  const url = "https://admin.bancoprata.com.br/";
  const email = margemEmail ? margemEmail.value : "";
  const password = margemPassword ? margemPassword.value : "";
  const headless = margemHeadless ? !!margemHeadless.checked : false;
  const filePath = (margemFile && margemFile.files && margemFile.files[0]) ? margemFile.files[0].path : null;

    // Require credentials to standardize per-client access
    if (!email || !password) {
      alert("Informe seu E-MAIL e SENHA para login antes de iniciar a consulta.");
      if (margemEmail) margemEmail.focus();
      return;
    }

    if (logArea) logArea.textContent = "";
    if (logArea) appendLog(`Iniciando consulta de margem — ${url}`);

  const payload = { url, email, password, options: { headless }, filePath };
    if (window.electronAPI && typeof window.electronAPI.startMargem === "function") {
      window.electronAPI.startMargem(payload);
    } else {
      appendLog("Erro: startMargem não disponível");
    }
  });
}
