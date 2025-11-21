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

function readCpfsFromCsv(filePath){
  if (!filePath) return [];
  try{
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if (lines.length === 0) return [];

    // If first line looks like header, try to detect CPF column; otherwise take first column
    const header = lines[0];
    const delimiter = header.includes(';') ? ';' : (header.includes(',') ? ',' : '\n');
    const cpfs = [];
    for (let i=0;i<lines.length;i++){
      const parts = delimiter === '\n' ? [lines[i]] : lines[i].split(delimiter).map(p=>p.trim());
      // Heuristic: pick first column that contains digits; if header row contains non-digits, skip it
      let candidate = parts[0];
      if (i===0){
        // if header contains letters, try find column index with 'cpf' or 'document'
        if (/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(header)){
          let idx = parts.findIndex(p=>/cpf|documento|document/i.test(p));
          if (idx === -1) idx = 0;
          candidate = parts[idx];
          // skip header
          continue;
        }
      }
      // normalize digits only
      const digits = (candidate||'').replace(/\D/g,'');
      if (digits) cpfs.push(digits);
    }
    // remove duplicates
    return Array.from(new Set(cpfs));
  }catch(e){
    return [];
  }
}

async function runMargem(payload, onProgress, onLog){
  const { url, email, password, cpf, steps, options, filePath } = payload || {};
  const headless = options && typeof options.headless === 'boolean' ? options.headless : true;

  emitLogCb(onLog, 'info', `Iniciando margem — url=${url} headless=${headless}`);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  // prepare results file if batch
  let resultsPath = null;
  let cpfs = [];
  if (filePath) {
    cpfs = readCpfsFromCsv(filePath || '');
    const outDir = path.join(process.cwd(), 'Relatórios Margem');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    resultsPath = path.join(outDir, `resultado-${ts}.csv`);
    try{ fs.writeFileSync(resultsPath, 'CPF;OPERAÇÃO;OBS\n', { encoding: 'utf8' }); }catch(e){}
    emitLogCb(onLog, 'info', `Batch detectado: ${cpfs.length} CPFs lidos. Resultado em: ${resultsPath}`);
  } else if (cpf) {
    cpfs = [ (cpf||'').replace(/\D/g,'') ];
  } else {
    // Do not abort: still proceed to login and navigation. CPF will only be used during consultation.
    cpfs = [];
    emitLogCb(onLog,'info','Nenhum CPF ou arquivo CSV fornecido — executando fluxo sem CPFs (consulta manual ou passos).');
  }

  try {
    emitLogCb(onLog, 'info', `Navegando para ${url}`);
    const resp = await page.goto(url, { timeout: 30000 });
    emitLogCb(onLog, 'info', `Página carregada, status=${resp && resp.status ? resp.status() : 'unknown'}`);

    // Preencher login: tente selectors comuns
    try{
      if (email) {
        const selEmail = 'input[type="email"], input[name*=email i], input[id*=email i], input[placeholder*=email i]';
        await page.fill(selEmail, email);
        emitLogCb(onLog, 'info', `Preenchido e-mail via selector ${selEmail}`);
      }
    }catch(e){ emitLogCb(onLog,'warn', 'Falha ao preencher email: '+(e && e.message)); }

    try{
      if (password) {
        const selPass = 'input[type="password"], input[name*=pass i], input[id*=pass i]';
        await page.fill(selPass, password);
        emitLogCb(onLog, 'info', `Preenchida senha via selector ${selPass}`);
      }
    }catch(e){ emitLogCb(onLog,'warn','Falha ao preencher senha: '+(e && e.message)); }

    // clicar botão de login
    try{
      const btnSel = 'button[type="submit"], button.button, button:has-text("Fazer login")';
      await page.click(btnSel, { timeout: 5000 });
      emitLogCb(onLog,'info', `Clicado botão de login (${btnSel})`);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
    }catch(e){ emitLogCb(onLog,'warn','Não foi possível clicar botão de login: '+(e && e.message)); }

    // Após login, navegar diretamente para a área de Consulta Margem (/clt/consultar)
    try {
      emitLogCb(onLog, 'info', `URL atual após login: ${page.url()}`);

      let navigated = false;

      // Attempt direct navigation first (more reliable for SPA/menus)
      try{
        if (url){
          const base = url.replace(/\/$/, '');
          const direct = base + '/clt/consultar';
          emitLogCb(onLog,'info', `Tentando navegação direta para ${direct}`);
          await page.goto(direct, { timeout: 20000 });
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{});
          // small pause to allow SPA routing to settle
          await delay(800);
          const current = page.url();
          emitLogCb(onLog,'info', `URL após navegação direta: ${current}`);
          if (current.includes('/clt') || current.includes('/consultar')) navigated = true;
        }
      }catch(e){ emitLogCb(onLog,'warn','Falha na navegação direta para /clt/consultar: '+(e && e.message)); }

      // If direct navigation didn't land, try link candidates and DOM click fallback
      if (!navigated) {
        const linkCandidates = [
          'a[href="/clt/consultar"]',
          'a[href*="/clt"]',
          'a:has-text("Consulta Margem")',
          'a:has-text("Consultar Margem")',
          'a:has-text("Margem")'
        ];

        for (const sel of linkCandidates) {
          try {
            const el = await page.$(sel);
            if (!el) continue;
            emitLogCb(onLog, 'info', `Tentando clicar link candidato: ${sel}`);
            await el.click().catch(()=>{});
            await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(()=>{});
            const current = page.url();
            emitLogCb(onLog, 'info', `URL após tentativa de clique: ${current}`);
            if (current.includes('/clt') || current.includes('/consultar')){ navigated = true; break; }
          } catch (e) {
            // ignore and try next
          }
        }

        if (!navigated) {
          try{
            const clicked = await page.evaluate(() => {
              const anchors = Array.from(document.querySelectorAll('a'));
              const a = anchors.find(x => x.href && x.href.indexOf('/clt') !== -1);
              if (a){ a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); return true; }
              return false;
            });
            emitLogCb(onLog, 'info', `DOM-click fallback result: ${clicked}`);
            if (clicked){
              await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(()=>{});
              const current = page.url();
              if (current.includes('/clt') || current.includes('/consultar')) navigated = true;
            }
          }catch(e){ emitLogCb(onLog,'warn','Erro no DOM-click fallback: '+(e&&e.message)); }
        }
      }

      if (navigated) emitLogCb(onLog, 'info', 'Navegação para Consulta Margem concluída');
      else emitLogCb(onLog, 'warn', 'Não foi possível navegar automaticamente para Consulta Margem');
    } catch (e) {
      emitLogCb(onLog, 'warn', `Erro ao tentar acessar Consulta Margem: ${e && e.message}`);
    }

    // Descobrir selector do botão de consulta (fora do loop, pois tende a ser mais estável)
    let consultButtonSelector = null;
    try {
      const btnSelectors = [
        'button:has-text("Consultar saldo")',
        'button.is-success',
        'button[type="submit"]:has-text("Consultar")',
        'button:has-text("Consultar")'
      ];
      for (const bsel of btnSelectors){
        try{
          const btn = await page.$(bsel);
          if (btn){ consultButtonSelector = bsel; emitLogCb(onLog,'info',`Botão de consulta encontrado via ${bsel}`); break; }
        }catch(e){}
      }
      if(!consultButtonSelector) emitLogCb(onLog,'warn',"Botão 'Consultar saldo' não encontrado automaticamente");
    } catch (e) {
      emitLogCb(onLog, 'warn', `Erro durante busca do botão de consulta: ${e && e.message}`);
    }

    // If steps provided, execute them once (may prepare page)
    if (steps && steps.trim()){
      const lines = steps.split('\n').map(l=>l.trim()).filter(Boolean);
      for (let i=0;i<lines.length;i++){
        const line = lines[i];
        emitLogCb(onLog,'info', `Executando passo ${i+1}: ${line}`);
        const parts = line.split(':');
        const action = parts[0];
        const selector = parts[1];
        const rest = parts.slice(2).join(':');
        try{
          if (action === 'click'){
            await page.click(selector, { timeout: 10000 });
            await delay(500);
          } else if (action === 'wait'){
            await page.waitForSelector(selector, { timeout: 15000 });
          } else if (action === 'fill'){
            const value = rest === '$CPF' ? (cpf || '') : rest;
            await page.fill(selector, value);
            await delay(300);
          } else if (action === 'press'){
            await page.press(selector, rest || 'Enter');
          } else {
            emitLogCb(onLog,'warn', `Ação desconhecida: ${action}`);
          }
        }catch(e){ emitLogCb(onLog,'warn', `Erro no passo ${i+1}: ${e && e.message}`, { line }); }
      }
    }

    // Iterate CPFs
    for (let i=0;i<cpfs.length;i++){
      const currentCpf = cpfs[i];
      emitLogCb(onLog,'info', `Processando ${i+1}/${cpfs.length}: ${currentCpf}`);
      let op = 'Falha';
      let obs = '';
      try{
        // Re-localizar o input de CPF a cada iteração para evitar stale element reference
        let cpfInputHandle = null;
        emitLogCb(onLog, 'info', 'Tentando localizar input de CPF...');
        const cpfCandidateSelectors = [
          'input[name*=cpf i]', 'input[id*=cpf i]', 'input[placeholder*=cpf i]',
          'input[placeholder*="000" i]', 'input[maxlength="15"]', 'input[type="tel"]',
          'input[class*=document i]', 'div.document-input input', 'div.control.document-input input',
          'input[type=text]'
        ];

        try {
          const xpath = `xpath=//label[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CPF')]/following::input[1]`;
          cpfInputHandle = await page.$(xpath);
          if (cpfInputHandle) emitLogCb(onLog, 'info', 'Encontrado input CPF via label XPath');
        } catch (e) { /* ignore */ }

        if (!cpfInputHandle) {
          for (const s of cpfCandidateSelectors) {
            try {
              const el = await page.$(s);
              if (el) {
                cpfInputHandle = el;
                emitLogCb(onLog, 'info', `Encontrado input CPF via selector: ${s}`);
                break;
              }
            } catch (e) {}
          }
        }

        if (!cpfInputHandle){
          throw new Error('Input de CPF não encontrado na página nesta iteração');
        }

        // Limpar, preencher e verificar
        try{
          await cpfInputHandle.fill('');
          await cpfInputHandle.fill(currentCpf);
          const filledValue = await cpfInputHandle.inputValue();
          if (filledValue.replace(/\D/g, '') !== currentCpf) {
            emitLogCb(onLog, 'warn', `Verificação falhou: CPF no input (${filledValue}) não bate com o esperado (${currentCpf}). Tentando novamente.`);
            await cpfInputHandle.fill('');
            await cpfInputHandle.fill(currentCpf);
          }
          emitLogCb(onLog,'info', `Preenchido e verificado CPF ${currentCpf}`);
        }catch(e){ throw new Error('Falha ao preencher/verificar CPF: '+(e && e.message)); }

        // small delay before clicking to simulate user pause
        const beforeClickMs = (options && options.margemDelayBeforeClickMs) || 1000;
        await delay(beforeClickMs);

        // click consult
        if (consultButtonSelector){
          try{
            await page.click(consultButtonSelector);
            emitLogCb(onLog,'info', 'Clicado botão de consulta');
          }catch(e){ throw new Error('Falha ao clicar botão de consulta: '+(e && e.message)); }
        } else {
          // try to press Enter on input
          try{ await cpfInputHandle.press('Enter'); emitLogCb(onLog,'info','Press Enter no input CPF'); }catch(e){ emitLogCb(onLog,'warn','Não foi possível submeter via Enter: '+(e&&e.message)); }
        }

        // wait for potential result selectors to appear
        const resultSelectors = ['.result', '.saldo', '.consulta-resultado', '.resultado', '.card .body', '.card-body', '.balance', '#saldo'];
        const combinedSelector = resultSelectors.join(',');
        const resultTimeout = (options && options.margemResultTimeoutMs) || 6000;
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(()=>{});
        let resultText = '';
        try{
          await page.waitForSelector(combinedSelector, { timeout: resultTimeout });
          const el = await page.$(combinedSelector);
          if (el) resultText = (await el.innerText()).trim();
        }catch(e){
          // not found within timeout
        }

        if (resultText) {
          op = 'Sucesso';
          obs = resultText.replace(/\r?\n/g,' | ').replace(/;/g,',');
          emitLogCb(onLog,'info', `Resultado para ${currentCpf}: ${obs}`);
        } else {
          op = 'Falha';
          obs = 'Sem resultado detectado dentro do tempo limite';
          emitLogCb(onLog,'warn', `Sem resultado detectado para ${currentCpf} (timeout ${resultTimeout}ms)`);
          // save screenshot for debugging
          try{
            if (resultsPath){
              const shotName = `screenshot-${currentCpf}-${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
              const shotPath = path.join(path.dirname(resultsPath), shotName);
              await page.screenshot({ path: shotPath, fullPage: false });
              emitLogCb(onLog,'info', `Screenshot salvo em: ${shotPath}`);
              obs += `; screenshot=${shotName}`;
            }
          }catch(e){ emitLogCb(onLog,'warn','Falha ao salvar screenshot: '+(e&&e.message)); }
        }
      }catch(e){
        op = 'Falha';
        obs = (e && e.message) || '';
        emitLogCb(onLog,'warn', `Erro processando ${currentCpf}: ${obs}`);
      }

      // write result
      try{
        const line = `${currentCpf};${op};"${(obs||'').replace(/"/g,'""')}"\n`;
        if (resultsPath) fs.appendFileSync(resultsPath, line, { encoding: 'utf8' });
      }catch(e){ emitLogCb(onLog,'warn','Falha ao gravar resultado: '+(e&&e.message)); }

      // progress callback
      if (typeof onProgress === 'function'){
        const percent = Math.round(((i+1)/cpfs.length)*100);
        onProgress({ current: i+1, total: cpfs.length, percent, message: `Processado ${i+1}/${cpfs.length}` });
      }
      // small delay between iterations
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
