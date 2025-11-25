const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

function removeAccents(str) {
  if (typeof str !== 'string') return str;
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

function emitLogCb(onLog, level, message, meta){
  const cleanedMessage = removeAccents(message);
  const payload = { level, message: cleanedMessage, meta };
  try{ if (typeof onLog === 'function') onLog(payload); }catch(e){}
  if(level==='error') console.error(cleanedMessage, meta||'');
  else if(level==='warn') console.warn(cleanedMessage, meta||'');
  else console.log(cleanedMessage, meta||'');
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
                emitLogCb(onLog, 'info', `Leitura finalizada. Encontrados ${Array.from(new Set(cpfs)).length} CPFs unicos.`);
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
    emitLogCb(onLog, 'info', 'Navegando para a pagina de Consulta Margem.');
    await page.goto(new URL(targetUrlPart, baseUrl).href, { timeout: 20000, waitUntil: 'networkidle' });
}

async function runMargem(payload, onProgress, onLog){
  emitLogCb(onLog, 'info', `Payload recebido: ${JSON.stringify(payload)}`);

  const { url, email, password, options, reportsPath } = payload || {};
  const filePath = payload.filePath || payload.path;

  if (!filePath) {
      const errorMsg = 'Nenhum arquivo CSV foi fornecido no payload.';
      emitLogCb(onLog, 'error', errorMsg);
      if (typeof onProgress === 'function') onProgress({ current: 1, total: 1, percent: 100, message: `Erro: ${errorMsg}` });
      return;
  }

  const cpfs = await readCpfsFromCsv(filePath, onLog);

  if (!cpfs || cpfs.length === 0) {
    const errorMsg = 'Nenhum CPF valido foi encontrado para processar no arquivo CSV.';
    emitLogCb(onLog, 'error', errorMsg);
    if (typeof onProgress === 'function') onProgress({ current: 1, total: 1, percent: 100, message: `Erro: ${errorMsg}` });
    return;
  }

  const headless = options && typeof options.headless === 'boolean' ? options.headless : true;
  emitLogCb(onLog, 'info', `Iniciando navegador no modo ${headless ? 'headless' : 'com interface'}. Total de ${cpfs.length} CPFs para processar.`);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const outDir = reportsPath || path.join(process.cwd(), 'Relatorios Margem');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const resultsFilePath = path.join(outDir, `resultado-margem-${ts}.csv`);
  
  const results = cpfs.map(cpf => ({ cpf, status: 'Nao Processado', valor: '' }));

  try {
    emitLogCb(onLog, 'info', `Navegando para ${url}`);
    await page.goto(url, { timeout: 30000 });

    if (email) await page.fill('input[type="email"], input[name*=email i]', email);
    if (password) await page.fill('input[type="password"], input[name*=pass i]', password);

    await page.click('button[type="submit"], button:has-text("Fazer login")');
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{});

    await navigateToConsulta(page, url, onLog);

    emitLogCb(onLog, 'info', 'Iniciando submissao de CPFs...');
    for (let i = 0; i < cpfs.length; i++) {
      const currentCpf = cpfs[i];
      try {
        await navigateToConsulta(page, url, onLog);

        const cpfSelector = 'input[placeholder="000.000.000-00"]';
        await page.waitForSelector(cpfSelector, { state: 'visible', timeout: 10000 });
        await page.fill(cpfSelector, currentCpf);
        await page.click('button:has-text("Consultar saldo")');

        emitLogCb(onLog, 'info', `Submetido ${i + 1}/${cpfs.length}: ${currentCpf}`);
        if (typeof onProgress === 'function'){
          const percent = Math.round(((i + 1) / cpfs.length / 2) * 100);
          onProgress({ current: i + 1, total: cpfs.length, percent, message: `Submetendo ${i+1}/${cpfs.length}` });
        }
        await delay(1000);
      } catch(e) {
        emitLogCb(onLog, 'error', `Erro ao submeter CPF ${currentCpf}: ${e.message}`);
      }
    }

    emitLogCb(onLog, 'info', 'Todos os CPFs foram submetidos. Aguardando processamento final...');
    for (let attempt = 0; attempt < 15; attempt++) {
        await page.reload({ waitUntil: 'networkidle' });
        await delay(2000);
        const processingCount = await page.locator('p.tag.is-info:has-text("Processando")').count();
        if (processingCount === 0) {
            emitLogCb(onLog, 'info', 'Nenhum CPF em processamento. Iniciando coleta de resultados.');
            break;
        }
        emitLogCb(onLog, 'info', `${processingCount} CPFs ainda estao processando. Tentativa ${attempt + 1}/15.`);
        if (attempt === 14) {
            emitLogCb(onLog, 'warn', 'Tempo de espera excedido. Alguns CPFs podem nao ter sido processados.');
        }
        await delay(3000);
    }

    emitLogCb(onLog, 'info', 'Extraindo resultados da pagina...');
    const resultElements = await page.locator('div.box').all();
    emitLogCb(onLog, 'info', `Encontrados ${resultElements.length} elementos de resultado na pagina.`);

    for (const element of resultElements) {
        let cpfText = '';
        try {
            cpfText = await element.locator('p, span, strong').filter({ hasText: /[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}/ }).first().innerText();
        } catch(e) {
            continue;
        }

        const cpfOnPage = (cpfText || '').replace(/\D/g, '');
        if (cpfOnPage.length !== 11) continue;

        const resultIndex = results.findIndex(r => r.cpf === cpfOnPage);
        if (resultIndex === -1) {
            emitLogCb(onLog, 'warn', `CPF ${cpfOnPage} encontrado na pagina mas nao estava na lista original.`);
            continue;
        }

        let status = 'Falha';
        let valor = 'Nao foi possivel obter o valor.';

        const isSuccess = await element.locator('p.tag.is-success:has-text("Sucesso")').isVisible();
        const isProcessing = await element.locator('p.tag.is-info:has-text("Processando")').isVisible();

        if (isSuccess) {
            status = 'Sucesso';
            try {
                const saldo = await element.locator('input.v-money.input[disabled]').inputValue();
                valor = `Valor da Margem: ${saldo}`;
            } catch (e) {
                valor = 'Sucesso (valor nao extraido)';
            }
        } else if (isProcessing) {
            status = 'Ainda Processando';
            valor = 'Consulta nao finalizou a tempo.';
        }

        results[resultIndex] = { ...results[resultIndex], status, valor };
        emitLogCb(onLog, 'info', `Resultado para ${cpfOnPage}: ${status} - ${valor}`);
    }

    if (typeof onProgress === 'function'){
      onProgress({ current: cpfs.length, total: cpfs.length, percent: 100, message: `Processamento concluido. Gerando relatorio...` });
    }

  } catch (err) {
    emitLogCb(onLog, 'error', 'Erro catastrofico durante execucao: '+(err && err.message), { stack: err && err.stack });
  } finally {
    const csvHeader = 'CPF;Status;Valor\n';
    const csvBody = results.map(r => `${r.cpf};${r.status};"${(removeAccents(r.valor) || '').replace(/"/g, '""')}"`).join('\n');
    const csvContent = '\uFEFF' + csvHeader + csvBody;
    try {
      fs.writeFileSync(resultsFilePath, csvContent, { encoding: 'utf8' });
      emitLogCb(onLog, 'info', `Relatorio final gerado em: ${resultsFilePath}`);
    } catch(e) {
      emitLogCb(onLog, 'error', `Falha ao escrever o arquivo de resultado final: ${e.message}`);
    }

    await browser.close();
    emitLogCb(onLog,'info','Finalizando execucao da margem');
  }
}

module.exports = runMargem;
