// Vercel serverless function: GET /api/agency  —  Agency dashboard (/agency)
// Separate from /api/data and /api/an-data (nothing shared, nothing changed there).
//
//   GET /api/agency?action=clients
//       → every Reportei project (client) with its Meta Ads and Google Ads accounts.
//   GET /api/agency?project=ID[&start=YYYY-MM-DD&end=YYYY-MM-DD&prevStart=…&prevEnd=…]
//       → that client's numbers for the period (month-to-date when no dates are given):
//         Meta Ads spend + leads (WhatsApp/Messenger conversations + instant-form leads), per day and per account,
//         Google Ads spend per account. Each period is compared with the previous one.
//
// The Reportei key lives ONLY in the Vercel env var REPORTEI_API_KEY.
// Optional extra lock: set AGENCY_CODE on Vercel → this API also asks for that code (header x-agency-code),
// so people who only have the CRM panels' code cannot open the agency data.

const API1 = "https://app.reportei.com/api/v1";
const API2 = "https://app.reportei.com/api/v2";
const TZ = "America/New_York";

const isMeta = (slug) => /facebook[_-]?ads|fb[_-]?ads|meta[_-]?ads/i.test(slug || "");
const isGoogle = (slug) => /google[_-]?ads|adwords/i.test(slug || "");
const activeInt = (i) => !i.status || /^(active|1|true)$/i.test(String(i.status));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v == null || v === "" || isNaN(Number(v)) ? 0 : Number(v));
const r2 = (n) => Math.round(n * 100) / 100;

