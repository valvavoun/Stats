/* ═══════════════════════════════════════════════════════
   MXGP Race Analytics — stats.js
   State · Storage · Charts · Stats calculation · Events
═══════════════════════════════════════════════════════ */

/* ── Bike brand colours (same ref as main.js) ── */
const BIKE_COLORS = {
  KTM: { bg: "#ff6600", fg: "#fff" },
  HUS: { bg: "#969696", fg: "#fff" },
  GAS: { bg: "#ff1a1a", fg: "#fff" },
  HON: { bg: "#cc0000", fg: "#fff" },
  KAW: { bg: "#00a651", fg: "#fff" },
  YAM: { bg: "#0033a0", fg: "#fff" },
  TM:  { bg: "#0057b8", fg: "#fff" },
  TRI: { bg: "#ffd100", fg: "#222" },
  BET: { bg: "#a0002a", fg: "#fff" },
  DUC: { bg: "#ffffff", fg: "#242424" },
  FAN: { bg: "#1e1e1e", fg: "#fff" },
  DEF: { bg: "#2e3650", fg: "#dde3f0" },
};

/* Points scale (MXGP official) */
const PTS_SCALE = [25,22,20,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1];

/* ── Global state ── */
const S = {
  db:     {},           // key → session data
  cur:    null,         // current session key
  riders: [],           // current session riders (processed)
  sel:    new Set(),    // selected rider nr values
  tab:    "lap",        // active chart tab
  chart:  null,         // Chart.js instance
  colVis: { base: true, lap: true, sector: true, adv: false },
};

/* ══════════════════════════════════════════
   HELPERS
══════════════════════════════════════════ */

/** Get bike colour object for a bike name string */
function bikeColor(bike) {
  const b = (bike || "").toUpperCase().trim();
  for (const [key, val] of Object.entries(BIKE_COLORS)) {
    if (b.includes(key)) return val;
  }
  return BIKE_COLORS.DEF;
}

/** Rider line colour for charts (bike bg color) */
function riderColor(rider) {
  return bikeColor(rider.bike).bg;
}

/** Rider initials: first letter first name + first letter last name */
function initials(r) {
  const fn = (r.firstName || "").trim();
  const ln = (r.lastName || "").trim();
  return (fn[0] || "") + (ln[0] || "");
}

/** Parse time string "M:SS.mmm" or "MM:SS.mmm" to seconds (float) */
function parseTime(s) {
  if (typeof s === "number") return s;
  if (!s || s === "—") return null;
  const m = String(s).match(/^(\d+):(\d{2})\.(\d+)$/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]) + parseFloat("0." + m[3]);
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/** Format seconds to "M:SS.mmm" */
function fmtTime(secs) {
  if (secs == null || isNaN(secs)) return "—";
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

/** Format seconds to "+S.mmm" gap */
function fmtGap(secs) {
  if (secs == null || isNaN(secs) || secs === 0) return "LEADER";
  return "+" + secs.toFixed(3);
}

/** Standard deviation */
function stdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sq = arr.map(x => (x - mean) ** 2);
  return Math.sqrt(sq.reduce((a, b) => a + b, 0) / arr.length);
}

/** Trimmed mean (exclude best + worst, "pace") */
function trimmedMean(arr) {
  if (!arr || arr.length < 3) return arr ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
  const sorted = [...arr].sort((a, b) => a - b);
  const trimmed = sorted.slice(1, -1);
  return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
}

/** Rolling average of an array with window size w */
function rollingAvg(arr, w = 3) {
  return arr.map((_, i) => {
    const slice = arr.slice(Math.max(0, i - w + 1), i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/** Cumulative sum array */
function cumsum(arr) {
  let acc = 0;
  return arr.map(v => { acc += (v || 0); return acc; });
}

/** Build lap-by-lap gap to leader (seconds) */
function gapToLeader(riders) {
  if (!riders.length) return {};
  const leader = riders[0]; // pos 1 at index 0
  const laps = (leader.lapTimes || []).length;
  const result = {};
  const leaderCumul = cumsum(leader.lapTimes || []);

  for (const r of riders) {
    const rCumul = cumsum(r.lapTimes || []);
    result[r.nr] = rCumul.map((t, i) => {
      const lg = leaderCumul[i];
      return lg != null ? t - lg : null;
    });
  }
  return result;
}

/** Build lap-by-lap position arrays from lapTimes (sorted per lap) */
function buildPositions(riders) {
  if (!riders.length) return {};
  const laps = Math.max(...riders.map(r => (r.lapTimes || []).length));
  const result = {};
  for (const r of riders) result[r.nr] = [];

  for (let lap = 0; lap < laps; lap++) {
    // Cumul time for each rider at this lap
    const lapTotals = riders.map(r => {
      const lts = r.lapTimes || [];
      if (lap >= lts.length) return { nr: r.nr, total: Infinity };
      const total = lts.slice(0, lap + 1).reduce((a, b) => a + b, 0);
      return { nr: r.nr, total };
    });
    lapTotals.sort((a, b) => a.total - b.total);
    lapTotals.forEach((item, idx) => {
      result[item.nr].push(idx + 1);
    });
  }
  return result;
}

/* ══════════════════════════════════════════
   STATS CALCULATION
══════════════════════════════════════════ */

/**
 * Calculate all professional stats for an array of riders.
 * Returns an enriched copy with extra fields.
 */
function calcStats(riders) {
  // Sort by pos first
  const sorted = [...riders].sort((a, b) => (a.pos || 99) - (b.pos || 99));

  return sorted.map((r, idx) => {
    const lts = (r.lapTimes || []).filter(t => t != null && t > 0);
    const avgLap = lts.length ? lts.reduce((a, b) => a + b, 0) / lts.length : null;
    const pace = trimmedMean(lts);
    const consistency = stdDev(lts);  // lower = better
    const bestLap = lts.length ? Math.min(...lts) : (r.bestLap || null);
    const worstLap = lts.length ? Math.max(...lts) : null;

    // Sector averages (if available)
    const sectorAvg = [null, null, null, null];
    if (r.sectors && r.sectors.length) {
      for (let s = 0; s < 4; s++) {
        const vals = r.sectors.map(lap => lap[s]).filter(v => v != null && v > 0);
        sectorAvg[s] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      }
    }

    // Points (from data or scale)
    const points = r.points != null ? r.points : (PTS_SCALE[idx] || 0);

    // Start gain: grid pos - lap 1 pos
    const gridPos = r.gridPos || null;
    const lap1Pos = r.lap1Pos || null; // if available from position chart
    const startGain = (gridPos && lap1Pos) ? gridPos - lap1Pos : null;

    // Overall gain: grid - final pos
    const overallGain = (gridPos && r.pos) ? gridPos - r.pos : null;

    return {
      ...r,
      lapTimes: lts,
      avgLap, pace, consistency,
      bestLap, worstLap,
      sectorAvg,
      points,
      startGain,
      overallGain,
      initials: initials(r),
      color: riderColor(r),
    };
  });
}

/* ══════════════════════════════════════════
   STORAGE
══════════════════════════════════════════ */

const STORAGE_KEY = "mxgp_stats_db";

function dbLoad() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    S.db = raw ? JSON.parse(raw) : {};
  } catch (e) {
    S.db = {};
  }
}

function dbSave() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(S.db));
  } catch (e) {
    console.warn("Storage full:", e);
  }
}

