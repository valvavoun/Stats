/**
 * ═══════════════════════════════════════════════════════════
 *  MXGP Results Scraper — scraper.js  v3.0 (bug-fixed)
 *  Playwright · ASP.NET WebForms (ViewState + postback)
 *
 *  Fixes vs v2:
 *   - Use ":scope > td, :scope > th" everywhere → no nested-table bleed
 *   - Dedicated Analysis parser (per-rider blocks with inner tables)
 *   - Skip Lap Chart (P/L position matrix, not times), WC, Manufacturers
 *   - detectColumns rewritten for exact cell names
 *   - parseTime handles "1:45.0902" (ms + lap-nr concatenated)
 *
 *  Usage :
 *    npm install playwright
 *    npx playwright install chromium
 *    node scraper.js [--year 2026] [--cat MXGP] [--out ../data/results.json]
 *
 *  Options :
 *    --year   Année cible (défaut: année en cours). "all" = toutes.
 *    --cat    Catégorie filtre ex: "MXGP" (défaut: toutes)
 *    --event  Filtre sur le nom de l'événement (sous-chaîne)
 *    --out    Fichier de sortie (défaut: mxgp_results_YYYY-MM-DD.json)
 *    --slow   Délai entre requêtes ms (défaut: 1000)
 *    --csv    Exporter aussi en CSV
 *    --debug  Mode verbose + dump HTML
 * ═══════════════════════════════════════════════════════════
 */

const { chromium } = require("playwright");
const fs   = require("fs");
const path = require("path");

/* ── CLI args ── */
function arg(name, def) {
  const idx = process.argv.indexOf("--" + name);
  if (idx === -1) return def;
  return process.argv[idx + 1] || def;
}
const YEAR_FILTER  = arg("year",  String(new Date().getFullYear()));
const CAT_FILTER   = (arg("cat",   "") || "").toUpperCase();
const EVENT_FILTER = (arg("event", "") || "").toLowerCase();
const SLOW_MS      = parseInt(arg("slow", "1000"), 10);
const DEBUG        = process.argv.includes("--debug");
const EXPORT_CSV   = process.argv.includes("--csv");
const OUT_FILE     = arg("out", `mxgp_results_${new Date().toISOString().slice(0,10)}.json`);

/* ── Constants ── */
const BASE_URL = "https://results.mxgp.com/reslists.aspx";
const TIMEOUT  = 45_000;

/* ── Points scale ── */
const PTS_SCALE = [25,22,20,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1];

/* ── Logger ── */
const log  = (...a) => console.log("[MXGP]", ...a);
const dbg  = (...a) => DEBUG && console.log("[DBG]", ...a);
const warn = (...a) => console.warn("[WARN]", ...a);

/* ══════════════════════════════════════════
   HELPERS
══════════════════════════════════════════ */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Parse time string to seconds.
 * Handles: "M:SS.mmm", "M:SS.mmmN" (extra digit = lap nr), "SS.mmm"
 */
function parseTime(s) {
  if (s == null) return null;
  if (typeof s === "number") return isNaN(s) ? null : s;
  const str = String(s).trim();
  if (!str || str === "—" || str === "-" || str === "DNF" || str === "DNS") return null;

  // "M:SS.mmm" — capture exactly 1-3 ms digits (ignore any trailing digit = lap nr)
  let m = str.match(/^(\d+):(\d{2})[.,](\d{1,3})/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]) + parseFloat("0." + m[3]);

  // "0:SS.mmm" minute part = 0
  m = str.match(/^0:(\d{2})[.,](\d{1,3})/);
  if (m) return parseInt(m[1]) + parseFloat("0." + m[2]);

  // Pure decimal "SS.mmm"
  m = str.match(/^(\d+)[.,](\d+)$/);
  if (m) return parseFloat(str.replace(",", "."));

  return null;
}

