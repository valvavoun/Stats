# MXGP Stats v3

Dashboard statistiques FIM Motocross World Championship — données historiques complètes.

## Structure

```
mxgp-stats-v2/
├── index.html              ← Dashboard (page principale)
├── scraper.html            ← Gestion scraping + import
├── scrape_ids.js           ← Phase 1 : collecte tous les IDs
├── scrape_data.js          ← Phase 2 : scrape les données
├── weekly-rescrape.yml     ← À déplacer dans .github/workflows/
├── package.json
├── mxgp_ids.json           ← Généré par scrape_ids.js
├── mxgp_results.json       ← Généré par scrape_data.js
├── js/
│   ├── DataManager.js
│   ├── StatsEngine.js
│   ├── GraphEngine.js
│   └── UI.js
└── css/
    └── style.css
```

## Utilisation

```bash
npm install
npx playwright install chromium

# Phase 1 — IDs (une seule fois, 15-40 min)
node scrape_ids.js

# Phase 2 — Données (une seule fois, 2-6h)
node scrape_data.js --workers=3

# Serveur local
npx serve . --listen 3000
# → http://localhost:3000/scraper.html  pour importer
# → http://localhost:3000/index.html    dashboard
```

## Mise à jour hebdo (GitHub Actions)

1. Créer `.github/workflows/` à la racine
2. Déplacer `weekly-rescrape.yml` dedans
3. Pusher → cron automatique chaque dimanche 20h
