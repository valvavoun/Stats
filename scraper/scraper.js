/**
 * ═══════════════════════════════════════════════════════════
 *  MXGP Results Scraper — scraper.js  (v2.0 — fixed)
 *  Playwright · ASP.NET WebForms (ViewState + postback)
 *
 *  Usage :
 *    npm install playwright
 *    npx playwright install chromium
 *    node scraper.js [--year 2026] [--cat MXGP] [--out results.json]
 *
 *  Options :
 *    --year   Année cible (défaut: année en cours). "all" = toutes les années.
 *    --cat    Catégorie filtre ex: "MXGP" (défaut: toutes)
 *    --event  Filtre sur le nom de l'événement (sous-chaîne, insensible casse)
 *    --out    Fichier de sortie (défaut: mxgp_results_YYYY-MM-DD.json)
 *    --slow   Délai entre requêtes en ms (défaut: 1000)
 *    --csv    Exporter aussi en CSV
 *    --debug  Mode verbose
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

/** Parse time string "M:SS.mmm" or "MM:SS.mmm" to seconds */
function parseTime(s) {
  if (s == null) return null;
  if (typeof s === "number") return isNaN(s) ? null : s;
  const str = String(s).trim();
  if (!str || str === "—" || str === "-" || str === "DNF" || str === "DNS") return null;
  // M:SS.mmm
  let m = str.match(/^(\d+):(\d{2})[.,](\d+)$/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]) + parseFloat("0." + m[3]);
  // SS.mmm
  m = str.match(/^(\d+)[.,](\d+)$/);
  if (m) return parseFloat(str.replace(",", "."));
  return null;
}

/**
 * Get options from a <select> element.
 * Tries both exact ID and partial ID match (ASP.NET mangled IDs).
 */
async function getOptions(page, selectBaseName) {
  // Try multiple selectors: exact, suffix match, name match
  const selectors = [
    `#${selectBaseName}`,
    `[id$='${selectBaseName}']`,
    `[id*='${selectBaseName}']`,
    `select[name$='${selectBaseName}']`,
    `select[name*='${selectBaseName}']`,
  ];

  for (const sel of selectors) {
    try {
      const opts = await page.$$eval(`${sel} option`, opts =>
        opts.map(o => ({ value: o.value, text: o.text.trim() }))
          .filter(o => o.value && o.value !== "0" && o.value.trim() !== "")
      );
      if (opts.length) {
        dbg(`  getOptions(${selectBaseName}) via "${sel}" → ${opts.length} opts`);
        return opts;
      }
    } catch { /* try next */ }
  }
  dbg(`  getOptions(${selectBaseName}) → NOT FOUND with any selector`);
  return [];
}

/**
 * Select option and wait for postback.
 * Uses flexible selector matching.
 */
async function selectAndWait(page, selectBaseName, value) {
  dbg(`  select ${selectBaseName} = "${value}"`);
  const selectors = [
    `#${selectBaseName}`,
    `[id$='${selectBaseName}']`,
    `[id*='${selectBaseName}']`,
    `select[name$='${selectBaseName}']`,
  ];

  let selected = false;
  for (const sel of selectors) {
    try {
      await page.selectOption(sel, value, { timeout: 5000 });
      selected = true;
      dbg(`    → selected via "${sel}"`);
      break;
    } catch { /* try next */ }
  }

  if (!selected) {
    warn(`  Could not select "${selectBaseName}" = "${value}"`);
    return;
  }

  // Wait for postback / networkidle
  try {
    await page.waitForLoadState("networkidle", { timeout: TIMEOUT });
  } catch {
    await sleep(1500);
  }
  await sleep(SLOW_MS);
}

/* ══════════════════════════════════════════
   TABLE PARSING
══════════════════════════════════════════ */

/**
 * Parse the results table currently displayed on the page.
 * Uses a multi-pass strategy: named table → biggest table → any table.
 */