/** Get options from a <select> — tries multiple selector patterns */
async function getOptions(page, selectBaseName) {
  const selectors = [
    `#${selectBaseName}`,
    `[id$='${selectBaseName}']`,
    `[id*='${selectBaseName}']`,
    `select[name='${selectBaseName}']`,
    `select[name$='${selectBaseName}']`,
  ];
  for (const sel of selectors) {
    try {
      const opts = await page.$$eval(`${sel} option`, opts =>
        opts.map(o => ({ value: o.value, text: o.text.trim() }))
          .filter(o => o.value && o.value !== "0" && o.value.trim() !== "")
      );
      if (opts.length) { dbg(`  getOptions(${selectBaseName}) via "${sel}" → ${opts.length}`); return opts; }
    } catch { /* try next */ }
  }
  dbg(`  getOptions(${selectBaseName}) → NOT FOUND`);
  return [];
}

/** Select value and wait for ASP.NET postback */
async function selectAndWait(page, selectBaseName, value) {
  dbg(`  select ${selectBaseName} = "${value}"`);
  const selectors = [
    `#${selectBaseName}`,
    `[id$='${selectBaseName}']`,
    `[id*='${selectBaseName}']`,
    `select[name='${selectBaseName}']`,
  ];
  for (const sel of selectors) {
    try {
      await page.selectOption(sel, value, { timeout: 5000 });
      dbg(`    → via "${sel}"`);
      break;
    } catch { /* try next */ }
  }
  // Wait for network to settle after ASP.NET postback
  try { await page.waitForLoadState("networkidle", { timeout: TIMEOUT }); }
  catch { await sleep(1500); }

  // For SelectResult: additionally wait for a data table row to actually appear
  // (AJAX can finish network-idle before the DOM is fully rendered)
  if (selectBaseName.toLowerCase().includes("result")) {
    try {
      await page.waitForFunction(() => {
        const tables = Array.from(document.querySelectorAll("table"));
        return tables.some(t => {
          const rows = t.querySelectorAll("tr");
          return Array.from(rows).some(tr => {
            const cells = tr.querySelectorAll(":scope > td");
            return cells.length >= 3 && /^\d+$/.test((cells[0].textContent || "").trim());
          });
        });
      }, { timeout: 8000 });
      dbg(`    table rows appeared`);
    } catch {
      dbg(`    waitForFunction timeout — proceeding anyway`);
    }
  }

  await sleep(SLOW_MS);
}

/* ══════════════════════════════════════════
   TABLE PARSING  (v3 — scoped cell selection)
══════════════════════════════════════════ */

/**
 * Find the index of the most "data-like" table on the page.
 * Evaluation runs inside the browser with :scope > td/th (no nested bleed).
 */
async function findBestTableIdx(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll("table"));
    let bestIdx = -1, bestScore = 0;

    tables.forEach((t, i) => {
      const rows = Array.from(t.querySelectorAll("tr"));
      let dataCount = 0, headerFound = false;

      for (const tr of rows) {
        const cells = Array.from(tr.querySelectorAll(":scope > td, :scope > th"))
          .map(c => (c.innerText || c.textContent || "").trim());

        if (cells.length < 3) continue;
        if (/^\d+$/.test(cells[0])) dataCount++;
        if (/^pos$/i.test(cells[0]) && /^(nr|num|#|no)$/i.test(cells[1] || "")) headerFound = true;
        if (/^pos$/i.test(cells[0]) && /^rider$/i.test(cells[2] || ""))         headerFound = true;
      }

      const score = dataCount * 10 + (headerFound ? 100 : 0);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    });

    return { idx: bestIdx, score: bestScore };
  });
}

/**
 * Parse the per-rider Analysis table.
 * Structure: outer table whose <td> cells each contain an inner table
 * with per-lap rows (Lap | Laptime | S1 | S2 | S3 | S4).
 */
