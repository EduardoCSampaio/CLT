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
  const results = [];

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
      let status = 'Falha';
      let valor = 'Falha ao consultar (CPF pode nao ter o tempo minimo ou vinculo empregaticio)';

      try {
        await navigateToConsulta(page, url, onLog);

        emitLogCb(onLog, 'info', 'Procurando campo CPF...');
        const cpfSelector = 'input[placeholder="000.000.000-00"]';
        await page.waitForSelector(cpfSelector, { state: 'visible', timeout: 10000 });
        await page.fill(cpfSelector, currentCpf);
        emitLogCb(onLog, 'info', `CPF ${currentCpf} inserido.`);

        emitLogCb(onLog, 'info', 'Clicando no botao de consulta...');
        await page.click('button:has-text("Consultar saldo")');

        emitLogCb(onLog, 'info', 'Aguardando resultado...');

        for (let attempt = 0; attempt < 5; attempt++) {
            await delay(3000); 

            const isProcessing = await page.isVisible('p.tag.is-info:has-text("Processando")');
            const isSuccess = await page.isVisible('p.tag.is-success:has-text("Sucesso")');

            if (isSuccess) {
                const saldoInput = await page.waitForSelector('input.v-money.input[disabled]', { state: 'visible', timeout: 5000 });
                const saldo = await saldoInput.inputValue();
                if (saldo) {
                    status = 'Sucesso';
                    valor = `Valor da Margem: ${saldo}`;
                }
                emitLogCb(onLog, 'info', `Resultado para ${currentCpf}: ${status} - ${valor}`);
                break;
            } else if (isProcessing) {
                emitLogCb(onLog, 'info', `CPF ${currentCpf} ainda em processamento. Tentativa ${attempt + 1}/5.`);
                if (attempt < 4) await page.reload({ waitUntil: 'networkidle' });
            } else {
                emitLogCb(onLog, 'warn', `Nao foi possivel obter a margem para o CPF ${currentCpf}. Status desconhecido.`);
                break;
            }
        }

      } catch (e) {
          emitLogCb(onLog, 'error', `Erro inesperado ao processar CPF ${currentCpf}: ${e.message}`);
      }

      results.push({ cpf: currentCpf, status, valor });

      if (typeof onProgress === 'function'){
        const percent = Math.round(((i+1)/cpfs.length)*100);
        onProgress({ current: i+1, total: cpfs.length, percent, message: `Processado ${i+1}/${cpfs.length}` });
      }
      await delay(500);
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
