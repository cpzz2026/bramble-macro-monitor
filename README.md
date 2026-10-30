# Bramble Macro Monitor

A live, auto-updating macro dashboard for **Bramble Investments** (deal diligence
and portfolio context) and **Bramble Intelligence** (client advisory). It shows
the latest market and macro data grouped by asset class, a one-line regime read,
and a **scenario engine** that turns today's signals into implications for each
side of the business.

Market data refreshes automatically on a schedule via GitHub Actions — no manual
steps. Open the Pages URL any time to see the current picture.

## How it works

```
scripts/fetch_data.mjs   → fetches live data, writes public/data.json
public/index.html        → reads data.json at load, renders the dashboard
.github/workflows/update.yml → runs the fetch on a schedule, commits data, deploys Pages
```

The fetcher is plain Node (18+), zero dependencies. The dashboard is a single
static HTML file. Everything degrades gracefully: any source that fails, or a
missing FRED key, produces an "awaiting feed" tile instead of breaking the page.

## Data sources

| Group | Metrics | Source | Key needed |
|---|---|---|---|
| Equities | FTSE 100, S&P 500, Tesco | Yahoo Finance (public) | No |
| Rates & FX | GBP/USD, US 10-yr (`^TNX`) | Yahoo Finance | No |
| Rates & FX | UK 10-yr gilt | FRED `IRLTLT01GBM156N` | Yes |
| Energy | Brent crude (`BZ=F`) | Yahoo Finance | No |
| Agriculture | Wheat, corn, soybeans, sugar, cocoa, coffee | Yahoo Finance | No |
| Macro | US consumer sentiment `UMCSENT`, US CPI `CPIAUCSL`, UK CPI `GBRCPIALLMINMEI`, Fed funds `DFF`, US unemployment `UNRATE` | FRED | Yes |
| No free feed | Urea (fertiliser), Global mfg PMI | — | Placeholder |

Market futures quote in US cents and are converted to the conventional unit
(e.g. wheat 605¢ → $6.05/bushel). Each tile also shows where today's value sits
in its trailing-year range (percentile).

> **Note on Stooq:** the original plan used Stooq's CSV feed, but it now serves an
> anti-bot challenge instead of data, so this project uses Yahoo Finance's public
> chart API for market data instead.

## Setup

### 1. GitHub Pages
The workflow enables Pages automatically (`configure-pages` with `enablement`).
If your org restricts that, enable it once by hand: **Settings → Pages → Build and
deployment → Source: GitHub Actions**.

### 2. FRED API key (for macro + consumer confidence)
Macro tiles stay greyed until a free FRED key is added as a repository secret.

1. Get a free key: <https://fred.stlouisfed.org/docs/api/api_key.html>
2. Add it as a secret named `FRED_API_KEY`, either:
   - **GitHub UI:** Settings → Secrets and variables → Actions → New repository secret, or
   - **CLI:** `gh secret set FRED_API_KEY` (paste the key when prompted)
3. Re-run the workflow (Actions tab → *Update data and deploy* → *Run workflow*).

## Changing the dashboard

- **Update cadence:** edit the `cron` lines in `.github/workflows/update.yml`.
  Times are UTC; GitHub may delay scheduled runs by a few minutes.
- **Add or change a metric:** edit the `METRICS` array in `scripts/fetch_data.mjs`.
  Add a Yahoo symbol or a FRED `series` id, set the unit, decimals and scale, and
  assign it to a group (`g-eq`, `g-rt`, `g-en`, `g-ag`, `g-mc`).
- **Scenario logic:** the thresholds that set each scenario's status live in
  `buildScenarios()` in the same file; the prose (analogues, implications) sits
  alongside them.

## Run locally

```bash
node scripts/fetch_data.mjs          # writes public/data.json (set FRED_API_KEY first for macro)
npx serve public                     # or any static server, then open the page
```

## Disclaimer

Scenario statuses are computed from live signal thresholds; the analogues and
implications are an analytical framework for discussion, **not investment advice
or a forecast**. Placeholder tiles are clearly marked and carry no data.