async function parseAnalysisTable(page, resultType) {
  // Step 1: collect raw blocks inside the browser
  const blocks = await page.evaluate(() => {
    // Leaf tables = tables that contain no nested tables = per-rider lap tables
    const allTables = Array.from(document.querySelectorAll("table"));
    const leafTables = allTables.filter(t => t.querySelectorAll("table").length === 0);

    // Keep only tables whose first row looks like a lap-data header
    const lapTables = leafTables.filter(t => {
      const rows = Array.from(t.querySelectorAll("tr"));
      if (rows.length < 3) return false;
      const hText = (rows[0].innerText || rows[0].textContent || "").trim().toLowerCase();
      return (hText.includes("lap") && hText.includes("time")) ||
              hText.includes("laptime") ||
             (hText.includes("lap") && hText.includes("section"));
    });

    return lapTables.map(t => {
      // Rider info is the text in the parent <td>, minus the table's own content
      const parentTd = t.closest("td");
      let riderInfo = "";
      if (parentTd) {
        const clone = parentTd.cloneNode(true);
        clone.querySelectorAll("table").forEach(x => x.remove());
        riderInfo = (clone.innerText || clone.textContent || "")
          .replace(/\s+/g, " ").trim();
      }

      // Rows with scoped cells (no nested bleed)
      const rows = Array.from(t.querySelectorAll("tr")).map(tr =>
        Array.from(tr.querySelectorAll(":scope > td, :scope > th"))
          .map(c => (c.innerText || c.textContent || "").trim())
      ).filter(r => r.length >= 2);

      return { riderInfo, rows };
    });
  });

  dbg(`  Analysis: found ${blocks.length} rider blocks`);

  const BIKES = ["KTM","HUSQVARNA","HUS","HONDA","HON","KAWASAKI","KAW",
                 "YAMAHA","YAM","DUCATI","DUC","TRIUMPH","TRI","FANTIC","FAN",
                 "BETA","BET","TM","GAS GAS","GASGAS","GAS","SHERCO"];

  const parsedRiders = [];

  for (const { riderInfo, rows } of blocks) {
    // Lap rows = first cell is a lap number
    const lapRows = rows.filter(r => /^\d+$/.test(r[0]));
    if (!lapRows.length) continue;

    // Parse rider info string: "5 Coenen Lucas KTM" or "5 Coenen Lucas\nKTM"
    const tokens = riderInfo.replace(/[\n\r]+/g, " ").trim().split(/\s+/).filter(Boolean);
    const nr = parseInt(tokens[0]) || null;

    let bike = null;
    let nameTokens = tokens.slice(1);
    // Bike is usually the last token
    for (let i = nameTokens.length - 1; i >= 0; i--) {
      const up = nameTokens[i].toUpperCase();
      if (BIKES.some(b => b.split(" ")[0] === up || up === b)) {
        bike = nameTokens[i];
        nameTokens = nameTokens.slice(0, i);
        break;
      }
    }

    const firstName = nameTokens[0] || "";
    const lastName  = nameTokens.slice(1).join(" ");

    const lapTimes = [];
    const sectors  = [];

    for (const row of lapRows) {
      const lt = parseTime(row[1]);
      if (lt !== null && lt > 0) lapTimes.push(lt);

      const sv = [2, 3, 4, 5].map(i => parseTime(row[i])).filter(v => v !== null && v > 0);
      if (sv.length >= 2) sectors.push(sv);
    }

    if (!lapTimes.length) continue;

    parsedRiders.push({
      pos: null,
      nr,
      firstName,
      lastName,
      bike,
      lapTimes,
      sectors,
      bestLap:    Math.min(...lapTimes),
      laps:       lapTimes.length,
      _resultType: resultType,
    });
  }

  dbg(`  Analysis: ${parsedRiders.length} riders parsed`);
  return { resultType, rows: parsedRiders };
}

/**
 * Parse the main results table currently displayed on the page.
 * Returns { resultType, rows: [...] }
 */