function sessionKey(cat, event, race) {
  return [cat, event, race].map(s => (s || "").trim()).join("|");
}

/** Save a session to db. data = { meta, riders: [...] } */
function sessionStore(data) {
  const key = sessionKey(data.meta.category, data.meta.event, data.meta.race);
  S.db[key] = data;
  dbSave();
  return key;
}

/** Load session by key and update state */
function sessionActivate(key) {
  const data = S.db[key];
  if (!data) return;
  S.cur = key;
  S.riders = calcStats(data.riders || []);

  // Select top 10 by default
  S.sel.clear();
  const maxSel = parseInt(document.getElementById("sel-max-riders").value) || 10;
  S.riders.slice(0, maxSel || S.riders.length).forEach(r => S.sel.add(r.nr));

  // Update header
  const m = data.meta;
  document.getElementById("sb-cat").textContent   = m.category || "—";
  document.getElementById("sb-event").textContent = m.event    || "—";
  document.getElementById("sb-race").textContent  = m.race     || "—";
  document.getElementById("session-date").textContent =
    m.date ? new Date(m.date).toLocaleDateString("fr-FR", { day:"2-digit", month:"long", year:"numeric" }) : "—";
  document.getElementById("brand-cat").textContent = m.category || "MXGP";
  document.getElementById("t-cat").textContent = m.category || "STATS";

  renderSessionList();
  renderRiderSelector();
  renderStatCards();
  renderStatsTable();
  drawChart();
  updateTicker();

  document.getElementById("btn-export").disabled = false;
  document.getElementById("btn-del-session").disabled = false;
  document.getElementById("sel-session").value = key;
}

/** Delete session by key */
function sessionDelete(key) {
  delete S.db[key];
  dbSave();
  if (S.cur === key) {
    S.cur = null;
    S.riders = [];
    S.sel.clear();
    resetUI();
  }
  renderSessionList();
  populateSessionSelect();
}

/* ══════════════════════════════════════════
   IMPORT / EXPORT
══════════════════════════════════════════ */

/** Import a JSON file. Supports two formats:
    1. Full session: { meta: {...}, riders: [...] }
    2. Riders array only: [{ pos, nr, firstName, ... }]
    3. Scraper output: { results: { raceName: { riders: [...] } } }
*/
function importJSON(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      let sessions = [];

      // Format 1: full session object
      if (data.meta && data.riders) {
        sessions.push(data);
      }
      // Format 2: array of sessions
      else if (Array.isArray(data) && data[0] && data[0].meta) {
        sessions = data;
      }
      // Format 3: scraper output { category, event, race, riders }
      else if (data.category && data.riders) {
        sessions.push({ meta: { category: data.category, event: data.event || "—", race: data.race || "Race 1", date: data.date || "" }, riders: data.riders });
      }
      // Format 4: raw riders array - ask for meta from modal
      else if (Array.isArray(data)) {
        // Show a prompt to fill meta then combine
        pendingRiders = data;
        openManualModal(data);
        return;
      }
      // Format 5: scraper bulk output { sessions: [...] }
      else if (data.sessions && Array.isArray(data.sessions)) {
        sessions = data.sessions;
      } else {
        throw new Error("Format JSON non reconnu");
      }

      // Store all sessions
      let lastKey = null;
      for (const s of sessions) {
        if (!s.meta) s.meta = {};
        if (!s.riders) s.riders = [];
        lastKey = sessionStore(s);
      }

      renderSessionList();
      populateSessionSelect();
      if (lastKey) sessionActivate(lastKey);

      setTicker(`✓ ${sessions.length} session(s) importée(s) depuis le fichier JSON`);
    } catch (err) {
      alert("Erreur import JSON : " + err.message);
    }
  };
  reader.readAsText(file);
}

/** Export current session to JSON */
function exportJSON() {
  if (!S.cur) return;
  const data = S.db[S.cur];
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mxgp_stats_${S.cur.replace(/\|/g, "_").replace(/\s+/g, "_")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

let pendingRiders = null;

/* ══════════════════════════════════════════
   RENDER — SESSION LIST & SELECTOR
══════════════════════════════════════════ */

function renderSessionList() {
  const el = document.getElementById("session-list");
  const keys = Object.keys(S.db);

  if (!keys.length) {
    el.innerHTML = `<div class="empty-state">Aucune session sauvegardée</div>`;
    return;
  }

  el.innerHTML = keys.map(key => {
    const d = S.db[key];
    const m = d.meta || {};
    const active = key === S.cur ? " active" : "";
    const cat = m.category || "—";
    const name = [m.event, m.race].filter(Boolean).join(" · ");
    const date = m.date ? new Date(m.date).toLocaleDateString("fr-FR") : "";
    return `<div class="sess-item${active}" data-key="${escHtml(key)}">
      <span class="sess-cat">${escHtml(cat)}</span>
      <div class="sess-info">
        <div class="sess-name">${escHtml(name || key)}</div>
        <div class="sess-date">${escHtml(date)}</div>
      </div>
      <button class="sess-del" data-key="${escHtml(key)}" title="Supprimer">✕</button>
    </div>`;
  }).join("");

  // Events
  el.querySelectorAll(".sess-item").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("sess-del")) return;
      sessionActivate(el.dataset.key);
    });
  });
  el.querySelectorAll(".sess-del").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm("Supprimer cette session ?")) sessionDelete(btn.dataset.key);
    });
  });
}