// ---------- HTTP with retry (Reportei answers 429 to bursts) ----------
async function call(url, key, init, step) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, Object.assign({
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" }
    }, init || {}));
    if (r.status === 429 && attempt < 4) {
      const ra = Number(r.headers.get("retry-after"));
      await sleep(ra > 0 && ra < 20 ? ra * 1000 : 1200 * attempt);
      continue;
    }
    if (!r.ok) throw new Error(`${step}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
}
async function allPages(url, key, step) {
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const j = await call(url + (url.includes("?") ? "&" : "?") + "page=" + page, key, null, step);
    out.push(...(Array.isArray(j) ? j : j.data || []));
    const last = j.meta && Number(j.meta.last_page);
    if (!last || page >= last) break;
  }
  return out;
}

// ---------- Periods (same rules as the other panels) ----------
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const isISO = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
const addDays = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
function todayISO() {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function periodsFrom(q) {
  const t = todayISO();
  let start, end, prevStart, prevEnd;
  if (q && isISO(q.start) && isISO(q.end)) {
    start = q.start; end = q.end > t ? t : q.end;
    if (start > end) [start, end] = [end, start];
    if (diffDays(start, end) > 91) start = addDays(end, -91);
    const len = diffDays(start, end) + 1;
    if (isISO(q.prevStart) && isISO(q.prevEnd) && q.prevStart <= q.prevEnd) { prevStart = q.prevStart; prevEnd = q.prevEnd; }
    else { prevEnd = addDays(start, -1); prevStart = addDays(prevEnd, -(len - 1)); }
  } else {
    const y = +t.slice(0, 4), m = +t.slice(5, 7), d = +t.slice(8, 10);
    start = iso(y, m, 1); end = t;
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    prevStart = iso(py, pm, 1); prevEnd = iso(py, pm, Math.min(d, last));
  }
  const dates = [];
  for (let i = 0, n = diffDays(start, end); i <= n; i++) dates.push(addDays(start, i));
  return { start, end, prevStart, prevEnd, dates };
}

// ---------- Clients (Reportei projects) ----------
let clientsCache = null; // { at, data } while the instance is warm

async function listClients(key) {
  if (clientsCache && Date.now() - clientsCache.at < 10 * 60e3) return clientsCache.data;
  let projects = [];
  try { projects = await allPages(`${API2}/projects`, key, "projects"); } catch (e) { projects = []; }
  const ints = await allPages(`${API2}/integrations`, key, "integrations");
  const byId = new Map();
  projects.forEach((p) => byId.set(Number(p.id), {
    id: Number(p.id), name: String(p.name || p.title || p.company_name || ("Project " + p.id)).trim(), meta: [], google: [], other: 0
  }));
  ints.forEach((i) => {
    const pid = Number(i.project_id || (i.project && i.project.id));
    if (!pid) return;
    if (!byId.has(pid)) byId.set(pid, { id: pid, name: String((i.project && (i.project.name || i.project.title)) || ("Project " + pid)), meta: [], google: [], other: 0 });
    const c = byId.get(pid);
    if (!activeInt(i)) return;
    const acc = { id: Number(i.id), name: String(i.name || i.title || i.slug || i.id), slug: i.slug };
    if (isMeta(i.slug)) c.meta.push(acc); else if (isGoogle(i.slug)) c.google.push(acc); else c.other++;
  });
  const data = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  clientsCache = { at: Date.now(), data };
  return data;
}

async function projectAccounts(pid, key) {
  const cached = clientsCache && clientsCache.data.find((c) => c.id === pid);
  if (cached) return cached;
  const ints = await allPages(`${API2}/integrations?project_id=${pid}`, key, "integrations");
  const c = { id: pid, name: "Project " + pid, meta: [], google: [] };
  ints.forEach((i) => {
    if (Number(i.project_id) && Number(i.project_id) !== pid) return;
    if (!activeInt(i)) return;
    const acc = { id: Number(i.id), name: String(i.name || i.slug || i.id), slug: i.slug };
    if (isMeta(i.slug)) c.meta.push(acc); else if (isGoogle(i.slug)) c.google.push(acc);
  });
  return c;
}

// ---------- Meta Ads (Reportei v1 widgets, same metrics as the AN panel) ----------
const META_WIDGETS = [
  { id: "spend", reference_key: "fb_ads:spend", component: "number_v1", metrics: ["spend"] },
  { id: "msg", reference_key: "fb_ads:actions_onsite_conversion.messaging_conversation_started_7d", component: "number_v1",
    metrics: ["actions:onsite_conversion.messaging_conversation_started_7d"] },
  { id: "msg_by_date", reference_key: "fb_ads:spend_by_date", component: "chart_v1", chart_type: "line",
    metrics: ["actions:onsite_conversion.messaging_conversation_started_7d"], dimensions: [{ field: "date_start" }] },
  { id: "spend_by_date", reference_key: "fb_ads:spend_by_date", component: "chart_v1", chart_type: "line",
    metrics: ["spend"], dimensions: [{ field: "date_start" }] }
];
const FORM_WIDGETS = [
  { id: "form", reference_key: "fb_ads:actions_onsite_conversion.lead_grouped", component: "number_v1", metrics: ["actions:onsite_conversion.lead_grouped"] },
  { id: "form_by_date", reference_key: "fb_ads:spend_by_date", component: "chart_v1", chart_type: "line",
    metrics: ["actions:onsite_conversion.lead_grouped"], dimensions: [{ field: "date_start" }] }
];
function series(w, dates) {
  const map = {};
  ((w && w.labels) || []).forEach((lab, i) => { map[String(lab).slice(0, 10)] = num((((w.values || [])[0] || {}).data || [])[i]); });
  return dates.map((d) => map[d] || 0);
}
async function metaAccount(acc, p, key) {
  const body = (widgets) => JSON.stringify({ start: p.start, end: p.end, comparison_start: p.prevStart, comparison_end: p.prevEnd, widgets });
  const url = `${API1}/integrations/${acc.id}/widgets/value`;
  let d, formOk = true;
  try { d = (await call(url, key, { method: "POST", body: body(META_WIDGETS.concat(FORM_WIDGETS)) }, "Meta " + acc.name)).data || {}; }
  catch (e) { formOk = false; d = (await call(url, key, { method: "POST", body: body(META_WIDGETS) }, "Meta " + acc.name)).data || {}; }
  const msg = num(d.msg && d.msg.values), msgPrev = num(d.msg && d.msg.comparison && d.msg.comparison.values);
  const form = num(d.form && d.form.values), formPrev = num(d.form && d.form.comparison && d.form.comparison.values);
  const msgDays = series(d.msg_by_date, p.dates), formDays = series(d.form_by_date, p.dates);
  return {
    platform: "meta", id: acc.id, name: acc.name,
    spend: r2(num(d.spend && d.spend.values)), spendPrev: r2(num(d.spend && d.spend.comparison && d.spend.comparison.values)),
    leads: msg + form, leadsPrev: msgPrev + formPrev, msg, form, formOk,
    days: series(d.spend_by_date, p.dates).map(r2),
    leadsDays: msgDays.map((v, i) => v + formDays[i])
  };
}

// ---------- Google Ads (Reportei v2, total cost per account) ----------
const gMetricCache = {};
async function googleCostMetric(slug, key) {
  if (gMetricCache[slug]) return gMetricCache[slug];
  const list = await allPages(`${API2}/metrics?integration_slug=${encodeURIComponent(slug)}`, key, "metrics " + slug);
  const score = (m) => {
    const rk = String(m.reference_key || "").toLowerCase(), comp = String(m.component || "");
    if (!/^number/.test(comp)) return -1;
    if (/:(cost|spend|amount_spent|investment)$/.test(rk)) return 3;
    if (/:(metrics\.)?cost(_micros)?$/.test(rk)) return 2;
    if (/(cost|spend|invest)/.test(rk) && !/(per|cpc|cpm|cpa|cpl|conv|avg|average|_by_)/.test(rk)) return 1;
    return -1;
  };
  const best = list.map((m) => [score(m), m]).filter((x) => x[0] > 0).sort((a, b) => b[0] - a[0])[0];
  if (!best) throw new Error("Google Ads cost metric not found");
  return (gMetricCache[slug] = best[1]);
}
async function googleAccount(acc, p, key) {
  const m = await googleCostMetric(acc.slug, key);
  const j = await call(`${API2}/metrics/get-data`, key, {
    method: "POST",
    body: JSON.stringify({ start: p.start, end: p.end, comparison_start: p.prevStart, comparison_end: p.prevEnd, integration_id: acc.id,
      metrics: [{ id: m.id, reference_key: m.reference_key, component: m.component, metrics: m.metrics, type: m.type }] })
  }, "Google " + acc.name);
  const d = (j.data || {})[m.id] || Object.values(j.data || {})[0] || {};
  return { platform: "google", id: acc.id, name: acc.name, spend: r2(num(d.values)), spendPrev: r2(num(d.comparison && d.comparison.values)) };
}

async function clientData(pid, p, key) {
  const c = await projectAccounts(pid, key);
  const accounts = [], errors = [];
  for (const a of c.meta) {
    try { accounts.push(await metaAccount(a, p, key)); }
    catch (e) { errors.push({ platform: "meta", name: a.name, error: String(e.message || e).slice(0, 200) }); }
  }
  for (const a of c.google) {
    try { accounts.push(await googleAccount(a, p, key)); }
    catch (e) { errors.push({ platform: "google", name: a.name, error: String(e.message || e).slice(0, 200) }); }
  }
  const sum = (arr, k) => r2(arr.reduce((s, a) => s + (a[k] || 0), 0));
  const meta = accounts.filter((a) => a.platform === "meta"), google = accounts.filter((a) => a.platform === "google");
  const days = p.dates.map((_, i) => r2(meta.reduce((s, a) => s + (a.days[i] || 0), 0)));
  const leadsDays = p.dates.map((_, i) => meta.reduce((s, a) => s + (a.leadsDays[i] || 0), 0));
  return {
    id: pid, name: c.name, updated: new Date().toISOString(),
    start: p.start, end: p.end, prevStart: p.prevStart, prevEnd: p.prevEnd, dates: p.dates,
    metaSpend: sum(meta, "spend"), metaSpendPrev: sum(meta, "spendPrev"),
    googleSpend: sum(google, "spend"), googleSpendPrev: sum(google, "spendPrev"),
    leads: sum(meta, "leads"), leadsPrev: sum(meta, "leadsPrev"), msg: sum(meta, "msg"), form: sum(meta, "form"),
    days, leadsDays, accounts, errors,
    counts: { meta: c.meta.length, google: c.google.length }
  };
}

module.exports = async (req, res) => {
  const key = process.env.REPORTEI_API_KEY;
  if (!key) { res.status(500).json({ error: "REPORTEI_API_KEY is not set" }); return; }
  const lock = process.env.AGENCY_CODE;
  if (lock && String(req.headers["x-agency-code"] || "") !== lock) {
    await sleep(500);
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({ error: "agency_code_required" });
    return;
  }
  // Responses vary by the agency code header, so the edge cache never serves one person's answer to another.
  res.setHeader("Vary", "x-agency-code");
  const q = req.query || {};
  try {
    if (q.action === "clients") {
      const clients = await listClients(key);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.status(200).json({ clients, updated: new Date().toISOString() });
      return;
    }
    const pid = Number(q.project);
    if (!pid) { res.status(400).json({ error: "project is required" }); return; }
    const data = await clientData(pid, periodsFrom(q), key);
    res.setHeader("Cache-Control", "private, max-age=120");
    res.status(200).json(data);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};

module.exports.config = { maxDuration: 60 };
