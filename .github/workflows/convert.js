/**
 * ═══════════════════════════════════════════════════════
 *  MXGP Convert — convert.js
 *  Lit mxgp_results.json (Python scraper)
 *  → génère data/results.json (format stats.js)
 *
 *  Usage :
 *    node convert.js [input.json] [output.json]
 *    node convert.js mxgp_results.json ../data/results.json
 * ═══════════════════════════════════════════════════════
 */

"use strict";

const fs   = require("fs");
const path = require("path");

/* ── Points scale (MXGP officiel) ── */
const PTS_SCALE = [25,22,20,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1];

/* ── Logger ── */
const log  = (...a) => console.log("[CONVERT]", ...a);
const warn = (...a) => console.warn("[WARN]", ...a);

/* ══════════════════════════════════════════
   HELPERS
══════════════════════════════════════════ */

/** Convertit "M:SS.mmm" ou "SS.mmm" ou "0:SS.mmm" en secondes (float) */
function parseTime(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s || s === "—" || s === "-") return null;

  // "M:SS.mmm"
  let m = s.match(/^(\d+):(\d{2})[.,](\d+)/);
  if (m) return parseInt(m[1]) * 60 + parseInt(m[2]) + parseFloat("0." + m[3]);

  // Pure decimal "SS.mmm"
  const n = parseFloat(s.replace(",", "."));
  return isNaN(n) ? null : n;
}

/* ══════════════════════════════════════════
   PARSE ANALYSIS TEXT BLOCK
   Extrait le texte brut du tableau Analysis
   (rows[3][0] du JSON Python)
══════════════════════════════════════════ */

/**
 * Parse le bloc texte complet de l'Analysis.
 *
 * Format attendu :
 *   MXGP - Grand Prix Race 2 - Analysis    ← titre (ignoré)
 *   <ligne vide>
 *   5 Coenen Lucas                          ← NR Prénom Nom
 *   KTM                                     ← Bike
 *   Lap	Laptime	Section 1 ...            ← headers (ignoré)
 *   1	1:46.688	0:26.911	0:28.690 ...  ← données
 *   ...
 *   <ligne vide>
 *   84 Herlings Jeffrey
 *   Honda
 *   ...
 */
function parseAnalysisText(text) {
  const riders = [];

  // Nettoyer : supprimer les retours \r
  const lines = text.replace(/\r/g, "").split("\n");

  let nr = null, firstName = "", lastName = "", bike = null;
  let lapTimes = [], sectors = [], inData = false;

  function flush() {
    if (nr !== null && lapTimes.length > 0) {
      riders.push({
        nr,
        firstName,
        lastName,
        bike,
        lapTimes,
        sectors,
        bestLap:    Math.min(...lapTimes),
        bestLapNum: lapTimes.indexOf(Math.min(...lapTimes)) + 1,
        laps:       lapTimes.length,
      });
    }
    nr = null; firstName = ""; lastName = ""; bike = null;
    lapTimes = []; sectors = []; inData = false;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trim();

    if (!line) {
      flush();
      continue;
    }

    /* Ligne avec tabulations = ligne de données de tour */
    if (raw.includes("\t")) {
      const cells = raw.split("\t").map(c => c.trim());

      // Ignorer les headers (Lap, Laptime, Section...)
      if (/^(lap|section|s\d)/i.test(cells[0])) continue;

      // Ligne de tour : premier champ = numéro de tour
      if (/^\d+$/.test(cells[0]) && cells.length >= 2) {
        inData = true;
        const lt = parseTime(cells[1]);
        if (lt && lt > 0 && lt < 600) {           // < 10 min = cohérent
          lapTimes.push(lt);
          const sv = [2, 3, 4, 5]
            .map(j => parseTime(cells[j]))
            .filter(v => v && v > 0 && v < 300);   // secteur < 5 min
          if (sv.length >= 2) sectors.push(sv);
        }
      }
      continue;
    }

    /* Ligne sans tabulation */
    const parts = line.split(/\s+/);

    // Ligne de rider : premier token = numéro, puis nom
    // ex: "5 Coenen Lucas" ou "84 Herlings Jeffrey"
    if (/^\d+$/.test(parts[0]) && parts.length >= 2 && !inData) {
      flush();
      nr = parseInt(parts[0]);
      // Dernier token peut être prénom ou nom selon les données
      // Le site donne "NR Prénom Nom" (ex: "5 Coenen Lucas" → Lucas = prénom ?)
      // En réalité le site donne "NR FirstName LastName" : "5 Coenen Lucas" = nr=5, first="Coenen", last="Lucas"
      // Mais pour les riders à prénom composé : "84 Herlings Jeffrey" = nr=84, first="Herlings", last="Jeffrey"
      // Le format est NR LastName FirstName sur le site MXGP
      firstName = parts.slice(2).join(" ");
      lastName  = parts[1] || "";
      continue;
    }

    // Ligne de bike : juste après le rider, avant les headers
    if (nr !== null && bike === null && !inData && !/^lap$/i.test(line)) {
      bike = line;
      continue;
    }

    // Header line "Lap  Laptime  Section 1..." → ignorer
    if (/^lap/i.test(line)) {
      inData = true;  // les données commencent après
      continue;
    }
  }

  flush(); // dernier rider
  return riders;
}

