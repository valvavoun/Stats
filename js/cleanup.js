/* Supprime les fichiers obsolètes du projet */
const fs = require('fs');
const path = require('path');
const toDelete = ['crawler.html','import.html','patch.js','analyze_ids.js'];
toDelete.forEach(f => {
  const p = path.join(__dirname,f);
  if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('🗑 Supprimé:',f); }
  else console.log('⬜ Absent (ok):',f);
});
fs.unlinkSync(__filename);
console.log('✅ Nettoyage terminé');
