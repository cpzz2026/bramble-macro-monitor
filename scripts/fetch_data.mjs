// Bramble Macro Monitor — data fetcher
//
// Pulls live market data (keyless, Yahoo Finance chart API) and macro data
// (FRED, free API key) and writes public/data.json, which the dashboard reads.
// Zero dependencies: Node 18+ native fetch. Every metric degrades gracefully —
// a source that fails or a FRED key that is absent produces an "awaiting feed"
// tile rather than a crash, so the site always renders.
//
// Run: node scripts/fetch_data.mjs   (set FRED_API_KEY in env for macro tiles)

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "public", "data.json");

const UA = "bramble-macro-monitor/1.0 (+https://github.com/ data fetcher)";
const FRED_KEY = process.env.FRED_API_KEY || "";

// ---- Metric definitions -----------------------------------------------------
// source: "yahoo" | "fred" | "pending"
// kind:   "price" | "yield" | "yoy" | "level"
// change: "pct" (percent move) | "bp" (basis points, for yields)
const METRICS = [
  // Equities & single names
  { key:"ftse",  group:"g-eq", name:"FTSE 100",   unit:"index",            source:"yahoo", symbol:"^FTSE",    kind:"price", change:"pct", scale:1,     dp:0, thousands:true },
  { key:"spx",   group:"g-eq", name:"S&P 500",    unit:"index",            source:"yahoo", symbol:"^GSPC",    kind:"price", change:"pct", scale:1,     dp:0, thousands:true },
  { key:"tesco", group:"g-eq", name:"Tesco",      unit:"pence · LSE",      source:"yahoo", symbol:"TSCO.L",   kind:"price", change:"pct", scale:1,     dp:1 },

  // Rates & currency
  { key:"gbp",   group:"g-rt", name:"GBP / USD",  unit:"$ per £",          source:"yahoo", symbol:"GBPUSD=X", kind:"price", change:"pct", scale:1,     dp:4 },
  { key:"us10y", group:"g-rt", name:"US 10-yr",   unit:"yield %",          source:"yahoo", symbol:"^TNX",     kind:"yield", change:"bp",  scale:1,     dp:2 },
  { key:"gilt",  group:"g-rt", name:"UK 10-yr gilt", unit:"yield % · monthly", source:"fred", series:"IRLTLT01GBM156N", kind:"yield", change:"bp", dp:2 },

  // Energy
  { key:"brent", group:"g-en", name:"Brent crude", unit:"$/bbl",           source:"yahoo", symbol:"BZ=F",     kind:"price", change:"pct", scale:1,     dp:2 },

  // Agriculture & soft commodities (CME futures quote in US cents)
  { key:"wheat", group:"g-ag", name:"Wheat",      unit:"$/bushel · CBOT",  source:"yahoo", symbol:"ZW=F",     kind:"price", change:"pct", scale:0.01,  dp:2 },
  { key:"corn",  group:"g-ag", name:"Corn",       unit:"$/bushel · CBOT",  source:"yahoo", symbol:"ZC=F",     kind:"price", change:"pct", scale:0.01,  dp:2 },
  { key:"soy",   group:"g-ag", name:"Soybeans",   unit:"$/bushel · CBOT",  source:"yahoo", symbol:"ZS=F",     kind:"price", change:"pct", scale:0.01,  dp:2 },
  { key:"sugar", group:"g-ag", name:"Sugar",      unit:"¢/lb · raw NY",    source:"yahoo", symbol:"SB=F",     kind:"price", change:"pct", scale:1,     dp:2 },
  { key:"cocoa", group:"g-ag", name:"Cocoa",      unit:"$/tonne · NY",     source:"yahoo", symbol:"CC=F",     kind:"price", change:"pct", scale:1,     dp:0, thousands:true },
  { key:"coffee",group:"g-ag", name:"Coffee",     unit:"$/lb · arabica",   source:"yahoo", symbol:"KC=F",     kind:"price", change:"pct", scale:0.01,  dp:2 },
  { key:"urea",  group:"g-ag", name:"Urea",       unit:"fertiliser",       source:"pending" },

  // Macro indicators (incl. consumer confidence) — FRED, free API key
  { key:"umcsent", group:"g-mc", name:"US consumer sentiment", unit:"UMich index", source:"fred", series:"UMCSENT",         kind:"level", change:"pct", dp:1 },
  { key:"uscpi",   group:"g-mc", name:"US CPI",                unit:"YoY %",        source:"fred", series:"CPIAUCSL",        kind:"yoy",   change:"bp",  dp:1 },
  { key:"ukcpi",   group:"g-mc", name:"UK CPI",                unit:"YoY %",        source:"fred", series:"GBRCPIALLMINMEI", kind:"yoy",   change:"bp",  dp:1 },
  { key:"fedfunds",group:"g-mc", name:"Fed funds rate",        unit:"% · effective",source:"fred", series:"DFF",             kind:"level", change:"bp",  dp:2 },
  { key:"unrate",  group:"g-mc", name:"US unemployment",       unit:"% rate",       source:"fred", series:"UNRATE",          kind:"level", change:"bp",  dp:1 },
  { key:"pmi",     group:"g-mc", name:"Global mfg PMI",        unit:"no free feed", source:"pending" },
];

