const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

function emitLogCb(onLog, level, message, meta){
  const payload = { level, message, meta };
  try{ if (typeof onLog === 'function') onLog(payload); }catch(e){}
  if(level==='error') console.error(message, meta||'');
  else if(level==='warn') console.warn(message, meta||'');
  else console.log(message, meta||'');
}

function readCpfsFromCsv(filePath, onLog) {
    if (!filePath) return [];
    emitLogCb(onLog, 'info', `Iniciando leitura do arquivo CSV: ${filePath}`);
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) {
            emitLogCb(onLog, 'warn', 'Arquivo CSV está vazio ou contém apenas linhas em branco.');
            return [];
        }

        const header = lines[0].toLowerCase();
        const delimiter = header.includes(';') ? ';' : ',';
        emitLogCb(onLog, 'info', `CSV: Detectado delimitador: '${delimiter}'`);
        
        let cpfColumnIndex = -1;
        let hasHeader = false;
        const headerColumns = header.split(delimiter).map(h => h.replace(/["']/g, '').trim());

        // Procura pela coluna de CPF no cabeçalho
        const cpfKeywords = ['cpf', 'documento', 'document'];
        cpfColumnIndex = headerColumns.findIndex(h => cpfKeywords.some(k => h.includes(k)));

        if (cpfColumnIndex !== -1) {
            hasHeader = true;
            emitLogCb(onLog, 'info', `CSV: Cabeçalho encontrado. Usando coluna ${cpfColumnIndex} ('${headerColumns[cpfColumnIndex]}') para os CPFs.`);
        } else {
            // Se não encontrou um cabeçalho com keywords, assume que é um arquivo sem cabeçalho e usa a primeira coluna
            hasHeader = false;
            cpfColumnIndex = 0;
            emitLogCb(onLog, 'warn', 'CSV: Cabeçalho com a coluna CPF não identificado. Assumindo que a primeira coluna contém os CPFs.');
        }

        const cpfs = [];
        const startLine = hasHeader ? 1 : 0;

        for (let i = startLine; i < lines.length; i++) {
            const columns = lines[i].split(delimiter);
            const cpfCandidate = (columns[cpfColumnIndex] || '').trim();
            const digits = cpfCandidate.replace(/\D/g, '');
            if (digits.length === 11) {
                cpfs.push(digits);
            } else if (digits) {
                emitLogCb(onLog, 'warn', `CSV: Valor ignorado na linha ${i + 1}. CPF inválido: "${cpfCandidate}"`);
            }
        }
        
        const uniqueCpfs = Array.from(new Set(cpfs));
        emitLogCb(onLog, 'info', `CSV: Leitura finalizada. Encontrados ${uniqueCpfs.length} CPFs únicos.`);
        return uniqueCpfs;
    } catch (e) {
        emitLogCb(onLog, 'error', `Falha catastrófica ao ler o arquivo CSV: ${e.message}`);
        return [];
    }
}


async function navigateToConsulta(page, baseUrl, onLog) {
  const targetUrlPart = '/clt/consultar';
  const currentUrl = page.url();

  if (currentUrl.includes(targetUrlPart)) {
    emitLogCb(onLog, 'info', 'Já está na página de consulta, pulando navegação.');
    await page.waitForLoadState('networkidle', { timeout: 2000 }).catch(() => {});
    return;
  }
  
  emitLogCb(onLog, 'info', 'Iniciando navegação para a página de Consulta Margem.');
  let navigated = false;

  try {
    if (baseUrl) {
      const direct = new URL(targetUrlPart, baseUrl).href;
      emitLogCb(onLog, 'info', `Tentando navegação direta para ${direct}`);
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
        emitLogCb(onLog, 'info', `Tentando clicar link candidato: ${sel}`);
        await el.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
        if (page.url().includes(targetUrlPart)) {
          navigated = true;
          break;
        }
      } catch (e) { /* ignore and try next */ }
    }
  }
  
  if (navigated) {
    emitLogCb(onLog, 'info', 'Navegação para Consulta Margem concluída.');
  } else {
    throw new Error('Falha ao navegar para a página de consulta.');
  }
}

