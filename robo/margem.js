const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

function emitLogCb(onLog, level, message, meta){
  const payload = { level, message, meta };
  try{ if (typeof onLog === 'function') onLog(payload); }catch(e){}
  if(level==='error') console.error(message, meta||'');
  else if(level==='warn') console.warn(message, meta||'');
  else console.log(message, meta||'');
}

// =================================================================
// FUNÇÃO DE LEITURA DE CSV
// =================================================================
function readCpfsFromCsv(filePath, onLog) {
    return new Promise((resolve, reject) => {
        const absolutePath = path.resolve(filePath);
        if (!fs.existsSync(absolutePath)) {
            emitLogCb(onLog, 'error', `[LEITOR] FALHA CRÍTICA: O arquivo não existe no caminho: ${absolutePath}`);
            return resolve([]);
        }
        const cpfs = [];
        fs.createReadStream(absolutePath)
            .pipe(csv({ separator: ';', mapHeaders: ({ header }) => header.trim().toLowerCase() }))
            .on('data', (row) => {
                const cpfKey = Object.keys(row).find(key => key.includes('cpf') || key.includes('documento'));
                if (cpfKey && row[cpfKey]) {
                    const digits = (row[cpfKey] || '').replace(/\\D/g, '');
                    if (digits.length === 11) cpfs.push(digits);
                }
            })
            .on('end', () => {
                const uniqueCpfs = Array.from(new Set(cpfs));
                emitLogCb(onLog, 'info', `Leitura finalizada. Encontrados ${uniqueCpfs.length} CPFs únicos.`);
                resolve(uniqueCpfs);
            })
            .on('error', (err) => {
                emitLogCb(onLog, 'error', `[LEITOR] Erro CRÍTICO no parser do CSV: ${err.message}`);
                reject(err);
            });
    });
}

// =================================================================
// FUNÇÃO DE NAVEGAÇÃO (QUE ESTAVA FALTANDO)
// =================================================================
async function navigateToConsulta(page, baseUrl, onLog) {
  const targetUrlPart = '/clt/consultar';
  const currentUrl = page.url();

  if (currentUrl.includes(targetUrlPart)) {
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
    return;
  }
  
  emitLogCb(onLog, 'info', 'Navegando para a página de Consulta Margem.');
  let navigated = false;

  try {
    if (baseUrl) {
      const direct = new URL(targetUrlPart, baseUrl).href;
      await page.goto(direct, { timeout: 20000, waitUntil: 'networkidle' });
      await delay(800);
      if (page.url().includes(targetUrlPart)) navigated = true;
    }
  } catch (e) {
    emitLogCb(onLog, 'warn', `Falha na navegação direta: ${e.message}`);
  }

  if (!navigated) {
    const linkCandidates = [
      'a[href="/clt/consultar"]', 'a[href*="/clt"]', 'a:has-text("Consulta Margem")',
      'a:has-text("Consultar Margem")', 'a:has-text("Margem")'
    ];
    for (const sel of linkCandidates) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        await el.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        if (page.url().includes(targetUrlPart)) {
          navigated = true;
          break;
        }
      } catch (e) { /* ignore and try next */ }
    }
  }
  
  if (!navigated) {
    throw new Error('Falha ao navegar para a página de consulta.');
  }
}

