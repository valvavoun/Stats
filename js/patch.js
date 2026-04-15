/* patch.js — lance une seule fois pour corriger index.html */
const fs = require('fs');
const p  = require('path');

const file = p.join(__dirname, 'index.html');
let html   = fs.readFileSync(file, 'utf8');

html = html
  .replace('href="crawler.html">🚀 Ouvrir le Crawler</a>', 'href="import.html">📥 Importer les données</a>')
  .replace('href="crawler.html">⚙ Crawler</a>',            'href="import.html">📥 Import</a>');

fs.writeFileSync(file, html);
console.log('✅ index.html patché');
fs.unlinkSync(__filename); // auto-supprime ce script
