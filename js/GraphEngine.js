/* ═══════════════════════════════════════════════════════════════
   MXGP Stats — GraphEngine.js
   Graphiques Canvas2D natifs. Zéro dépendance.
   Points avec initiales pilotes · Couleurs par marque moto.
═══════════════════════════════════════════════════════════════ */

const GraphEngine = (() => {

  /* ── Couleurs par marque (identiques au Live Timing) ── */
  const BIKE_COLORS = {
    'KTM':       '#ff6600',
    'Husqvarna': '#969696',
    'GasGas':    '#ff1a1a',
    'Honda':     '#cc0000',
    'Kawasaki':  '#00a651',
    'Yamaha':    '#0033a0',
    'TM':        '#0057b8',
    'Triumph':   '#ffd100',
    'Beta':      '#a0002a',
    'Ducati':    '#e8e8e8',
    'Fantic':    '#ff6600',
    'Sherco':    '#00aaff',
  };

  /* Palette de fallback (si moto inconnue) */
  const FALLBACK_PALETTE = [
    '#e8002d','#2196f3','#00c97a','#f5c400','#cc00ff',
    '#ff7700','#00cfff','#ff4488','#a0ff00','#ff00aa',
    '#44ffcc','#ffaa00','#0099ff','#ff5544','#88ff44',
  ];

  let _fallbackIdx = 0;
  const _colorCache = new Map(); // riderId → color

  function getRiderColor(riderId, bike) {
    if (_colorCache.has(riderId)) return _colorCache.get(riderId);
    const normalized = StatsEngine.normalizeBike(bike);
    const color = BIKE_COLORS[normalized]
      || FALLBACK_PALETTE[_fallbackIdx++ % FALLBACK_PALETTE.length];
    _colorCache.set(riderId, color);
    return color;
  }

  function resetColorCache() { _colorCache.clear(); _fallbackIdx = 0; }

  /* ── Initiales pilote ── */
  function getInitials(firstName, lastName) {
    const f = (firstName || '').trim()[0] || '';
    const l = (lastName  || '').trim()[0] || '';
    return (f + l).toUpperCase() || '?';
  }

  /* ── Device pixel ratio ── */
  function setupHiDPI(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w: rect.width, h: rect.height, dpr };
  }

  /* ── Design tokens ── */
  const T = {
    bg:      '#0a0c10',
    bg2:     '#0e1118',
    bg3:     '#12151f',
    grid:    '#1a1f2e',
    grid2:   '#252b3d',
    muted:   '#4e566e',
    white:   '#dde3f0',
    accent:  '#e8002d',
    green:   '#00c97a',
    yellow:  '#f5c400',
    purple:  '#cc00ff',
    fontMono: '"Chakra Petch", monospace',
    fontUI:   '"Barlow Condensed", sans-serif',
  };

  /* ══════════════════════════════════════════════
     HELPERS COMMUNS
  ══════════════════════════════════════════════ */
  function drawGrid(ctx, area, xCount, yCount) {
    ctx.strokeStyle = T.grid;
    ctx.lineWidth   = 0.5;
    const { x, y, w, h } = area;

    for (let i = 0; i <= xCount; i++) {
      const px = x + (w / xCount) * i;
      ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px, y + h); ctx.stroke();
    }
    for (let i = 0; i <= yCount; i++) {
      const py = y + (h / yCount) * i;
      ctx.beginPath(); ctx.moveTo(x, py); ctx.lineTo(x + w, py); ctx.stroke();
    }
  }

  function drawLabel(ctx, text, x, y, opts = {}) {
    ctx.save();
    ctx.font      = opts.font  || `${opts.size || 10}px ${T.fontMono}`;
    ctx.fillStyle = opts.color || T.muted;
    ctx.textAlign = opts.align || 'center';
    ctx.textBaseline = opts.baseline || 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /* Calcule les limites min/max d'une série */
  function dataRange(series) {
    const all = series.flatMap(s => s.data.filter(v => v !== null));
    if (!all.length) return { min: 0, max: 1 };
    return { min: Math.min(...all), max: Math.max(...all) };
  }

  /* ══════════════════════════════════════════════
     1. LINE CHART — Évolution temporelle
     series : [{ riderId, firstName, lastName, bike, data: [val|null] }]
     labels : [string]
     opts.invertY = true → position (1 en haut)
  ══════════════════════════════════════════════ */
  function drawLineChart(canvas, series, labels, opts = {}) {
    const { ctx, w, h } = setupHiDPI(canvas);
    const pad = { top: 24, right: 80, bottom: 52, left: 52 };
    const area = { x: pad.left, y: pad.top, w: w - pad.left - pad.right, h: h - pad.top - pad.bottom };

    /* Fond */
    ctx.fillStyle = T.bg2;
    ctx.fillRect(0, 0, w, h);

    if (!series.length || !labels.length) {
      drawLabel(ctx, 'Aucune donnée', w/2, h/2, { color: T.muted, size: 13 });
      return;
    }

    const { min, max } = dataRange(series);
    const yMin = opts.invertY ? (opts.yMin ?? 1)              : (opts.yMin ?? min);
    const yMax = opts.invertY ? (opts.yMax ?? Math.max(max,20)) : (opts.yMax ?? max);
    const yRange = yMax - yMin || 1;

    const toX = i => area.x + (i / Math.max(labels.length - 1, 1)) * area.w;
    const toY = v => opts.invertY
      ? area.y + ((v - yMin) / yRange) * area.h    // inversion : pos 1 = haut
      : area.y + area.h - ((v - yMin) / yRange) * area.h;

    /* Grid horizontal */
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const v  = yMin + (yRange / yTicks) * i;
      const py = toY(v);
      ctx.strokeStyle = T.grid;
      ctx.lineWidth   = 0.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(area.x, py); ctx.lineTo(area.x + area.w, py); ctx.stroke();
      ctx.setLineDash([]);
      drawLabel(ctx, opts.invertY ? Math.round(v) + 'e' : Math.round(v),
        area.x - 8, py, { align: 'right', size: 9 });
    }

    /* Axe X — labels */
    const step = Math.max(1, Math.ceil(labels.length / 10));
    labels.forEach((lbl, i) => {
      if (i % step !== 0 && i !== labels.length - 1) return;
      const px = toX(i);
      ctx.save();
      ctx.translate(px, area.y + area.h + 8);
      ctx.rotate(-Math.PI / 4);
      drawLabel(ctx, lbl, 0, 0, { align: 'right', size: 9 });
      ctx.restore();
    });

    /* Séries */
    series.forEach(serie => {
      const color    = getRiderColor(serie.riderId, serie.bike);
      const initials = getInitials(serie.firstName, serie.lastName);

      /* Ligne */
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      let moved = false;
      serie.data.forEach((v, i) => {
        if (v === null) { moved = false; return; }
        const px = toX(i), py = toY(v);
        if (!moved) { ctx.moveTo(px, py); moved = true; }
        else        ctx.lineTo(px, py);
      });
      ctx.stroke();

      /* Points avec initiales */
      serie.data.forEach((v, i) => {
        if (v === null) return;
        const px = toX(i), py = toY(v);
        const r  = 11;

        /* Cercle rempli */
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI*2);
        ctx.fillStyle   = color;
        ctx.fill();
        ctx.strokeStyle = T.bg;
        ctx.lineWidth   = 1.5;
        ctx.stroke();

        /* Initiales */
        ctx.font      = `700 8px ${T.fontMono}`;
        ctx.fillStyle = isLight(color) ? '#111' : '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials, px, py);
      });
    });

    /* Légende */
    let legendX = area.x;
    series.forEach(serie => {
      const color = getRiderColor(serie.riderId, serie.bike);
      ctx.fillStyle = color;
      ctx.fillRect(legendX, area.y + area.h + 38, 14, 4);
      legendX += 18;
      drawLabel(ctx, `${serie.firstName} ${serie.lastName}`, legendX, area.y + area.h + 40,
        { align: 'left', size: 9, color: T.white });
      legendX += ctx.measureText(`${serie.firstName} ${serie.lastName}`).width + 14;
    });
  }

  /* ══════════════════════════════════════════════
     2. BAR CHART — Comparaison stats
     categories : [string]
     series      : [{ riderId, firstName, lastName, bike, data:[val] }]
  ══════════════════════════════════════════════ */
  function drawBarChart(canvas, categories, series, opts = {}) {
    const { ctx, w, h } = setupHiDPI(canvas);
    const pad = { top: 20, right: 20, bottom: 80, left: 60 };
    const area = { x: pad.left, y: pad.top, w: w - pad.left - pad.right, h: h - pad.top - pad.bottom };

    ctx.fillStyle = T.bg2;
    ctx.fillRect(0, 0, w, h);

    if (!series.length) return;

    const allVals  = series.flatMap(s => s.data);
    const maxVal   = opts.maxVal ?? Math.max(...allVals.filter(v => v !== null), 1);
    const groupW   = area.w / categories.length;
    const barW     = Math.min(28, (groupW - 8) / series.length);

    /* Grid */
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const v  = (maxVal / yTicks) * i;
      const py = area.y + area.h - (v / maxVal) * area.h;
      ctx.strokeStyle = T.grid;
      ctx.lineWidth   = 0.5;
      ctx.setLineDash([3,4]);
      ctx.beginPath(); ctx.moveTo(area.x, py); ctx.lineTo(area.x + area.w, py); ctx.stroke();
      ctx.setLineDash([]);
      drawLabel(ctx, Math.round(v), area.x - 8, py, { align: 'right', size: 9 });
    }

    /* Barres */
    categories.forEach((cat, ci) => {
      const gx = area.x + ci * groupW + groupW / 2;

      series.forEach((serie, si) => {
        const val   = serie.data[ci] ?? 0;
        if (val === null) return;
        const color = getRiderColor(serie.riderId, serie.bike);
        const bh    = (val / maxVal) * area.h;
        const bx    = gx + (si - (series.length-1)/2) * (barW + 2) - barW/2;
        const by    = area.y + area.h - bh;

        /* Barre */
        ctx.fillStyle = color;
        ctx.fillRect(bx, by, barW, bh);

        /* Valeur au-dessus */
        if (bh > 14) {
          drawLabel(ctx, typeof val === 'number' ? (Number.isInteger(val) ? val : val.toFixed(1)) : val,
            bx + barW/2, by - 7, { size: 9, color: T.white });
        }
      });

      /* Label catégorie */
      ctx.save();
      ctx.translate(gx, area.y + area.h + 8);
      ctx.rotate(-Math.PI/4);
      drawLabel(ctx, cat, 0, 0, { align: 'right', size: 9 });
      ctx.restore();
    });

    /* Légende */
    let lx = area.x;
    series.forEach(s => {
      const c = getRiderColor(s.riderId, s.bike);
      ctx.fillStyle = c;
      ctx.fillRect(lx, area.y + area.h + 48, 12, 12);
      lx += 16;
      drawLabel(ctx, `${s.firstName} ${s.lastName}`, lx, area.y + area.h + 54, { align:'left', size:9, color: T.white });
      lx += ctx.measureText(`${s.firstName} ${s.lastName}`).width + 12;
    });
  }

  /* ══════════════════════════════════════════════
     3. RADAR CHART — Profil multi-axes
     axes    : [{ key, label, max }]
     series  : [{ riderId, firstName, lastName, bike, data:{key:val} }]
  ══════════════════════════════════════════════ */
  function drawRadarChart(canvas, axes, series, opts = {}) {
    const { ctx, w, h } = setupHiDPI(canvas);
    ctx.fillStyle = T.bg2;
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const r  = Math.min(w, h) * 0.36;
    const n  = axes.length;
    if (!n) return;

    const angle = i => (i / n) * Math.PI * 2 - Math.PI / 2;
    const pt    = (i, pct) => ({
      x: cx + Math.cos(angle(i)) * r * pct,
      y: cy + Math.sin(angle(i)) * r * pct,
    });

    /* Toile */
    [0.2, 0.4, 0.6, 0.8, 1.0].forEach(pct => {
      ctx.strokeStyle = T.grid;
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      axes.forEach((_, i) => {
        const p = pt(i, pct);
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
    });

    /* Rayons */
    axes.forEach((_, i) => {
      const p = pt(i, 1);
      ctx.strokeStyle = T.grid;
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });

    /* Labels axes */
    axes.forEach((ax, i) => {
      const p = pt(i, 1.18);
      drawLabel(ctx, ax.label, p.x, p.y, { size: 10, color: T.muted });
    });

    /* Polygones pilotes */
    series.forEach(serie => {
      const color = getRiderColor(serie.riderId, serie.bike);
      const pts   = axes.map((ax, i) => {
        const v   = serie.data[ax.key] ?? 0;
        const pct = Math.min(1, Math.max(0, v / (ax.max || 100)));
        return pt(i, pct);
      });

      /* Remplissage */
      ctx.fillStyle   = hexAlpha(color, 0.12);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.beginPath();
      pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      /* Points */
      pts.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI*2);
        ctx.fillStyle = color;
        ctx.fill();
      });
    });
  }

  /* ══════════════════════════════════════════════
     4. SCATTER CHART — Cohérence vs Performance
     points : [{ riderId, firstName, lastName, bike, x, y, label }]
  ══════════════════════════════════════════════ */
  function drawScatterChart(canvas, points, opts = {}) {
    const { ctx, w, h } = setupHiDPI(canvas);
    const pad = { top: 24, right: 24, bottom: 48, left: 56 };
    const area = { x: pad.left, y: pad.top, w: w-pad.left-pad.right, h: h-pad.top-pad.bottom };

    ctx.fillStyle = T.bg2;
    ctx.fillRect(0, 0, w, h);

    if (!points.length) return;

    const xVals = points.map(p => p.x).filter(v => v != null);
    const yVals = points.map(p => p.y).filter(v => v != null);
    const xMin  = opts.xMin ?? Math.min(...xVals) * 0.9;
    const xMax  = opts.xMax ?? Math.max(...xVals) * 1.05;
    const yMin  = opts.yMin ?? Math.min(...yVals) * 0.9;
    const yMax  = opts.yMax ?? Math.max(...yVals) * 1.05;

    const toX = v => area.x + ((v - xMin) / (xMax - xMin)) * area.w;
    const toY = v => area.y + area.h - ((v - yMin) / (yMax - yMin)) * area.h;

    drawGrid(ctx, area, 5, 5);

    /* Labels axes */
    drawLabel(ctx, opts.xLabel || 'X', area.x + area.w/2, area.y + area.h + 36, { size:10 });
    ctx.save();
    ctx.translate(12, area.y + area.h/2);
    ctx.rotate(-Math.PI/2);
    drawLabel(ctx, opts.yLabel || 'Y', 0, 0, { size: 10 });
    ctx.restore();

    /* Points */
    points.forEach(pt => {
      if (pt.x == null || pt.y == null) return;
      const px = toX(pt.x), py = toY(pt.y);
      const color    = getRiderColor(pt.riderId, pt.bike);
      const initials = getInitials(pt.firstName, pt.lastName);
      const r = 13;

      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI*2);
      ctx.fillStyle   = color;
      ctx.fill();
      ctx.strokeStyle = T.bg;
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      ctx.font      = `700 8px ${T.fontMono}`;
      ctx.fillStyle = isLight(color) ? '#111' : '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(initials, px, py);
    });
  }

  /* ══════════════════════════════════════════════
     5. HEAT MAP — Résultats GP par GP
     rows : pilotes, cols : GPs, val : position
  ══════════════════════════════════════════════ */
  function drawHeatMap(canvas, rows, cols, getData, opts = {}) {
    const { ctx, w, h } = setupHiDPI(canvas);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, w, h);

    if (!rows.length || !cols.length) return;

    const labelW = 110;
    const labelH = 20;
    const cellW  = Math.max(20, (w - labelW) / cols.length);
    const cellH  = Math.max(18, (h - labelH) / rows.length);

    /* En-têtes colonnes */
    cols.forEach((col, ci) => {
      ctx.save();
      ctx.translate(labelW + ci * cellW + cellW/2, labelH - 4);
      ctx.rotate(-Math.PI/4);
      drawLabel(ctx, col, 0, 0, { align: 'right', size: 8 });
      ctx.restore();
    });

    /* Lignes */
    rows.forEach((row, ri) => {
      /* Label */
      drawLabel(ctx, row.label, labelW - 4, labelH + ri * cellH + cellH/2,
        { align: 'right', size: 9, color: T.white });

      cols.forEach((col, ci) => {
        const val   = getData(row, col);
        const color = positionColor(val);
        const x     = labelW + ci * cellW;
        const y     = labelH + ri * cellH;

        ctx.fillStyle = color;
        ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);

        if (val !== null && cellW > 14) {
          drawLabel(ctx, val, x + cellW/2, y + cellH/2,
            { size: 8, color: val <= 3 ? '#111' : T.muted });
        }
      });
    });
  }

  /* ══════════════════════════════════════════════
     6. MOMENTUM GAUGE — Jauge circulaire
  ══════════════════════════════════════════════ */
  function drawMomentumGauge(canvas, score, opts = {}) {
    const { ctx, w, h } = setupHiDPI(canvas);
    ctx.fillStyle = T.bg2;
    ctx.fillRect(0, 0, w, h);

    const cx = w/2, cy = h * 0.6;
    const r  = Math.min(w, h) * 0.35;

    /* Arc fond */
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.strokeStyle = T.grid2;
    ctx.lineWidth   = 14;
    ctx.stroke();

    /* Arc valeur */
    if (score !== null) {
      const pct    = (score + 100) / 200; // -100→200 → 0→1
      const endA   = Math.PI + pct * Math.PI;
      const color  = score > 20 ? T.green : score < -20 ? T.accent : T.yellow;
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI, endA);
      ctx.strokeStyle = color;
      ctx.lineWidth   = 14;
      ctx.lineCap     = 'round';
      ctx.stroke();

      /* Valeur texte */
      drawLabel(ctx, (score > 0 ? '+' : '') + score.toFixed(1),
        cx, cy - r * 0.1, { size: 24, color, font: `700 24px ${T.fontMono}` });
    }

    drawLabel(ctx, opts.label || 'MOMENTUM', cx, cy + r * 0.25, { size: 10 });
    drawLabel(ctx, '-100', cx - r, cy + 14, { size: 8 });
    drawLabel(ctx, '+100', cx + r, cy + 14, { size: 8 });
  }

  /* ══════════════════════════════════════════════
     7. TREND SPARKLINE — Petite courbe inline
  ══════════════════════════════════════════════ */
  function drawSparkline(canvas, data, opts = {}) {
    const { ctx, w, h } = setupHiDPI(canvas);
    ctx.clearRect(0, 0, w, h);

    const valid = data.filter(v => v !== null);
    if (valid.length < 2) return;

    const min   = Math.min(...valid);
    const max   = Math.max(...valid);
    const range = max - min || 1;
    const pad   = 4;

    const toX = i => pad + (i / (data.length - 1)) * (w - pad*2);
    const toY = v => opts.invertY
      ? pad + ((v - min) / range) * (h - pad*2)
      : h - pad - ((v - min) / range) * (h - pad*2);

    const color = opts.color || T.accent;

    /* Gradient fill */
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexAlpha(color, 0.3));
    grad.addColorStop(1, hexAlpha(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    data.forEach((v, i) => {
      if (v === null) return;
      const px = toX(i), py = toY(v);
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.lineTo(toX(data.length-1), h);
    ctx.lineTo(toX(0), h);
    ctx.closePath();
    ctx.fill();

    /* Ligne */
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    let moved = false;
    data.forEach((v, i) => {
      if (v === null) { moved = false; return; }
      const px = toX(i), py = toY(v);
      if (!moved) { ctx.moveTo(px, py); moved = true; }
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  /* ══════════════════════════════════════════════
     UTILS
  ══════════════════════════════════════════════ */

  /* Couleur selon position (1=or, 2=argent, etc.) */
  function positionColor(pos) {
    if (pos === null || pos === undefined) return '#12151f';
    if (pos === 1) return '#7a6000';
    if (pos === 2) return '#505060';
    if (pos === 3) return '#6a3a1a';
    if (pos <= 5)  return '#1a3a1a';
    if (pos <= 10) return '#1a1f2e';
    return '#0e1118';
  }

  /* Luminosité d'une couleur hex (pour texte noir/blanc) */
  function isLight(hex) {
    const h = hex.replace('#','');
    if (h.length < 6) return false;
    const r = parseInt(h.slice(0,2),16);
    const g = parseInt(h.slice(2,4),16);
    const b = parseInt(h.slice(4,6),16);
    return (r*299 + g*587 + b*114) / 1000 > 140;
  }

  function hexAlpha(hex, alpha) {
    const h = hex.replace('#','');
    if (h.length < 6) return hex;
    const r = parseInt(h.slice(0,2),16);
    const g = parseInt(h.slice(2,4),16);
    const b = parseInt(h.slice(4,6),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /* Resize observer — redessine quand le canvas change de taille */
  function observeResize(canvas, drawFn) {
    if (!window.ResizeObserver) return;
    const obs = new ResizeObserver(() => drawFn());
    obs.observe(canvas);
    return obs;
  }

  /* ══════════════════════════════════════════════
     EXPORT
  ══════════════════════════════════════════════ */
  return {
    drawLineChart,
    drawBarChart,
    drawRadarChart,
    drawScatterChart,
    drawHeatMap,
    drawMomentumGauge,
    drawSparkline,
    getRiderColor,
    getInitials,
    resetColorCache,
    observeResize,
    BIKE_COLORS,
  };
})();