// =================================================================
// FUNÇÃO PRINCIPAL DO ROBÔ
// =================================================================
async function runMargem(payload, onProgress, onLog){
  emitLogCb(onLog, 'info', `Payload recebido: ${JSON.stringify(payload)}`);
  
  const { url, email, password, options } = payload || {};
  const filePath = payload.filePath || payload.path;
  
  if (!filePath) {
      const errorMsg = 'Nenhum arquivo CSV foi fornecido no payload.';
      emitLogCb(onLog, 'error', errorMsg);
      if (typeof onProgress === 'function') onProgress({ current: 1, total: 1, percent: 100, message: `Erro: ${errorMsg}` });
      return;
  }

  const cpfs = await readCpfsFromCsv(filePath, onLog);

  if (!cpfs || cpfs.length === 0) {
    const errorMsg = 'Nenhum CPF válido foi encontrado para processar no arquivo CSV.';
    emitLogCb(onLog, 'error', errorMsg);
    if (typeof onProgress === 'function') onProgress({ current: 1, total: 1, percent: 100, message: `Erro: ${errorMsg}` });
    return;
  }

  const headless = options && typeof options.headless === 'boolean' ? options.headless : true;
  emitLogCb(onLog, 'info', `Iniciando navegador no modo ${headless ? 'headless' : 'com interface'}. Total de ${cpfs.length} CPFs para processar.`);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const outDir = path.join(process.cwd(), 'Relatórios Margem');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const resultsPath = path.join(outDir, `resultado-${ts}.csv`);
  try { fs.writeFileSync(resultsPath, 'CPF;OPERACAO;OBS\n', { encoding: 'utf8' }); } catch(e) {}

  try {
    emitLogCb(onLog, 'info', `Navegando para ${url}`);
    await page.goto(url, { timeout: 30000 });

    if (email) await page.fill('input[type="email"], input[name*=email i]', email);
    if (password) await page.fill('input[type="password"], input[name*=pass i]', password);
    
    await page.click('button[type="submit"], button:has-text("Fazer login")');
    // TIMING OTIMIZADO: Reduzido de 15s para 10s
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{});

    await navigateToConsulta(page, url, onLog);
    
    for (let i = 0; i < cpfs.length; i++) {
      const currentCpf = cpfs[i];
      emitLogCb(onLog, 'info', `Processando ${i + 1}/${cpfs.length}: ${currentCpf}`);
      let op = 'Falha';
      let obs = '';

      try {
        await navigateToConsulta(page, url, onLog);
        
        emitLogCb(onLog, 'info', 'Procurando campo CPF...');
        const cpfSelector = 'input[placeholder="000.000.000-00"]';
        const cpfInputHandle = await page.waitForSelector(cpfSelector, { state: 'visible', timeout: 10000 });
        await cpfInputHandle.fill(currentCpf);
        emitLogCb(onLog, 'info', `CPF ${currentCpf} inserido.`);

        // ============================================================================================
        // ATENÇÃO: AINDA PRECISAMOS RESOLVER O "VÍNCULO EMPREGATÍCIO"
        // Se este campo for obrigatório, o robô vai falhar aqui. Me diga o que fazer.
        // ============================================================================================
        
        emitLogCb(onLog, 'info', 'Clicando no botão de consulta...');
        const buttonSelector = 'button:has-text("Consultar saldo")';
        await page.click(buttonSelector);
        
        emitLogCb(onLog, 'info', 'Aguardando resultado aparecer no histórico de consultas...');
        const resultSelector = `xpath=//tr[contains(., '${currentCpf}')]//td[contains(@class, 'table-status')]//span`;
        // TIMING OTIMIZADO: Reduzido de 20s para 10s
        const resultEl = await page.waitForSelector(resultSelector, { timeout: 10000 });
        
        const resultText = (await resultEl.innerText()).trim();
        obs = resultText;

        if (obs.toLowerCase().includes('sucesso')) {
            op = 'Sucesso';
        } else {
            op = 'Falha';
        }
        emitLogCb(onLog, 'info', `Resultado para ${currentCpf}: ${op} - ${obs}`);

      } catch (e) {
          obs = e.message || 'Erro desconhecido durante a consulta.';
          emitLogCb(onLog, 'error', `Falha ao processar CPF ${currentCpf}: ${obs}`);
          try {
              const errorDir = path.join(outDir, 'erros');
              if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir, { recursive: true });
              const errorImagePath = path.join(errorDir, `erro-${currentCpf}-${Date.now()}.png`);
              await page.screenshot({ path: errorImagePath });
              emitLogCb(onLog, 'info', `Screenshot do erro salvo em: ${errorImagePath}`);
              obs += ` | Screenshot: ${path.basename(errorImagePath)}`;
          } catch (screenshotError) {
              emitLogCb(onLog, 'error', `Falha ao tirar screenshot: ${screenshotError.message}`);
          }
      }
      
      const line = `${currentCpf};${op};"${(obs || '').replace(/"/g, '""')}"\n`;
      fs.appendFileSync(resultsPath, line, { encoding: 'utf8' });

      if (typeof onProgress === 'function'){
        const percent = Math.round(((i+1)/cpfs.length)*100);
        onProgress({ current: i+1, total: cpfs.length, percent, message: `Processado ${i+1}/${cpfs.length}` });
      }
      // TIMING OTIMIZADO: Delay reduzido de 1000ms para 250ms
      await delay(250); 
    }
  } catch (err) {
    emitLogCb(onLog, 'error', 'Erro catastrófico durante execução: '+(err && err.message), { stack: err && err.stack });
  } finally {
    await browser.close();
    emitLogCb(onLog,'info','Finalizando execução da margem');
  }
}





module.exports = runMargem;
