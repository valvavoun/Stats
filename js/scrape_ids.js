/* ═══════════════════════════════════════════════════════════════
   MXGP Stats — scrape_ids.js
   Scrape TOUS les dropdowns en cascade :
     SelectYear → SelectCShip → [SelectClass] → [SelectEvent] → SelectRace → SelectResult
   - Gère les championnats SANS SelectClass (ex: MX Nations)
   - Gère les championnats SANS SelectEvent
   - Anti-doublon · reprend si interrompu
   - --year=2026 : scrape seulement cette année (pour le cron hebdo)

   Usage :
     node scrape_ids.js              → toutes les années
     node scrape_ids.js --year=2026  → 2026 seulement
═══════════════════════════════════════════════════════════════ */

const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');

/* ── Args ── */
const ARGS       = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k,v] = a.replace(/^--/,'').split('=');
    return [k, v ?? true];
  })
);
const FILTER_YEAR = ARGS.year ? String(ARGS.year) : null;

const IDS_FILE    = path.join(__dirname,'mxgp_ids.json');
const BASE_URL    = 'https://results.mxgp.com/reslists.aspx';
const WAIT_SEL    = 1400;
const WAIT_INIT   = 3000;

/* ── Fichier ── */
function load() {
  if (!fs.existsSync(IDS_FILE)) return { entries:[], keys:new Set() };
  const entries = JSON.parse(fs.readFileSync(IDS_FILE,'utf8'));
  return { entries, keys: new Set(entries.map(entryKey)) };
}
function save(entries) { fs.writeFileSync(IDS_FILE, JSON.stringify(entries,null,2)); }
function entryKey(e) {
  return [
    e.year?.id||'', e.champ?.id||'', e.class?.id||'',
    e.event?.id||'', e.race?.id||'', e.result?.id||''
  ].join('|');
}

/* ── Helpers page ── */
async function getOpts(page, sel) {
  try {
    await page.waitForSelector(sel, {timeout:3500});
    return await page.$$eval(`${sel} option`, opts =>
      opts.map(o=>({id:o.value.trim(), name:o.textContent.trim()}))
          .filter(o=>o.id&&o.id!=='0')
    );
  } catch { return []; }
}
async function choose(page, sel, val) {
  try { await page.selectOption(sel,val); await page.waitForTimeout(WAIT_SEL); }
  catch(e) { console.warn(`  ⚠️ choose(${sel},${val}): ${e.message.slice(0,60)}`); }
}
async function has(page, sel) {
  try { await page.waitForSelector(sel,{timeout:2000}); return true; }
  catch { return false; }
}

/* ── Traitement events+races+results ── */
async function processRaces(page, year, champ, cls, event, entries, keys) {
  const races = await getOpts(page,'#SelectRace');
  if (!races.length) return;

  for (const race of races) {
    await choose(page,'#SelectRace',race.id);
    const results = await getOpts(page,'#SelectResult');

    for (const result of results) {
      const entry = {
        year, champ,
        ...(cls   ? {class:cls}   : {}),
        ...(event ? {event:event} : {}),
        race, result
      };
      const k = entryKey(entry);
      if (keys.has(k)) continue;
      keys.add(k);
      entries.push(entry);
      save(entries);
      const label = [year.name, champ.name, cls?.name||'-', event?.name||'-', race.name, result.name].join(' | ');
      console.log(`  ✔ ${label}`);
    }
  }
}

/* ── MAIN ── */
(async () => {
  const { entries, keys } = load();
  console.log(`📂 IDs existants : ${entries.length}${FILTER_YEAR ? ` (mode année ${FILTER_YEAR})` : ''}`);

  const browser = await chromium.launch({headless:true});
  const page    = await browser.newPage();

  await page.goto(BASE_URL,{waitUntil:'networkidle',timeout:30000});
  await page.waitForTimeout(WAIT_INIT);

  const years = await getOpts(page,'#SelectYear');
  const filteredYears = FILTER_YEAR ? years.filter(y=>y.id===FILTER_YEAR) : years;
  console.log(`📅 Années ciblées : ${filteredYears.map(y=>y.name).join(', ')}`);

  for (const year of filteredYears) {
    console.log(`\n══════ ${year.name} ══════`);
    await choose(page,'#SelectYear',year.id);

    const champs = await getOpts(page,'#SelectCShip');
    if (!champs.length) { console.log('  ⚠️ Aucun championnat'); continue; }

    for (const champ of champs) {
      await choose(page,'#SelectCShip',champ.id);
      console.log(`\n  🏆 ${champ.name}`);

      const hasClass = await has(page,'#SelectClass');
      const hasEvent = await has(page,'#SelectEvent');

      if (hasClass) {
        /* Championnat avec classes (MXGP / MX2 / WMX / EMX…) */
        const classes = await getOpts(page,'#SelectClass');
        if (!classes.length) { console.log(`    ⚠️ Aucune classe`); continue; }

        for (const cls of classes) {
          await choose(page,'#SelectClass',cls.id);

          const hasEvt2 = await has(page,'#SelectEvent');
          if (hasEvt2) {
            const events = await getOpts(page,'#SelectEvent');
            if (!events.length) { console.log(`    ⚠️ ${cls.name} : aucun event`); continue; }
            console.log(`    📍 ${cls.name} — ${events.length} GPs`);
            for (const event of events) {
              await choose(page,'#SelectEvent',event.id);
              await processRaces(page,year,champ,cls,event,entries,keys);
            }
          } else {
            /* Pas d'event (rare) */
            console.log(`    📍 ${cls.name} — direct races`);
            await processRaces(page,year,champ,cls,null,entries,keys);
          }
        }
      } else if (hasEvent) {
        /* Championnat SANS class AVEC event (ex: Nations selon les années) */
        const events = await getOpts(page,'#SelectEvent');
        console.log(`    📍 (no class) — ${events.length} GPs`);
        for (const event of events) {
          await choose(page,'#SelectEvent',event.id);
          await processRaces(page,year,champ,null,event,entries,keys);
        }
      } else {
        /* Championnat SANS class SANS event (MX Nations classique) */
        console.log(`    📍 (no class, no event) — direct races`);
        await processRaces(page,year,champ,null,null,entries,keys);
      }
    }
  }

  await browser.close();
  console.log(`\n✅ DONE — total : ${entries.length} entrées dans mxgp_ids.json`);
})();
