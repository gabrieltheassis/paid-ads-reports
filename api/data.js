// Vercel serverless function: GET /api/data
// Reads month-to-date Meta Ads numbers for every location from the Reportei API.
// Returns spend, leads (messaging conversations), leads per day, spend per day and hourly activity.
// The API key lives ONLY in the Vercel environment variable REPORTEI_API_KEY (never in the page).

const API = "https://app.reportei.com/api/v1";
const TZ = "America/New_York";

// One entry per location: Reportei integration id (Meta Ads) + how it shows on the page.
const LOCATIONS = [
  { k: "Marlborough", name: "Marlborough", integration: 3824099 },
  { k: "Medford",     name: "Medford",     integration: 3824934 },
  { k: "Mitsubishi",  name: "Mitsubishi",  integration: 3824969 },
  { k: "DougCar",     name: "Doug Car",    integration: 3824981 },
  { k: "Nissan",      name: "Nissan",      integration: 3824943 },
  { k: "Danbury",     name: "Danbury",     integration: 3824642 }
];

const WIDGETS = [
  { id: "spend", reference_key: "fb_ads:spend", component: "number_v1", metrics: ["spend"] },
  { id: "leads", reference_key: "fb_ads:actions_onsite_conversion.messaging_conversation_started_7d", component: "number_v1",
    metrics: ["actions:onsite_conversion.messaging_conversation_started_7d"] },
  { id: "leads_by_date", reference_key: "fb_ads:spend_by_date", component: "chart_v1", chart_type: "line",
    metrics: ["actions:onsite_conversion.messaging_conversation_started_7d"], dimensions: [{ field: "date_start" }] },
  { id: "by_date", reference_key: "fb_ads:spend_by_date", component: "chart_v1", chart_type: "line",
    metrics: ["spend"], dimensions: [{ field: "date_start" }] },
  { id: "by_hour", reference_key: "fb_ads:impressions_reach_by_hour", component: "chart_v1", chart_type: "bar",
    metrics: ["impressions", "reach"], dimensions: [{ field: "hourly_stats_aggregated_by_audience_time_zone" }] }
];

// ---------- Google Ads (total spend only, all locations) ----------
// Reportei project id per location. Every Google Ads account connected in these projects is summed
// automatically, so new accounts show up on the dashboard as soon as they are connected in Reportei.
const API2 = "https://app.reportei.com/api/v2";
const GOOGLE_PROJECTS = {
  Marlborough: 1341647, Medford: 1342532, Mitsubishi: 1342545,
  DougCar: 1342549, Nissan: 1342535, Danbury: 1342406
};
const isGoogleAds = (slug) => /google[_-]?ads|adwords/i.test(slug || "");
let googleMetricCache = {}; // slug -> metric definition (cost/spend number widget)

async function getJSON2(url, key, init, step) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, Object.assign({
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" }
    }, init || {}));
    if (r.status === 429 && attempt < 4) { await sleep(1200 * attempt); continue; }
    if (!r.ok) {
      const body = (await r.text()).slice(0, 300);
      throw new Error(`Google Ads ${step}: HTTP ${r.status} ${body}`);
    }
    return r.json();
  }
}

async function getAllPages(url, key, step) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const j = await getJSON2(url + (url.includes("?") ? "&" : "?") + "page=" + page, key, null, step);
    out.push(...(j.data || []));
    const last = j.meta && Number(j.meta.last_page);
    if (!last || page >= last) break;
  }
  return out;
}

async function googleIntegrations(key) {
  const out = [];
  for (const [k, pid] of Object.entries(GOOGLE_PROJECTS)) {
    const list = await getAllPages(`${API2}/integrations?project_id=${pid}`, key, "integrations");
    list.forEach((i) => {
      if (isGoogleAds(i.slug) && Number(i.project_id) === pid && (!i.status || /^(active|1|true)$/i.test(String(i.status))))
        out.push({ k, id: i.id, slug: i.slug, name: i.name });
    });
  }
  return out;
}