async function parseResultTable(page, resultType) {
  if (DEBUG) {
    const html = await page.content();
    const fname = `debug_${resultType.replace(/\W+/g, "_")}.html`;
    fs.writeFileSync(fname, html);
    dbg(`  HTML dumped to ${fname}`);
  }

  const rtLower = resultType.toLowerCase();

  // ── Special parser for Analysis ──────────────────────────────
  if (rtLower.includes("analysis")) {
    return parseAnalysisTable(page, resultType);
  }

  // ── Skip position matrix / cumulative tables ──────────────────
  if (rtLower.includes("lap chart")) {
    dbg("  Skip Lap Chart (P/L position matrix — lap times come from Analysis)");
    return { resultType, rows: [] };
  }
  if (rtLower.includes("world championship") || rtLower.includes("manufacturers")) {
    dbg(`  Skip cumulative: ${resultType}`);
    return { resultType, rows: [] };
  }

  // ── Find the best table ───────────────────────────────────────
  const { idx, score } = await findBestTableIdx(page);
  dbg(`  Best table idx=${idx} score=${score}`);

  if (idx === -1 || score < 10) {
    dbg("  No suitable table found");
    return { resultType, rows: [] };
  }

  const tables = await page.$$("table");
  if (!tables[idx]) return { resultType, rows: [] };

  // ── Read rows using :scope to avoid nested table bleed ────────
  const rawRows = await tables[idx].$$eval("tr", trs =>
    trs.map(tr => {
      return Array.from(tr.querySelectorAll(":scope > td, :scope > th"))
        .map(c => (c.innerText || c.textContent || "").trim());
    }).filter(r => r.filter(c => c.length > 0).length >= 3)
  );

  dbg(`  Raw rows: ${rawRows.length}`);

  // ── Find header row ───────────────────────────────────────────
  const headerRow =
    rawRows.find(r => /^pos$/i.test(r[0]) && r.length >= 4) ||
    rawRows.find(r => r.some(c => /^pos$/i.test(c)) && r.some(c => /^(nr|num)$/i.test(c)));

  dbg(`  Header: ${(headerRow || []).slice(0, 8).join(" | ")}`);

  // ── Data rows: first cell is a plain number (position) ────────
  const dataRows = rawRows.filter(r => /^\d+$/.test((r[0] || "").trim()));
  dbg(`  Data rows: ${dataRows.length}`);

  if (!dataRows.length) return { resultType, rows: [] };

  const colMap = detectColumns(headerRow || []);
  dbg(`  colMap: ${JSON.stringify(colMap)}`);

  const rows = dataRows.map(cells => parseRow(cells, colMap, resultType)).filter(Boolean);
  dbg(`  Parsed rows: ${rows.length}`);

  return { resultType, rows };
}

/* ══════════════════════════════════════════
   COLUMN DETECTION
══════════════════════════════════════════ */

/**
 * Map column header names to indices.
 * Normalises to lowercase letters+digits only for matching.
 *
 * Expected Classification headers (in order):
 *   Pos · Nr · Rider · Nat. · Fed. · Bike · Time · laps ·
 *   Diff. First · Diff. Prev. · Bestlaptime · in lap · Speed
 */
function detectColumns(header) {
  const map = {};
  header.forEach((h, i) => {
    const n = (h || "").toLowerCase().replace(/[^a-z0-9]/g, "");

    if      (n === "pos" || n === "position")                    map.pos = i;
    else if (/^(nr|nb|num|number|no|bib)$/.test(n))              map.nr  = i;
    else if (/^(rider|name|pilot)$/.test(n) && map.rider == null) map.rider = i;
    else if (/^(nat|nationality|country)$/.test(n))              map.nat  = i;
    // "fed" / "federation" — deliberately ignored
    else if (/^(bike|brand|moto|marque|make)$/.test(n))          map.bike = i;
    else if (/^(time|totaltime|racetime)$/.test(n))              map.totalTime = i;
    else if (/^(laps|tours|nlaps)$/.test(n))                     map.laps = i;
    else if (/^(points|pts|pt)$/.test(n))                        map.points = i;
    else if (/difffirst|gapfirst|gapleader/.test(n))             map.diffFirst = i;
    else if (/diffprev|interval/.test(n))                        map.diffPrev  = i;
    else if (/bestlaptime|fastestlap/.test(n))                   map.bestLap   = i;
    else if (/inlap/.test(n))                                    map.bestLapNum = i;
    else if (/^s1$|^sector1$|^section1$/.test(n))                map.s1 = i;
    else if (/^s2$|^sector2$|^section2$/.test(n))                map.s2 = i;
    else if (/^s3$|^sector3$|^section3$/.test(n))                map.s3 = i;
    else if (/^s4$|^sector4$|^section4$/.test(n))                map.s4 = i;
    else if (/^(grid|start|grille|startpos)$/.test(n))           map.gridPos = i;
    else if (/^(lap\d+|l\d+)$/.test(n)) {
      if (!map.lapCols) map.lapCols = [];
      map.lapCols.push(i);
    }
  });
  return map;
}