function populateSessionSelect() {
  const sel = document.getElementById("sel-session");
  const keys = Object.keys(S.db);
  sel.innerHTML = `<option value="">— Aucune —</option>` +
    keys.map(k => {
      const m = (S.db[k].meta || {});
      const label = [m.category, m.event, m.race].filter(Boolean).join(" · ") || k;
      return `<option value="${escHtml(k)}" ${k === S.cur ? "selected" : ""}>${escHtml(label)}</option>`;
    }).join("");
}

/* ══════════════════════════════════════════
   RENDER — RIDER SELECTOR (left panel)
══════════════════════════════════════════ */

function renderRiderSelector() {
  const el = document.getElementById("rider-list");
  const countEl = document.getElementById("rider-sel-count");

  if (!S.riders.length) {
    el.innerHTML = `<div class="empty-state">Aucune donnée</div>`;
    countEl.textContent = "0/0";
    return;
  }

  countEl.textContent = `${S.sel.size}/${S.riders.length}`;

  el.innerHTML = S.riders.map(r => {
    const col = r.color;
    const checked = S.sel.has(r.nr) ? "checked" : "";
    const selCls = S.sel.has(r.nr) ? " selected" : "";
    const posTxt = r.pos || "—";
    return `<div class="rider-item${selCls}" data-nr="${r.nr}">
      <input type="checkbox" class="rider-cb" data-nr="${r.nr}" ${checked} />
      <div class="rider-swatch" style="background:${col}"></div>
      <span class="rider-nr">${r.nr}</span>
      <div class="rider-name">
        <span class="rider-fn">${escHtml(r.firstName || "")}</span>
        <span class="rider-ln">${escHtml(r.lastName || "")}</span>
      </div>
      <span class="rider-pos-badge" style="color:${col}">${posTxt}</span>
    </div>`;
  }).join("");

  el.querySelectorAll(".rider-item").forEach(item => {
    item.addEventListener("click", (e) => {
      const nr = parseInt(item.dataset.nr);
      if (S.sel.has(nr)) { S.sel.delete(nr); item.classList.remove("selected"); }
      else               { S.sel.add(nr);    item.classList.add("selected"); }
      const cb = item.querySelector(".rider-cb");
      if (cb) cb.checked = S.sel.has(nr);
      countEl.textContent = `${S.sel.size}/${S.riders.length}`;
      drawChart();
    });
  });
}

/* ══════════════════════════════════════════
   RENDER — STAT CARDS
══════════════════════════════════════════ */

function renderStatCards() {
  const container = document.getElementById("stat-cards");
  const riders = S.riders;

  if (!riders.length) {
    container.innerHTML = buildPlaceholderCards();
    return;
  }

  const winner   = riders[0];
  const fastLap  = [...riders].sort((a,b)=>(a.bestLap||999)-(b.bestLap||999))[0];
  const bestPace = [...riders].filter(r=>r.pace).sort((a,b)=>a.pace-b.pace)[0];
  const mostCons = [...riders].filter(r=>r.consistency).sort((a,b)=>a.consistency-b.consistency)[0];
  const bestStart= riders.filter(r=>r.startGain!=null).sort((a,b)=>b.startGain-a.startGain)[0];
  const maxGain  = riders.filter(r=>r.overallGain!=null).sort((a,b)=>b.overallGain-a.overallGain)[0];

  const cards = [
    {
      icon:"🏆", label:"VAINQUEUR", cls:"sc-gold",
      value: winner ? `${winner.firstName?.[0]}. ${winner.lastName}` : "—",
      sub: winner ? `#${winner.nr} · ${winner.bike}` : "—",
    },
    {
      icon:"⚡", label:"MEILLEUR TOUR", cls:"sc-purple",
      value: fastLap?.bestLap ? fmtTime(fastLap.bestLap) : "—",
      sub: fastLap ? `${fastLap.firstName?.[0]}. ${fastLap.lastName} · Tour ${fastLap.bestLapNum||"?"}` : "—",
    },
    {
      icon:"📊", label:"MEILLEURE PACE", cls:"sc-green",
      value: bestPace?.pace ? fmtTime(bestPace.pace) : "—",
      sub: bestPace ? `${bestPace.firstName?.[0]}. ${bestPace.lastName} (moy. tronquée)` : "—",
    },
    {
      icon:"🎯", label:"PLUS RÉGULIER", cls:"sc-blue",
      value: mostCons?.consistency != null ? `σ ${mostCons.consistency.toFixed(3)}s` : "—",
      sub: mostCons ? `${mostCons.firstName?.[0]}. ${mostCons.lastName}` : "—",
    },
    {
      icon:"🚀", label:"MEILLEUR DÉPART", cls:"sc-orange",
      value: bestStart?.startGain != null ? `+${bestStart.startGain} pos` : "—",
      sub: bestStart ? `${bestStart.firstName?.[0]}. ${bestStart.lastName} (grille→T1)` : "Données grille manquantes",
    },
    {
      icon:"📈", label:"MAX POSITIONS", cls:"sc-accent",
      value: maxGain?.overallGain != null ? `+${maxGain.overallGain}` : "—",
      sub: maxGain ? `${maxGain.firstName?.[0]}. ${maxGain.lastName}` : "Données grille manquantes",
    },
  ];

  container.innerHTML = cards.map(c =>
    `<div class="stat-card ${c.cls}">
      <div class="sc-icon">${c.icon}</div>
      <div class="sc-label">${c.label}</div>
      <div class="sc-value">${c.value}</div>
      <div class="sc-sub">${c.sub}</div>
    </div>`
  ).join("");
}