// ---- Helpers ----------------------------------------------------------------
const FLAT_PCT = 0.05;   // |change%| below this reads as flat
const FLAT_BP  = 1;      // |change bp| below this reads as flat

function dirFrom(delta, mode) {
  const t = mode === "bp" ? FLAT_BP : FLAT_PCT;
  if (delta > t) return "up";
  if (delta < -t) return "down";
  return "flat";
}

function fmtVal(v, dp, thousands) {
  if (v == null || Number.isNaN(v)) return "—";
  if (thousands) return v.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return v.toFixed(dp);
}

function fmtChange(delta, mode) {
  if (delta == null || Number.isNaN(delta)) return "";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const a = Math.abs(delta);
  if (mode === "bp") {
    const bp = Math.round(a);
    return `${sign}${bp} bp`;
  }
  return `${sign}${a.toFixed(1)}%`;
}

function roundSpark(x) {
  if (x == null || Number.isNaN(x)) return null;
  return Number(x.toPrecision(5));
}

function percentile(series, value) {
  const xs = series.filter((x) => x != null && !Number.isNaN(x));
  if (xs.length < 5) return null;
  const below = xs.filter((x) => x <= value).length;
  return Math.round((below / xs.length) * 100);
}

function readLine(dir, pct, change, mode) {
  const moved = fmtChange(change, mode);
  let band = "";
  if (pct != null) {
    if (pct >= 85) band = `near 1-yr high · ${pct}th pct`;
    else if (pct <= 15) band = `near 1-yr low · ${pct}th pct`;
    else band = `mid-range · ${pct}th pct`;
  }
  const tone = dir === "up" ? "Firmer" : dir === "down" ? "Softer" : "Steady";
  return band ? `${tone} — ${band}` : `${tone}${moved ? " on the session" : ""}`;
}

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---- Yahoo Finance (keyless) ------------------------------------------------
async function fetchYahoo(m) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(m.symbol)}?range=1y&interval=1d`;
  const j = await getJSON(url);
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error("no result");
  const meta = res.meta;
  const rawCloses = (res.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
  const scale = m.scale ?? 1;
  const closes = rawCloses.map((x) => x * scale);
  const latest = (meta.regularMarketPrice ?? rawCloses[rawCloses.length - 1]) * scale;
  // previousClose is the PRIOR SESSION close; chartPreviousClose is the close before
  // the whole range (~1yr ago) and must not be used for a daily move.
  const prevRaw = meta.previousClose ?? rawCloses[rawCloses.length - 2] ?? rawCloses[rawCloses.length - 1];
  const prev = prevRaw * scale;

  let change;
  if (m.change === "bp") {
    change = (latest - prev) * 100;                                 // yield move in basis points
  } else if (Number.isFinite(meta.regularMarketChangePercent)) {
    change = meta.regularMarketChangePercent;                       // clean session % from Yahoo
  } else {
    change = prev ? ((latest - prev) / prev) * 100 : 0;
  }
  const dir = dirFrom(change, m.change);
  const spark = closes.slice(-24).map(roundSpark);
  const pct = percentile(closes.slice(-252), latest);

  return {
    key: m.key, n: m.name, u: m.unit,
    v: fmtVal(latest, m.dp, m.thousands),
    c: fmtChange(change, m.change),
    dir, s: spark, pct,
    r: readLine(dir, pct, change, m.change),
    raw: latest, chg: change,
  };
}

// ---- FRED (free API key) ----------------------------------------------------
async function fetchFred(m) {
  if (!FRED_KEY) return pendingTile(m, "Add FRED_API_KEY");
  const url = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${m.series}&api_key=${FRED_KEY}&file_type=json`
    + `&sort_order=desc&limit=400`;
  const j = await getJSON(url);
  const obs = (j.observations || [])
    .map((o) => ({ date: o.date, v: parseFloat(o.value) }))
    .filter((o) => !Number.isNaN(o.v))
    .reverse(); // oldest -> newest
  if (obs.length < 2) throw new Error("insufficient observations");

  let series = obs.map((o) => o.v);
  let latest, prev, label = m.unit;

  if (m.kind === "yoy") {
    // monthly index -> year-over-year percent, needs ~13 points
    const yoy = [];
    for (let i = 12; i < series.length; i++) {
      yoy.push(((series[i] - series[i - 12]) / series[i - 12]) * 100);
    }
    if (yoy.length < 2) throw new Error("insufficient history for YoY");
    series = yoy;
    latest = series[series.length - 1];
    prev = series[series.length - 2];
  } else {
    latest = series[series.length - 1];
    prev = series[series.length - 2];
  }

  let change;
  if (m.change === "bp") change = (latest - prev) * 100;
  else change = prev ? ((latest - prev) / prev) * 100 : 0;
  const dir = dirFrom(change, m.change);
  const spark = series.slice(-24).map(roundSpark);
  const pct = percentile(series.slice(-60), latest);
  const asOf = obs[obs.length - 1].date;

  return {
    key: m.key, n: m.name, u: label,
    v: fmtVal(latest, m.dp, m.thousands),
    c: fmtChange(change, m.change),
    dir, s: spark, pct,
    r: `As of ${asOf} · ${readLine(dir, pct, change, m.change).toLowerCase()}`,
    raw: latest, chg: change,
  };
}