async function googleCostMetric(slug, key) {
  if (googleMetricCache[slug]) return googleMetricCache[slug];
  const list = await getAllPages(`${API2}/metrics?integration_slug=${encodeURIComponent(slug)}`, key, "metrics " + slug);
  const score = (m) => {
    const rk = String(m.reference_key || "").toLowerCase(), comp = String(m.component || "");
    if (!/^number/.test(comp)) return -1;
    if (/:(cost|spend|amount_spent|investment)$/.test(rk)) return 3;
    if (/:(metrics\.)?cost(_micros)?$/.test(rk)) return 2;
    if (/(cost|spend|invest)/.test(rk) && !/(per|cpc|cpm|cpa|cpl|conv|avg|average|_by_)/.test(rk)) return 1;
    return -1;
  };
  const best = list.map((m) => [score(m), m]).filter((x) => x[0] > 0).sort((a, b) => b[0] - a[0])[0];
  if (!best) throw new Error("Google Ads cost metric not found for " + slug);
  googleMetricCache[slug] = best[1];
  return best[1];
}

async function fetchGoogle(p, key) {
  const ints = await googleIntegrations(key);
  let spend = 0, spendPrev = 0;
  for (const i of ints) {
    const m = await googleCostMetric(i.slug, key);
    const j = await getJSON2(`${API2}/metrics/get-data`, key, {
      method: "POST",
      body: JSON.stringify({ start: p.start, end: p.end, comparison_start: p.prevStart, comparison_end: p.prevEnd,
        integration_id: i.id, metrics: [{ id: m.id, reference_key: m.reference_key, component: m.component, metrics: m.metrics, type: m.type }] })
    }, "get-data " + i.id + " " + m.reference_key);
    const d = (j.data || {})[m.id] || Object.values(j.data || {})[0] || {};
    spend += Number(d.values) || 0;
    spendPrev += Number(d.comparison && d.comparison.values) || 0;
  }
  return {
    spend: Math.round(spend * 100) / 100, spendPrev: Math.round(spendPrev * 100) / 100,
    accounts: ints.length, locations: [...new Set(ints.map((i) => i.k))]
  };
}

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function todayInTZ() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: +p.year, m: +p.month, d: +p.day };
}

const isISO = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const addDays = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

// Custom period from the query string (?start=YYYY-MM-DD&end=YYYY-MM-DD[&prevStart=…&prevEnd=…]).
// Falls back to month-to-date. Max 92 days per request.
function periodsFrom(q) {
  const t = todayInTZ(), todayIso = iso(t.y, t.m, t.d);
  if (!q || !isISO(q.start) || !isISO(q.end)) return periods();
  let start = q.start, end = q.end > todayIso ? todayIso : q.end;
  if (start > end) [start, end] = [end, start];
  if (diffDays(start, end) > 91) start = addDays(end, -91);
  const len = diffDays(start, end) + 1;
  let prevStart, prevEnd;
  if (isISO(q.prevStart) && isISO(q.prevEnd) && q.prevStart <= q.prevEnd) { prevStart = q.prevStart; prevEnd = q.prevEnd; }
  else { prevEnd = addDays(start, -1); prevStart = addDays(prevEnd, -(len - 1)); }
  const dates = [];
  for (let i = 0; i < len; i++) dates.push(addDays(start, i));
  return { start, end, prevStart, prevEnd, dates };
}

function periods() {
  const t = todayInTZ();
  const start = iso(t.y, t.m, 1), end = iso(t.y, t.m, t.d);
  const py = t.m === 1 ? t.y - 1 : t.y, pm = t.m === 1 ? 12 : t.m - 1;
  const lastDayPrev = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const prevStart = iso(py, pm, 1), prevEnd = iso(py, pm, Math.min(t.d, lastDayPrev));
  const dates = [];
  for (let d = 1; d <= t.d; d++) dates.push(iso(t.y, t.m, d));
  return { start, end, prevStart, prevEnd, dates };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reportei rejects bursts of parallel requests (HTTP 429), so locations are fetched one at a time,
// with a short retry when the API asks us to slow down.
async function postWithRetry(url, init, label) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, init);
    if (r.status !== 429 || attempt >= 4) {
      if (!r.ok) throw new Error(`Reportei ${label}: HTTP ${r.status}`);
      return r;
    }
    const ra = Number(r.headers.get("retry-after"));
    await sleep(ra > 0 && ra < 20 ? ra * 1000 : 1200 * attempt);
  }
}