function buildPlaceholderCards() {
  return `
    <div class="stat-card placeholder"><div class="sc-icon">🏆</div><div class="sc-label">VAINQUEUR</div><div class="sc-value">—</div><div class="sc-sub">—</div></div>
    <div class="stat-card placeholder"><div class="sc-icon">⚡</div><div class="sc-label">MEILLEUR TOUR</div><div class="sc-value">—</div><div class="sc-sub">—</div></div>
    <div class="stat-card placeholder"><div class="sc-icon">📊</div><div class="sc-label">MEILLEURE PACE</div><div class="sc-value">—</div><div class="sc-sub">—</div></div>
    <div class="stat-card placeholder"><div class="sc-icon">🎯</div><div class="sc-label">PLUS RÉGULIER</div><div class="sc-value">—</div><div class="sc-sub">—</div></div>
    <div class="stat-card placeholder"><div class="sc-icon">🚀</div><div class="sc-label">MEILLEUR DÉPART</div><div class="sc-value">—</div><div class="sc-sub">—</div></div>
    <div class="stat-card placeholder"><div class="sc-icon">📈</div><div class="sc-label">MAX POSITIONS</div><div class="sc-value">—</div><div class="sc-sub">—</div></div>
  `;
}

/* ══════════════════════════════════════════
   RENDER — STATS TABLE
══════════════════════════════════════════ */

function renderStatsTable() {
  const tbody = document.getElementById("stbl-tbody");
  const riders = S.riders;

  if (!riders.length) {
    tbody.innerHTML = `<tr><td colspan="17" class="stbl-empty">Aucune donnée chargée</td></tr>`;
    return;
  }

  // Find best lap overall (purple)
  const allBests = riders.map(r => r.bestLap).filter(Boolean);
  const overallBest = allBests.length ? Math.min(...allBests) : null;

  // Find best sector times overall
  const bestSectors = [null, null, null, null];
  riders.forEach(r => {
    r.sectorAvg.forEach((avg, i) => {
      if (avg != null && (bestSectors[i] == null || avg < bestSectors[i])) bestSectors[i] = avg;
    });
  });

  tbody.innerHTML = riders.map(r => {
    const bike = bikeColor(r.bike);
    const posCls = r.pos === 1 ? "p1" : r.pos === 2 ? "p2" : r.pos === 3 ? "p3" : "";
    const trCls = r.pos === 1 ? "tr-p1" : r.pos === 2 ? "tr-p2" : r.pos === 3 ? "tr-p3" : "";

    const bestCls = (r.bestLap && overallBest && Math.abs(r.bestLap - overallBest) < 0.001) ? " best" : "";

    const gainCls = (r.overallGain != null)
      ? (r.overallGain > 0 ? " green" : r.overallGain < 0 ? " red" : " muted")
      : "";
    const gainTxt = r.overallGain != null
      ? (r.overallGain > 0 ? `+${r.overallGain}` : `${r.overallGain}`)
      : "—";

    const sectors = [0,1,2,3].map(i => {
      const val = r.sectorAvg[i];
      if (val == null) return `<td class="td c muted col-sector">—</td>`;
      const best = bestSectors[i] != null && Math.abs(val - bestSectors[i]) < 0.01;
      return `<td class="td c mono col-sector ${best ? "best" : ""}">${val.toFixed(3)}</td>`;
    }).join("");

    return `<tr class="${trCls}">
      <td class="td pos ${posCls}">${r.pos || "—"}</td>
      <td class="td c">
        <div class="td-nr-wrap">
          <div class="td-nr-badge" style="--nr-bg:${bike.bg};--nr-fg:${bike.fg}">${r.nr}</div>
        </div>
      </td>
      <td class="td">
        <div class="td-rider">
          <span class="td-fn">${escHtml(r.firstName || "")}</span>
          <span class="td-ln">${escHtml(r.lastName || "")}</span>
        </div>
      </td>
      <td class="td c muted mono" style="letter-spacing:1px">${escHtml(r.bike || "—")}</td>
      <td class="td c mono col-base">${r.totalTime ? (typeof r.totalTime === "number" ? fmtTime(r.totalTime) : r.totalTime) : "—"}</td>
      <td class="td c muted col-base">${r.laps || (r.lapTimes?.length) || "—"}</td>
      <td class="td c mono${bestCls} col-lap">${r.bestLap ? fmtTime(r.bestLap) : "—"}</td>
      <td class="td c mono col-lap">${r.avgLap ? fmtTime(r.avgLap) : "—"}</td>
      <td class="td c mono col-lap">${r.pace ? fmtTime(r.pace) : "—"}</td>
      <td class="td c mono col-lap">${r.consistency ? r.consistency.toFixed(3) + "s" : "—"}</td>
      ${sectors}
      <td class="td c muted col-adv">${r.gridPos || "—"}</td>
      <td class="td c${gainCls} col-adv">${gainTxt}</td>
      <td class="td c muted col-adv">${r.points != null ? r.points : "—"}</td>
    </tr>`;
  }).join("");
}

/* ══════════════════════════════════════════
   CHARTS
══════════════════════════════════════════ */

/** Get selected riders filtered by nr, ordered by pos */
function selectedRiders() {
  return S.riders.filter(r => S.sel.has(r.nr));
}

/** Common Chart.js config base */
function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    plugins: {
      legend: {
        display: true,
        labels: {
          color: "#4e566e",
          font: { family: "'Chakra Petch', monospace", size: 11, weight: "700" },
          usePointStyle: true,
          pointStyleWidth: 14,
          boxHeight: 3,
        },
      },
      tooltip: {
        backgroundColor: "#0e1118",
        borderColor: "#252b3d",
        borderWidth: 1,
        titleFont: { family: "'Chakra Petch', monospace", size: 11, weight: "700" },
        bodyFont: { family: "'Barlow Condensed', sans-serif", size: 13 },
        titleColor: "#dde3f0",
        bodyColor: "#4e566e",
        padding: 10,
      },
      datalabels: { display: false }, // off by default
    },
    scales: {
      x: {
        grid: { color: "#1a1f2e", drawTicks: false },
        ticks: {
          color: "#4e566e",
          font: { family: "'Chakra Petch', monospace", size: 10 },
        },
        border: { color: "#252b3d" },
      },
      y: {
        grid: { color: "#1a1f2e", drawTicks: false },
        ticks: {
          color: "#4e566e",
          font: { family: "'Chakra Petch', monospace", size: 10 },
        },
        border: { color: "#252b3d" },
      },
    },
  };
}