function pendingTile(m, note) {
  return { key: m.key, n: m.name, u: m.unit, pending: true, note: note || "Awaiting feed", raw: null, chg: null };
}

// ---- Scenario engine --------------------------------------------------------
// Authored prose (framework); status pill + signal chips computed from live data.
function buildScenarios(by) {
  const val = (k) => (by[k] && by[k].raw != null ? by[k].raw : null);
  const chg = (k) => (by[k] && by[k].chg != null ? by[k].chg : null);
  const up = (k) => chg(k) != null && chg(k) > FLAT_PCT;
  const down = (k) => chg(k) != null && chg(k) < -FLAT_PCT;

  const brentHigh = val("brent") != null && val("brent") > 100;
  const ratesHigh = val("us10y") != null && val("us10y") > 4.0;
  const foodFirm = up("wheat") || up("sugar");
  const grainsEasing = down("corn") || down("soy") || down("coffee");
  const equitiesSteady =
    (chg("spx") == null || Math.abs(chg("spx")) < 1) &&
    (chg("ftse") == null || Math.abs(chg("ftse")) < 1);

  const sig = (k, label) => {
    const d = by[k] ? by[k].dir : "flat";
    const icon = d === "up" ? "▲" : d === "down" ? "▼" : "■";
    return { cls: d === "up" ? "u" : d === "down" ? "d" : "f", icon, text: label };
  };

  const energyActive = (up("brent") || brentHigh) && ratesHigh;
  const stagflationActive = ratesHigh && (up("brent") || foodFirm);
  const softActive = equitiesSteady && (grainsEasing || !up("brent"));
  const agriActive = grainsEasing;

  return [
    {
      id: "energy", name: "Higher-for-longer, energy-led",
      sub: "Sticky inflation keeps rates restrictive",
      status: energyActive ? "rising" : "emerging",
      statusLabel: energyActive ? "Risk rising" : "Contained",
      signals: [
        sig("brent", `Brent $${by.brent?.v ?? "—"}`),
        sig("us10y", `US 10-yr ${by.us10y?.v ?? "—"}%`),
        sig("wheat", "Wheat"),
        sig("sugar", "Sugar"),
      ],
      analogue: "2022–23 energy-driven inflation; partial echo of the 1973–74 oil shock.",
      inv: "Long-duration, pre-profit growth re-rates down. Diligence DCFs at a higher WACC, stress-test runway and burn, and favour cash-generative businesses with genuine pricing power. Energy, real assets and defensives are relatively insulated.",
      int: "Clients face input-cost pass-through and margin defence. Advise on pricing architecture, energy and freight hedging, and supply-chain resilience; watch demand elasticity for consumer-facing names.",
    },
    {
      id: "soft", name: "Soft landing, disinflation glide",
      sub: "Orderly growth with cooling goods prices",
      status: softActive ? "base" : "tail",
      statusLabel: softActive ? "Base case" : "Fragile",
      signals: [
        sig("spx", `S&P ${by.spx?.c ?? ""}`),
        sig("gbp", `GBP $${by.gbp?.v ?? "—"}`),
        sig("corn", "Corn"),
        sig("coffee", "Coffee"),
      ],
      analogue: "2024 disinflation; mid-1990s Fed soft landing.",
      inv: "Gradual rate relief supports multiples and reopens the window for growth rounds and exits. Re-engage deferred deals, normalise entry valuations, and lean back toward quality growth.",
      int: "Clients can plan around stabilising rates: capex, hiring and M&A pipelines unlock. Position advisory work around growth re-acceleration rather than pure cost defence.",
    },
    {
      id: "stag", name: "Stagflation squeeze",
      sub: "High rates meet weak demand",
      status: stagflationActive ? "tail" : "emerging",
      statusLabel: stagflationActive ? "Tail risk — watch" : "Low",
      signals: [
        sig("us10y", `US 10-yr ${by.us10y?.v ?? "—"}%`),
        sig("brent", "Energy firm"),
        sig("umcsent", "Confidence"),
      ],
      analogue: "1970s stagflation; UK 2011–12 commodity-and-austerity squeeze.",
      inv: "The worst regime for growth equity — high discount rates and soft demand together. Prioritise unit economics, defensive revenue and cost discipline; defer cash-hungry bets and extend runway assumptions.",
      int: "Clients need resilience planning: cost base, pricing power, working capital and demand scenarios. Lead with downside stress-testing and liquidity headroom.",
    },
    {
      id: "agri", name: "Agri-input relief",
      sub: "Grains ease off their peaks",
      status: agriActive ? "emerging" : "tail",
      statusLabel: agriActive ? "Emerging" : "Fading",
      signals: [
        sig("corn", "Corn"),
        sig("soy", "Soybeans"),
        sig("wheat", "Wheat"),
        sig("coffee", "Coffee"),
      ],
      analogue: "2023 fertiliser normalisation after the 2022 spike.",
      inv: "Margin tailwind for food producers, agritech and downstream food; a headwind for ag-input sellers. A lens for screening food and agri deals and for portfolio companies exposed to feedstock costs.",
      int: "Food, staples and agri clients see procurement relief. Revisit pricing held up during the spike and reset sourcing strategy while input costs soften.",
    },
  ];
}

