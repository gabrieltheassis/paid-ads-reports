// Vercel serverless function: /api/budgets — monthly budgets shared by every panel.
//
//   GET  /api/budgets  → { main:{meta,google}, an:{meta}, clients:{projectId:amount}, storage:true|false }
//   POST /api/budgets  → saves the same shape (sent by the agency dashboard, /agency)
//
// Values live in an Upstash Redis database connected to this Vercel project
// (env vars KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
// Without the database, GET returns the defaults below and POST answers 503.
// If AGENCY_CODE is set on Vercel, saving also requires that code (header x-agency-code).

const DEFAULTS = { main: { meta: 60500, google: 5000 }, an: { meta: 17000 }, clients: {} };
const KEY = "paid-ads-reports:budgets";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function store() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}
async function redis(s, cmd) {
  const r = await fetch(s.url, { method: "POST", headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `Redis HTTP ${r.status}`);
  return j.result;
}

const amount = (v, d) => {
  if (v === "" || v == null) return d;
  const n = Number(v);
  return isFinite(n) && n >= 0 && n <= 10000000 ? Math.round(n * 100) / 100 : d;
};
function clean(v, base) {
  v = v && typeof v === "object" ? v : {};
  base = base || DEFAULTS;
  const out = {
    main: { meta: amount(v.main && v.main.meta, base.main.meta), google: amount(v.main && v.main.google, base.main.google) },
    an: { meta: amount(v.an && v.an.meta, base.an.meta) },
    clients: {}
  };
  const c = v.clients && typeof v.clients === "object" ? v.clients : base.clients || {};
  Object.keys(c).slice(0, 500).forEach((k) => { const n = amount(c[k], 0); if (/^\d+$/.test(k) && n > 0) out.clients[k] = n; });
  return out;
}
async function read(s) {
  if (!s) return clean(DEFAULTS);
  const raw = await redis(s, ["GET", KEY]);
  let v = null; try { v = raw ? JSON.parse(raw) : null; } catch (e) { v = null; }
  return clean(v || DEFAULTS);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const s = store();
  try {
    if (req.method === "GET") {
      const b = await read(s);
      res.status(200).json(Object.assign(b, { storage: !!s }));
      return;
    }
    if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); res.status(405).json({ error: "method_not_allowed" }); return; }
    const lock = process.env.AGENCY_CODE;
    if (lock && String(req.headers["x-agency-code"] || "") !== lock) { await sleep(500); res.status(401).json({ error: "agency_code_required" }); return; }
    if (!s) { res.status(503).json({ error: "storage_not_connected" }); return; }
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== "object") { res.status(400).json({ error: "invalid_body" }); return; }
    const cur = await read(s);
    const next = clean(body, cur);
    await redis(s, ["SET", KEY, JSON.stringify(next)]);
    res.status(200).json(Object.assign(next, { storage: true, saved: new Date().toISOString() }));
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
};