/** Datalabels plugin config: show initials at last point only */
function initialsLabels() {
  return {
    display: (ctx) => ctx.dataIndex === ctx.dataset.data.length - 1,
    formatter: (_, ctx) => ctx.dataset.label || "",
    color: (ctx) => ctx.dataset.borderColor || "#fff",
    font: { family: "'Chakra Petch', monospace", size: 10, weight: "700" },
    anchor: "end",
    align: "right",
    offset: 4,
    padding: 0,
  };
}

/* ── 1. Lap Times ── */
function chartLapTimes() {
  const riders = selectedRiders();
  if (!riders.length || !riders.some(r => r.lapTimes?.length)) return null;

  const maxLaps = Math.max(...riders.map(r => r.lapTimes?.length || 0));
  const labels  = Array.from({ length: maxLaps }, (_, i) => `T${i + 1}`);

  const datasets = riders.map(r => {
    const col = r.color;
    const inits = r.initials;
    return {
      label: inits,
      data: r.lapTimes.map(t => t != null ? parseFloat(t.toFixed(3)) : null),
      borderColor: col,
      backgroundColor: col + "22",
      pointRadius: 3,
      pointHoverRadius: 6,
      pointBackgroundColor: col,
      borderWidth: 2,
      tension: 0.25,
      spanGaps: true,
    };
  });

  const cfg = chartDefaults();
  cfg.plugins.datalabels = initialsLabels();
  cfg.plugins.tooltip.callbacks = {
    title: ([ctx]) => `Tour ${ctx.dataIndex + 1}`,
    label: (ctx) => {
      const r = riders.find(x => x.initials === ctx.dataset.label);
      const v = ctx.raw;
      return ` ${r ? `${r.firstName} ${r.lastName}` : ctx.dataset.label} : ${fmtTime(v)}`;
    },
  };
  cfg.scales.y.ticks.callback = (v) => fmtTime(v);
  cfg.scales.y.title = { display: true, text: "Temps", color: "#4e566e", font: { size: 10, family: "'Chakra Petch', monospace" } };

  // Best lap annotation line (visual baseline)
  const allTimes = riders.flatMap(r => r.lapTimes || []).filter(Boolean);
  if (allTimes.length) {
    const minT = Math.min(...allTimes);
    cfg.scales.y.min = Math.max(0, minT - 5);
  }

  return new Chart(document.getElementById("main-chart"), {
    type: "line",
    data: { labels, datasets },
    options: cfg,
    plugins: [ChartDataLabels],
  });
}

/* ── 2. Gap to Leader ── */
function chartGap() {
  const riders = selectedRiders();
  if (!riders.length || !riders.some(r => r.lapTimes?.length)) return null;

  const maxLaps = Math.max(...riders.map(r => r.lapTimes?.length || 0));
  const labels  = Array.from({ length: maxLaps }, (_, i) => `T${i + 1}`);
  const gapMap  = gapToLeader(S.riders); // use all riders for leader reference

  const datasets = riders.map(r => {
    const col = r.color;
    const gapArr = (gapMap[r.nr] || []).map(g => g != null ? parseFloat(g.toFixed(3)) : null);
    return {
      label: r.initials,
      data: gapArr,
      borderColor: col,
      backgroundColor: col + "22",
      pointRadius: 3,
      pointHoverRadius: 6,
      pointBackgroundColor: col,
      borderWidth: 2,
      tension: 0.25,
      spanGaps: true,
    };
  });

  const cfg = chartDefaults();
  cfg.plugins.datalabels = initialsLabels();
  cfg.plugins.tooltip.callbacks = {
    title: ([ctx]) => `Tour ${ctx.dataIndex + 1}`,
    label: (ctx) => {
      const r = riders.find(x => x.initials === ctx.dataset.label);
      const v = ctx.raw;
      return ` ${r ? `${r.firstName} ${r.lastName}` : ctx.dataset.label} : ${fmtGap(v)}`;
    },
  };
  cfg.scales.y.ticks.callback = (v) => v === 0 ? "LEADER" : `+${v.toFixed(1)}s`;
  cfg.scales.y.title = { display: true, text: "Écart au leader (s)", color: "#4e566e", font: { size: 10 } };

  return new Chart(document.getElementById("main-chart"), {
    type: "line",
    data: { labels, datasets },
    options: cfg,
    plugins: [ChartDataLabels],
  });
}

/* ── 3. Race Position Evolution ── */
function chartPosition() {
  const riders = selectedRiders();
  if (!riders.length || !riders.some(r => r.lapTimes?.length)) return null;

  const posMap  = buildPositions(S.riders); // use all riders for correct positions
  const maxLaps = Math.max(...Object.values(posMap).map(a => a.length));
  const labels  = Array.from({ length: maxLaps }, (_, i) => `T${i + 1}`);

  const datasets = riders.map(r => {
    const col = r.color;
    const posArr = posMap[r.nr] || [];
    return {
      label: r.initials,
      data: posArr,
      borderColor: col,
      backgroundColor: col + "22",
      pointRadius: 3,
      pointHoverRadius: 6,
      pointBackgroundColor: col,
      borderWidth: 2,
      tension: 0,
      stepped: "before",
      spanGaps: true,
    };
  });

  const cfg = chartDefaults();
  cfg.plugins.datalabels = initialsLabels();
  cfg.plugins.tooltip.callbacks = {
    title: ([ctx]) => `Tour ${ctx.dataIndex + 1}`,
    label: (ctx) => {
      const r = riders.find(x => x.initials === ctx.dataset.label);
      return ` ${r ? `${r.firstName} ${r.lastName}` : ctx.dataset.label} : P${ctx.raw}`;
    },
  };
  cfg.scales.y.reverse = true; // P1 at top
  cfg.scales.y.min = 1;
  cfg.scales.y.max = S.riders.length + 1;
  cfg.scales.y.ticks.callback = (v) => `P${v}`;
  cfg.scales.y.title = { display: true, text: "Position", color: "#4e566e", font: { size: 10 } };

  return new Chart(document.getElementById("main-chart"), {
    type: "line",
    data: { labels, datasets },
    options: cfg,
    plugins: [ChartDataLabels],
  });
}