/** Parse one data row into a rider object */
function parseRow(cells, colMap, resultType) {
  const get = (key, def = null) => {
    const idx = colMap[key];
    return (idx != null && cells[idx] != null) ? String(cells[idx]).trim() : def;
  };

  const posVal = parseInt(get("pos"), 10);
  if (isNaN(posVal)) return null;

  const riderRaw = get("rider", "");
  let firstName = "", lastName = riderRaw;
  if (riderRaw.includes(",")) {
    const p = riderRaw.split(",").map(s => s.trim());
    lastName  = p[0];
    firstName = p[1] || "";
  } else if (riderRaw.includes(" ")) {
    const p = riderRaw.trim().split(/\s+/);
    firstName = p[0];
    lastName  = p.slice(1).join(" ");
  }

  const sectors = colMap.s1 != null ? [
    [colMap.s1, colMap.s2, colMap.s3, colMap.s4]
      .filter(i => i != null)
      .map(i => parseTime(cells[i]))
      .filter(v => v !== null)
  ] : [];

  const lapTimes = (colMap.lapCols || [])
    .map(i => parseTime(cells[i]))
    .filter(v => v !== null && v > 0);

  const nr = parseInt(get("nr"), 10) || null;
  if (!nr && !riderRaw) return null;

  return {
    pos:        posVal,
    nr,
    firstName:  firstName.trim(),
    lastName:   lastName.trim(),
    nat:        get("nat"),
    bike:       get("bike"),
    totalTime:  get("totalTime"),
    laps:       parseInt(get("laps"), 10) || null,
    bestLap:    parseTime(get("bestLap")),
    bestLapNum: parseInt(get("bestLapNum"), 10) || null,
    diffFirst:  get("diffFirst"),
    diffPrev:   get("diffPrev"),
    gridPos:    parseInt(get("gridPos"), 10) || null,
    points:     parseInt(get("points"), 10) || (PTS_SCALE[posVal - 1] || 0),
    sectors,
    lapTimes,
    _resultType: resultType,
  };
}

/* ══════════════════════════════════════════
   MERGE RESULT TYPES
══════════════════════════════════════════ */

/**
 * Merge Classification + Analysis (+ optional Grid) into one riders array.
 * Keyed by rider number.
 */
function mergeResults(resultSets) {
  const byNr = {};

  for (const { resultType, rows } of resultSets) {
    const rtl = resultType.toLowerCase();

    for (const row of rows) {
      const key = row.nr != null ? String(row.nr) : `${row.firstName}_${row.lastName}`;
      if (!byNr[key]) byNr[key] = { sectors: [], lapTimes: [], ...row };
      const ex = byNr[key];

      // Analysis → lap times and sectors
      if (rtl.includes("analysis")) {
        if (row.lapTimes?.length) ex.lapTimes = row.lapTimes;
        if (row.sectors?.length)  ex.sectors  = row.sectors;
        if (row.bike && !ex.bike) ex.bike = row.bike;
      }

      // Classification → authoritative race fields
      if (rtl.includes("classification") && !rtl.includes("world") && !rtl.includes("manufacturers") && !rtl.includes("gp")) {
        if (row.pos != null)       ex.pos       = row.pos;
        if (row.totalTime)         ex.totalTime = row.totalTime;
        if (row.laps)              ex.laps      = row.laps;
        if (row.nat && !ex.nat)    ex.nat       = row.nat;
        if (row.bike && !ex.bike)  ex.bike      = row.bike;
        if (row.diffFirst)         ex.diffFirst = row.diffFirst;
        if (row.points)            ex.points    = row.points;
      }

      // Best lap (take the fastest across all result types)
      if (row.bestLap && (!ex.bestLap || row.bestLap < ex.bestLap)) {
        ex.bestLap    = row.bestLap;
        ex.bestLapNum = row.bestLapNum;
      }

      // Grid position
      if (rtl.includes("grid") && row.gridPos) ex.gridPos = row.gridPos;

      // Fill blanks
      for (const f of ["firstName","lastName","nat","bike","totalTime","laps"]) {
        if (!ex[f] && row[f]) ex[f] = row[f];
      }
    }
  }

  return Object.values(byNr).sort((a, b) => (a.pos || 999) - (b.pos || 999));
}

