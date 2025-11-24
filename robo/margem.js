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

function readCpfsFromCsv(filePath, onLog) {
    return new Promise((resolve, reject) => {
        const cpfs = [];
        fs.createReadStream(path.resolve(filePath))
            .pipe(csv({ separator: ';', mapHeaders: ({ header }) => header.trim().toLowerCase() }))
            .on('data', (row) => {
                const cpfKey = Object.keys(row).find(key => key.includes('cpf') || key.includes('documento'));
                if (cpfKey && row[cpfKey]) {
                    const digits = (row[cpfKey] || '').replace(/\D/g, '');
                    if (digits.length === 11) cpfs.push(digits);
                }
            })
            .on('end', () => {
                emitLogCb(onLog, 'info', `Leitura finalizada. Encontrados ${Array.from(new Set(cpfs)).length} CPFs únicos.`);
                resolve(Array.from(new Set(cpfs)));
            })
            .on('error', (err) => {
                emitLogCb(onLog, 'error', `Erro ao ler o CSV: ${err.message}`);
                reject(err);
            });
    });
}

async function navigateToConsulta(page, baseUrl, onLog) {
    const targetUrlPart = '/clt/consultar';
    if (page.url().includes(targetUrlPart)) return;
    emitLogCb(onLog, 'info', 'Navegando para a página de Consulta Margem.');
    await page.goto(new URL(targetUrlPart, baseUrl).href, { timeout: 20000, waitUntil: 'networkidle' });
}

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
  try { fs.writeFileSync(resultsPath, 'CPF;Status;Valor\n', { encoding: 'utf8' }); } catch(e) {}

  try {
    emitLogCb(onLog, 'info', `Navegando para ${url}`);
    await page.goto(url, { timeout: 30000 });

    if (email) await page.fill('input[type="email"], input[name*=email i]', email);
    if (password) await page.fill('input[type="password"], input[name*=pass i]', password);
    
    await page.click('button[type="submit"], button:has-text("Fazer login")');
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{});

    await navigateToConsulta(page, url, onLog);
    
    for (let i = 0; i < cpfs.length; i++) {
      const currentCpf = cpfs[i];
      emitLogCb(onLog, 'info', `Processando ${i + 1}/${cpfs.length}: ${currentCpf}`);
      let status = '';
      let valor = '';

      try {
        await navigateToConsulta(page, url, onLog);
        
        emitLogCb(onLog, 'info', 'Procurando campo CPF...');
        const cpfSelector = 'input[placeholder="000.000.000-00"]';
        const cpfInputHandle = await page.waitForSelector(cpfSelector, { state: 'visible', timeout: 10000 });
        await cpfInputHandle.fill(currentCpf);
        emitLogCb(onLog, 'info', `CPF ${currentCpf} inserido.`);
        
        emitLogCb(onLog, 'info', 'Clicando no botão de consulta...');
        const buttonSelector = 'button:has-text("Consultar saldo")';
        await page.click(buttonSelector);
        
        emitLogCb(onLog, 'info', 'Aguardando resultado...');
        
        // Aguarda a resposta da consulta
        await page.waitForLoadState('networkidle', { timeout: 10000 });

        // Tenta pegar o valor da margem
        const saldo = await page.$eval('input.v-money.input[disabled]', input => input.value).catch(() => null);

        if (saldo !== null) {
            status = 'Sucesso';
            valor = `Valor da Margem: ${saldo}`;
        } else {
            status = 'Falha';
            valor = 'Falha ao consultar (CPF pode não ter o tempo mínimo ou vinculo empregaticio)';
        }
        emitLogCb(onLog, 'info', `Resultado para ${currentCpf}: ${status} - ${valor}`);

      } catch (e) {
          status = 'Falha';
          valor = 'Falha ao consultar (CPF pode não ter o tempo mínimo ou vinculo empregaticio)';
          emitLogCb(onLog, 'error', `Falha ao processar CPF ${currentCpf}: ${e.message}`);
      }
      
      const line = `${currentCpf};${status};"${(valor || '').replace(/"/g, '""')}"\n`;
      fs.appendFileSync(resultsPath, line, { encoding: 'utf8' });

      if (typeof onProgress === 'function'){
        const percent = Math.round(((i+1)/cpfs.length)*100);
        onProgress({ current: i+1, total: cpfs.length, percent, message: `Processado ${i+1}/${cpfs.length}` });
      }
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