/* ── 4. Race Pace (horizontal bar) ── */
function chartPace() {
  const riders = selectedRiders().filter(r => r.pace);
  if (!riders.length) return null;

  const sorted = [...riders].sort((a, b) => a.pace - b.pace);
  const bestPace = sorted[0].pace;
  const labels   = sorted.map(r => `${r.initials} #${r.nr}`);
  const values   = sorted.map(r => parseFloat(r.pace.toFixed(3)));
  const colors   = sorted.map(r => r.color);

  const cfg = chartDefaults();
  delete cfg.scales.y;
  cfg.indexAxis = "y";
  cfg.plugins.datalabels = {
    display: true,
    anchor: "end",
    align: "right",
    color: "#dde3f0",
    font: { family: "'Chakra Petch', monospace", size: 11, weight: "700" },
    formatter: (v) => fmtTime(v),
  };
  cfg.plugins.legend.display = false;
  cfg.plugins.tooltip.callbacks = {
    label: (ctx) => ` Pace : ${fmtTime(ctx.raw)} (+${(ctx.raw - bestPace).toFixed(3)}s)`,
  };
  cfg.scales.x = {
    ...cfg.scales.x,
    ticks: { callback: (v) => fmtTime(v), color: "#4e566e", font: { size: 10, family: "'Chakra Petch', monospace" } },
    title: { display: true, text: "Pace (moy. tronquée)", color: "#4e566e", font: { size: 10 } },
    min: Math.max(0, bestPace - 5),
  };
  cfg.scales.yAxis = {
    grid: { color: "#1a1f2e" },
    ticks: { color: "#dde3f0", font: { size: 12, family: "'Chakra Petch', monospace" } },
    border: { color: "#252b3d" },
  };

  return new Chart(document.getElementById("main-chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Pace",
        data: values,
        backgroundColor: colors.map(c => c + "cc"),
        borderColor: colors,
        borderWidth: 1,
        borderRadius: 2,
        borderSkipped: false,
      }],
    },
    options: { ...cfg, indexAxis: "y" },
    plugins: [ChartDataLabels],
  });
}

/* ── 5. Sector Times (grouped bar) ── */
function chartSectors() {
  const riders = selectedRiders().filter(r => r.sectorAvg?.some(v => v != null));
  if (!riders.length) return null;

  const sectorLabels = ["S1", "S2", "S3", "S4"];
  const datasets = riders.map(r => ({
    label: `${r.initials} #${r.nr}`,
    data: r.sectorAvg.map(v => v != null ? parseFloat(v.toFixed(3)) : null),
    backgroundColor: r.color + "cc",
    borderColor: r.color,
    borderWidth: 1,
    borderRadius: 2,
  }));

  const cfg = chartDefaults();
  cfg.plugins.datalabels = {
    display: true,
    color: "#dde3f0",
    font: { family: "'Chakra Petch', monospace", size: 9, weight: "700" },
    anchor: "end", align: "top", offset: 2,
    formatter: (v) => v != null ? v.toFixed(2) : "",
  };
  cfg.plugins.tooltip.callbacks = {
    label: (ctx) => ` ${ctx.dataset.label} : ${ctx.raw != null ? ctx.raw.toFixed(3) + "s" : "—"}`,
  };
  cfg.scales.y.title = { display: true, text: "Temps secteur moyen (s)", color: "#4e566e", font: { size: 10 } };

  return new Chart(document.getElementById("main-chart"), {
    type: "bar",
    data: { labels: sectorLabels, datasets },
    options: cfg,
    plugins: [ChartDataLabels],
  });
}

/* ── 6. Consistency (std deviation bar) ── */
function chartConsistency() {
  const riders = selectedRiders().filter(r => r.consistency != null);
  if (!riders.length) return null;

  const sorted   = [...riders].sort((a, b) => a.consistency - b.consistency);
  const labels   = sorted.map(r => `${r.initials} #${r.nr}`);
  const values   = sorted.map(r => parseFloat(r.consistency.toFixed(4)));
  const colors   = sorted.map((r, i) => {
    // Gradient: best (green) → worst (red)
    const ratio = i / Math.max(sorted.length - 1, 1);
    const g = Math.round(201 * (1 - ratio));
    const rr = Math.round(232 * ratio);
    return `rgb(${rr},${g},74)`;
  });

  const cfg = chartDefaults();
  cfg.plugins.datalabels = {
    display: true,
    anchor: "end", align: "top", offset: 2,
    color: "#dde3f0",
    font: { family: "'Chakra Petch', monospace", size: 11, weight: "700" },
    formatter: (v) => `σ ${v.toFixed(3)}s`,
  };
  cfg.plugins.legend.display = false;
  cfg.plugins.tooltip.callbacks = {
    label: (ctx) => {
      const r = sorted[ctx.dataIndex];
      return ` ${r.firstName} ${r.lastName} : σ = ${ctx.raw.toFixed(3)}s`;
    },
  };
  cfg.scales.y.title = { display: true, text: "Écart-type (σ) — secondes", color: "#4e566e", font: { size: 10 } };
  cfg.scales.y.min = 0;

  return new Chart(document.getElementById("main-chart"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Consistance",
        data: values,
        backgroundColor: colors.map(c => c.replace(")", ", 0.75)").replace("rgb", "rgba")),
        borderColor: colors,
        borderWidth: 1,
        borderRadius: 2,
      }],
    },
    options: cfg,
    plugins: [ChartDataLabels],
  });
}