/* ══════════════════════════════════════════
   MAIN SCRAPER
══════════════════════════════════════════ */

async function scrape() {
  log("═".repeat(60));
  log("MXGP Results Scraper v3.0 — Playwright");
  log(`Year: ${YEAR_FILTER}  Cat: ${CAT_FILTER || "ALL"}  Out: ${OUT_FILE}`);
  log("═".repeat(60));

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.on("pageerror", e => dbg("page error:", e.message));

  const allSessions = [];
  let totalRaces = 0;

  // Result types we want (in priority order)
  // Lap Chart = P/L matrix → skipped. Analysis = per-rider lap+sector times → PRIMARY.
  const WANTED = [
    "classification",        // race results: pos, time, bike, nat
    "analysis",              // per-rider: lap times + sectors  ← most valuable
    "qualifying result",
    "grid", "starting grid",
  ];

  const SKIP = [
    "world championship", "manufacturers", "lap chart",
    "gp classification",   // cumulative GP points
    "photo", "video", "schedule", "timetable",
  ];

  try {
    log("Navigating to results.mxgp.com...");
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await sleep(2000);

    if (DEBUG) {
      const sels = await page.$$eval("select", els =>
        els.map(s => ({ id: s.id, name: s.name, opts: s.options.length }))
      );
      dbg("Selects on page:", JSON.stringify(sels, null, 2));
    }

    // ── Years ───────────────────────────────────────────────────
    const years = await getOptions(page, "SelectYear");
    log(`Found ${years.length} year(s): ${years.map(y => y.text).join(", ")}`);

    const targetYears = YEAR_FILTER === "all"
      ? years
      : years.filter(y => y.text.includes(YEAR_FILTER) || y.value.includes(YEAR_FILTER));

    if (!targetYears.length) {
      warn(`No year matching '${YEAR_FILTER}'`);
      await browser.close();
      return;
    }

    for (const year of targetYears) {
      log(`\n── Year: ${year.text} ──`);
      await selectAndWait(page, "SelectYear", year.value);

      const classes = await getOptions(page, "SelectClass");
      const targetClasses = CAT_FILTER
        ? classes.filter(c => c.text.toUpperCase().includes(CAT_FILTER))
        : classes;
      log(`  Classes: ${targetClasses.map(c => c.text).join(", ")}`);

      for (const cls of targetClasses) {
        log(`\n  ─ Category: ${cls.text} ─`);
        await selectAndWait(page, "SelectClass", cls.value);

        const events = await getOptions(page, "SelectEvent");
        const targetEvents = EVENT_FILTER
          ? events.filter(e => e.text.toLowerCase().includes(EVENT_FILTER))
          : events;
        log(`    Events: ${targetEvents.length} GP(s)`);

        for (const event of targetEvents) {
          log(`    ─ Event: ${event.text}`);
          await selectAndWait(page, "SelectEvent", event.value);

          const races = await getOptions(page, "SelectRace");
          if (!races.length) { dbg("      No races"); continue; }

          for (const race of races) {
            log(`      ─ Race: ${race.text}`);
            await selectAndWait(page, "SelectRace", race.value);

            const resultTypes = await getOptions(page, "SelectResult").catch(() => []);
            log(`        Result types (${resultTypes.length}): ${resultTypes.map(r => r.text).join(", ") || "none"}`);

            // Sort: WANTED types first (by priority index), SKIP types removed
            const filteredTypes = resultTypes.filter(rt => {
              const l = rt.text.toLowerCase();
              return !SKIP.some(s => l.includes(s));
            });

            const sortedTypes = [...filteredTypes].sort((a, b) => {
              const al = a.text.toLowerCase();
              const bl = b.text.toLowerCase();
              const ai = WANTED.findIndex(w => al.includes(w));
              const bi = WANTED.findIndex(w => bl.includes(w));
              return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
            });

            const resultSets = [];

            if (sortedTypes.length === 0) {
              // No SelectResult dropdown — likely data not yet published for this race
              log(`        No result types — trying current page directly`);
              const parsed = await parseResultTable(page, "Classification");
              if (parsed.rows.length) resultSets.push(parsed);
            } else {
              for (const rt of sortedTypes) {
                dbg(`        Parsing: "${rt.text}"`);
                await selectAndWait(page, "SelectResult", rt.value);
                const parsed = await parseResultTable(page, rt.text);
                dbg(`        → ${parsed.rows.length} rows`);
                if (parsed.rows.length) resultSets.push(parsed);
              }
            }

            if (!resultSets.length) {
              warn(`        No data for ${cls.text} · ${event.text} · ${race.text}`);
              continue;
            }

            const mergedRiders = mergeResults(resultSets);
            if (!mergedRiders.length) continue;

            totalRaces++;

            const dateMatch = event.text.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/);
            const session = {
              meta: {
                year:      year.text,
                category:  cls.text,
                event:     event.text,
                race:      race.text,
                date:      dateMatch ? dateMatch[0] : year.text,
                scrapedAt: new Date().toISOString(),
              },
              riders: mergedRiders,
            };

            allSessions.push(session);
            log(`        ✓ ${mergedRiders.length} riders — ${cls.text} · ${race.text}`);

            if (allSessions.length % 5 === 0) {
              saveJSON(allSessions, OUT_FILE);
              log(`        [AUTO-SAVE] ${allSessions.length} sessions`);
            }
          }
        }
      }
    }

  } catch (err) {
    console.error("Scraper error:", err);
  } finally {
    await browser.close();
  }

  log(`\n${"═".repeat(60)}`);
  log(`DONE — ${totalRaces} races, ${allSessions.length} sessions`);

  if (!allSessions.length) {
    warn("0 sessions scraped.");
    warn("Run with --debug to save HTML files and inspect structure.");
  }

  saveJSON(allSessions, OUT_FILE);
  if (EXPORT_CSV && allSessions.length) saveCSV(allSessions, OUT_FILE);
}

