import fs from 'node:fs';

const inPath = 'C:/Users/ChaitanyaMalle/Desktop/all_connectors_real.csv';
const outPath = 'C:/Users/ChaitanyaMalle/Desktop/microsoft_published_connectors.csv';

const lines = fs.readFileSync(inPath, 'utf-8').split('\n');
const header = lines[0];
const msLines = [header];
let msCount = 0;
let total = 0;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  total++;
  if (line.includes('"Microsoft",') || line.includes('"Microsoft Corporation",')) {
    msLines.push(line);
    msCount++;
  }
}

fs.writeFileSync(outPath, msLines.join('\n'), 'utf-8');
console.log('Total rows:', total);
console.log('Rows where publisher is exactly Microsoft or Microsoft Corporation:', msCount);
console.log('Saved to:', outPath);