/* ── Master draw function ── */
const CHART_TITLES = {
  lap:         "ÉVOLUTION DES TEMPS PAR TOUR",
  gap:         "ÉCART AU LEADER PAR TOUR",
  pos:         "ÉVOLUTION DES POSITIONS",
  pace:        "PACE ANALYSIS (MOY. TRONQUÉE)",
  sector:      "TEMPS DE SECTEURS MOYENS (S1–S4)",
  consistency: "CONSISTANCE — ÉCART-TYPE (σ)",
};

function drawChart() {
  // Show canvas, hide no-data msg
  const canvas = document.getElementById("main-chart");
  const noData = document.getElementById("no-data-msg");
  const hint   = document.getElementById("chart-hint");
  const title  = document.getElementById("chart-title");

  title.textContent = CHART_TITLES[S.tab] || "";

  // Destroy previous chart
  if (S.chart) { S.chart.destroy(); S.chart = null; }

  const riders = selectedRiders();
  if (!S.riders.length || !riders.length) {
    canvas.style.display = "none";
    noData.style.display = "flex";
    hint.textContent = "Importez des données et sélectionnez des pilotes";
    return;
  }

  noData.style.display = "none";
  canvas.style.display = "block";
  hint.textContent = `${riders.length} pilote(s) sélectionné(s)`;

  switch (S.tab) {
    case "lap":         S.chart = chartLapTimes();    break;
    case "gap":         S.chart = chartGap();          break;
    case "pos":         S.chart = chartPosition();     break;
    case "pace":        S.chart = chartPace();         break;
    case "sector":      S.chart = chartSectors();      break;
    case "consistency": S.chart = chartConsistency();  break;
  }

  if (!S.chart) {
    canvas.style.display = "none";
    noData.style.display = "flex";
    hint.textContent = "Données insuffisantes pour ce type de graphique";
  }
}

/* ══════════════════════════════════════════
   TICKER
══════════════════════════════════════════ */
function setTicker(txt) {
  const inner = document.getElementById("t-inner");
  inner.innerHTML = `<span class="ti">${escHtml(txt)}</span><span class="ti">${escHtml(txt)}</span>`;
}

function updateTicker() {
  if (!S.riders.length) return;
  const winner = S.riders[0];
  const best   = [...S.riders].sort((a,b) => (a.bestLap||999)-(b.bestLap||999))[0];
  const parts  = [
    `<strong>VAINQUEUR</strong> ${winner.firstName} ${winner.lastName} #${winner.nr} (${winner.bike})`,
    `<span class="tp">MEILLEUR TOUR</span> ${best.firstName} ${best.lastName} #${best.nr} — ${fmtTime(best.bestLap)}`,
    ...S.riders.slice(1, 5).map(r => `P${r.pos} ${r.firstName} ${r.lastName} #${r.nr} · ${r.bike}`),
  ];
  const line = parts.join("  <span class='t-sep'>·</span>  ");
  const inner = document.getElementById("t-inner");
  inner.innerHTML = `<span class="ti">${line}</span><span class="ti">${line}</span>`;
}

/* ══════════════════════════════════════════
   MANUAL INPUT MODAL
══════════════════════════════════════════ */

function openManualModal(prefillRiders) {
  document.getElementById("m-date").value = new Date().toISOString().slice(0, 10);
  if (prefillRiders) {
    document.getElementById("m-json").value = JSON.stringify(prefillRiders, null, 2);
  }
  document.getElementById("modal-overlay").removeAttribute("hidden");
}

function closeManualModal() {
  document.getElementById("modal-overlay").setAttribute("hidden", "");
  pendingRiders = null;
}

function saveManualSession() {
  const cat   = document.getElementById("m-cat").value.trim();
  const event = document.getElementById("m-event").value.trim();
  const race  = document.getElementById("m-race").value.trim();
  const date  = document.getElementById("m-date").value;
  const raw   = document.getElementById("m-json").value.trim();

  if (!event) { alert("Renseignez le nom du GP / manche."); return; }

  let riders = pendingRiders || [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      riders = Array.isArray(parsed) ? parsed : (parsed.riders || []);
    } catch (e) {
      alert("JSON invalide : " + e.message);
      return;
    }
  }

  // Normalise lap times (parse strings to seconds)
  riders = riders.map(r => ({
    ...r,
    lapTimes: (r.lapTimes || []).map(parseTime).filter(v => v != null),
    bestLap: r.bestLap ? parseTime(r.bestLap) : null,
    totalTime: r.totalTime || null,
  }));

  const session = { meta: { category: cat, event, race, date }, riders };
  const key = sessionStore(session);
  renderSessionList();
  populateSessionSelect();
  sessionActivate(key);
  closeManualModal();
}

/* ══════════════════════════════════════════
   COLUMN VISIBILITY TOGGLE
══════════════════════════════════════════ */

function applyColVis() {
  const table = document.getElementById("stats-table");
  const cls = table.className.replace(/\bhide-\w+/g, "").trim();
  const hidden = Object.entries(S.colVis)
    .filter(([, v]) => !v)
    .map(([k]) => `hide-${k}`)
    .join(" ");
  table.className = cls + (hidden ? " " + hidden : "");
}

/* ══════════════════════════════════════════
   RESET UI
══════════════════════════════════════════ */

function resetUI() {
  document.getElementById("sb-cat").textContent   = "—";
  document.getElementById("sb-event").textContent = "Aucune session";
  document.getElementById("sb-race").textContent  = "—";
  document.getElementById("session-date").textContent = "Importez des données pour commencer";
  document.getElementById("brand-cat").textContent = "MXGP";
  document.getElementById("t-cat").textContent = "STATS";
  renderStatCards();
  renderStatsTable();
  if (S.chart) { S.chart.destroy(); S.chart = null; }
  document.getElementById("main-chart").style.display = "none";
  document.getElementById("no-data-msg").style.display = "flex";
  document.getElementById("btn-export").disabled = true;
  document.getElementById("btn-del-session").disabled = true;
  document.getElementById("rider-list").innerHTML = `<div class="empty-state">Aucune donnée</div>`;
  document.getElementById("rider-sel-count").textContent = "0/0";
  populateSessionSelect();
}

