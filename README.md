# MXGP Race Analytics

Dashboard analytics MXGP avec scraping automatique via GitHub Actions.

## Structure
```
/
├── index.html                  # Interface principale (GitHub Pages)
├── css/stats.css               # Styles
├── js/stats.js                 # Logique + charts (auto-fetch data/results.json)
├── data/results.json           # Données (auto-générées par GitHub Actions)
├── scraper/
│   ├── scraper.js              # Scraper Playwright
│   └── package.json
└── .github/workflows/
    └── scrape.yml              # Workflow auto (dimanche + lundi 22h UTC)
```

## Lancer le scraper en local
```bash
cd scraper
npm install
npx playwright install chromium
npm run scrape           # scrape 2026 MXGP → ../data/results.json
npm run scrape:debug     # mode verbose + sauvegarde HTML pour debug
```

## Déploiement GitHub Pages
1. Push ce repo sur GitHub
2. Settings → Pages → Source: branch `main`, dossier `/` (root)
3. Actions se lance auto après les courses (dim + lun soir)
4. Lancement manuel : onglet Actions → "MXGP Auto-Scrape" → Run workflow
