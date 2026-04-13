"""
MXGP Full Scraper — Playwright v3
Scrape TOUT : toutes années, championnats, classes, events, courses, types de résultats
Sauvegarde progressive + reprise automatique
"""

import json
import os
import time
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

OUTPUT_FILE   = "mxgp_results.json"
BASE_URL      = "https://results.mxgp.com/reslists.aspx"
WAIT_AFTER    = 1200   # ms entre chaque changement de dropdown
WAIT_TABLE    = 3000   # ms max pour attendre le tableau
HEADLESS      = True   # False = voir le navigateur (debug)


# ══════════════════════════════════════════════════════════════════════════════
# Persistance
# ══════════════════════════════════════════════════════════════════════════════

def load_data():
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        print(f"[REPRISE] Chargé depuis {OUTPUT_FILE}")
        return data
    return {}


def save_data(data):
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ══════════════════════════════════════════════════════════════════════════════
# Helpers Playwright
# ══════════════════════════════════════════════════════════════════════════════

def get_options(page, select_name):
    """Retourne les options d'un <select> sous forme [{value, label}]."""
    try:
        opts = page.eval_on_selector(
            f"select[name='{select_name}']",
            """el => Array.from(el.options)
                .filter(o => o.value.trim() !== '')
                .map(o => ({ value: o.value, label: o.text.trim() }))"""
        )
        return opts
    except Exception:
        return []


def select_option_and_wait(page, select_name, value, label=""):
    """Sélectionne une option et attend que la page se stabilise."""
    try:
        page.select_option(f"select[name='{select_name}']", value=value)
        page.wait_for_load_state("networkidle", timeout=15000)
        page.wait_for_timeout(WAIT_AFTER)
    except PWTimeout:
        print(f"      ⚠️  Timeout réseau pour {label} — on continue quand même")
    except Exception as e:
        print(f"      ❌ Erreur select {select_name}={value} : {e}")


def parse_table(page):
    """Extrait le tableau de résultats visible en tableau de dicts."""
    rows = []
    try:
        table = page.query_selector("table")
        if not table:
            return rows

        headers = [
            th.inner_text().strip()
            for th in table.query_selector_all("th")
        ]

        tr_list = table.query_selector_all("tr")
        # Sauter la première ligne si c'est les headers
        start = 1 if headers else 0

        for tr in tr_list[start:]:
            cells = [td.inner_text().strip() for td in tr.query_selector_all("td")]
            if not cells:
                continue
            if headers and len(cells) == len(headers):
                rows.append(dict(zip(headers, cells)))
            elif cells:
                rows.append(cells)

    except Exception as e:
        print(f"      ⚠️  Erreur parse_table : {e}")

    return rows


def get_page_title(page):
    """Titre h2 ou h3 au-dessus du tableau (ex: 'MX2 - Race 1 - Classification')."""
    for sel in ["h2", "h3", ".res-title", ".title"]:
        el = page.query_selector(sel)
        if el:
            txt = el.inner_text().strip()
            if txt:
                return txt
    return ""


# ══════════════════════════════════════════════════════════════════════════════
# Scraper principal
# ══════════════════════════════════════════════════════════════════════════════

def scrape():
    all_data = load_data()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        context = browser.new_context()
        page = context.new_page()

        print(f"\n[INIT] Ouverture de {BASE_URL}...")
        page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(2000)

        # ── Années ────────────────────────────────────────────────────────────
        years = get_options(page, "SelectYear")
        print(f"       {len(years)} année(s) trouvée(s) : {[y['label'] for y in years]}\n")

        for year in years:
            yval, ylabel = year["value"], year["label"]

            if ylabel not in all_data:
                all_data[ylabel] = {}

            print(f"{'═'*65}")
            print(f"[ANNÉE] {ylabel}")

            select_option_and_wait(page, "SelectYear", yval, ylabel)
            championships = get_options(page, "SelectCShip")

            # ── Championnats ──────────────────────────────────────────────────
            for champ in championships:
                cval, clabel = champ["value"], champ["label"]

                if clabel not in all_data[ylabel]:
                    all_data[ylabel][clabel] = {}

                print(f"  [CHAMP] {clabel}")
                select_option_and_wait(page, "SelectCShip", cval, clabel)
                classes = get_options(page, "SelectClass")

                # ── Classes ───────────────────────────────────────────────────
                for cls in classes:
                    clsval, clslabel = cls["value"], cls["label"]

                    if clslabel not in all_data[ylabel][clabel]:
                        all_data[ylabel][clabel][clslabel] = {}

                    print(f"    [CLASSE] {clslabel}")
                    select_option_and_wait(page, "SelectClass", clsval, clslabel)
                    events = get_options(page, "SelectEvent")

                    # ── Events ────────────────────────────────────────────────
                    for event in events:
                        eval_, elabel = event["value"], event["label"]

                        if elabel not in all_data[ylabel][clabel][clslabel]:
                            all_data[ylabel][clabel][clslabel][elabel] = {}

                        print(f"      [EVENT] {elabel}")
                        select_option_and_wait(page, "SelectEvent", eval_, elabel)
                        races = get_options(page, "SelectRace")

                        # ── Courses ───────────────────────────────────────────
                        for race in races:
                            rval, rlabel = race["value"], race["label"]

                            if rlabel in all_data[ylabel][clabel][clslabel][elabel]:
                                print(f"        [SKIP] {rlabel}")
                                continue

                            print(f"        [COURSE] {rlabel}")
                            all_data[ylabel][clabel][clslabel][elabel][rlabel] = {}

                            select_option_and_wait(page, "SelectRace", rval, rlabel)
                            result_types = get_options(page, "SelectResult")

                            # ── Types de résultats ────────────────────────────
                            for rtype in result_types:
                                rtval, rtlabel = rtype["value"], rtype["label"]
                                key = rtlabel.replace("/", "-").strip()

                                select_option_and_wait(page, "SelectResult", rtval, rtlabel)

                                rows = parse_table(page)
                                title = get_page_title(page)

                                all_data[ylabel][clabel][clslabel][elabel][rlabel][key] = {
                                    "title": title,
                                    "rows": rows
                                }

                                status = f"{len(rows)} lignes" if rows else "vide"
                                print(f"          [{rtlabel}] {status}")

                            # Sauvegarde après chaque course
                            save_data(all_data)
                            print(f"          💾 Sauvegardé")

        browser.close()

    return all_data


# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import sys
    try:
        data = scrape()
        print(f"\n✅  Terminé — tout sauvegardé dans '{OUTPUT_FILE}'")
    except KeyboardInterrupt:
        print(f"\n[!] Arrêté — données partielles dans '{OUTPUT_FILE}'")
        sys.exit(0)
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"\n[ERREUR] {e}")
        print(f"Les données jusqu'ici sont dans '{OUTPUT_FILE}'")
        sys.exit(1)