/* ══════════════════════════════════════════
   PARSE GP CLASSIFICATION
   Extrait les données de la table GP Classif
   (rows avec len >= 6 et row[0] = chiffre)
══════════════════════════════════════════ */

/**
 * Retourne { raceColumns: [], riders: [] }
 * raceColumns ex: ["Race 1", "Race 2", "Total"]
 */
function parseGPClassification(rows) {
  if (!rows || !rows.length) return null;

  // Trouver le header : première ligne avec "Pos", "Nr", "Rider"
  const headerIdx = rows.findIndex(r =>
    r.length >= 5 &&
    /^pos$/i.test(r[0]) &&
    /^nr$/i.test(r[1])
  );
  if (headerIdx === -1) return null;

  const header       = rows[headerIdx];
  const raceColumns  = header.slice(6).map(h => h.trim());   // ["Race 1","Race 2","Total"]

  const gpRiders = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 6 || !/^\d+$/.test(String(r[0]).trim())) continue;

    const riderRaw = String(r[2] || "").trim();
    let firstName = "", lastName = riderRaw;
    if (riderRaw.includes(",")) {
      // Format "Nom, Prénom"
      const p = riderRaw.split(",").map(s => s.trim());
      lastName  = p[0];
      firstName = p[1] || "";
    } else if (riderRaw.includes(" ")) {
      const p = riderRaw.trim().split(/\s+/);
      firstName = p[0];
      lastName  = p.slice(1).join(" ");
    }

    gpRiders.push({
      gpPos:    parseInt(r[0]) || null,
      nr:       parseInt(r[1]) || null,
      firstName,
      lastName,
      nat:      String(r[3] || "").trim(),
      bike:     String(r[5] || "").trim(),
      racePts:  r.slice(6).map(v => parseInt(String(v).trim()) || 0),
    });
  }

  return { raceColumns, riders: gpRiders };
}

/* ══════════════════════════════════════════
   TROUVER L'INDEX DE COLONNE DE COURSE
   Résout "Grand Prix Race 2" → index dans
   raceColumns ["Race 1","Race 2","Total"]
══════════════════════════════════════════ */

function findRaceColumnIndex(raceName, raceColumns) {
  if (!raceColumns || !raceColumns.length) return -1;
  const rl = raceName.toLowerCase();

  // Essayer une correspondance directe (partielle)
  for (let i = 0; i < raceColumns.length; i++) {
    const cl = raceColumns[i].toLowerCase();
    // "grand prix race 2" contient "race 2"
    // "race 2" est dans "grand prix race 2"
    if (rl.includes(cl) || cl.includes(rl)) return i;
  }

  // Fallback : numéro de course
  const numMatch = rl.match(/\d+/);
  if (numMatch) {
    const num = numMatch[0];
    for (let i = 0; i < raceColumns.length; i++) {
      if (raceColumns[i].includes(num)) return i;
    }
  }

  // Dernier recours : première colonne non-"total"
  for (let i = 0; i < raceColumns.length; i++) {
    if (!/total/i.test(raceColumns[i])) return i;
  }

  return -1;
}

/* ══════════════════════════════════════════
   CONSTRUCTION DES SESSIONS
   Cœur du convertisseur
══════════════════════════════════════════ */

/**
 * data = contenu complet de mxgp_results.json
 * Retourne un tableau de sessions au format stats.js
 */
