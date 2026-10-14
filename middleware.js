// Vercel Routing Middleware: asks for an access code before showing the dashboard or its data.
// The code lives ONLY in the Vercel environment variable ACCESS_CODE (never in this repository).
// Ways in: the login screen, a link with ?code=XXXX (for the CRM menu), or the header x-access-code.

export const config = { matcher: "/:path*" };

const COOKIE = "pa_access";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

async function token(code) {
  const data = new TextEncoder().encode("paid-ads-reports:" + code);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function readCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(value) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=None; Partitioned`;
}
function next(extraHeaders) {
  const h = new Headers(extraHeaders || {});
  h.set("x-middleware-next", "1");
  return new Response(null, { headers: h });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function middleware(req) {
  const expected = process.env.ACCESS_CODE;
  if (!expected) return next(); // not configured yet → page stays open (set ACCESS_CODE on Vercel to lock it)

  const url = new URL(req.url);
  const good = await token(expected);

  // 1) Login form
  if (url.pathname === "/__login" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const code = String((form && form.get("code")) || "").trim();
    const back = String((form && form.get("back")) || "/");
    if (code === expected) {
      const dest = back.startsWith("/") && !back.startsWith("//") ? back : "/";
      return new Response(null, { status: 303, headers: { Location: dest, "Set-Cookie": setCookie(good), "Cache-Control": "no-store" } });
    }
    await sleep(600); // slows down guessing
    return loginPage(back, true, expected.length);
  }

  // 2) Already unlocked (cookie)
  if (readCookie(req, COOKIE) === good) return next();

  // 3) Code in the link (?code=) or header (used by the page inside the CRM, where cookies may be blocked)
  const given = url.searchParams.get("code") || req.headers.get("x-access-code");
  if (given) {
    if (given === expected) return next({ "Set-Cookie": setCookie(good) });
    await sleep(600);
  }

  // 4) Locked
  if (url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "access_code_required" }), { status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  return loginPage(url.pathname + url.search.replace(/([?&])code=[^&]*&?/, "$1").replace(/[?&]$/, ""), Boolean(given), expected.length);
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function loginPage(back, wrong, n) {
  n = Math.min(Math.max(n || 4, 4), 8);
  const boxes = Array.from({ length: n }, (_, i) => `<input${i ? "" : ' id="c1" autofocus'} inputmode="numeric" maxlength="1" aria-label="Digit ${i + 1}">`).join("\n    ");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paid Ads Performance · Access</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font-family:Inter,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#18181b;-webkit-font-smoothing:antialiased;display:flex;align-items:center;justify-content:center;padding:24px;
background:radial-gradient(900px 500px at 15% -10%,rgba(234,179,8,.12),transparent 60%),radial-gradient(700px 400px at 100% 0%,rgba(99,102,241,.07),transparent 60%),#f7f7f8}
.card{width:100%;max-width:380px;background:#fff;border:1px solid rgba(24,24,27,.08);border-radius:18px;box-shadow:0 1px 2px rgba(24,24,27,.04),0 20px 50px rgba(24,24,27,.08);padding:32px 28px 28px;text-align:center}
.logo{width:48px;height:48px;margin:0 auto 16px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(135deg,#facc15,#ca8a04);color:#111;font-weight:900;font-size:16px;box-shadow:0 6px 18px rgba(202,138,4,.25)}
.eyebrow{font-size:12px;font-weight:600;color:#71717a}
h1{font-size:21px;font-weight:700;letter-spacing:-.02em;margin:2px 0 6px}
p{font-size:13.5px;color:#71717a;margin:0 0 22px}
.code{display:flex;justify-content:center;gap:10px;margin-bottom:14px}
.code input{width:54px;height:62px;text-align:center;font:700 26px Inter,sans-serif;color:#09090b;border:1px solid rgba(24,24,27,.16);border-radius:12px;background:#fff;caret-color:#ca8a04}
.code input:focus{outline:0;border-color:rgba(202,138,4,.6);box-shadow:0 0 0 3px rgba(234,179,8,.15)}
.err .code input{border-color:#fca5a5;animation:shake .35s}
@keyframes shake{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.msg{font-size:12.5px;min-height:18px;margin:0 0 14px;color:#dc2626}
button{width:100%;border:0;border-radius:11px;padding:12px;font:600 14px Inter,sans-serif;color:#18181b;background:#eab308;cursor:pointer;box-shadow:0 6px 18px rgba(234,179,8,.25)}
button:hover{background:#facc15}
.foot{font-size:11.5px;color:#a1a1aa;margin-top:18px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style></head><body>
<form class="card${wrong ? " err" : ""}" method="post" action="/__login" id="f" autocomplete="off">
  <div class="logo">IM</div>
  <div class="eyebrow">Icon Motors Group</div>
  <h1>Paid Ads Performance</h1>
  <p>Enter the access code to view the dashboard.</p>
  <label class="sr" for="c1">Access code</label>
  <div class="code" id="boxes">
    ${boxes}
  </div>
  <input type="hidden" name="code" id="code"><input type="hidden" name="back" value="${esc(back || "/")}">
  <p class="msg" role="alert">${wrong ? "Wrong code. Try again." : ""}</p>
  <button type="submit">Enter</button>
  <div class="foot">You'll stay signed in on this device for 30 days.</div>
</form>
<script>
(function(){
  var f=document.getElementById("f"),b=[].slice.call(document.querySelectorAll("#boxes input")),h=document.getElementById("code");
  function val(){return b.map(function(i){return i.value}).join("")}
  b.forEach(function(i,k){
    i.addEventListener("input",function(){i.value=i.value.replace(/\\D/g,"").slice(-1);if(i.value&&k<b.length-1)b[k+1].focus();if(val().length===b.length){h.value=val();f.submit();}});
    i.addEventListener("keydown",function(e){if(e.key==="Backspace"&&!i.value&&k>0){b[k-1].focus();b[k-1].value="";}});
    i.addEventListener("paste",function(e){var t=(e.clipboardData||window.clipboardData).getData("text").replace(/\\D/g,"").slice(0,b.length);if(!t)return;e.preventDefault();t.split("").forEach(function(c,j){b[j].value=c});(b[t.length]||b[b.length-1]).focus();if(t.length===b.length){h.value=t;f.submit();}});
  });
  f.addEventListener("submit",function(){h.value=val()});
})();
</script></body></html>`;
  return new Response(html, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
