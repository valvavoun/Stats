/* ═══════════════════════════════════════════════════════════════
   MXGP Stats — DataManager.js  v3
   Source : mxgp_results.json (fetch local ou GitHub raw)
   Stockage : IndexedDB mxgp_stats_v3
   Fonctionne en totale autonomie sur GitHub Pages.
═══════════════════════════════════════════════════════════════ */

const DataManager = (() => {

  const DB_NAME   = 'mxgp_stats_v3';
  const DB_VER    = 1;
  let   db        = null;

  const PTS_TABLE = [25,22,20,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1];
  const calcPts   = pos => PTS_TABLE[pos-1] ?? 0;

  /* ══ IndexedDB ══ */
  function initDB() {
    return new Promise((res,rej) => {
      const r = indexedDB.open(DB_NAME,DB_VER);
      r.onupgradeneeded = ev => {
        const d = ev.target.result;
        if (!d.objectStoreNames.contains('sessions')) {
          const s = d.createObjectStore('sessions',{keyPath:'id'});
          s.createIndex('year',        'year');
          s.createIndex('category',    'category');
          s.createIndex('year_cat',    ['year','category']);
          s.createIndex('championship','championship');
          s.createIndex('sessionType', 'sessionType');
        }
        if (!d.objectStoreNames.contains('riders')) {
          const r2 = d.createObjectStore('riders',{keyPath:'riderId'});
          r2.createIndex('lastName','lastName');
          r2.createIndex('nation',  'nation');
        }
        if (!d.objectStoreNames.contains('meta'))
          d.createObjectStore('meta',{keyPath:'key'});
      };
      r.onsuccess = ev => { db=ev.target.result; res(db); };
      r.onerror   = ev => rej(ev.target.error);
    });
  }

  const _tx  = (s,m='readonly') => db.transaction(s,m).objectStore(s);
  const dbGet    = (s,k)    => new Promise((r,j) => { const q=_tx(s).get(k);      q.onsuccess=()=>r(q.result??null); q.onerror=()=>j(q.error); });
  const dbPut    = (s,o)    => new Promise((r,j) => { const q=_tx(s,'readwrite').put(o); q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error); });
  const dbGetAll = (s,i,v)  => new Promise((r,j) => {
    const st=_tx(s);
    const q=i ? st.index(i).getAll(Array.isArray(v)?IDBKeyRange.only(v):v) : st.getAll();
    q.onsuccess=()=>r(q.result??[]); q.onerror=()=>j(q.error);
  });
  const dbCount  = s => new Promise((r,j) => { const q=_tx(s).count(); q.onsuccess=()=>r(q.result); q.onerror=()=>j(q.error); });

  /* ══ Fetch mxgp_results.json ══
     Cherche dans l'ordre :
     1. Même origine (serveur local ou GitHub Pages)
     2. URL absolue si fournie
  ══════════════════════════════ */
  async function fetchResults(onLog) {
    const urls = ['./mxgp_results.json'];
    for (const url of urls) {
      try {
        onLog(`📡 Fetch ${url}…`);
        const r = await fetch(url, {cache:'no-cache'});
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        onLog(`✅ ${data.length} entrées chargées`);
        return data;
      } catch(e) {
        onLog(`⚠️ ${url} : ${e.message}`);
      }
    }
    onLog('❌ mxgp_results.json introuvable.');
    onLog('💡 Lance npm run serve pour un serveur local, ou pousse le fichier sur GitHub.');
    return null;
  }

  /* ══ Clé unique ══ */
  function sessionKey(e) {
    return [e.year?.id||'0',e.champ?.id||'0',e.class?.id||'',e.event?.id||'',e.race?.id||'0',e.result?.id||'0'].join('__');
  }

  /* ══ Import JSON → IndexedDB ══ */
  async function importFromJSON(onLog=console.log, onProgress=()=>{}) {
    if (!db) await initDB();
    const raw = await fetchResults(onLog);
    if (!raw) return 0;

    /* Filtre les entrées sans données (vides intentionnels) */
    const entries = raw.filter(e => !e.noData && e.riders?.length > 0);
    onLog(`📋 ${entries.length} sessions avec données (sur ${raw.length} total)`);

    let inserted=0, skipped=0;

    for (let i=0; i<entries.length; i++) {
      const e   = entries[i];
      const sid = sessionKey(e);

      if (await dbGet('sessions',sid)) { skipped++; continue; }

      const riders = (e.riders||[]).map(r=>({...r, points:calcPts(r.pos)}));
      const session = {
        id:             sid,
        year:           parseInt(e.year?.id)||0,
        yearName:       e.year?.name||'',
        championshipId: e.champ?.id||'',
        championship:   e.champ?.name||'',
        categoryId:     e.class?.id||'',
        category:       e.class?.name||'',
        eventId:        e.event?.id||'',
        eventName:      e.event?.name||'',
        raceId:         e.race?.id||'',
        session:        e.race?.name||'',
        sessionType:    classifySession(e.race?.name||''),
        resultId:       e.result?.id||'',
        resultName:     e.result?.name||'',
        resultType:     classifyResultType(e.result?.name||''),
        riders,
        scrapedAt:      e.scrapedAt||'',
      };

      await dbPut('sessions',session);
      for (const r of riders) {
        if (!await dbGet('riders',r.riderId))
          await dbPut('riders',{riderId:r.riderId,firstName:r.firstName,lastName:r.lastName,nation:r.nation,bike:r.bike,nr:r.nr});
      }
      inserted++;
      if (i%100===0) onProgress({done:i,total:entries.length,pct:Math.round(i/entries.length*100)});
    }

    await dbPut('meta',{key:'lastImport',value:new Date().toISOString()});
    onLog(`✅ Import terminé — ${inserted} nouvelles sessions (${skipped} déjà présentes)`);
    onProgress({done:entries.length,total:entries.length,pct:100});
    return inserted;
  }

  /* ══ Re-import year (mise à jour hebdo) ══ */
  async function reimportYear(year, onLog=console.log, onProgress=()=>{}) {
    if (!db) await initDB();
    onLog(`🔄 Re-import année ${year}…`);

    /* Supprime les sessions de cette année */
    const existing = await dbGetAll('sessions','year',+year);
    for (const s of existing) await new Promise((r,j)=>{const q=_tx('sessions','readwrite').delete(s.id);q.onsuccess=r;q.onerror=j;});
    onLog(`🗑 ${existing.length} sessions supprimées pour ${year}`);

    const raw = await fetchResults(onLog);
    if (!raw) return 0;
    const entries = raw.filter(e=>!e.noData && e.riders?.length>0 && e.year?.id===String(year));
    onLog(`📋 ${entries.length} sessions ${year} dans le JSON`);

    let inserted=0;
    for (let i=0; i<entries.length; i++) {
      const e   = entries[i];
      const sid = sessionKey(e);
      const riders = (e.riders||[]).map(r=>({...r,points:calcPts(r.pos)}));
      await dbPut('sessions',{
        id:sid, year:parseInt(e.year?.id)||0, yearName:e.year?.name||'',
        championshipId:e.champ?.id||'', championship:e.champ?.name||'',
        categoryId:e.class?.id||'', category:e.class?.name||'',
        eventId:e.event?.id||'', eventName:e.event?.name||'',
        raceId:e.race?.id||'', session:e.race?.name||'',
        sessionType:classifySession(e.race?.name||''),
        resultId:e.result?.id||'', resultName:e.result?.name||'',
        resultType:classifyResultType(e.result?.name||''),
        riders, scrapedAt:e.scrapedAt||'',
      });
      inserted++;
      if (i%50===0) onProgress({done:i,total:entries.length,pct:Math.round(i/entries.length*100)});
    }
    onLog(`✅ ${inserted} sessions ${year} re-importées`);
    return inserted;
  }

  /* ══ Classifications ══ */
  function classifySession(n) {
    const s=(n||'').toLowerCase();
    if (s.includes('race 2')||s.includes('grand prix race 2')||s.includes('manche 2')) return 'race2';
    if (s.includes('race 1')||s.includes('grand prix race 1')||s.includes('manche 1')) return 'race1';
    if (s.includes('qualifying race'))    return 'qualifying_race';
    if (s.includes('qualifying group'))   return 'qualifying_group';
    if (s.includes('qualifying'))         return 'qualifying';
    if (s.includes('time practice')||s.includes('time attack')||s.includes('timed')) return 'timeattack';
    if (s.includes('free practice')||s.includes('free')) return 'fp';
    if (s.includes('warm'))               return 'warmup';
    if (s.includes('last chance'))        return 'lcq';
    if (s.includes('b-final')||s.includes('b final')) return 'bfinal';
    if (s.includes('c-final')||s.includes('c final')) return 'cfinal';
    return 'other';
  }
  function classifyResultType(n) {
    const s=(n||'').toLowerCase();
    if (s.includes('world championship'))  return 'world_championship';
    if (s.includes('overall'))             return 'overall';
    if (s.includes('gp classification'))   return 'gp_classification';
    if (s.includes('manufacturers'))       return 'manufacturers';
    if (s.includes('championship'))        return 'championship_classification';
    if (s.includes('classification'))      return 'classification';
    if (s.includes('lap chart'))           return 'lap_chart';
    if (s.includes('analysis'))            return 'analysis';
    return 'other';
  }

  /* ══ API Lecture ══ */
  async function getSessions(f={}) {
    if (!db) await initDB();
    let sessions;
    if (f.year && f.category)  sessions = await dbGetAll('sessions','year_cat',[+f.year,f.category]);
    else if (f.year)           sessions = await dbGetAll('sessions','year',+f.year);
    else if (f.championship)   sessions = await dbGetAll('sessions','championship',f.championship);
    else if (f.sessionType)    sessions = await dbGetAll('sessions','sessionType',f.sessionType);
    else                       sessions = await dbGetAll('sessions');

    return sessions.filter(s => {
      if (f.category    && s.category    !== f.category)    return false;
      if (f.championship&& s.championship!== f.championship)return false;
      if (f.eventId     && s.eventId     !== f.eventId)     return false;
      if (f.sessionType && s.sessionType !== f.sessionType) return false;
      if (f.resultType  && s.resultType  !== f.resultType)  return false;
      if (f.onlyClassification) {
        return ['classification','gp_classification','overall','championship_classification'].includes(s.resultType);
      }
      return true;
    });
  }

  async function getYears() {
    const a = await dbGetAll('sessions');
    return [...new Set(a.map(s=>s.year))].sort((a,b)=>b-a);
  }
  async function getChampionships(year) {
    const a = year ? await dbGetAll('sessions','year',+year) : await dbGetAll('sessions');
    const m = {}; a.forEach(s=>{m[s.championshipId]=s.championship;});
    return Object.entries(m).map(([id,name])=>({id,name}));
  }
  async function getCategories(year,champId) {
    let a = year ? await dbGetAll('sessions','year',+year) : await dbGetAll('sessions');
    if (champId) a=a.filter(s=>s.championshipId===champId);
    const m={}; a.forEach(s=>{m[s.categoryId]=s.category;});
    return Object.entries(m).map(([id,name])=>({id,name}));
  }
  async function getEvents(year,catId) {
    const a = await getSessions({year,category:catId});
    const m={}; a.forEach(s=>{m[s.eventId]=s.eventName;});
    return Object.entries(m).map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name));
  }
  async function getRiders(id) {
    if (!db) await initDB();
    return id ? dbGet('riders',id) : dbGetAll('riders');
  }
  async function getDBStats() {
    if (!db) await initDB();
    const [sessions,riders,li] = await Promise.all([dbCount('sessions'),dbCount('riders'),dbGet('meta','lastImport')]);
    return {sessions,riders,lastImport:li?.value??null};
  }
  async function resetDB() {
    if (!db) await initDB();
    for (const s of ['sessions','riders','meta'])
      await new Promise((r,j)=>{const q=_tx(s,'readwrite').clear();q.onsuccess=r;q.onerror=j;});
  }

  const lapToSec = str => {
    if (!str) return null;
    const s=String(str).trim(); let m;
    m=s.match(/^(\d+):(\d{2})\.(\d{1,3})$/); if(m) return +m[1]*60+ +m[2]+ +m[3].padEnd(3,'0')/1000;
    m=s.match(/^(\d{1,3})\.(\d{1,3})$/);     if(m) return +m[1]+ +m[2].padEnd(3,'0')/1000;
    return null;
  };

  return {
    init:initDB, importFromJSON, reimportYear,
    getSessions, getYears, getChampionships, getCategories, getEvents,
    getRiders, getDBStats, resetDB,
    calcPts, classifySession, classifyResultType, lapToSec,
  };
})();