function buildSessions(data) {
  const sessions = [];

  for (const [year, champs] of Object.entries(data)) {
    for (const [champ, classes] of Object.entries(champs)) {
      for (const [cls, events] of Object.entries(classes)) {
        for (const [event, races] of Object.entries(events)) {
          for (const [raceName, resultTypes] of Object.entries(races)) {

            /* ── 1. Analysis ─────────────────────────── */
            const anaRows = resultTypes["Analysis"]?.rows;
            if (!anaRows || anaRows.length < 4) {
              warn(`Pas d'Analysis : ${cls} · ${event} · ${raceName}`);
              continue;
            }

            // Le texte complet est dans rows[3][0]
            // (la première cellule de la 4ème <tr> qui contient tout le tableau)
            const anaText = anaRows[3]?.[0];
            if (!anaText || !anaText.includes("Laptime") && !anaText.includes("Lap")) {
              warn(`Texte Analysis vide : ${cls} · ${event} · ${raceName}`);
              continue;
            }

            const anaRiders = parseAnalysisText(anaText);
            if (!anaRiders.length) {
              warn(`Aucun rider parsé depuis Analysis : ${cls} · ${event} · ${raceName}`);
              continue;
            }

            /* ── 2. GP Classification ────────────────── */
            const gpRows = resultTypes["GP Classification"]?.rows;
            const gpData = gpRows ? parseGPClassification(gpRows) : null;
            const raceColIdx = gpData
              ? findRaceColumnIndex(raceName, gpData.raceColumns)
              : -1;

            // Map nr → anaRider pour fusion rapide
            const byNr = {};
            for (const r of anaRiders) byNr[r.nr] = r;

            /* ── 3. Fusion & construction riders ─────── */
            const finalRiders = [];

            if (gpData && raceColIdx >= 0) {
              // Trier par points de la course pour retrouver les positions
              const sorted = [...gpData.riders].sort((a, b) =>
                (b.racePts[raceColIdx] || 0) - (a.racePts[raceColIdx] || 0)
              );

              let posCounter = 1;
              for (const gp of sorted) {
                const ana = byNr[gp.nr];
                const pts = gp.racePts[raceColIdx] || 0;

                finalRiders.push({
                  pos:        pts > 0 ? posCounter++ : null,
                  nr:         gp.nr,
                  firstName:  gp.firstName  || ana?.firstName || "",
                  lastName:   gp.lastName   || ana?.lastName  || "",
                  nat:        gp.nat        || "",
                  bike:       gp.bike       || ana?.bike      || "",
                  totalTime:  null,   // non disponible depuis Python scraper
                  laps:       ana?.laps     || 0,
                  bestLap:    ana?.bestLap  || null,
                  bestLapNum: ana?.bestLapNum || null,
                  lapTimes:   ana?.lapTimes || [],
                  sectors:    ana?.sectors  || [],
                  gridPos:    null,
                  points:     pts,
                });
              }

              // Ajouter les riders présents dans Analysis mais absents de GP Classif
              for (const ana of anaRiders) {
                if (!finalRiders.find(r => r.nr === ana.nr)) {
                  finalRiders.push({
                    pos: null, nr: ana.nr,
                    firstName: ana.firstName, lastName: ana.lastName,
                    nat: "", bike: ana.bike || "",
                    totalTime: null, laps: ana.laps,
                    bestLap: ana.bestLap, bestLapNum: ana.bestLapNum,
                    lapTimes: ana.lapTimes, sectors: ana.sectors,
                    gridPos: null, points: 0,
                  });
                }
              }
            } else {
              // Pas de GP Classification : utiliser uniquement Analysis
              // Trier par temps total estimé (somme des tours)
              const withTotal = anaRiders.map(r => ({
                ...r, totalSecs: r.lapTimes.reduce((a, b) => a + b, 0)
              }));
              withTotal.sort((a, b) => {
                if (!a.totalSecs) return 1;
                if (!b.totalSecs) return -1;
                return a.totalSecs - b.totalSecs;
              });

              let posCounter = 1;
              for (const r of withTotal) {
                const pts = PTS_SCALE[posCounter - 1] || 0;
                finalRiders.push({
                  pos: posCounter++, nr: r.nr,
                  firstName: r.firstName, lastName: r.lastName,
                  nat: "", bike: r.bike || "",
                  totalTime: null, laps: r.laps,
                  bestLap: r.bestLap, bestLapNum: r.bestLapNum,
                  lapTimes: r.lapTimes, sectors: r.sectors,
                  gridPos: null,
                  points: pts,
                });
              }
            }

            // Ne garder que les riders avec des tours valides
            const validRiders = finalRiders.filter(r => r.lapTimes?.length > 0);
            if (!validRiders.length) continue;

            /* ── 4. Métadonnées session ───────────────── */
            sessions.push({
              meta: {
                year,
                category:  cls,
                event,
                race:      raceName,
                date:      year,
                scrapedAt: new Date().toISOString(),
              },
              riders: validRiders,
            });

            log(`✓ ${validRiders.length} riders — ${cls} · ${raceName} — ${event}`);
          }
        }
      }
    }
  }

  return sessions;
}

/* ══════════════════════════════════════════
   MAIN
══════════════════════════════════════════ */

const inputFile  = process.argv[2] || "mxgp_results.json";
const outputFile = process.argv[3] || path.join(__dirname, "..", "data", "results.json");

if (!fs.existsSync(inputFile)) {
  console.error(`[ERREUR] Fichier introuvable : ${inputFile}`);
  process.exit(1);
}

log(`Lecture : ${inputFile}`);
const raw = JSON.parse(fs.readFileSync(inputFile, "utf-8"));

log("Conversion en cours...");
const sessions = buildSessions(raw);

const dir = path.dirname(outputFile);
if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const output = {
  scraper:  "MXGP Python Scraper + convert.js",
  scraped:  new Date().toISOString(),
  total:    sessions.length,
  sessions,
};

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2), "utf-8");
log(`✓ ${sessions.length} session(s) → ${outputFile} (${(fs.statSync(outputFile).size / 1024).toFixed(1)} KB)`);
