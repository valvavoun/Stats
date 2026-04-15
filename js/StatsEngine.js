/* ═══════════════════════════════════════════════════════════════
   MXGP Stats — StatsEngine.js
   Moteur de statistiques avancées. Source : DataManager.getSessions()
   Aucune dépendance externe.
═══════════════════════════════════════════════════════════════ */

const StatsEngine = (() => {

  /* ══════════════════════════════════════════════
     CONSTANTES
  ══════════════════════════════════════════════ */
  const PTS = [25,22,20,18,16,15,14,13,12,11,10,9,8,7,6,5,4,3,2,1];
  const calcPts = pos => PTS[pos-1] ?? 0;

  /* Sessions de course principale uniquement (exclut FP/TP/Warmup pour stats points) */
  const RACE_TYPES   = new Set(['race1','race2','qualifying_race','lcq','bfinal','cfinal']);
  const MAIN_RACES   = new Set(['race1','race2']);
  const ALL_SESSIONS = null; // null = toutes

  /* ══════════════════════════════════════════════
     1. AGRÉGATION PAR PILOTE
     Prend un tableau de sessions et retourne un
     Map riderId → { meta, results[] }
  ══════════════════════════════════════════════ */
  function groupByRider(sessions, sessionFilter = MAIN_RACES) {
    const map = new Map(); // riderId → { meta, results }

    for (const sess of sessions) {
      if (sessionFilter && !sessionFilter.has(sess.sessionType)) continue;

      for (const r of sess.riders) {
        if (!map.has(r.riderId)) {
          map.set(r.riderId, {
            riderId:   r.riderId,
            firstName: r.firstName,
            lastName:  r.lastName,
            nation:    r.nation,
            bike:      r.bike,
            nr:        r.nr,
            results:   [],
          });
        }
        map.get(r.riderId).results.push({
          year:        sess.year,
          eventName:   sess.eventName,
          eventId:     sess.eventId,
          session:     sess.session,
          sessionType: sess.sessionType,
          category:    sess.category,
          pos:         r.pos,
          pts:         calcPts(r.pos),
          bestSec:     r.bestSec,
          laps:        r.laps,
          dnf:         r.dnf,
          dns:         r.dns,
          speed:       r.speed,
          nr:          r.nr,
          bike:        r.bike,
        });
      }
    }
    return map;
  }

  /* ══════════════════════════════════════════════
     2. STATS DE BASE PAR PILOTE
  ══════════════════════════════════════════════ */
  function computeBaseStats(meta, results) {
    if (!results.length) return null;

    const positions = results.map(r => r.pos);
    const points    = results.map(r => r.pts);
    const validPos  = positions.filter(p => p > 0 && p <= 40);

    const totalPts  = points.reduce((a,b) => a+b, 0);
    const avgPos    = validPos.length ? mean(validPos) : null;
    const bestPos   = validPos.length ? Math.min(...validPos) : null;
    const worstPos  = validPos.length ? Math.max(...validPos) : null;

    const wins    = results.filter(r => r.pos === 1).length;
    const podiums = results.filter(r => r.pos <= 3).length;
    const top5    = results.filter(r => r.pos <= 5).length;
    const top10   = results.filter(r => r.pos <= 10).length;
    const dnfs    = results.filter(r => r.dnf).length;
    const dns     = results.filter(r => r.dns).length;
    const races   = results.length;

    /* Taux de finition */
    const finishRate = races ? ((races - dnfs - dns) / races) * 100 : 0;

    /* Meilleur tour */
    const lapTimes = results.map(r => r.bestSec).filter(Boolean);
    const bestLap  = lapTimes.length ? Math.min(...lapTimes) : null;
    const avgLap   = lapTimes.length ? mean(lapTimes) : null;

    /* Vitesse moyenne */
    const speeds   = results.map(r => r.speed).filter(Boolean);
    const avgSpeed = speeds.length ? mean(speeds) : null;

    return {
      ...meta,
      races, totalPts, avgPos, bestPos, worstPos,
      wins, podiums, top5, top10, dnfs, dns, finishRate,
      bestLap, avgLap, avgSpeed,
      winRate:    races ? (wins / races) * 100 : 0,
      podiumRate: races ? (podiums / races) * 100 : 0,
    };
  }

  /* ══════════════════════════════════════════════
     3. RÉGULARITÉ (CONSISTENCY SCORE)
     Basé sur l'écart-type des positions.
     Score 0–100 : 100 = parfaitement régulier.
  ══════════════════════════════════════════════ */
  function computeConsistency(results) {
    const positions = results.map(r => r.pos).filter(p => p > 0 && p <= 40);
    if (positions.length < 2) return { score: null, stdDev: null, cv: null };

    const avg = mean(positions);
    const sd  = stdDev(positions);
    const cv  = avg > 0 ? (sd / avg) * 100 : 0; // coefficient de variation

    /* Score inversé : moins de variance = meilleur score */
    /* Normalise sur une échelle 0-100 (sd=0 → 100, sd=15 → 0) */
    const score = Math.max(0, Math.min(100, 100 - (sd / 15) * 100));

    return { score: Math.round(score * 10) / 10, stdDev: Math.round(sd * 100) / 100, cv: Math.round(cv * 10) / 10 };
  }

  /* ══════════════════════════════════════════════
     4. MOMENTUM (FORME ACTUELLE)
     Compare les N dernières courses à la moyenne globale.
     Score -100 → +100 (positif = en forme montante)
  ══════════════════════════════════════════════ */
  function computeMomentum(results, n = 5) {
    if (results.length < 2) return { score: null, trend: 'stable', recentAvg: null, globalAvg: null };

    const sorted   = [...results].sort((a,b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.eventId?.localeCompare?.(b.eventId) ?? 0;
    });

    const recent   = sorted.slice(-n).map(r => r.pos).filter(p => p > 0);
    const all      = sorted.map(r => r.pos).filter(p => p > 0);

    if (!recent.length || !all.length) return { score: null, trend: 'stable', recentAvg: null, globalAvg: null };

    const recentAvg = mean(recent);
    const globalAvg = mean(all);

    /* Delta positif = amélioration (position plus basse = mieux) */
    const delta = globalAvg - recentAvg;
    /* Normalise -100 → +100 */
    const score = Math.max(-100, Math.min(100, (delta / globalAvg) * 100));

    const trend = score > 10 ? 'rising' : score < -10 ? 'falling' : 'stable';

    return {
      score:      Math.round(score * 10) / 10,
      trend,
      recentAvg:  Math.round(recentAvg * 10) / 10,
      globalAvg:  Math.round(globalAvg * 10) / 10,
      n:          recent.length,
    };
  }

  /* ══════════════════════════════════════════════
     5. SCORE DE DOMINATION
     Combine victoires, podiums, points et écart sur le 2e.
     Score 0–100.
  ══════════════════════════════════════════════ */
  function computeDomination(base) {
    if (!base || !base.races) return 0;
    const wR = (base.wins    / base.races) * 40;
    const pR = (base.podiums / base.races) * 25;
    const tR = (base.top5   / base.races)  * 20;
    const fR = (base.finishRate / 100)      * 15;
    return Math.round(Math.min(100, wR + pR + tR + fR) * 10) / 10;
  }

  /* ══════════════════════════════════════════════
     6. TENDANCE (régression linéaire sur les positions)
     Retourne slope (négatif = amélioration), r² (qualité fit)
  ══════════════════════════════════════════════ */
  function computeTrend(results) {
    const sorted = [...results]
      .sort((a,b) => a.year - b.year || (a.eventId||'').localeCompare(b.eventId||''))
      .filter(r => r.pos > 0 && r.pos <= 40);

    if (sorted.length < 3) return { slope: null, r2: null, direction: 'unknown' };

    const x = sorted.map((_,i) => i);
    const y = sorted.map(r => r.pos);

    const { slope, r2 } = linearRegression(x, y);

    return {
      slope:     Math.round(slope * 1000) / 1000,
      r2:        Math.round(r2 * 1000) / 1000,
      direction: slope < -0.1 ? 'improving' : slope > 0.1 ? 'declining' : 'stable',
    };
  }

  /* ══════════════════════════════════════════════
     7. PROJECTION FUTURE
     Utilise la régression pour estimer les N prochaines courses.
  ══════════════════════════════════════════════ */
  function computeProjection(results, nFuture = 3) {
    const sorted = [...results]
      .sort((a,b) => a.year - b.year || (a.eventId||'').localeCompare(b.eventId||''))
      .filter(r => r.pos > 0);

    if (sorted.length < 4) return null;

    const x = sorted.map((_,i) => i);
    const y = sorted.map(r => r.pos);
    const { slope, intercept } = linearRegression(x, y);

    const n    = sorted.length;
    const proj = [];
    for (let i = 1; i <= nFuture; i++) {
      const p = Math.round(Math.max(1, Math.min(40, intercept + slope * (n + i))));
      proj.push(p);
    }

    /* Intervalle de confiance approximatif (±2 * résidu std) */
    const residuals = y.map((yi,i) => yi - (intercept + slope * x[i]));
    const residStd  = stdDev(residuals);
    const confidence= Math.round(residStd * 2);

    return { projectedPositions: proj, confidence, trend: slope };
  }

  /* ══════════════════════════════════════════════
     8. HEAD-TO-HEAD
     Compare deux pilotes sur les mêmes sessions.
  ══════════════════════════════════════════════ */
  function computeH2H(resultsA, resultsB) {
    /* Index B par eventId+sessionType */
    const bMap = new Map();
    resultsB.forEach(r => bMap.set(`${r.eventId}_${r.sessionType}`, r));

    let aWins = 0, bWins = 0, ties = 0;
    const diffs = [];

    for (const ra of resultsA) {
      const key = `${ra.eventId}_${ra.sessionType}`;
      const rb  = bMap.get(key);
      if (!rb) continue;

      if (ra.pos < rb.pos) aWins++;
      else if (rb.pos < ra.pos) bWins++;
      else ties++;

      diffs.push(rb.pos - ra.pos); /* positif = A devant */
    }

    const total = aWins + bWins + ties;
    return {
      aWins, bWins, ties, total,
      aWinPct: total ? Math.round((aWins / total) * 100) : 0,
      bWinPct: total ? Math.round((bWins / total) * 100) : 0,
      avgDiff: diffs.length ? Math.round(mean(diffs) * 10) / 10 : 0,
    };
  }

  /* ══════════════════════════════════════════════
     9. PERFORMANCE INDEX (IPI)
     Score composite 0–1000.
     Combine : points, victoires, régularité, momentum, finitions.
  ══════════════════════════════════════════════ */
  function computeIPI(base, consistency, momentum) {
    if (!base || !base.races) return 0;

    /* Points par course normalisé (25 = max par course) */
    const ptsScore   = Math.min(100, (base.totalPts / (base.races * 25)) * 100);
    const winScore   = base.winRate;
    const podScore   = base.podiumRate;
    const conScore   = consistency.score ?? 50;
    const momScore   = momentum.score !== null ? (momentum.score + 100) / 2 : 50;
    const finScore   = base.finishRate;

    const ipi = (
      ptsScore  * 0.30 +
      winScore  * 0.20 +
      podScore  * 0.15 +
      conScore  * 0.15 +
      momScore  * 0.10 +
      finScore  * 0.10
    ) * 10; // → 0–1000

    return Math.round(ipi);
  }

  /* ══════════════════════════════════════════════
     10. ÉVOLUTION DES POINTS (série temporelle)
     Retourne tableau ordonné { label, cumulPts, pos, event }
  ══════════════════════════════════════════════ */
  function buildPointsSeries(results) {
    const sorted = [...results]
      .filter(r => MAIN_RACES.has(r.sessionType))
      .sort((a,b) => a.year - b.year || (a.eventId||'').localeCompare(b.eventId||''));

    /* Groupe par GP (Race1+Race2 = même GP) */
    const gpMap = new Map();
    for (const r of sorted) {
      const key = `${r.year}__${r.eventId}`;
      if (!gpMap.has(key)) gpMap.set(key, { year: r.year, eventName: r.eventName, pts: 0, positions: [] });
      gpMap.get(key).pts        += r.pts;
      gpMap.get(key).positions.push(r.pos);
    }

    let cumul = 0;
    return [...gpMap.values()].map(gp => {
      cumul += gp.pts;
      return {
        label:    `${gp.year} ${gp.eventName.replace('Grand Prix of ','GP ').replace('Grand Prix ','GP ')}`,
        ptsGP:   gp.pts,
        cumulPts: cumul,
        avgPos:  Math.round(mean(gp.positions) * 10) / 10,
      };
    });
  }

  /* ══════════════════════════════════════════════
     11. ANALYSE PAR GP (classement GP par GP)
  ══════════════════════════════════════════════ */
  function buildGPBreakdown(results) {
    const gpMap = new Map();
    for (const r of results) {
      if (!MAIN_RACES.has(r.sessionType)) continue;
      const key = `${r.year}__${r.eventId}`;
      if (!gpMap.has(key)) gpMap.set(key, { year: r.year, eventName: r.eventName, race1: null, race2: null, pts: 0 });
      const gp = gpMap.get(key);
      if (r.sessionType === 'race1') gp.race1 = r.pos;
      if (r.sessionType === 'race2') gp.race2 = r.pos;
      gp.pts += r.pts;
    }
    return [...gpMap.values()].sort((a,b) => a.year - b.year || a.eventName.localeCompare(b.eventName));
  }

  /* ══════════════════════════════════════════════
     12. CHAMPIONS RANKING (classement championnat calculé)
     Pour une liste de sessions données.
  ══════════════════════════════════════════════ */
  function computeChampionshipRanking(sessions) {
    const riderMap = groupByRider(sessions, MAIN_RACES);
    const ranked   = [];

    for (const [, data] of riderMap) {
      const base        = computeBaseStats(data, data.results);
      const consistency = computeConsistency(data.results);
      const momentum    = computeMomentum(data.results);
      const domination  = computeDomination(base);
      const ipi         = computeIPI(base, consistency, momentum);

      ranked.push({ ...base, consistency, momentum, domination, ipi });
    }

    return ranked
      .filter(r => r.races >= 1)
      .sort((a,b) => b.totalPts - a.totalPts || a.avgPos - b.avgPos);
  }

  /* ══════════════════════════════════════════════
     13. FULL RIDER PROFILE (tout en un)
     Utilisé pour afficher le profil complet d'un pilote.
  ══════════════════════════════════════════════ */
  function buildRiderProfile(riderData, allSessions) {
    const { results } = riderData;
    if (!results.length) return null;

    const raceResults = results.filter(r => MAIN_RACES.has(r.sessionType));
    const allResults  = results;

    const base        = computeBaseStats(riderData, raceResults);
    const consistency = computeConsistency(raceResults);
    const momentum    = computeMomentum(raceResults);
    const trend       = computeTrend(raceResults);
    const projection  = computeProjection(raceResults);
    const domination  = computeDomination(base);
    const ipi         = computeIPI(base, consistency, momentum);
    const pointsSeries= buildPointsSeries(results);
    const gpBreakdown = buildGPBreakdown(results);

    /* Meilleures saisons */
    const byYear = {};
    for (const r of raceResults) {
      if (!byYear[r.year]) byYear[r.year] = { pts: 0, races: 0, wins: 0 };
      byYear[r.year].pts  += r.pts;
      byYear[r.year].races++;
      if (r.pos === 1) byYear[r.year].wins++;
    }
    const bestSeason = Object.entries(byYear)
      .sort((a,b) => b[1].pts - a[1].pts)[0];

    /* Piste préférée (meilleure pos moyenne) */
    const byEvent = {};
    for (const r of raceResults) {
      if (!byEvent[r.eventName]) byEvent[r.eventName] = [];
      byEvent[r.eventName].push(r.pos);
    }
    const tracks = Object.entries(byEvent)
      .filter(([,v]) => v.length >= 2)
      .map(([name, positions]) => ({ name, avgPos: mean(positions), races: positions.length }))
      .sort((a,b) => a.avgPos - b.avgPos);

    return {
      ...base,
      consistency, momentum, trend, projection,
      domination, ipi,
      pointsSeries, gpBreakdown,
      bestSeason: bestSeason ? { year: bestSeason[0], ...bestSeason[1] } : null,
      bestTrack:  tracks[0]  ?? null,
      worstTrack: tracks[tracks.length-1] ?? null,
      byYear,
      allResults,
    };
  }

  /* ══════════════════════════════════════════════
     14. STATS COMPARAISON MULTI-PILOTES
     Retourne un objet structuré pour les graphiques.
  ══════════════════════════════════════════════ */
  function buildComparison(riderIds, sessions, sessionFilter = MAIN_RACES) {
    const riderMap = groupByRider(sessions, sessionFilter);
    const result   = [];

    for (const id of riderIds) {
      const data = riderMap.get(id);
      if (!data) continue;
      const profile = buildRiderProfile(data, sessions);
      if (profile) result.push({ riderId: id, ...profile });
    }

    return result;
  }

  /* ══════════════════════════════════════════════
     15. CLASSEMENT CONSTRUCTEURS
  ══════════════════════════════════════════════ */
  function computeManufacturersRanking(sessions) {
    const bikeMap = new Map();
    for (const sess of sessions) {
      if (!MAIN_RACES.has(sess.sessionType)) continue;
      for (const r of sess.riders) {
        const bike = normalizeBike(r.bike);
        if (!bikeMap.has(bike)) bikeMap.set(bike, { bike, pts: 0, wins: 0, podiums: 0, races: 0 });
        const b = bikeMap.get(bike);
        b.pts     += calcPts(r.pos);
        b.races++;
        if (r.pos === 1) b.wins++;
        if (r.pos <= 3)  b.podiums++;
      }
    }
    return [...bikeMap.values()].sort((a,b) => b.pts - a.pts);
  }

  /* ══════════════════════════════════════════════
     16. STATS PAR NATIONALITÉ
  ══════════════════════════════════════════════ */
  function computeNationStats(sessions) {
    const map = new Map();
    for (const sess of sessions) {
      if (!MAIN_RACES.has(sess.sessionType)) continue;
      for (const r of sess.riders) {
        const nat = r.nation || 'UNK';
        if (!map.has(nat)) map.set(nat, { nation: nat, pts: 0, wins: 0, podiums: 0, riders: new Set() });
        const n = map.get(nat);
        n.pts += calcPts(r.pos);
        if (r.pos === 1) n.wins++;
        if (r.pos <= 3)  n.podiums++;
        n.riders.add(r.riderId);
      }
    }
    return [...map.values()]
      .map(n => ({ ...n, riderCount: n.riders.size, riders: undefined }))
      .sort((a,b) => b.pts - a.pts);
  }

  /* ══════════════════════════════════════════════
     17. ANALYSE HISTORIQUE GLOBALE
     Vue macro sur toutes les sessions disponibles.
  ══════════════════════════════════════════════ */
  function computeGlobalOverview(sessions) {
    const years       = [...new Set(sessions.map(s => s.year))].sort();
    const categories  = [...new Set(sessions.map(s => s.category))];
    const riderMap    = groupByRider(sessions, MAIN_RACES);
    const totalRiders = riderMap.size;
    const totalRaces  = sessions.filter(s => MAIN_RACES.has(s.sessionType)).length;

    /* Pilote le plus titré (pts total) */
    let topRider = null, topPts = 0;
    for (const [, data] of riderMap) {
      const pts = data.results.reduce((a,r) => a + r.pts, 0);
      if (pts > topPts) { topPts = pts; topRider = data; }
    }

    return { years, categories, totalRiders, totalRaces, totalSessions: sessions.length, topRider, topPts };
  }

  /* ══════════════════════════════════════════════
     UTILITAIRES MATH
  ══════════════════════════════════════════════ */
  function mean(arr) {
    return arr.reduce((a,b) => a+b, 0) / arr.length;
  }

  function stdDev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((a,b) => a + (b-m)**2, 0) / (arr.length - 1));
  }

  function linearRegression(x, y) {
    const n    = x.length;
    const sumX = x.reduce((a,b) => a+b, 0);
    const sumY = y.reduce((a,b) => a+b, 0);
    const sumXY= x.reduce((a,xi,i) => a + xi*y[i], 0);
    const sumX2= x.reduce((a,xi) => a + xi**2, 0);
    const denom= n*sumX2 - sumX**2;
    if (Math.abs(denom) < 1e-10) return { slope: 0, intercept: mean(y), r2: 0 };

    const slope     = (n*sumXY - sumX*sumY) / denom;
    const intercept = (sumY - slope*sumX) / n;

    /* R² */
    const yMean  = mean(y);
    const ssTot  = y.reduce((a,yi) => a + (yi-yMean)**2, 0);
    const ssRes  = y.reduce((a,yi,i) => a + (yi - (slope*x[i]+intercept))**2, 0);
    const r2     = ssTot > 0 ? 1 - ssRes/ssTot : 0;

    return { slope, intercept, r2: Math.max(0, r2) };
  }

  function normalizeBike(bike) {
    const b = (bike || '').toUpperCase();
    if (b.includes('KTM'))      return 'KTM';
    if (b.includes('HUSQ'))     return 'Husqvarna';
    if (b.includes('HUS'))      return 'Husqvarna';
    if (b.includes('GAS'))      return 'GasGas';
    if (b.includes('HON'))      return 'Honda';
    if (b.includes('KAW'))      return 'Kawasaki';
    if (b.includes('YAM'))      return 'Yamaha';
    if (b.includes('TM'))       return 'TM';
    if (b.includes('TRIUMPH'))  return 'Triumph';
    if (b.includes('BETA'))     return 'Beta';
    if (b.includes('DUC'))      return 'Ducati';
    if (b.includes('FANTIC'))   return 'Fantic';
    if (b.includes('SHERCO'))   return 'Sherco';
    return bike || 'Other';
  }

  /* ══════════════════════════════════════════════
     EXPORT
  ══════════════════════════════════════════════ */
  return {
    /* Core */
    groupByRider,
    computeBaseStats,
    buildRiderProfile,
    buildComparison,

    /* Stats individuelles */
    computeConsistency,
    computeMomentum,
    computeTrend,
    computeProjection,
    computeDomination,
    computeIPI,
    computeH2H,

    /* Séries temporelles */
    buildPointsSeries,
    buildGPBreakdown,

    /* Classements */
    computeChampionshipRanking,
    computeManufacturersRanking,
    computeNationStats,
    computeGlobalOverview,

    /* Utils exposés */
    mean, stdDev, linearRegression, normalizeBike,
    MAIN_RACES, RACE_TYPES,
  };
})();