// ---- Regime read ------------------------------------------------------------
function buildRegime(by) {
  const chg = (k) => (by[k] && by[k].chg != null ? by[k].chg : null);
  const val = (k) => (by[k] && by[k].raw != null ? by[k].raw : null);
  const up = (k) => chg(k) != null && chg(k) > FLAT_PCT;
  const down = (k) => chg(k) != null && chg(k) < -FLAT_PCT;

  const energyPhrase = up("brent") ? "firming" : down("brent") ? "easing" : "steady";
  const ratesHigh = val("us10y") != null && val("us10y") > 4.0;
  const equitiesHold =
    (chg("spx") == null || chg("spx") > -1) && (chg("ftse") == null || chg("ftse") > -1);
  const grainsSoft = down("corn") || down("soy");

  const read =
    `<strong>Energy-led inflation risk is ${energyPhrase} while equities ${equitiesHold ? "hold" : "slip"}.</strong> ` +
    `${val("brent") != null ? `Brent near $${by.brent.v}` : "Energy"} and ` +
    `${val("us10y") != null ? `US 10-yr around ${by.us10y.v}%` : "restrictive rates"} ` +
    `${ratesHigh ? "keep the higher-for-longer bias intact" : "leave room for easing"}, ` +
    `${grainsSoft ? "even as softening grains leave a disinflation glide path open" : "with food prices a swing factor"}. ` +
    `The base case is a soft landing; the live risk is an energy-and-food squeeze.`;

  const tag = (cond, a, b) => (cond ? a : b);
  const tags = [
    { label: "Rates bias", value: tag(ratesHigh, "Higher-for-longer", "Easing bias") },
    { label: "Inflation impulse", value: `Energy ${up("brent") ? "↑" : down("brent") ? "↓" : "→"} · Grains ${grainsSoft ? "↓" : "→"}` },
    { label: "Risk appetite", value: tag(equitiesHold, "Steady", "Risk-off") },
    { label: "Discount-rate view", value: tag(ratesHigh, "Elevated", "Normalising") },
  ];
  return { read, tags };
}

