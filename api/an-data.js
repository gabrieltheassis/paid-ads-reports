// Vercel serverless function: GET /api/an-data  —  panel "AN - Icon Motors Group" (/an)
// Separate from /api/data (the original Icon Motors panel): own ad accounts, Meta Ads only, no Google Ads.
// Reads month-to-date Meta Ads numbers for every location from the Reportei API.
// Returns spend, leads (messaging conversations), leads per day, spend per day and hourly activity.
// The API key lives ONLY in the Vercel environment variable REPORTEI_API_KEY (never in the page).

const API = "https://app.reportei.com/api/v1";
const TZ = "America/New_York";

// One entry per location: Reportei integration id (Meta Ads) + how it shows on the page.
// integration: Reportei Meta Ads integration id of THIS panel's ad account (null = not connected yet → shows 0).
const LOCATIONS = [
  { k: "Marlborough", name: "Marlborough", integration: 3824696 },
  { k: "Medford",     name: "Medford",     integration: 3824697 },
  { k: "Mitsubishi",  name: "Mitsubishi",  integration: 3824698 },
  { k: "Nissan",      name: "Nissan",      integration: 3824737 },
  { k: "Danbury",     name: "Danbury",     integration: 3824738 }
];

// Native Meta instant-form leads ("On-Facebook Leads Coming from Messenger and Instant Forms" in Reportei).
// Added to the WhatsApp/Messenger conversations so Leads = conversations + form leads.
const FORM_WIDGETS = [
  { id: "form_leads", reference_key: "fb_ads:actions_leadgen_grouped", component: "number_v1", metrics: ["actions:leadgen_grouped"] },
  { id: "form_leads_by_date", reference_key: "fb_ads:spend_by_date", component: "chart_v1", chart_type: "line",
    metrics: ["actions:leadgen_grouped"], dimensions: [{ field: "date_start" }] }
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
  if (!loc.integration) {
    return { k: loc.k, name: loc.name, spend: 0, spendPrev: 0, conv: 0, convPrev: 0, convMsg: 0, convForm: 0, formOk: false,
      days: p.dates.map(() => 0), leadsDays: p.dates.map(() => 0), hour: new Array(24).fill(0) };
  }
  const call = (widgets) => postWithRetry(`${API}/integrations/${loc.integration}/widgets/value`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ start: p.start, end: p.end, comparison_start: p.prevStart, comparison_end: p.prevEnd, widgets })
  }, loc.name).then((r) => r.json()).then((j) => j.data || {});
  let data, formOk = true;
  try { data = await call(WIDGETS.concat(FORM_WIDGETS)); }
  catch (e) { formOk = false; data = await call(WIDGETS); } // form metric rejected → keep the rest working
  const num = (v) => (v == null || v === "" ? 0 : Number(v));

  const byDate = data.by_date || {};
  const dayMap = {};
  (byDate.labels || []).forEach((lab, i) => { dayMap[lab] = num(((byDate.values || [])[0] || {}).data?.[i]); });

  const leadsByDate = data.leads_by_date || {};
  const leadMap = {};
  (leadsByDate.labels || []).forEach((lab, i) => { leadMap[lab] = num(((leadsByDate.values || [])[0] || {}).data?.[i]); });

  const formByDate = data.form_leads_by_date || {};
  const formMap = {};
  (formByDate.labels || []).forEach((lab, i) => { formMap[lab] = num(((formByDate.values || [])[0] || {}).data?.[i]); });
  const msg = num(data.leads?.values), msgPrev = num(data.leads?.comparison?.values);
  const form = num(data.form_leads?.values), formPrev = num(data.form_leads?.comparison?.values);

  const byHour = data.by_hour || {};
  const impressions = ((byHour.values || []).find((s) => s.name === "impressions") || {}).data || [];
  const hour = (byHour.labels || []).length === 24 ? impressions.map(num) : new Array(24).fill(1);

  return {
    k: loc.k,
    name: loc.name,
    spend: num(data.spend?.values),
    spendPrev: num(data.spend?.comparison?.values),
    conv: msg + form,
    convPrev: msgPrev + formPrev,
    convMsg: msg, convForm: form, formOk,
    days: p.dates.map((d) => dayMap[d] || 0),
    leadsDays: p.dates.map((d) => (leadMap[d] || 0) + (formMap[d] || 0)),
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
  // TEMP debug (to be removed): raw values of candidate lead metrics for one location.
  if (req.query && req.query.debugleads) {
    const loc = LOCATIONS.find((l) => l.k === req.query.debugleads) || LOCATIONS[4];
    const p = periodsFrom(req.query || {});
    const cands = [
      ["leadgen_grouped", "fb_ads:actions_leadgen_grouped", ["actions:leadgen_grouped"]],
      ["lead", "fb_ads:actions_lead", ["actions:lead"]],
      ["onsite_lead_grouped", "fb_ads:actions_onsite_conversion.lead_grouped", ["actions:onsite_conversion.lead_grouped"]],
      ["facebook_leads", "fb_ads:facebook_leads", ["facebook_leads"]],
      ["facebook_leads2", "fb_ads:facebook_leads", ["actions:leadgen_grouped"]]
    ];
    const out = {};
    for (const [id, rk, m] of cands) {
      try {
        const r = await fetch(`${API}/integrations/${loc.integration}/widgets/value`, { method: "POST",
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ start: p.start, end: p.end, widgets: [{ id, reference_key: rk, component: "number_v1", metrics: m }] }) });
        out[id] = { status: r.status, body: (await r.text()).slice(0, 400) };
      } catch (e) { out[id] = { error: String(e) }; }
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ loc: loc.name, out });
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
    const google = null; // this panel has no Google Ads
    // Cache on Vercel's edge for 5 min (keeps the page "live" without hammering the Reportei API).
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    const payload = {
      updated: new Date().toISOString(),
      start: p.start, end: p.end, prevStart: p.prevStart, prevEnd: p.prevEnd,
      dates: p.dates, locs, google,
      budget: 12000 // fixed monthly Meta Ads budget for this panel
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
