/* ═══════════════════════════════════════════════════════════════
   MXGP Stats — scrape_data.js
   Lit mxgp_ids.json, scrape les tableaux de résultats.
   - Skip silencieux si données absentes (années vides, etc.)
   - N workers Playwright en parallèle
   - Anti-doublon, reprend si interrompu
   - Mode --year=2026 pour re-scraper une année précise (cron hebdo)

   Usage :
     node scrape_data.js                → scrape tout ce qui manque
     node scrape_data.js --workers=4   → 4 navigateurs en parallèle
     node scrape_data.js --year=2026   → re-scrape 2026 seulement (--force)
     node scrape_data.js --force       → re-scrape tout même si déjà présent
═══════════════════════════════════════════════════════════════ */

const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');

/* ══ Config depuis args ══ */
const ARGS       = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k,v] = a.replace(/^--/,'').split('=');
    return [k, v ?? true];
  })
);
const N_WORKERS  = parseInt(ARGS.workers  ?? 3);
const FORCE_YEAR = ARGS.year   ? String(ARGS.year) : null;
const FORCE_ALL  = !!ARGS.force;
const WAIT_NAV   = 1400;
const WAIT_TABLE = 1800;
const SAVE_EVERY = 20;

const IDS_FILE     = path.join(__dirname,'mxgp_ids.json');
const RESULTS_FILE = path.join(__dirname,'mxgp_results.json');
const BASE_URL     = 'https://results.mxgp.com/reslists.aspx';

/* ══ Fichiers ══ */
function loadIDs() {
  if (!fs.existsSync(IDS_FILE)) { console.error('❌ mxgp_ids.json manquant'); process.exit(1); }
  return JSON.parse(fs.readFileSync(IDS_FILE,'utf8'));
}
function loadResults() {
  if (!fs.existsSync(RESULTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE,'utf8')); } catch { return []; }
}
function resultKey(e) {
  return [e.year?.id||'', e.champ?.id||'', e.class?.id||'', e.event?.id||'', e.race?.id||'', e.result?.id||''].join('|');
}

let _results     = [];
let _resultKeys  = new Set();
let _dirty       = 0;
function saveResults() { fs.writeFileSync(RESULTS_FILE, JSON.stringify(_results,null,2)); _dirty=0; }

/* ══ Parse le tableau HTML (Node.js, sans DOM) ══ */
function parseTable(html) {
  const riders = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(html)) !== null) {
    const tbl  = tm[0];
    const rows = [];
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tbl)) !== null) rows.push(rm[0]);
    if (rows.length < 3) continue;

    /* Ligne header */
    let hIdx = -1, cols = [];
    for (let i=0; i<Math.min(rows.length,5); i++) {
      const cells = extractCells(rows[i]);
      if (cells.some(c=>/^pos$/i.test(c.trim()))) { hIdx=i; cols=cells; break; }
    }
    if (hIdx<0 || !cols.some(c=>/^rider$/i.test(c.trim()))) continue;

    const idx = {};
    cols.forEach((c,i) => { idx[c.trim().toLowerCase()]=i; });

    for (let i=hIdx+1; i<rows.length; i++) {
      if (rows[i].includes('colspan')) continue;
      const cells = extractCells(rows[i]);
      if (!cells.length) continue;

      const get = keys => {
        for (const k of (Array.isArray(keys)?keys:[keys])) {
          const v = cells[idx[k.toLowerCase()]];
          if (v !== undefined && v !== '') return v.trim();
        }
        return '';
      };

      const posRaw = get('pos').replace(/\D/g,'');
      const pos    = parseInt(posRaw);
      if (isNaN(pos)||pos<1||pos>80) continue;

      const rawName = get('rider');
      let fn='', ln=rawName;
      const ci = rawName.indexOf(',');
      if (ci>-1) { ln=rawName.slice(0,ci).trim(); fn=rawName.slice(ci+1).trim(); }
      else { const p=rawName.split(/\s+/); if(p.length>=2){fn=p[0];ln=p.slice(1).join(' ');} }

      const hrefM   = rows[i].match(/href="[^"]*[?&]r=(\d+)/i);
      const riderId = hrefM ? `r${hrefM[1]}` : `${fn}_${ln}`.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'') || `rider_${pos}`;

      const bestLap = get(['bestlaptime','best lap','bestlap']);
      const timeStr = get(['time']);
      const laps    = parseInt(get(['laps'])) || 0;

      riders.push({
        pos, nr: parseInt(get(['nr']))||0,
        riderId, firstName:fn, lastName:ln,
        nation: get(['nat.','nation','nat']),
        bike:   get(['bike']),
        time:   timeStr, laps,
        diffFirst: get(['diff. first']),
        diffPrev:  get(['diff. prev.']),
        bestLap,
        bestSec:   lapToSec(bestLap),
        speed:     parseFloat(get(['speed']))||null,
        dnf: /dnf/i.test(timeStr),
        dns: /dns/i.test(timeStr),
      });
    }
    if (riders.length>=2) return riders;
  }
  return [];
}