/* ══════════════════════════════════════════
   UTILITY
══════════════════════════════════════════ */
function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ══════════════════════════════════════════
   EVENT LISTENERS
══════════════════════════════════════════ */

function initEvents() {
  // Import button
  document.getElementById("btn-import").addEventListener("click", () => {
    document.getElementById("file-input").click();
  });
  document.getElementById("file-input").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) importJSON(f);
    e.target.value = "";
  });

  // Export button
  document.getElementById("btn-export").addEventListener("click", exportJSON);

  // Session selector (toolbar)
  document.getElementById("sel-session").addEventListener("change", (e) => {
    if (e.target.value) sessionActivate(e.target.value);
    else { S.cur = null; S.riders = []; S.sel.clear(); resetUI(); }
  });

  // Delete session button (toolbar)
  document.getElementById("btn-del-session").addEventListener("click", () => {
    if (S.cur && confirm("Supprimer cette session ?")) sessionDelete(S.cur);
  });

  // Chart tabs
  document.querySelectorAll(".tb-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tb-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      S.tab = btn.dataset.tab;
      drawChart();
    });
  });

  // Max riders selector
  document.getElementById("sel-max-riders").addEventListener("change", () => {
    if (S.riders.length) {
      const n = parseInt(document.getElementById("sel-max-riders").value) || S.riders.length;
      S.sel.clear();
      S.riders.slice(0, n || S.riders.length).forEach(r => S.sel.add(r.nr));
      renderRiderSelector();
      drawChart();
    }
  });

  // Top 10 button
  document.getElementById("btn-top10").addEventListener("click", () => {
    S.sel.clear();
    S.riders.slice(0, 10).forEach(r => S.sel.add(r.nr));
    renderRiderSelector();
    drawChart();
  });

  // Reset selection
  document.getElementById("btn-clear-sel").addEventListener("click", () => {
    S.sel.clear();
    renderRiderSelector();
    drawChart();
  });

  // Manual input
  document.getElementById("btn-manual").addEventListener("click", () => openManualModal());
  document.getElementById("modal-close").addEventListener("click", closeManualModal);
  document.getElementById("m-cancel").addEventListener("click", closeManualModal);
  document.getElementById("m-save").addEventListener("click", saveManualSession);
  document.getElementById("modal-overlay").addEventListener("click", (e) => {
    if (e.target === document.getElementById("modal-overlay")) closeManualModal();
  });

  // Column toggles
  document.querySelectorAll(".col-tog").forEach(btn => {
    btn.addEventListener("click", () => {
      const col = btn.dataset.col;
      S.colVis[col] = !S.colVis[col];
      btn.classList.toggle("active", S.colVis[col]);
      applyColVis();
    });
  });

  // Drag-to-scroll on left panel for rider list (desktop UX)
  const riderListEl = document.getElementById("rider-list");
  let isDragging = false, startY, scrollTop;
  riderListEl.addEventListener("mousedown", e => {
    isDragging = true; startY = e.pageY; scrollTop = riderListEl.scrollTop;
  });
  document.addEventListener("mouseup", () => { isDragging = false; });
  document.addEventListener("mousemove", e => {
    if (!isDragging) return;
    riderListEl.scrollTop = scrollTop - (e.pageY - startY);
  });
}

/* ══════════════════════════════════════════
   INIT
══════════════════════════════════════════ */

/* ══════════════════════════════════════════
   AUTO-FETCH DATA
   Charge automatiquement data/results.json
   (GitHub Pages — généré par GitHub Actions)
══════════════════════════════════════════ */

async function autoFetchData() {
  const candidates = ["data/results.json", "results.json"];
  for (const dataPath of candidates) {
    try {
      const res = await fetch(dataPath, { cache: "no-cache" });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data) continue;

      let sessions = [];
      if (data.sessions && Array.isArray(data.sessions))          sessions = data.sessions;
      else if (data.meta && data.riders)                          sessions = [data];
      else if (Array.isArray(data) && data[0]?.meta)              sessions = data;

      if (!sessions.length) continue;

      let lastKey = null;
      for (const s of sessions) {
        if (!s.meta)   s.meta   = {};
        if (!s.riders) s.riders = [];
        // Parse string lap times to numbers
        s.riders = s.riders.map(r => ({
          ...r,
          lapTimes: (r.lapTimes || []).map(v => typeof v === "string" ? parseTime(v) : v).filter(v => v != null),
          bestLap:  r.bestLap ? (typeof r.bestLap === "string" ? parseTime(r.bestLap) : r.bestLap) : null,
        }));
        lastKey = sessionStore(s);
      }

      renderSessionList();
      populateSessionSelect();
      if (lastKey) sessionActivate(lastKey);

      setTicker(`✓ Auto-chargé : ${sessions.length} session(s) depuis ${dataPath}`);
      console.log(`[MXGP] Auto-fetch OK: ${sessions.length} sessions from "${dataPath}"`);
      return true;
    } catch (e) {
      console.log(`[MXGP] Auto-fetch skipped (${dataPath}):`, e.message);
    }
  }
  return false;
}

function init() {
  Chart.defaults.font.family = "'Barlow Condensed', sans-serif";
  Chart.defaults.color = "#4e566e";

  dbLoad();
  renderSessionList();
  populateSessionSelect();
  initEvents();

  // Auto-activate last local session if available
  const keys = Object.keys(S.db);
  if (keys.length) sessionActivate(keys[keys.length - 1]);

  // Default col-adv hidden
  S.colVis.adv = false;
  document.querySelector(".col-tog[data-col='adv']").classList.remove("active");
  applyColVis();

  // Auto-fetch remote data AFTER local sessions loaded
  // (will override display if remote data is fresher)
  autoFetchData().catch(e => console.warn("[MXGP] autoFetch error:", e));
}

// Wait for Chart.js to load
window.addEventListener("load", init);
