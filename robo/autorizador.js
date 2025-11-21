const fs = require("fs");
const csv = require("csv-parser");
const { chromium } = require("playwright");

// atraso humano
function delay(min = 300, max = 1200) {
  const t = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((res) => setTimeout(res, t));
}

// digitação humana
// typingOptions: { minSeconds, maxSeconds } -> total time to type the whole text
async function typeHuman(page, selector, text, typingOptions) {
  await page.focus(selector);

  const len = Math.max(String(text || "").length, 1);

  if (typingOptions && typeof typingOptions.minSeconds === "number" && typeof typingOptions.maxSeconds === "number") {
    const minMs = Math.max(0, typingOptions.minSeconds * 1000);
    const maxMs = Math.max(minMs, typingOptions.maxSeconds * 1000);
    const totalMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    const baseDelay = totalMs / len;

    for (let char of text) {
      await page.keyboard.type(char);
      // add small jitter around baseDelay
      const jitter = baseDelay * (Math.random() * 0.6 + 0.7); // 0.7x - 1.3x
      await delay(Math.max(10, Math.floor(jitter)), Math.max(10, Math.ceil(jitter)));
    }
  } else {
    // fallback to original per-character small delays
    for (let char of text) {
      await page.keyboard.type(char);
      await delay(40, 120);
    }
  }
}

