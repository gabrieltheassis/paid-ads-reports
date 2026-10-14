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

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function todayInTZ() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: +p.year, m: +p.month, d: +p.day };
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

async function fetchLocation(loc, p, key) {
  const r = await fetch(`${API}/integrations/${loc.integration}/widgets/value`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ start: p.start, end: p.end, comparison_start: p.prevStart, comparison_end: p.prevEnd, widgets: WIDGETS })
  });
  if (!r.ok) throw new Error(`Reportei ${loc.name}: HTTP ${r.status}`);
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

module.exports = async (req, res) => {
  const key = process.env.REPORTEI_API_KEY;
  if (!key) {
    res.status(500).json({ error: "REPORTEI_API_KEY is not set" });
    return;
  }
  try {
    const p = periods();
    const locs = await Promise.all(LOCATIONS.map((l) => fetchLocation(l, p, key)));
    // Cache on Vercel's edge for 5 min (keeps the page "live" without hammering the Reportei API).
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({
      updated: new Date().toISOString(),
      start: p.start, end: p.end, prevStart: p.prevStart, prevEnd: p.prevEnd,
      dates: p.dates, locs,
      // Optional: monthly budget for everyone, set as MONTHLY_BUDGET on Vercel (e.g. 25000)
      budget: Number(process.env.MONTHLY_BUDGET) || null
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};