function extractCells(row) {
  const re=[]; const ce=/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi; let m;
  while((m=ce.exec(row))!==null) re.push(m[1].replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#?\w+;/g,'').replace(/\s+/g,' ').trim());
  return re;
}
function lapToSec(str) {
  if (!str) return null;
  const s=String(str).trim(); let m;
  m=s.match(/^(\d+):(\d{2})\.(\d{1,3})$/); if(m) return +m[1]*60+ +m[2]+ +m[3].padEnd(3,'0')/1000;
  m=s.match(/^(\d{1,3})\.(\d{1,3})$/);     if(m) return +m[1]+ +m[2].padEnd(3,'0')/1000;
  return null;
}

/* ══ Navigation browser ══ */
async function safeSelect(page, selector, value) {
  try {
    await page.waitForSelector(selector, {timeout:5000});
    await page.selectOption(selector, value);
    await page.waitForTimeout(WAIT_NAV);
    return true;
  } catch { return false; }
}

/* ══ Worker ══ */
async function worker(id, queue, browser, counters) {
  const page = await browser.newPage();
  await page.goto(BASE_URL, {waitUntil:'networkidle', timeout:30000});
  await page.waitForTimeout(2000);

  const last = {};

  while (queue.length>0) {
    const entry = queue.shift();
    const key   = resultKey(entry);

    if (!FORCE_ALL && !FORCE_YEAR && _resultKeys.has(key)) { counters.skipped++; continue; }
    if (FORCE_YEAR && !FORCE_ALL && _resultKeys.has(key) && entry.year?.id!==FORCE_YEAR) { counters.skipped++; continue; }

    try {
      /* Navigation — ne re-sélectionne que ce qui a changé */
      if (last.year !== entry.year?.id) {
        const ok = await safeSelect(page,'#SelectYear',entry.year.id);
        if (!ok) { counters.errors++; continue; }
        last.year=entry.year.id; last.champ=last.cls=last.event=last.race=last.result=null;
      }
      if (last.champ !== entry.champ?.id) {
        const ok = await safeSelect(page,'#SelectCShip',entry.champ.id);
        if (!ok) { counters.errors++; continue; }
        last.champ=entry.champ.id; last.cls=last.event=last.race=last.result=null;
      }
      /* SelectClass — optionnel selon le championnat */
      if (entry.class?.id && last.cls !== entry.class.id) {
        await safeSelect(page,'#SelectClass',entry.class.id);
        last.cls=entry.class.id; last.event=last.race=last.result=null;
      }
      /* SelectEvent — optionnel (Nations n'en a pas toujours) */
      if (entry.event?.id && last.event !== entry.event.id) {
        await safeSelect(page,'#SelectEvent',entry.event.id);
        last.event=entry.event.id; last.race=last.result=null;
      }
      if (last.race !== entry.race?.id) {
        const ok = await safeSelect(page,'#SelectRace',entry.race.id);
        if (!ok) { counters.errors++; continue; }
        last.race=entry.race.id; last.result=null;
      }
      if (last.result !== entry.result?.id) {
        await safeSelect(page,'#SelectResult',entry.result.id);
        last.result=entry.result.id;
      }

      await page.waitForTimeout(WAIT_TABLE);
      const html   = await page.content();
      const riders = parseTable(html);

      if (riders.length>0) {
        /* Supprime l'ancienne version si re-scrape forcé */
        if (FORCE_YEAR || FORCE_ALL) {
          const idx = _results.findIndex(r=>resultKey(r)===key);
          if (idx>-1) _results.splice(idx,1);
        }
        _results.push({ ...entry, riders, scrapedAt: new Date().toISOString() });
        _resultKeys.add(key);
        counters.ok++;
        _dirty++;
        console.log(`[W${id}] ✅ ${riders.length} pilotes — ${entry.year.name}|${entry.champ.name}|${entry.class?.name||'-'}|${entry.event?.name||'-'}|${entry.race.name}|${entry.result.name}`);
      } else {
        /* Données absentes sur le site — on passe silencieusement */
        counters.empty++;
        // On marque quand même pour ne pas retryer indéfiniment
        _results.push({ ...entry, riders:[], scrapedAt:new Date().toISOString(), noData:true });
        _resultKeys.add(key);
        _dirty++;
        console.log(`[W${id}] ⬜ Vide (skip) — ${entry.year.name}|${entry.event?.name||entry.race.name}|${entry.result.name}`);
      }

      if (_dirty>=SAVE_EVERY) saveResults();

    } catch(e) {
      counters.errors++;
      console.error(`[W${id}] ❌ ${entry.year?.name}|${entry.race?.name}: ${e.message.slice(0,80)}`);
      /* Reset navigation après erreur */
      try {
        await page.goto(BASE_URL,{waitUntil:'networkidle',timeout:20000});
        await page.waitForTimeout(2000);
        Object.keys(last).forEach(k=>last[k]=null);
      } catch {}
    }
  }
  await page.close();
}

/* ══ MAIN ══ */
(async () => {
  console.log('════════════════════════════════════════');
  console.log(' MXGP Scraper — Phase 2 : Données');
  if (FORCE_YEAR) console.log(` Mode : re-scrape année ${FORCE_YEAR}`);
  if (FORCE_ALL)  console.log(' Mode : force tout');
  console.log(`════════════════════════════════════════`);

  const ids = loadIDs();
  console.log(`📋 ${ids.length} combinaisons dans mxgp_ids.json`);

  _results    = loadResults();
  _resultKeys = new Set(_results.map(resultKey));
  console.log(`📦 ${_results.length} entrées déjà en base`);

  /* Filtre ce qu'il reste */
  let todo;
  if (FORCE_YEAR) {
    todo = ids.filter(e => e.year?.id === FORCE_YEAR);
    /* Supprime les anciennes entrées de cette année */
    _results = _results.filter(r => r.year?.id !== FORCE_YEAR);
    _resultKeys = new Set(_results.map(resultKey));
    console.log(`🔄 Re-scrape ${FORCE_YEAR} : ${todo.length} entrées`);
  } else if (FORCE_ALL) {
    todo = [...ids]; _results=[]; _resultKeys=new Set();
  } else {
    todo = ids.filter(e => !_resultKeys.has(resultKey(e)));
    console.log(`🎯 ${todo.length} entrées restantes à scraper`);
  }

  if (!todo.length) { console.log('✅ Rien à faire.'); return; }

  /* Tri pour minimiser la navigation dans chaque worker */
  todo.sort((a,b)=> {
    for (const k of ['year','champ','class','event','race','result']) {
      const ka=a[k]?.id||'', kb=b[k]?.id||'';
      if (ka!==kb) return ka.localeCompare(kb);
    }
    return 0;
  });

  /* Distribution round-robin entre workers */
  const queues = Array.from({length:N_WORKERS},()=>[]);
  todo.forEach((e,i)=>queues[i%N_WORKERS].push(e));

  const counters = {ok:0,skipped:0,empty:0,errors:0};
  const browser  = await chromium.launch({headless:true});

  process.on('SIGINT',async()=>{
    console.log('\n⏹ Interruption — sauvegarde…');
    saveResults();
    await browser.close();
    summary(counters,todo.length);
    process.exit(0);
  });

  await Promise.allSettled(queues.map((q,i)=>worker(i+1,q,browser,counters)));
  saveResults();
  await browser.close();
  summary(counters,todo.length);
})();

function summary(c,total) {
  console.log('\n════════════════════════════════════════');
  console.log(` ✅ Scrapés : ${c.ok}  ⬜ Vides : ${c.empty}  ❌ Erreurs : ${c.errors}  ↷ Skips : ${c.skipped}`);
  console.log(` 📋 Total traités / ${total}`);
  console.log(` 📄 → mxgp_results.json`);
  console.log('════════════════════════════════════════');
}