async function fetchLocation(loc, p, key) {
  const r = await postWithRetry(`${API}/integrations/${loc.integration}/widgets/value`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ start: p.start, end: p.end, comparison_start: p.prevStart, comparison_end: p.prevEnd, widgets: WIDGETS })
  }, loc.name);
  const data = (await r.json()).data || {};
  const num = (v) => (v == null || v === "" ? 0 : Number(v));

  const byDate = data.by_date || {};
  const dayMap = {};
  (byDate.labels || []).forEach((lab, i) => { dayMap[lab] = num(((byDate.values || [])[0] || {}).data?.[i]); });

  const leadsByDate = data.leads_by_date || {};
  const leadMap = {};
  (leadsByDate.labels || []).forEach((lab, i) => { leadMap[lab] = num(((leadsByDate.values || [])[0] || {}).data?.[i]); });

  const byHour = data.by_hour || {};
  const impressions = ((byHour.values || []).find((s) => s.name === "impressions") || {}).data || [];
  const hour = (byHour.labels || []).length === 24 ? impressions.map(num) : new Array(24).fill(1);

  return {
    k: loc.k,
    name: loc.name,
    spend: num(data.spend?.values),
    spendPrev: num(data.spend?.comparison?.values),
    conv: num(data.leads?.values),
    convPrev: num(data.leads?.comparison?.values),
    days: p.dates.map((d) => dayMap[d] || 0),
    leadsDays: p.dates.map((d) => leadMap[d] || 0),
    hour
  };
}

// Last good answer per period, kept while this server instance is warm (used if Reportei is busy).
const lastGood = new Map();

module.exports = async (req, res) => {
  const key = process.env.REPORTEI_API_KEY;
  if (!key) {
    res.status(500).json({ error: "REPORTEI_API_KEY is not set" });
    return;
  }
  try {
    const p = periodsFrom(req.query || {});
    const cacheKey = [p.start, p.end, p.prevStart, p.prevEnd].join("|");
    let locs;
    try {
      locs = [];
      for (const l of LOCATIONS) locs.push(await fetchLocation(l, p, key));
    } catch (err) {
      const stale = lastGood.get(cacheKey);
      if (!stale) throw err;
      res.setHeader("Cache-Control", "s-maxage=30");
      res.status(200).json(Object.assign({}, stale, { stale: true }));
      return;
    }
    // Google Ads total: never blocks the Meta numbers if it fails.
    let google = null;
    try { google = await fetchGoogle(p, key); }
    catch (err) { google = { error: String(err.message || err) }; }
    // Cache on Vercel's edge for 5 min (keeps the page "live" without hammering the Reportei API).
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    const payload = {
      updated: new Date().toISOString(),
      start: p.start, end: p.end, prevStart: p.prevStart, prevEnd: p.prevEnd,
      dates: p.dates, locs, google,
      // Optional: monthly budget for everyone, set as MONTHLY_BUDGET on Vercel (e.g. 25000)
      budget: Number(process.env.MONTHLY_BUDGET) || null
    };
    lastGood.set(cacheKey, payload);
    if (lastGood.size > 30) lastGood.delete(lastGood.keys().next().value);
    res.status(200).json(payload);
  } catch (e) {
    // Short cache on errors so a busy API isn't hit again by every visitor.
    res.setHeader("Cache-Control", "s-maxage=20");
    res.status(502).json({ error: String(e.message || e) });
  }
};

// Allow time for one-at-a-time requests and retries.
module.exports.config = { maxDuration: 30 };