async function parseResultTable(page, resultType) {
  // Dump HTML for debugging
  if (DEBUG) {
    const html = await page.content();
    fs.writeFileSync(`debug_${resultType.replace(/\W/g,"_")}.html`, html);
  }

  // ── Pass 1: find table rows across multiple possible selectors ──
  const tableSelectorCandidates = [
    "table.list_table",
    "table.results-table",
    "table#tblResults",
    "table[id*='Result']",
    "table[id*='Grid']",
    "table[id*='List']",
    ".maintable table",
    ".results table",
    "#results table",
    "table",   // fallback: any table
  ];

  let rawRows = [];

  for (const tsel of tableSelectorCandidates) {
    try {
      const rows = await page.$$eval(`${tsel} tr`, (trs) =>
        trs.map(tr => {
          const cells = Array.from(tr.querySelectorAll("td, th"))
            .map(c => (c.innerText || c.textContent || "").trim());
          return cells;
        }).filter(row => row.length >= 3)
      );
      if (rows.length > 2) {
        dbg(`  Table via "${tsel}": ${rows.length} rows`);
        rawRows = rows;
        break;
      }
    } catch { /* try next */ }
  }

  if (!rawRows.length) {
    dbg("  No table rows found on page");
    return { resultType, rows: [] };
  }

  // ── Pass 2: identify header row ──
  const headerRow = rawRows.find(r =>
    r.some(c => /pos|position|#|nr|nr\.|rider|name|pilot|time|laps|lap|s1|sector/i.test(c))
  );

  // ── Pass 3: find data rows (first cell is a number = position) ──
  const dataRows = rawRows.filter(r => {
    const first = (r[0] || "").trim();
    // Accept "1", "2", ..., "DNF", "DNS", "DSQ" as valid first cells
    return /^\d+$/.test(first) || /^(DNF|DNS|DSQ|RET|NC)$/i.test(first);
  });

  dbg(`  → headerRow cells: ${headerRow?.slice(0,8).join(" | ")}`);
  dbg(`  → dataRows: ${dataRows.length}`);

  if (!dataRows.length) {
    // Last resort: rows with enough cells where one column looks like a time
    const altRows = rawRows.filter(r =>
      r.length >= 3 &&
      r.some(c => /^\d+:\d{2}[.,]\d+$/.test(c))
    );
    if (altRows.length) {
      dbg(`  → Using alt rows (time-pattern match): ${altRows.length}`);
      // treat first altRow as potential header, rest as data
      const potentialData = altRows.filter(r => /^\d+$/.test((r[0] || "").trim()));
      if (potentialData.length) {
        const colMap = detectColumns(headerRow || altRows[0] || []);
        const parsed = potentialData.map(c => parseRow(c, colMap, resultType)).filter(Boolean);
        return { resultType, rows: parsed };
      }
    }
    return { resultType, rows: [] };
  }

  const colMap = detectColumns(headerRow || []);
  dbg(`  colMap: ${JSON.stringify(colMap)}`);

  const rows = dataRows.map(cells => parseRow(cells, colMap, resultType)).filter(Boolean);
  return { resultType, rows };
}

/** Detect column indices from header row */
function detectColumns(header) {
  const map = {};
  header.forEach((h, i) => {
    const norm = (h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (/^pos(ition)?$/.test(norm))                   map.pos = i;
    else if (/^(nr|nb|num|number|no|bib|#)$/.test(norm)) map.nr = i;
    else if (/rider|name|pilot|firstname|lastName|coureur/.test(norm) && map.rider == null) map.rider = i;
    else if (/^nat(ionality)?$|^country$/.test(norm)) map.nat = i;
    else if (/bike|brand|moto|marque/.test(norm))     map.bike = i;
    else if (/totaltime|racetime|^time$|total$/.test(norm)) map.totalTime = i;
    else if (/^laps?$|^tours?$/.test(norm))           map.laps = i;
    else if (/^points?$|^pts$/.test(norm))            map.points = i;
    else if (/diff.*first|gap.*lead|behind/.test(norm)) map.diffFirst = i;
    else if (/diff.*prev|prev$|interval/.test(norm))  map.diffPrev = i;
    else if (/bestlap|best.*lap|fastest/.test(norm))  map.bestLap = i;
    else if (/inlap|in.*lap|lap.*num|best.*in/.test(norm)) map.bestLapNum = i;
    else if (/^s1$|sector.*1|^1$/.test(norm) && map.s1 == null) map.s1 = i;
    else if (/^s2$|sector.*2/.test(norm) && map.s2 == null)     map.s2 = i;
    else if (/^s3$|sector.*3/.test(norm) && map.s3 == null)     map.s3 = i;
    else if (/^s4$|sector.*4/.test(norm) && map.s4 == null)     map.s4 = i;
    else if (/grid|start|grille|depart/.test(norm))   map.gridPos = i;
    else if (/laptime|lap\d+|^l\d+$/.test(norm)) {
      if (!map.lapCols) map.lapCols = [];
      map.lapCols.push(i);
    }
  });
  return map;
}

/** Parse a data row into a rider object */
function parseRow(cells, colMap, resultType) {
  const get = (key, def = null) => {
    const idx = colMap[key];
    return (idx != null && cells[idx] != null) ? String(cells[idx]).trim() : def;
  };

  const posRaw = (get("pos") || "").trim();
  const pos = parseInt(posRaw, 10);
  // Accept DNF/DNS etc. as pos = 99+
  const posVal = isNaN(pos) ? (/^(DNF|DNS|DSQ|RET|NC)$/i.test(posRaw) ? 99 : null) : pos;
  if (posVal === null) return null;

  // Rider name: try splitting "FIRSTNAME LASTNAME" or "LASTNAME, FIRSTNAME"
  const riderRaw = get("rider", "");
  let firstName = "", lastName = riderRaw;
  if (riderRaw.includes(",")) {
    const parts = riderRaw.split(",").map(s => s.trim());
    lastName  = parts[0];
    firstName = parts[1] || "";
  } else if (riderRaw.includes(" ")) {
    const parts = riderRaw.trim().split(/\s+/);
    firstName = parts[0];
    lastName  = parts.slice(1).join(" ");
  }

  // Sector times
  const sectors = (colMap.s1 != null) ? [
    [
      parseTime(cells[colMap.s1]),
      colMap.s2 != null ? parseTime(cells[colMap.s2]) : null,
      colMap.s3 != null ? parseTime(cells[colMap.s3]) : null,
      colMap.s4 != null ? parseTime(cells[colMap.s4]) : null,
    ].filter(v => v != null)
  ] : [];

  // Lap times (if lap chart)
  const lapTimes = (colMap.lapCols || []).map(i => parseTime(cells[i])).filter(v => v != null);

  const nr = parseInt(get("nr"), 10) || null;
  if (!nr && !riderRaw) return null; // skip empty rows

  return {
    pos: posVal,
    nr,
    firstName: firstName.trim(),
    lastName:  lastName.trim(),
    nat:       get("nat"),
    bike:      get("bike"),
    totalTime: get("totalTime"),
    laps:      parseInt(get("laps"), 10) || null,
    bestLap:   parseTime(get("bestLap")),
    bestLapNum:parseInt(get("bestLapNum"), 10) || null,
    diffFirst: get("diffFirst"),
    diffPrev:  get("diffPrev"),
    gridPos:   parseInt(get("gridPos"), 10) || null,
    points:    parseInt(get("points"), 10) || (PTS_SCALE[posVal - 1] || 0),
    sectors,
    lapTimes,
    _resultType: resultType,
  };
}

/* ══════════════════════════════════════════
   MERGE RESULT TYPES
══════════════════════════════════════════ */

function mergeResults(resultSets) {
  const byNr = {};

  for (const { resultType, rows } of resultSets) {
    for (const row of rows) {
      const key = row.nr != null ? String(row.nr) : `${row.firstName}_${row.lastName}`;
      if (!byNr[key]) {
        byNr[key] = { ...row, sectors: [], lapTimes: [] };
      }
      const existing = byNr[key];

      const rtLower = resultType.toLowerCase();

      // Lap times come from "Lap Chart" or "Lap Times"
      if ((rtLower.includes("lap chart") || rtLower.includes("lap time") || rtLower.includes("lapchart"))
          && row.lapTimes?.length) {
        existing.lapTimes = row.lapTimes;
      }

      // Best lap
      if (row.bestLap && (!existing.bestLap || row.bestLap < existing.bestLap)) {
        existing.bestLap    = row.bestLap;
        existing.bestLapNum = row.bestLapNum;
      }

      // Sectors
      if ((rtLower.includes("sector") || rtLower.includes("s1")) && row.sectors?.length) {
        existing.sectors.push(...row.sectors);
      }

      // Grid position
      if ((rtLower.includes("grid") || rtLower.includes("starting")) && row.gridPos) {
        existing.gridPos = row.gridPos;
      }

      // Points
      if (row.points && !existing.points) existing.points = row.points;

      // Fill in any missing fields
      for (const field of ["firstName","lastName","nat","bike","totalTime","laps","pos"]) {
        if (!existing[field] && row[field]) existing[field] = row[field];
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
  log("MXGP Results Scraper v2.0 — Playwright");
  log(`Target: ${BASE_URL}`);
  log(`Year filter: ${YEAR_FILTER}  Category: ${CAT_FILTER || "ALL"}`);
  log(`Output: ${OUT_FILE}`);
  log("═".repeat(60));

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
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

  // Result types we want to collect (broad match — accept everything useful)
  // We NO LONGER filter strictly: we try ALL available result types
  const PRIORITY_TYPES = [
    "race result", "race results",
    "lap chart", "lap times", "lap time",
    "best laps", "best lap",
    "sector times", "sector time", "sectors",
    "grid", "starting grid",
    "qualifying result", "qualifying results",
  ];

  try {
    log("Navigating to results.mxgp.com...");
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await sleep(2000);

    // Dump all select elements for debugging
    if (DEBUG) {
      const selects = await page.$$eval("select", els =>
        els.map(s => ({ id: s.id, name: s.name, opts: s.options.length }))
      );
      dbg("Page selects:", JSON.stringify(selects, null, 2));
    }

    // ── 2. Get years ──
    const years = await getOptions(page, "SelectYear");
    log(`Found ${years.length} year(s): ${years.map(y => y.text).join(", ")}`);

    if (!years.length) {
      warn("No years found! The page structure may have changed. Run with --debug to save HTML.");
      await browser.close();
      return;
    }

    const targetYears = YEAR_FILTER === "all"
      ? years
      : years.filter(y => y.text.includes(YEAR_FILTER) || y.value.includes(YEAR_FILTER));

    if (!targetYears.length) {
      warn(`No year matching '${YEAR_FILTER}'. Available: ${years.map(y => y.text).join(", ")}`);
      await browser.close();
      return;
    }

    // ── 3. Loop over years ──
    for (const year of targetYears) {
      log(`\n── Year: ${year.text} ──`);
      await selectAndWait(page, "SelectYear", year.value);

      // Get classes (categories)
      const classes = await getOptions(page, "SelectClass");
      if (!classes.length) {
        warn("  No classes found after year select");
        continue;
      }

      const targetClasses = CAT_FILTER
        ? classes.filter(c => c.text.toUpperCase().includes(CAT_FILTER))
        : classes;

      log(`  Classes: ${targetClasses.map(c => c.text).join(", ")}`);

      // ── 4. Loop over classes ──
      for (const cls of targetClasses) {
        log(`\n  ─ Category: ${cls.text} ─`);
        await selectAndWait(page, "SelectClass", cls.value);

        const events = await getOptions(page, "SelectEvent");
        const targetEvents = EVENT_FILTER
          ? events.filter(e => e.text.toLowerCase().includes(EVENT_FILTER))
          : events;

        log(`    Events: ${targetEvents.length} GP(s)`);

        // ── 5. Loop over events ──
        for (const event of targetEvents) {
          log(`    ─ Event: ${event.text}`);
          await selectAndWait(page, "SelectEvent", event.value);

          const races = await getOptions(page, "SelectRace");
          if (!races.length) {
            dbg("      No races found");
            continue;
          }

          // ── 6. Loop over races ──
          for (const race of races) {
            log(`      ─ Race: ${race.text}`);
            await selectAndWait(page, "SelectRace", race.value);

            // Get result types
            const resultTypes = await getOptions(page, "SelectResult").catch(() => []);
            dbg(`        Result types found: ${resultTypes.length} — ${resultTypes.map(r => r.text).join(", ")}`);

            const resultSets = [];

            if (resultTypes.length === 0) {
              // No SelectResult dropdown — try to parse current page directly
              dbg("        No SelectResult dropdown — parsing current page directly");
              const parsed = await parseResultTable(page, "Race Results");
              if (parsed.rows.length) {
                resultSets.push(parsed);
                dbg(`        → Direct parse: ${parsed.rows.length} rows`);
              } else {
                warn(`        No data for ${cls.text} · ${event.text} · ${race.text}`);
              }
            } else {
              // Sort: priority types first
              const sortedTypes = [...resultTypes].sort((a, b) => {
                const ai = PRIORITY_TYPES.findIndex(p => a.text.toLowerCase().includes(p));
                const bi = PRIORITY_TYPES.findIndex(p => b.text.toLowerCase().includes(p));
                const av = ai === -1 ? 999 : ai;
                const bv = bi === -1 ? 999 : bi;
                return av - bv;
              });

              // ── 7. Loop over ALL result types ──
              for (const rt of sortedTypes) {
                const rtLower = rt.text.toLowerCase();

                // Skip types we definitely don't want
                const skipTypes = ["photo", "video", "press", "live timing", "schedule", "timetable"];
                if (skipTypes.some(s => rtLower.includes(s))) {
                  dbg(`        Skip (irrelevant): ${rt.text}`);
                  continue;
                }

                dbg(`        Parsing result type: "${rt.text}"`);
                await selectAndWait(page, "SelectResult", rt.value);

                const parsed = await parseResultTable(page, rt.text);
                dbg(`        → ${parsed.rows.length} rows`);

                if (parsed.rows.length) {
                  resultSets.push(parsed);
                }
              }

              if (!resultSets.length) {
                warn(`        No data for ${cls.text} · ${event.text} · ${race.text}`);
                continue;
              }
            }

            if (!resultSets.length) continue;

            // ── 8. Merge all result types ──
            const mergedRiders = mergeResults(resultSets);
            if (!mergedRiders.length) continue;

            totalRaces++;

            const dateMatch = event.text.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/);
            const raceDate  = dateMatch ? dateMatch[0] : year.text;

            const session = {
              meta: {
                year: year.text,
                category: cls.text,
                event: event.text,
                race: race.text,
                date: raceDate,
                scrapedAt: new Date().toISOString(),
              },
              riders: mergedRiders,
            };

            allSessions.push(session);
            log(`        ✓ ${mergedRiders.length} riders — ${cls.text} · ${event.text} · ${race.text}`);

            // Incremental save every 5 races
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

  // ── 9. Final save ──
  log(`\n${"═".repeat(60)}`);
  log(`DONE — ${totalRaces} races scraped across ${allSessions.length} sessions`);

  if (allSessions.length === 0) {
    warn("0 sessions scraped. Suggestions:");
    warn("  1. Run with --debug to inspect HTML (debug_*.html files saved)");
    warn("  2. The site may have changed structure — check results.mxgp.com manually");
    warn("  3. Try --slow 2000 to give more time to ASP.NET postbacks");
    warn("  4. Try --year 2025 (previous year may have more data)");
  }

  saveJSON(allSessions, OUT_FILE);
  if (EXPORT_CSV && allSessions.length) saveCSV(allSessions, OUT_FILE);

  return allSessions;
}

/* ══════════════════════════════════════════
   SAVE FUNCTIONS
══════════════════════════════════════════ */

function saveJSON(sessions, outFile) {
  // Ensure output directory exists
  const dir = path.dirname(outFile);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const output = {
    scraper:  "MXGP Results Scraper v2.0",
    scraped:  new Date().toISOString(),
    total:    sessions.length,
    sessions,
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2), "utf-8");
  log(`JSON saved: ${outFile} (${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)`);
}

function saveCSV(sessions, jsonFile) {
  const csvFile = jsonFile.replace(/\.json$/, ".csv");
  const header = [
    "year","category","event","race","date",
    "pos","nr","firstName","lastName","nat","bike",
    "totalTime","laps","bestLap","bestLapNum",
    "gridPos","points","consistency","avgLap"
  ].join(",");

  const rows = sessions.flatMap(s =>
    s.riders.map(r => {
      const lts = r.lapTimes || [];
      const avg = lts.length ? lts.reduce((a,b)=>a+b,0)/lts.length : "";
      const sd = lts.length > 1
        ? Math.sqrt(lts.map(x=>(x-avg)**2).reduce((a,b)=>a+b,0)/lts.length).toFixed(4)
        : "";
      return [
        s.meta.year, s.meta.category, `"${s.meta.event}"`, s.meta.race, s.meta.date,
        r.pos, r.nr, r.firstName, r.lastName, r.nat, r.bike,
        r.totalTime||"", r.laps||"", r.bestLap||"", r.bestLapNum||"",
        r.gridPos||"", r.points||"", sd, avg ? avg.toFixed(3) : "",
      ].join(",");
    })
  );

  fs.writeFileSync(csvFile, [header, ...rows].join("\n"), "utf-8");
  log(`CSV saved: ${csvFile}`);
}

/* ══════════════════════════════════════════
   RUN
══════════════════════════════════════════ */

scrape().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