// ---- Main -------------------------------------------------------------------
async function run() {
  const results = [];
  for (const m of METRICS) {
    try {
      if (m.source === "pending") { results.push({ m, tile: pendingTile(m) }); continue; }
      const tile = m.source === "yahoo" ? await fetchYahoo(m) : await fetchFred(m);
      results.push({ m, tile });
      console.log(`ok   ${m.key.padEnd(9)} ${tile.pending ? "(pending)" : tile.v}`);
    } catch (e) {
      console.warn(`warn ${m.key.padEnd(9)} ${e.message} — greyed`);
      results.push({ m, tile: pendingTile(m, "Source unavailable") });
    }
  }

  const by = {};
  for (const { tile } of results) by[tile.key] = tile;

  const groups = {};
  const groupMeta = {
    "g-eq": "Equities",
    "g-rt": "Rates & currency",
    "g-en": "Energy",
    "g-ag": "Agriculture & soft commodities",
    "g-mc": "Macro indicators (incl. consumer confidence)",
  };
  for (const { m, tile } of results) {
    (groups[m.group] ||= []).push(stripInternal(tile));
  }

  const now = new Date();
  const data = {
    generatedAt: now.toISOString(),
    asOf: now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
    fredEnabled: Boolean(FRED_KEY),
    groupMeta,
    groups,
    regime: buildRegime(by),
    scenarios: buildScenarios(by),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`\nwrote ${OUT}`);
  console.log(`FRED ${data.fredEnabled ? "enabled" : "disabled (macro tiles greyed)"}`);
}

function stripInternal(tile) {
  const { raw, chg, ...rest } = tile;
  return rest;
}

run().catch((e) => { console.error("FATAL", e); process.exit(1); });
