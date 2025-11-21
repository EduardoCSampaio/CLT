
const fs = require('fs');
const path = require('path');

// Esta é a função corrigida, isolada para teste.
function readCpfsFromCsv(filePath) {
    console.log(`Iniciando a leitura do arquivo: ${filePath}`);
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        const cpfs = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const digits = (line || '').replace(/\D/g, ''); 
            
            if (digits.length === 11) {
                cpfs.push(digits);
            }
        }
        
        const uniqueCpfs = Array.from(new Set(cpfs));
        
        if (uniqueCpfs.length > 0) {
            console.log(`\nSUCESSO! Foram encontrados ${uniqueCpfs.length} CPFs únicos:`);
            console.log(uniqueCpfs.join('\n'));
        } else {
            console.error('\nERRO: Nenhum CPF válido (número de 11 dígitos) foi encontrado no arquivo.');
        }
        return uniqueCpfs;
    } catch (e) {
        console.error(`\nFALHA CRÍTICA AO LER O ARQUIVO: ${e.message}`);
        return [];
    }
}

const filePathArg = process.argv[2];
if (!filePathArg) {
    console.error("Por favor, forneça o caminho para o arquivo CSV.");
    console.error("Uso: node robo/teste_leitura.js <caminho_do_seu_arquivo.csv>");
} else {
    readCpfsFromCsv(filePathArg);
}