async function runAutorizador(filePath, onProgress, options = {}, onLog) {
  const headless = typeof options.headless === "boolean" ? options.headless : false;
  const typingOptions = options.typingRangeSeconds || null; // { minSeconds, maxSeconds }

  // helper for unified logging: console + UI callback
  function emitLog(level, message, meta) {
    try {
      const payload = { level, message, meta };
      if (typeof onLog === "function") onLog(payload);
    } catch (e) {
      // ignore
    }
    if (level === "error") console.error(message, meta || "");
    else if (level === "warn") console.warn(message, meta || "");
    else console.log(message, meta || "");
  }

  emitLog("info", `Lançando browser (headless=${headless})`);
  const browser = await chromium.launch({ headless });
  const dados = [];

  // CSV input
  emitLog("info", `Lendo CSV: ${filePath}`);
  await new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv({ separator: ";" }))
      .on("data", (row) => dados.push(row))
      .on("end", () => {
        emitLog("info", `CSV lido. Linhas: ${dados.length}`);
        resolve();
      })
      .on("error", (err) => {
        emitLog("error", `Erro ao ler CSV: ${err && err.message}`, { stack: err && err.stack });
        reject(err);
      });
  });

  // Resultado em um único CSV com cabeçalho: CPF;NOME;OPERAÇÃO
  // Nome do arquivo: resultado-YYYYMMDD-HHMMSS.csv
  function pad(n) { return n < 10 ? '0' + n : n; }
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const reportsDir = 'Relatórios Autorizador';
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const resultFile = `${reportsDir}/resultado-${yyyy}${mm}${dd}-${hh}${min}${ss}.csv`;
  const resultStream = fs.createWriteStream(resultFile, { flags: "a" });
  resultStream.write("CPF;NOME;OPERAÇÃO\n");

  const total = dados.length;
  let currentCount = 0;

  // Track processed CPFs in this run to avoid duplicate processing
  const seenCpfs = new Set();

  // Cria um contexto com geolocalização automática e permissão concedida.
  // Isso evita que o site mostre um prompt de localização que quebraria a automação.
  // Coordenadas default: São Paulo, Brasil. Altere se precisar outra posição.
  const context = await browser.newContext({
    geolocation: { latitude: -23.55052, longitude: -46.633308 },
    permissions: ["geolocation"],
    timezoneId: "America/Sao_Paulo"
  });

  // Garantir permissão explicitamente para o domínio alvo
  try {
    await context.grantPermissions(["geolocation"], { origin: "https://assina.bancoprata.com.br" });
  } catch (e) {
    // Algumas versões do Playwright aceitam grantPermissions sem origin; ignorar falha não-crítica
    console.warn("Não foi possível conceder permissão específica por origin:", e.message || e);
  }

  const page = await context.newPage();

  for (const item of dados) {
    currentCount++;

    let cpfRaw = item.cpf || item.CPF || "";
    let cpf = String(cpfRaw).trim();
    let nome = (item.nome || item.NOME || "").trim();
    let email = (item.email || item.EMAIL || "").trim();
    let telefone = (item.telefone || item.TELEFONE || "").trim();

    // Skip empty CPF lines
    if (!cpf) {
      emitLog("warn", `Linha ${currentCount}/${total} ignorada: CPF vazio`, { line: currentCount });
      if (typeof onProgress === "function") {
        onProgress({
          current: currentCount,
          total,
          percent: Math.floor((currentCount / total) * 100),
          message: `Ignorado (CPF vazio)`
        });
      }
      continue;
    }

    // Skip duplicate CPFs within the same run
    if (seenCpfs.has(cpf)) {
      emitLog("warn", `Linha ${currentCount}/${total} ignorada: CPF duplicado ${cpf}`, { line: currentCount, cpf });
      if (typeof onProgress === "function") {
        onProgress({
          current: currentCount,
          total,
          percent: Math.floor((currentCount / total) * 100),
          message: `Ignorado (CPF duplicado): ${cpf}`
        });
      }
      continue;
    }

    seenCpfs.add(cpf);

    emitLog("info", `Processando ${currentCount}/${total} — CPF: ${cpf} — Nome: ${nome}`);

    try {
      const targetUrl = "https://assina.bancoprata.com.br/credito-trabalhador/termo-autorizacao";
      emitLog("info", `Navegando para ${targetUrl}`, { cpf, url: targetUrl });
      let pageLoadStatus = 200;
      let pageLoadTimeout = 15000;
      try {
        const resp = await page.goto(targetUrl, { timeout: pageLoadTimeout });
        pageLoadStatus = resp && resp.status ? resp.status() : 0;
        emitLog("info", `Status do carregamento da página: ${pageLoadStatus}`);
      } catch (e) {
        emitLog("warn", `Erro ao carregar página para CPF ${cpf}: ${e && e.message}`);
        pageLoadStatus = 0;
      }

      // Timeout dinâmico: se carregou ok (status 200), usa 20s; senão, 40s
      let waitTimeout = pageLoadStatus === 200 ? 20000 : 40000;
      emitLog("info", `Timeout para aguardar sucesso: ${waitTimeout/1000}s`, { cpf });

      emitLog("info", `Preenchendo campos para CPF ${cpf}`);
      await typeHuman(page, 'input[name="CPF"]', cpf, typingOptions);
      await typeHuman(page, 'input[name="Nome"]', nome, typingOptions);
      await typeHuman(page, 'input[name="E-mail"]', email, typingOptions);
      await typeHuman(page, 'input[name="Número de telefone"]', telefone, typingOptions);

      emitLog("info", `Assinalando checkboxes para CPF ${cpf}`);
      for (let i = 1; i <= 3; i++) {
        try {
          await page.check(`label.checkbox:nth-of-type(${i}) input`);
        } catch (e) {
          emitLog("warn", `Não foi possível checar checkbox ${i} para CPF ${cpf}: ${e && e.message}`);
        }
      }

      await delay(700, 1500);
      emitLog("info", `Clicando em submit para CPF ${cpf}`);
      await page.click('button[type="submit"]');

      // aguarda o redirect de sucesso
      const successUrl = "https://assina.bancoprata.com.br/inss/form-successfully-sent";
      emitLog("info", `Aguardando redirect para ${successUrl} (timeout ${waitTimeout}ms)`);
      let success = false;
      try {
        await page.waitForURL(successUrl, { timeout: waitTimeout });
        success = true;
      } catch (timeoutErr) {
        emitLog("warn", `Timeout de ${waitTimeout/1000}s para CPF ${cpf}. Credenciais incorretas ou erro de validação.`, { cpf, error: timeoutErr && timeoutErr.message });
      }

      if (success) {
        // SUCESSO
        emitLog("info", `Sucesso no CPF ${cpf}. Gravando resultado.`);
        resultStream.write(`${cpf};${nome};Sucesso\n`);
        if (typeof onProgress === "function") {
          onProgress({
            current: currentCount,
            total,
            percent: Math.floor((currentCount / total) * 100),
            message: `Sucesso: ${cpf}`
          });
        }
      } else {
        // FALHA por timeout
        emitLog("error", `Falha no CPF ${cpf}: Credenciais incorretas (timeout ${waitTimeout/1000}s)`, { cpf });
        resultStream.write(`${cpf};${nome};Falha (Credenciais incorretas)\n`);
        if (typeof onProgress === "function") {
          onProgress({
            current: currentCount,
            total,
            percent: Math.floor((currentCount / total) * 100),
            message: `Falha: ${cpf} (Credenciais incorretas)`
          });
        }
      }

    } catch (err) {

      // FALHA
      emitLog("error", `Falha ao processar CPF ${cpf}: ${err && err.message}`, { stack: err && err.stack });
      resultStream.write(`${cpf};${nome};Falha\n`);

      if (typeof onProgress === "function") {
        onProgress({
          current: currentCount,
          total,
          percent: Math.floor((currentCount / total) * 100),
          message: `Falha: ${cpf}`
        });
      }
    }
    emitLog("info", `Aguardando intervalo entre execuções para próximo registro`);
    await delay(1500, 3000);
  }

  resultStream.close();
  emitLog("info", "Fechando browser e finalizando automação");
  await browser.close();
}

module.exports = runAutorizador;