/* ══════════════════════════════════════════
   SAVE
══════════════════════════════════════════ */

function saveJSON(sessions, outFile) {
  const dir = path.dirname(outFile);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const output = {
    scraper:  "MXGP Results Scraper v3.0",
    scraped:  new Date().toISOString(),
    total:    sessions.length,
    sessions,
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), "utf-8");
  log(`JSON saved: ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);
}

function saveCSV(sessions, jsonFile) {
  const csvFile = jsonFile.replace(/\.json$/, ".csv");
  const header = ["year","category","event","race","date","pos","nr",
    "firstName","lastName","nat","bike","totalTime","laps","bestLap",
    "bestLapNum","gridPos","points","consistency","avgLap"].join(",");

  const rows = sessions.flatMap(s =>
    s.riders.map(r => {
      const lts = r.lapTimes || [];
      const avg = lts.length ? lts.reduce((a,b)=>a+b,0)/lts.length : "";
      const sd  = lts.length > 1
        ? Math.sqrt(lts.map(x=>(x-avg)**2).reduce((a,b)=>a+b,0)/lts.length).toFixed(4)
        : "";
      return [
        s.meta.year, s.meta.category, `"${s.meta.event}"`, s.meta.race, s.meta.date,
        r.pos, r.nr, r.firstName, r.lastName, r.nat, r.bike,
        r.totalTime||"", r.laps||"", r.bestLap||"", r.bestLapNum||"",
        r.gridPos||"", r.points||"", sd, avg ? avg.toFixed(3):"",
      ].join(",");
    })
  );

  fs.writeFileSync(csvFile, [header, ...rows].join("\n"), "utf-8");
  log(`CSV saved: ${csvFile}`);
}

/* ══════════════════════════════════════════
   RUN
══════════════════════════════════════════ */

scrape().catch(err => { console.error("Fatal:", err); process.exit(1); });
