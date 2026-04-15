/* ═══════════════════════════════════════════════════════════════
   MXGP Stats — UI.js
   Filtres, sélecteur pilotes, rendu dashboard complet.
═══════════════════════════════════════════════════════════════ */

const UI = (() => {

  /* ── State ── */
  let _sessions       = [];   // toutes les sessions chargées
  let _filtered       = [];   // après filtres
  let _allRiders      = [];   // { riderId, firstName, lastName, bike }
  let _selectedRiders = [];   // riderIds sélectionnés
  let _ranking        = [];   // classement courant

  const MAX_DEFAULT   = 10;
  let _showCount      = MAX_DEFAULT;

  /* Filtres courants */
  const _filters = {
    year:        '',
    category:    '',
    championship:'',
    event:       '',
    session:     '',
    sessionType: '',
  };

  /* ── Sections ── */
  const SECTIONS = ['sec-overview','sec-ranking','sec-evolution','sec-comparison',
                    'sec-h2h','sec-heatmap','sec-radar','sec-scatter','sec-manufacturers','sec-nations'];

  /* ══════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════ */
  async function init() {
    showLoader(true, 'Connexion à la base…');
    await DataManager.init();

    const stats = await DataManager.getDBStats();
    if (stats.sessions === 0) {
      showEmptyState();
      return;
    }

    showLoader(true, `Chargement de ${stats.sessions} sessions…`);
    _sessions = await DataManager.getSessions();

    await buildFilters();
    applyFilters();
    buildRiderSelector();
    bindNav();
    bindFilterEvents();
    bindRiderSelector();
    showLoader(false);
    switchSection('sec-overview');
  }

  /* ══════════════════════════════════════════════
     LOADER / ÉTATS VIDES
  ══════════════════════════════════════════════ */
  function showLoader(show, msg = 'Chargement…') {
    const el = document.getElementById('app-loader');
    if (!el) return;
    el.style.display = show ? 'flex' : 'none';
    const txt = el.querySelector('.loader-txt');
    if (txt) txt.textContent = msg;
  }

  function showEmptyState() {
    showLoader(false);
    const el = document.getElementById('empty-state');
    if (el) el.style.display = 'flex';
  }

  /* ══════════════════════════════════════════════
     FILTRES
  ══════════════════════════════════════════════ */
  async function buildFilters() {
    const years = [...new Set(_sessions.map(s => s.year))].sort((a,b) => b-a);
    const cats  = [...new Set(_sessions.map(s => s.category))].filter(Boolean);
    const champs= [...new Set(_sessions.map(s => s.championship))].filter(Boolean);
    const types = [...new Set(_sessions.map(s => s.session))].filter(Boolean);

    fillSelect('f-year',     [{ value:'', text:'Toutes les années' },  ...years.map(y  => ({ value:y,    text:y }))]);
    fillSelect('f-category', [{ value:'', text:'Toutes catégories' },  ...cats.map(c   => ({ value:c,    text:c }))]);
    fillSelect('f-champ',    [{ value:'', text:'Tous championnats' },   ...champs.map(c => ({ value:c,    text:c }))]);
    fillSelect('f-sesstype', [{ value:'', text:'Toutes sessions' },
      { value:'race1',    text:'Race 1' },
      { value:'race2',    text:'Race 2' },
      { value:'qualifying_race', text:'Qualifying Race' },
      { value:'qualifying',      text:'Qualifying' },
      { value:'fp',       text:'Free Practice' },
      { value:'warmup',   text:'Warm-up' },
      { value:'timeattack',text:'Time Practice' },
    ]);

    await updateEventFilter();
  }

  async function updateEventFilter() {
    const evtMap = new Map();
    _sessions.forEach(s => {
      if (_filters.year     && s.year     !== +_filters.year)    return;
      if (_filters.category && s.category !== _filters.category) return;
      evtMap.set(s.eventId, s.eventName);
    });
    const evts = [...evtMap.entries()].map(([id,name]) => ({ value:id, text:name }))
      .sort((a,b) => a.text.localeCompare(b.text));
    fillSelect('f-event', [{ value:'', text:'Tous les GPs' }, ...evts]);
  }

  function fillSelect(id, options) {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = el.value;
    el.innerHTML = options.map(o =>
      `<option value="${o.value}">${o.text}</option>`
    ).join('');
    if (options.find(o => o.value === cur)) el.value = cur;
  }

  function bindFilterEvents() {
    const ids = ['f-year','f-category','f-champ','f-event','f-sesstype'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', async () => {
        _filters.year        = document.getElementById('f-year')?.value     || '';
        _filters.category    = document.getElementById('f-category')?.value || '';
        _filters.championship= document.getElementById('f-champ')?.value    || '';
        _filters.event       = document.getElementById('f-event')?.value    || '';
        _filters.sessionType = document.getElementById('f-sesstype')?.value || '';

        await updateEventFilter();
        applyFilters();
        render();
      });
    });
  }

  function applyFilters() {
    _filtered = _sessions.filter(s => {
      if (_filters.year        && s.year         !== +_filters.year)         return false;
      if (_filters.category    && s.category     !== _filters.category)      return false;
      if (_filters.championship&& s.championship !== _filters.championship)  return false;
      if (_filters.event       && s.eventId      !== _filters.event)         return false;
      if (_filters.sessionType && s.sessionType  !== _filters.sessionType)   return false;
      return true;
    });

    /* Recalcule classement */
    _ranking = StatsEngine.computeChampionshipRanking(_filtered);

    /* Met à jour la liste de tous les pilotes disponibles */
    const riderMap = StatsEngine.groupByRider(_filtered, null);
    _allRiders = [...riderMap.values()].map(d => ({
      riderId:   d.riderId,
      firstName: d.firstName,
      lastName:  d.lastName,
      bike:      d.bike,
      nr:        d.nr,
    })).sort((a,b) => a.lastName.localeCompare(b.lastName));

    /* Sélection par défaut = top 10 du classement */
    if (!_selectedRiders.length || _selectedRiders.every(id => !_allRiders.find(r=>r.riderId===id))) {
      _selectedRiders = _ranking.slice(0, MAX_DEFAULT).map(r => r.riderId);
    }

    /* Filtre les sélectionnés qui n'existent plus dans les données filtrées */
    _selectedRiders = _selectedRiders.filter(id => _allRiders.find(r => r.riderId === id));
  }

  /* ══════════════════════════════════════════════
     SÉLECTEUR PILOTES
  ══════════════════════════════════════════════ */
  function buildRiderSelector() {
    renderChips();
    renderRiderDropdown('');
  }

  function bindRiderSelector() {
    const searchEl = document.getElementById('rider-search');
    if (searchEl) searchEl.addEventListener('input', () => renderRiderDropdown(searchEl.value));

    document.getElementById('btn-add-all')?.addEventListener('click', () => {
      _selectedRiders = _allRiders.map(r => r.riderId);
      onRidersChanged();
    });
    document.getElementById('btn-reset-top10')?.addEventListener('click', () => {
      _selectedRiders = _ranking.slice(0, MAX_DEFAULT).map(r => r.riderId);
      onRidersChanged();
    });
    document.getElementById('btn-top20')?.addEventListener('click', () => {
      _selectedRiders = _ranking.slice(0, 20).map(r => r.riderId);
      onRidersChanged();
    });
    document.getElementById('btn-top30')?.addEventListener('click', () => {
      _selectedRiders = _ranking.slice(0, 30).map(r => r.riderId);
      onRidersChanged();
    });
  }

  function renderChips() {
    const wrap = document.getElementById('rider-chips');
    if (!wrap) return;
    wrap.innerHTML = '';
    _selectedRiders.forEach(id => {
      const r = _allRiders.find(r => r.riderId === id);
      if (!r) return;
      const color = GraphEngine.getRiderColor(id, r.bike);
      const chip  = document.createElement('div');
      chip.className = 'rider-chip';
      chip.style.setProperty('--chip-color', color);
      chip.innerHTML = `<span class="chip-initials">${GraphEngine.getInitials(r.firstName, r.lastName)}</span><span class="chip-name">${r.lastName}</span><span class="chip-remove" data-id="${id}">×</span>`;
      chip.querySelector('.chip-remove').addEventListener('click', e => {
        _selectedRiders = _selectedRiders.filter(x => x !== e.target.dataset.id);
        onRidersChanged();
      });
      wrap.appendChild(chip);
    });
  }

  function renderRiderDropdown(query) {
    const list = document.getElementById('rider-dropdown');
    if (!list) return;
    const q = query.toLowerCase().trim();
    const filtered = _allRiders.filter(r => {
      if (_selectedRiders.includes(r.riderId)) return false;
      if (!q) return true;
      return (r.lastName + r.firstName + r.nr).toLowerCase().includes(q);
    }).slice(0, 20);

    list.innerHTML = '';
    list.style.display = filtered.length ? 'block' : 'none';

    filtered.forEach(r => {
      const color = GraphEngine.getRiderColor(r.riderId, r.bike);
      const item  = document.createElement('div');
      item.className = 'dropdown-item';
      item.innerHTML = `<span class="di-dot" style="background:${color}"></span><span class="di-nr">#${r.nr}</span><span class="di-name">${r.firstName} ${r.lastName}</span><span class="di-bike">${r.bike}</span>`;
      item.addEventListener('click', () => {
        _selectedRiders.push(r.riderId);
        const search = document.getElementById('rider-search');
        if (search) search.value = '';
        onRidersChanged();
      });
      list.appendChild(item);
    });
  }

  function onRidersChanged() {
    renderChips();
    renderRiderDropdown(document.getElementById('rider-search')?.value || '');
    render();
  }

  /* ══════════════════════════════════════════════
     NAVIGATION SECTIONS
  ══════════════════════════════════════════════ */
  function bindNav() {
    document.querySelectorAll('[data-section]').forEach(btn => {
      btn.addEventListener('click', () => {
        switchSection(btn.dataset.section);
        document.querySelectorAll('[data-section]').forEach(b => b.classList.remove('nav-active'));
        btn.classList.add('nav-active');
      });
    });
    /* Actif par défaut */
    document.querySelector('[data-section="sec-overview"]')?.classList.add('nav-active');
  }

  function switchSection(id) {
    SECTIONS.forEach(s => {
      const el = document.getElementById(s);
      if (el) el.style.display = s === id ? 'block' : 'none';
    });
    render(id);
  }

  /* ══════════════════════════════════════════════
     RENDER — dispatch selon section active
  ══════════════════════════════════════════════ */
  function render(section) {
    const active = section || SECTIONS.find(s => {
      const el = document.getElementById(s);
      return el && el.style.display !== 'none';
    }) || 'sec-overview';

    switch(active) {
      case 'sec-overview':     renderOverview();     break;
      case 'sec-ranking':      renderRanking();      break;
      case 'sec-evolution':    renderEvolution();    break;
      case 'sec-comparison':   renderComparison();   break;
      case 'sec-h2h':          renderH2H();          break;
      case 'sec-heatmap':      renderHeatmap();      break;
      case 'sec-radar':        renderRadar();        break;
      case 'sec-scatter':      renderScatter();      break;
      case 'sec-manufacturers':renderManufacturers();break;
      case 'sec-nations':      renderNations();      break;
    }
  }

  /* ══════════════════════════════════════════════
     SEC — OVERVIEW
  ══════════════════════════════════════════════ */
  function renderOverview() {
    const global = StatsEngine.computeGlobalOverview(_filtered);
    setText('ov-sessions',  _filtered.length.toLocaleString('fr'));
    setText('ov-riders',    global.totalRiders.toLocaleString('fr'));
    setText('ov-races',     global.totalRaces.toLocaleString('fr'));
    setText('ov-years',     `${Math.min(...global.years)} → ${Math.max(...global.years)}`);
    setText('ov-categories',global.categories.join(' · '));

    if (global.topRider) {
      setText('ov-top-name', `${global.topRider.firstName} ${global.topRider.lastName}`);
      setText('ov-top-pts',  global.topPts + ' pts');
    }

    /* Spark globale : points cumulés du top pilote */
    if (_ranking.length) {
      const top = _ranking[0];
      const topData = StatsEngine.groupByRider(_filtered, StatsEngine.MAIN_RACES).get(top.riderId);
      if (topData) {
        const series  = StatsEngine.buildPointsSeries(topData.results);
        const sparkEl = document.getElementById('ov-spark');
        if (sparkEl) {
          GraphEngine.drawSparkline(sparkEl, series.map(s => s.cumulPts),
            { color: GraphEngine.getRiderColor(top.riderId, top.bike) });
        }
      }
    }
  }

  /* ══════════════════════════════════════════════
     SEC — RANKING
  ══════════════════════════════════════════════ */
  function renderRanking() {
    const tbody = document.getElementById('ranking-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    _ranking.forEach((r, i) => {
      const consistency = r.consistency || { score: null };
      const momentum    = r.momentum    || { trend: 'stable', score: null };
      const color       = GraphEngine.getRiderColor(r.riderId, r.bike);
      const trendIcon   = { rising:'▲', falling:'▼', stable:'—' }[momentum.trend] || '—';
      const trendCls    = { rising:'t-up', falling:'t-down', stable:'t-flat' }[momentum.trend] || '';

      const tr = document.createElement('tr');
      tr.className = i < 3 ? `rank-row podium-${i+1}` : 'rank-row';
      tr.innerHTML = `
        <td class="rank-pos">${i+1}</td>
        <td><span class="nr-pill" style="--pill-bg:${color}">${r.nr || '?'}</span></td>
        <td class="rank-name"><span class="rn-fn">${r.firstName}</span> <span class="rn-ln">${r.lastName}</span></td>
        <td class="rank-nat">${flag(r.nation)}</td>
        <td class="rank-bike">${r.bike || '—'}</td>
        <td class="rank-pts"><strong>${r.totalPts}</strong></td>
        <td class="rank-val">${r.races}</td>
        <td class="rank-val">${r.wins}</td>
        <td class="rank-val">${r.podiums}</td>
        <td class="rank-val">${r.top10}</td>
        <td class="rank-val">${r.avgPos !== null ? r.avgPos.toFixed(1) : '—'}</td>
        <td class="rank-val">${consistency.score !== null ? consistency.score.toFixed(0) : '—'}</td>
        <td class="rank-val ${trendCls}">${trendIcon}</td>
        <td class="rank-val rank-ipi">${r.ipi}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  /* ══════════════════════════════════════════════
     SEC — ÉVOLUTION DES POINTS
  ══════════════════════════════════════════════ */
  function renderEvolution() {
    const canvas = document.getElementById('chart-evolution');
    if (!canvas) return;

    const riderMap = StatsEngine.groupByRider(_filtered, null);
    const series   = [];
    const labelsSet= new Set();

    /* Construit une série par pilote sélectionné */
    for (const id of _selectedRiders.slice(0, 20)) {
      const data = riderMap.get(id);
      if (!data) continue;
      const pts = StatsEngine.buildPointsSeries(data.results);
      pts.forEach(p => labelsSet.add(p.label));
      series.push({ ...data, _pts: pts });
    }

    const labels = [...labelsSet];

    const chartSeries = series.map(s => ({
      riderId:   s.riderId,
      firstName: s.firstName,
      lastName:  s.lastName,
      bike:      s.bike,
      data:      labels.map(lbl => s._pts.find(p => p.label === lbl)?.cumulPts ?? null),
    }));

    GraphEngine.drawLineChart(canvas, chartSeries, labels, {
      yMin: 0,
    });
  }

  /* ══════════════════════════════════════════════
     SEC — COMPARAISON STATS
  ══════════════════════════════════════════════ */
  function renderComparison() {
    const canvas = document.getElementById('chart-comparison');
    if (!canvas) return;

    const comparison = StatsEngine.buildComparison(_selectedRiders.slice(0,15), _filtered);
    if (!comparison.length) return;

    const categories = ['Points','Victoires','Podiums','Top 10','Courses','Fin. %'];
    const series = comparison.map(r => ({
      riderId:   r.riderId,
      firstName: r.firstName,
      lastName:  r.lastName,
      bike:      r.bike,
      data: [r.totalPts, r.wins, r.podiums, r.top10, r.races, Math.round(r.finishRate)],
    }));
    const maxVal = Math.max(...series.map(s => s.data[0]));

    GraphEngine.drawBarChart(canvas, categories, series, { maxVal });

    /* Cards stats textuelles */
    renderComparisonCards(comparison);
  }

  function renderComparisonCards(comparison) {
    const wrap = document.getElementById('comparison-cards');
    if (!wrap) return;
    wrap.innerHTML = '';

    comparison.slice(0, 6).forEach(r => {
      const color = GraphEngine.getRiderColor(r.riderId, r.bike);
      const mom   = r.momentum || {};
      const con   = r.consistency || {};
      const card  = document.createElement('div');
      card.className = 'cmp-card';
      card.style.setProperty('--card-color', color);
      card.innerHTML = `
        <div class="cmp-card-header">
          <span class="cmp-initials" style="background:${color}">${GraphEngine.getInitials(r.firstName,r.lastName)}</span>
          <div>
            <div class="cmp-name">${r.firstName} ${r.lastName}</div>
            <div class="cmp-bike">${r.bike || '—'}</div>
          </div>
        </div>
        <div class="cmp-stats-grid">
          <div class="cmp-stat"><div class="cmp-val">${r.totalPts}</div><div class="cmp-lbl">Points</div></div>
          <div class="cmp-stat"><div class="cmp-val">${r.wins}</div><div class="cmp-lbl">Victoires</div></div>
          <div class="cmp-stat"><div class="cmp-val">${r.podiums}</div><div class="cmp-lbl">Podiums</div></div>
          <div class="cmp-stat"><div class="cmp-val">${r.avgPos?.toFixed(1) || '—'}</div><div class="cmp-lbl">Pos. moy.</div></div>
          <div class="cmp-stat"><div class="cmp-val">${con.score?.toFixed(0) || '—'}</div><div class="cmp-lbl">Régularité</div></div>
          <div class="cmp-stat"><div class="cmp-val cmp-ipi">${r.ipi}</div><div class="cmp-lbl">IPI</div></div>
        </div>
        <div class="cmp-trend" style="color:${mom.trend==='rising'?'#00c97a':mom.trend==='falling'?'#e8354a':'#4e566e'}">
          ${{rising:'▲ EN FORME',falling:'▼ EN BAISSE',stable:'→ STABLE'}[mom.trend]||'—'}
        </div>
      `;
      wrap.appendChild(card);
    });
  }

  /* ══════════════════════════════════════════════
     SEC — HEAD-TO-HEAD
  ══════════════════════════════════════════════ */
  function renderH2H() {
    const riderMap = StatsEngine.groupByRider(_filtered, StatsEngine.MAIN_RACES);
    const sel      = _selectedRiders.slice(0, 2);
    if (sel.length < 2) {
      setText('h2h-msg', 'Sélectionnez exactement 2 pilotes pour la comparaison directe.');
      document.getElementById('h2h-result')?.style.setProperty('display','none');
      return;
    }
    setText('h2h-msg', '');

    const dA = riderMap.get(sel[0]);
    const dB = riderMap.get(sel[1]);
    if (!dA || !dB) return;

    const h2h  = StatsEngine.computeH2H(dA.results, dB.results);
    const cA   = GraphEngine.getRiderColor(sel[0], dA.bike);
    const cB   = GraphEngine.getRiderColor(sel[1], dB.bike);

    setText('h2h-name-a',`${dA.firstName} ${dA.lastName}`);
    setText('h2h-name-b',`${dB.firstName} ${dB.lastName}`);
    setText('h2h-wins-a', h2h.aWins);
    setText('h2h-wins-b', h2h.bWins);
    setText('h2h-pct-a',  h2h.aWinPct + '%');
    setText('h2h-pct-b',  h2h.bWinPct + '%');
    setText('h2h-total',  `${h2h.total} confrontations directes · ${h2h.ties} ex aequo`);
    setText('h2h-diff',   `Écart moyen : ${Math.abs(h2h.avgDiff).toFixed(1)} positions (${h2h.avgDiff >= 0 ? dA.lastName : dB.lastName} devant)`);

    /* Barre de domination */
    const barA = document.getElementById('h2h-bar-a');
    const barB = document.getElementById('h2h-bar-b');
    if (barA) { barA.style.width = h2h.aWinPct + '%'; barA.style.background = cA; }
    if (barB) { barB.style.width = h2h.bWinPct + '%'; barB.style.background = cB; }

    document.getElementById('h2h-result')?.style.removeProperty('display');
  }

  /* ══════════════════════════════════════════════
     SEC — HEATMAP
  ══════════════════════════════════════════════ */
  function renderHeatmap() {
    const canvas = document.getElementById('chart-heatmap');
    if (!canvas) return;

    const riderMap = StatsEngine.groupByRider(_filtered, StatsEngine.MAIN_RACES);
    const rows = _selectedRiders.slice(0,20).map(id => {
      const d = riderMap.get(id);
      return d ? { riderId:id, label:`${d.firstName[0]}. ${d.lastName}`, results:d.results } : null;
    }).filter(Boolean);

    /* Colonnes = GP uniques */
    const gpMap = new Map();
    _filtered.filter(s=>StatsEngine.MAIN_RACES.has(s.sessionType))
      .forEach(s=>gpMap.set(s.eventId, s.eventName.replace('Grand Prix of ','').replace('Grand Prix ','')));
    const cols  = [...gpMap.keys()].slice(0, 24);
    const colLabels = cols.map(id => gpMap.get(id));

    const getData = (row, colId) => {
      const results = row.results.filter(r => r.eventId === colId);
      if (!results.length) return null;
      return Math.round(StatsEngine.mean(results.map(r=>r.pos)));
    };

    GraphEngine.drawHeatMap(canvas, rows, cols, getData, {});

    /* Légende */
    const legEl = document.getElementById('heatmap-col-labels');
    if (legEl) legEl.textContent = colLabels.join(' · ');
  }

  /* ══════════════════════════════════════════════
     SEC — RADAR
  ══════════════════════════════════════════════ */
  function renderRadar() {
    const canvas = document.getElementById('chart-radar');
    if (!canvas) return;

    const axes = [
      { key:'ipi',        label:'IPI',        max:1000 },
      { key:'winRate',    label:'Win %',       max:100  },
      { key:'podiumRate', label:'Podium %',    max:100  },
      { key:'consistency',label:'Régularité',  max:100  },
      { key:'finishRate', label:'Finition %',  max:100  },
      { key:'momentum',   label:'Momentum',    max:100  },
    ];

    const comparison = StatsEngine.buildComparison(_selectedRiders.slice(0,6), _filtered);
    const series = comparison.map(r => ({
      riderId:   r.riderId,
      firstName: r.firstName,
      lastName:  r.lastName,
      bike:      r.bike,
      data: {
        ipi:        r.ipi,
        winRate:    r.winRate,
        podiumRate: r.podiumRate,
        consistency:r.consistency?.score ?? 50,
        finishRate: r.finishRate,
        momentum:   r.momentum?.score !== null ? (r.momentum.score + 100) / 2 : 50,
      },
    }));

    GraphEngine.drawRadarChart(canvas, axes, series);
  }

  /* ══════════════════════════════════════════════
     SEC — SCATTER (Régularité vs Performance)
  ══════════════════════════════════════════════ */
  function renderScatter() {
    const canvas = document.getElementById('chart-scatter');
    if (!canvas) return;

    const comparison = StatsEngine.buildComparison(_selectedRiders.slice(0,30), _filtered);
    const points = comparison.map(r => ({
      riderId:   r.riderId,
      firstName: r.firstName,
      lastName:  r.lastName,
      bike:      r.bike,
      x: r.consistency?.score ?? 50,
      y: r.ipi,
    }));

    GraphEngine.drawScatterChart(canvas, points, {
      xLabel: 'Régularité →',
      yLabel: '↑ IPI (Performance globale)',
      xMin: 0, xMax: 100,
      yMin: 0, yMax: 1000,
    });
  }

  /* ══════════════════════════════════════════════
     SEC — CONSTRUCTEURS
  ══════════════════════════════════════════════ */
  function renderManufacturers() {
    const ranking = StatsEngine.computeManufacturersRanking(_filtered);
    const tbody   = document.getElementById('mfr-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    ranking.slice(0, 20).forEach((m, i) => {
      const color = GraphEngine.BIKE_COLORS[m.bike] || '#4e566e';
      const tr = document.createElement('tr');
      tr.className = 'rank-row';
      tr.innerHTML = `
        <td class="rank-pos">${i+1}</td>
        <td><span class="bike-pill" style="background:${color}">${m.bike}</span></td>
        <td class="rank-pts"><strong>${m.pts}</strong></td>
        <td class="rank-val">${m.wins}</td>
        <td class="rank-val">${m.podiums}</td>
        <td class="rank-val">${m.races}</td>
        <td class="rank-val">${m.races ? Math.round(m.pts/m.races*10)/10 : '—'}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  /* ══════════════════════════════════════════════
     SEC — NATIONS
  ══════════════════════════════════════════════ */
  function renderNations() {
    const ranking = StatsEngine.computeNationStats(_filtered);
    const tbody   = document.getElementById('nat-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    ranking.slice(0, 25).forEach((n, i) => {
      const tr = document.createElement('tr');
      tr.className = 'rank-row';
      tr.innerHTML = `
        <td class="rank-pos">${i+1}</td>
        <td class="rank-nat">${flag(n.nation)} <span style="margin-left:6px;font-size:12px">${n.nation}</span></td>
        <td class="rank-pts"><strong>${n.pts}</strong></td>
        <td class="rank-val">${n.wins}</td>
        <td class="rank-val">${n.podiums}</td>
        <td class="rank-val">${n.riderCount}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  /* ══════════════════════════════════════════════
     HELPERS
  ══════════════════════════════════════════════ */
  const NAT_FLAGS = {
    FRA:'fr',BEL:'be',NED:'nl',GER:'de',ITA:'it',ESP:'es',GBR:'gb',
    USA:'us',AUS:'au',SWE:'se',NOR:'no',DEN:'dk',FIN:'fi',SUI:'ch',
    AUT:'at',POR:'pt',CZE:'cz',POL:'pl',BRA:'br',CAN:'ca',NZL:'nz',
    JPN:'jp',RSA:'za',SLO:'si',LAT:'lv',EST:'ee',LTU:'lt',SVK:'sk',
    HUN:'hu',CRO:'hr',BUL:'bg',ROU:'ro',SRB:'rs',
  };

  function flag(nat) {
    const code = NAT_FLAGS[(nat||'').toUpperCase()];
    if (!code) return `<span class="nat-code">${nat||'—'}</span>`;
    return `<img src="https://flagpedia.net/data/flags/w80/${code}.webp" width="20" height="14" class="flag-img" alt="${nat}"/>`;
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* ══════════════════════════════════════════════
     EXPORT
  ══════════════════════════════════════════════ */
  return { init, render, applyFilters };
})();