async function runMargem(payload, onProgress, onLog){
  const { url, email, password, cpf, steps, options, filePath } = payload || {};
  emitLogCb(onLog, 'info', 'Iniciando robô de consulta de margem.');

  // 1. Carrega os CPFs ANTES de qualquer outra coisa
  let cpfs = [];
  if (filePath) {
      cpfs = readCpfsFromCsv(filePath, onLog);
  } else if (cpf) {
      const singleCpf = (cpf||'').replace(/\D/g,'');
      if(singleCpf) cpfs = [singleCpf];
  }

  // 2. Valida se existem CPFs para processar
  if (!cpfs || cpfs.length === 0) {
    const errorMsg = 'Nenhum CPF válido foi encontrado para processar. Verifique o CPF individual ou o arquivo CSV fornecido.';
    emitLogCb(onLog, 'error', errorMsg);
    if (typeof onProgress === 'function') {
        onProgress({ current: 1, total: 1, percent: 100, message: `Erro: ${errorMsg}` });
    }
    emitLogCb(onLog, 'info', 'Finalizando execução por falta de CPFs.');
    return; // Interrompe a execução aqui.
  }

  // 3. Se houver CPFs, prossegue com a automação
  const headless = options && typeof options.headless === 'boolean' ? options.headless : true;
  emitLogCb(onLog, 'info', `Iniciando navegador no modo ${headless ? 'headless' : 'com interface'}. Total de ${cpfs.length} CPFs para processar.`);
  const browser = await chromium.launch({ headless });
  
  let resultsPath = null;
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    if (filePath) {
      const outDir = path.join(process.cwd(), 'Relatórios Margem');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g,'-');
      resultsPath = path.join(outDir, `resultado-${ts}.csv`);
      try{ fs.writeFileSync(resultsPath, 'CPF;OPERAÇÃO;OBS\n', { encoding: 'utf8' }); }catch(e){}
      emitLogCb(onLog, 'info', `Arquivo de resultados será salvo em: ${resultsPath}`);
    }

    emitLogCb(onLog, 'info', `Navegando para ${url}`);
    await page.goto(url, { timeout: 30000 });
    emitLogCb(onLog, 'info', 'Página carregada');

    try{
      if (email) {
        const selEmail = 'input[type="email"], input[name*=email i], input[id*=email i], input[placeholder*=email i]';
        await page.fill(selEmail, email);
        emitLogCb(onLog, 'info', 'Preenchido e-mail.');
      }
    }catch(e){ emitLogCb(onLog,'warn', 'Falha ao preencher email: '+(e && e.message)); }

    try{
      if (password) {
        const selPass = 'input[type="password"], input[name*=pass i], input[id*=pass i]';
        await page.fill(selPass, password);
        emitLogCb(onLog, 'info', 'Preenchida senha.');
      }
    }catch(e){ emitLogCb(onLog,'warn','Falha ao preencher senha: '+(e && e.message)); }

    try{
      const btnSel = 'button[type="submit"], button.button, button:has-text("Fazer login")';
      await page.click(btnSel, { timeout: 5000 });
      emitLogCb(onLog,'info', 'Clicado botão de login.');
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
    }catch(e){ emitLogCb(onLog,'warn','Não foi possível clicar botão de login: '+(e && e.message)); }

    await navigateToConsulta(page, url, onLog);
    
    let consultButtonSelector = 'button:has-text("Consultar saldo")';
    try {
        await page.waitForSelector(consultButtonSelector, { timeout: 5000 });
        emitLogCb(onLog,'info','Botão de consulta encontrado: "Consultar saldo"');
    } catch (e) {
      emitLogCb(onLog, 'warn', 'Botão "Consultar saldo" não encontrado, o robô tentará pressionar Enter após preencher o CPF.');
      consultButtonSelector = null;
    }
    
    for (let i=0;i<cpfs.length;i++) {
      const currentCpf = cpfs[i];
      emitLogCb(onLog,'info', `Processando ${i+1}/${cpfs.length}: ${currentCpf}`);
      let op = 'Falha';
      let obs = '';
      try{
        await navigateToConsulta(page, url, onLog);
        
        const cpfCandidateSelectors = [
          'div.control.document-input input[type="tel"]', 'input[placeholder="000.000.000-00"]',
          `xpath=//label[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CPF')]/following::input[1]`,
          'input[name*=cpf i]', 'input[id*=cpf i]', 'input[type="tel"]',
        ];
        
        let cpfInputHandle = null;
        for (const s of cpfCandidateSelectors) {
          try {
            const el = await page.waitForSelector(s, { timeout: 200 });
            if (el) {
              cpfInputHandle = el;
              emitLogCb(onLog, 'info', `Encontrado input CPF via selector: ${s}`);
              break;
            }
          } catch (e) {}
        }

        if (!cpfInputHandle){ throw new Error('Input de CPF não encontrado na página.'); }

        await cpfInputHandle.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await cpfInputHandle.type(currentCpf, { delay: 100 });
        
        const filledValue = await cpfInputHandle.inputValue();
        if (filledValue.replace(/\D/g, '') !== currentCpf) {
          throw new Error(`CPF no input (${filledValue}) não bate com o esperado (${currentCpf}).`);
        }
        emitLogCb(onLog,'info', `Preenchido e verificado CPF ${currentCpf}`);
        
        await delay((options && options.margemDelayBeforeClickMs) || 800);

        if (consultButtonSelector){
          await page.click(consultButtonSelector);
          emitLogCb(onLog,'info', 'Clicado botão de consulta');
        } else {
          await cpfInputHandle.press('Enter'); 
          emitLogCb(onLog,'info','Pressionado Enter no input CPF para submeter.');
        }

        const resultSelectors = ['.result', '.saldo', '.consulta-resultado', '.resultado', '.card .body', '.card-body', '.balance', '#saldo'];
        const combinedSelector = resultSelectors.join(',');
        const resultTimeout = (options && options.margemResultTimeoutMs) || 6000;
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(()=>{});
        
        let resultText = '';
        try{
          const el = await page.waitForSelector(combinedSelector, { timeout: resultTimeout });
          if (el) resultText = (await el.innerText()).trim();
        }catch(e){/* not found */}

        if (resultText) {
          op = 'Sucesso';
          obs = resultText.replace(/\r?\n/g,' | ').replace(/;/g,',');
          emitLogCb(onLog,'info', `Resultado para ${currentCpf}: ${obs}`);
        } else {
          op = 'Falha';
          obs = 'Sem resultado detectado dentro do tempo limite';
          emitLogCb(onLog,'warn', `Sem resultado para ${currentCpf} (timeout ${resultTimeout}ms)`);
          if (resultsPath){
            const shotName = `screenshot-${currentCpf}-${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
            const shotPath = path.join(path.dirname(resultsPath), shotName);
            await page.screenshot({ path: shotPath, fullPage: false });
            obs += '; screenshot=' + shotName;
          }
        }
      }catch(e){
        op = 'Falha';
        obs = (e && e.message) || 'Erro desconhecido';
        emitLogCb(onLog,'warn', `Erro processando ${currentCpf}: ${obs}`);
      }

      try{
        const line = `${currentCpf};${op};"${(obs || '').replace(/"/g, '""')}"\n`;
        if (resultsPath) fs.appendFileSync(resultsPath, line, { encoding: 'utf8' });
      }catch(e){ emitLogCb(onLog,'warn','Falha ao gravar resultado: '+(e&&e.message)); }

      if (typeof onProgress === 'function'){
        const percent = Math.round(((i+1)/cpfs.length)*100);
        onProgress({ current: i+1, total: cpfs.length, percent, message: `Processado ${i+1}/${cpfs.length}` });
      }
      await delay(500);
    }

    emitLogCb(onLog,'info','Processamento de CPFs finalizado');

  } catch (err) {
    emitLogCb(onLog, 'error', 'Erro durante execução: '+(err && err.message), { stack: err && err.stack });
    if (typeof onProgress === 'function') onProgress({ current: 1, total: 1, percent: 100, message: 'Erro: '+(err && err.message) });
  } finally {
    try{ await browser.close(); }catch(e){}
    emitLogCb(onLog,'info','Finalizando execução da margem');
  }
}

module.exports = runMargem;
