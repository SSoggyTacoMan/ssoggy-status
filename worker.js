import { connect } from "cloudflare:sockets";

/**
 * ssoggy status — Cloudflare Worker
 *
 * Copy per service: TARGETS.about / TARGETS.note are the defaults.
 * Overrides live in KV and are edited at /admin (cookie session, ADMIN_KEY secret).
 *
 * GET  /             status page
 * GET  /api/status   JSON
 * GET  /admin        editor (login once)
 */

const TARGETS = [
  {
    id: "minecraft", name: "Minecraft", group: "Game", type: "mc", host: "mc.ssoggy.com", port: 25565,
    sub: "mc.ssoggy.com:25565",
    about: "Velocity proxy on the Oracle box, forwarding to the Nest container.",
  },

  { id: "taalswipe", name: "TaalSwipe", group: "Vercel", type: "http", url: "https://taalswipe.ssoggy.com/", about: "Vercel · production branch." },
  { id: "minimusiclab", name: "MiniMusicLab", group: "Vercel", type: "http", url: "https://minimusiclab.ssoggy.com/", about: "Vercel · static site." },
  { id: "sprig", name: "Sprig", group: "Vercel", type: "http", url: "https://sprig.ssoggy.com/", about: "Vercel · takes a couple of seconds on cold start." },
  { id: "excel-dash", name: "Excel Dash (preview)", group: "Vercel", type: "http", url: "https://excel-dash-preview.ssoggy.com/", about: "Vercel · preview build." },
  { id: "ssoggysouls", name: "SSoggySouls Docs", group: "Vercel", type: "http", url: "https://ssoggysouls.ssoggy.com/", about: "Jekyll docs, built by Vercel from the mod repo." },
  { id: "portfolio", name: "Portfolio", group: "Vercel", type: "http", url: "https://maarenaurich.com/", about: "Vercel · apex of maarenaurich.com." },
  { id: "vishandel", name: "Vishandel Volendam", group: "Vercel", type: "http", url: "https://vishandelvolendam.maarenaurich.com/", about: "Vercel · client site." },

  { id: "ai", name: "AI Chat", group: "Cloudflare Pages", type: "http", url: "https://ai.ssoggy.com/", about: "Cloudflare Pages · ai-chat-export." },
  { id: "oba", name: "Beleggers Academie", group: "Cloudflare Pages", type: "http", url: "https://oba.ssoggy.com/", about: "Cloudflare Pages · online-beleggers-academie." },
  { id: "cev", name: "CEV Dashboard", group: "Cloudflare Pages", type: "http", url: "https://cev.ssoggy.com/", about: "Cloudflare Pages · same project as OBA, different route." },

  { id: "ghpages", name: "GitHub Pages", group: "GitHub Pages", type: "http", url: "https://ssoggytacoblud.github.io/", about: "Static site served by GitHub Pages." },

  { id: "panel", name: "Pterodactyl Panel", group: "Nest VPS", type: "http", url: "https://panel.ssoggy.me/", okUpTo: 499, about: "Nest container, behind the hackclub reverse proxy." },
  { id: "router", name: "Router", group: "Nest VPS", type: "http", url: "https://router.ssoggy.me/", okUpTo: 499, about: "Nest container, port 20128." },
  {
    id: "chat", name: "OpenWebUI (chat)", group: "Nest VPS", type: "http", url: "https://chat.ssoggy.me/", okUpTo: 499,
    about: "OpenWebUI on the Nest container, port 3000.",
    note: "Returns 502 whenever the container restarts — the proxy is fine, the app isn't up yet.",
  },
  { id: "node", name: "Pterodactyl Node", group: "Nest VPS", type: "http", url: "https://node.ssoggy.me/", okUpTo: 499, about: "Wings daemon. 401 is expected — it means it's alive." },
];

const GROUPS = ["Game", "Vercel", "Cloudflare Pages", "GitHub Pages", "Nest VPS"];
const HISTORY = 90;
const HTTP_TIMEOUT = 7000;
const MC_TIMEOUT = 6000;
const KV_KEY = "state:v2";
const KV_KEY_OLD = "state:v1";
const COPY_KEY = "copy:v1";
const MAX_BODY = 20_000;
const COOKIE = "ssoggy_admin";

/* ------------------------------- crypto ------------------------------- */

async function sha256(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i < 0) return;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

async function sessionToken(env) {
  if (!env.ADMIN_KEY) return null;
  return sha256("session:" + env.ADMIN_KEY);
}

async function isAuthed(request, env) {
  const token = await sessionToken(env);
  if (!token) return false;
  const got = parseCookies(request.headers.get("cookie"))[COOKIE];
  return !!got && safeEqual(got, token);
}

/* ------------------------------- copy ------------------------------- */

async function readCopy(env) {
  if (!env.STATUS) return {};
  try {
    const c = await env.STATUS.get(COPY_KEY, "json");
    return c && typeof c === "object" ? c : {};
  } catch { return {}; }
}

function effective(t, copy) {
  const o = (copy && copy[t.id]) || {};
  return { ...t, about: o.about ?? t.about ?? null, note: o.note ?? t.note ?? null };
}

/* ------------------------------- checks ------------------------------- */

async function checkHttp(t) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT);
  try {
    const res = await fetch(t.url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal,
      headers: { "user-agent": "ssoggy-status/4.0 (+status.ssoggy.com)" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const ms = Date.now() - started;
    const limit = t.okUpTo ?? 399;
    const ok = res.status <= limit;
    return { ok, code: res.status, ms, note: ok ? null : "HTTP " + res.status };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, code: null, note: shortErr(e) };
  } finally {
    clearTimeout(timer);
  }
}

function shortErr(e) {
  const m = (e && e.message) || String(e);
  if (/abort/i.test(m)) return "timeout";
  if (/dns|not found|no such/i.test(m)) return "DNS error";
  if (/tls|ssl|certificate/i.test(m)) return "TLS error";
  if (/refused|reset/i.test(m)) return "connection refused";
  return m.slice(0, 60);
}

/* ---- Minecraft: minimal server-list handshake ---- */

function varint(n) {
  const out = [];
  while (true) {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) out.push(b | 0x80);
    else { out.push(b); break; }
  }
  return Uint8Array.from(out);
}
const enc = new TextEncoder();
function mcString(s) {
  const b = enc.encode(s);
  return join(varint(b.length), b);
}
function join(...parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function checkMinecraft(t) {
  const started = Date.now();
  let socket;
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), MC_TIMEOUT));
  try {
    const work = (async () => {
      socket = connect({ hostname: t.host, port: t.port });
      await socket.opened;
      const writer = socket.writable.getWriter();
      const port = new Uint8Array([(t.port >> 8) & 0xff, t.port & 0xff]);
      const body = join(varint(0x00), varint(767), mcString(t.host), port, varint(0x01));
      await writer.write(join(varint(body.length), body, Uint8Array.from([0x01, 0x00])));
      writer.releaseLock();

      const reader = socket.readable.getReader();
      let buf = new Uint8Array(0);
      const deadline = Date.now() + MC_TIMEOUT;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = join(buf, value);
        const parsed = parseMc(buf);
        if (parsed) {
          reader.releaseLock();
          try { socket.close(); } catch {}
          return { ok: true, ms: Date.now() - started, ...parsed };
        }
      }
      reader.releaseLock();
      try { socket.close(); } catch {}
      return { ok: true, ms: Date.now() - started, note: "TCP open" };
    })();
    return await Promise.race([work, timeout]);
  } catch (e) {
    try { socket && socket.close(); } catch {}
    return { ok: false, ms: Date.now() - started, note: shortErr(e) };
  }
}

function readVarint(buf, offset) {
  let value = 0, shift = 0, i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

function parseMc(buf) {
  const len = readVarint(buf, 0);
  if (!len) return null;
  if (buf.length < len.next + len.value) return null;
  const pid = readVarint(buf, len.next);
  if (!pid) return null;
  const jlen = readVarint(buf, pid.next);
  if (!jlen) return null;
  const start = jlen.next;
  if (start + jlen.value > buf.length) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(buf.slice(start, start + jlen.value))); } catch { return null; }
  return {
    players: data.players ? { online: data.players.online, max: data.players.max } : null,
    version: data.version?.name ?? null,
    motd: motdText(data.description),
  };
}

function motdText(d) {
  if (!d) return null;
  const strip = (s) => String(s).replace(/§[0-9a-fk-or]/gi, "");
  if (typeof d === "string") return strip(d);
  if (Array.isArray(d)) return strip(d.map((x) => (typeof x === "string" ? x : x.text || "")).join(""));
  return d.text ? strip(d.text) : null;
}

async function runAll(env) {
  const results = await Promise.all(TARGETS.map(async (t) => {
    const r = t.type === "mc" ? await checkMinecraft(t) : await checkHttp(t);
    return {
      id: t.id, t: Date.now(), ok: !!r.ok, ms: r.ms ?? null, code: r.code ?? null,
      note: r.note ?? null, players: r.players ?? null, version: r.version ?? null, motd: r.motd ?? null,
    };
  }));

  const state = await readState(env);
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  for (const r of results) {
    const prev = state[r.id] || { history: [], total: 0, up: 0 };
    const history = (prev.history || []).map(normBeat);
    history.push({ t: r.t, ok: r.ok, ms: r.ms });
    while (history.length > HISTORY) history.shift();
    state[r.id] = { history, total: (prev.total || 0) + 1, up: (prev.up || 0) + (r.ok ? 1 : 0), last: r };
  }
  state.updated = Date.now();
  if (env.STATUS) {
    try { await env.STATUS.put(KV_KEY, JSON.stringify(state)); } catch {}
  }
  return { results, byId };
}

function normBeat(b) {
  if (typeof b === "number") return { t: null, ok: b === 1, ms: null };
  return b || { t: null, ok: false, ms: null };
}

async function readState(env) {
  if (!env.STATUS) return {};
  try {
    const cur = await env.STATUS.get(KV_KEY, "json");
    if (cur && typeof cur === "object") return cur;
    const old = await env.STATUS.get(KV_KEY_OLD, "json");
    if (old && typeof old === "object") {
      const migrated = { updated: old.updated };
      for (const [k, v] of Object.entries(old)) {
        if (k === "updated") continue;
        migrated[k] = { history: (v.history || []).map(normBeat), total: v.total || 0, up: v.up || 0, last: v.last || null };
      }
      return migrated;
    }
    return {};
  } catch { return {}; }
}

/* ------------------------------- helpers ------------------------------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function uptimeOf(entry) {
  if (!entry) return null;
  const beats = (entry.history || []).filter((b) => b && typeof b.ok === "boolean");
  if (beats.length) return beats.filter((b) => b.ok).length / beats.length;
  const total = entry.total || 0;
  return total ? (entry.up || 0) / total : null;
}

function avgMs(entry) {
  const beats = (entry.history || []).filter((b) => b && b.ms != null && b.ms < 30000);
  if (!beats.length) return null;
  return beats.reduce((a, b) => a + b.ms, 0) / beats.length;
}

const fmtMs = (ms) => (ms == null ? "–" : ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s");
const fmtTime = (t) => (t ? new Date(t).toISOString().slice(11, 19) + " UTC" : "–");
const fmtAgo = (t) => {
  if (!t) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
};

function whyText(t, last) {
  if (!last) return "No check data yet — the next run fills this in.";
  if (last.ok) {
    if (t.type === "mc") {
      const p = last.players ? `${last.players.online}/${last.players.max} players` : "no player data";
      return `Accepting connections. ${p}${last.version ? ", " + last.version : ""}.`;
    }
    if (last.code && last.code >= 400) return `Responding (HTTP ${last.code}) — up, but the app wants auth or a different path.`;
    return `Responding normally${last.code ? ` (HTTP ${last.code})` : ""} in ${fmtMs(last.ms)}.`;
  }
  const note = last.note || "";
  if (t.type === "mc") {
    if (/timeout/i.test(note)) return "No answer to the Minecraft handshake within 6s — server down, or the proxy in front is broken.";
    if (/refused/i.test(note)) return "Connection refused — nothing is listening on that port.";
    if (/dns/i.test(note)) return "DNS lookup failed — the hostname doesn't resolve.";
    return `Minecraft check failed: ${note || "unknown error"}.`;
  }
  if (/^HTTP 5\d\d/.test(note)) return `${note} — Cloudflare reached the origin, but the app behind it is failing (crash, bad upstream, or TLS at the origin).`;
  if (/^HTTP 4\d\d/.test(note)) return `${note} — the server answered, but not with the page (wrong host, removed route, or auth wall).`;
  if (/timeout/i.test(note)) return "No response within 7s — the server is unreachable or hanging.";
  if (/dns/i.test(note)) return "DNS lookup failed — the hostname doesn't resolve.";
  if (/tls/i.test(note)) return "TLS handshake failed — certificate or SNI mismatch at the origin.";
  if (/refused/i.test(note)) return "Connection refused — nothing is listening on 443.";
  return `Request failed: ${note || "unknown error"}.`;
}

/* ------------------------------- styles ------------------------------- */

const CSS = `
:root{
  --bg:#fff; --fg:#14161a; --muted:#6b7078; --faint:#9ba1a9;
  --line:#e5e7ea; --line-2:#f1f2f5;
  --ok:#18984f; --bad:#cf312c; --warn:#a06a06; --empty:#e9ebee;
  --panel:#fafbfc; --radius:4px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0c0e11; --fg:#e8eaed; --muted:#8b9199; --faint:#5f656e;
    --line:#22262e; --line-2:#171a20;
    --ok:#34c46a; --bad:#ff625c; --warn:#d8a13a; --empty:#22262e;
    --panel:#101318;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 var(--sans);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:color-mix(in srgb,var(--ok) 25%,transparent)}
.wrap{max-width:800px;margin:0 auto;padding:34px 20px 48px}

.top{display:flex;align-items:center;gap:10px;padding-bottom:12px;margin-bottom:20px;border-bottom:1px solid var(--line)}
h1{font-size:13px;font-weight:600;margin:0;letter-spacing:.01em}
.meta{margin-left:auto;font:10.5px/1 var(--mono);color:var(--faint);letter-spacing:.02em}

.banner{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:550;
  padding:8px 11px;margin-bottom:24px;border:1px solid var(--line);border-left:2px solid;border-radius:var(--radius)}
.banner i{width:5px;height:5px;border-radius:50%;background:currentColor;flex:0 0 auto}
.banner.ok{color:var(--ok);border-left-color:var(--ok);background:color-mix(in srgb,var(--ok) 5%,transparent)}
.banner.partial{color:var(--warn);border-left-color:var(--warn);background:color-mix(in srgb,var(--warn) 6%,transparent)}
.banner.major{color:var(--bad);border-left-color:var(--bad);background:color-mix(in srgb,var(--bad) 6%,transparent)}
.banner .n{margin-left:auto;font:10.5px/1 var(--mono);opacity:.85}

.group{margin:0 0 22px}
.g-head{display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:0 1px}
.g-head h2{font:600 9.5px/1 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--faint);margin:0}
.g-head .rule{flex:1;height:1px;background:var(--line-2)}
.g-count{font:500 9.5px/1 var(--mono);color:var(--faint)}
.g-count.bad{color:var(--bad)}

.list{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--bg)}
.row{border-top:1px solid var(--line-2)}
.row:first-child{border-top:0}
.row>summary{display:grid;grid-template-columns:6px minmax(112px,1fr) minmax(0,2.3fr) 50px 54px 13px;
  gap:11px;align-items:center;padding:8px 12px;cursor:pointer;list-style:none;user-select:none}
.row>summary::-webkit-details-marker{display:none}
.row>summary::marker{content:""}
.row>summary:hover{background:var(--panel)}
.row>summary:focus-visible{outline:2px solid color-mix(in srgb,var(--ok) 45%,transparent);outline-offset:-2px}
.row[open]{background:var(--panel)}
.row[open]>summary{background:var(--panel)}
.state{width:5px;height:5px;border-radius:50%;background:var(--faint);justify-self:start}
.state.up{background:var(--ok)}
.state.down{background:var(--bad)}
.name{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.beats{display:flex;gap:1px;height:24px;align-items:stretch;min-width:0}
.beat{flex:1 1 0;min-width:1px;border-radius:1px;background:var(--empty)}
.beat.up{background:var(--ok);opacity:.7}
.beat.down{background:var(--bad);opacity:.9}
.beat.empty{opacity:.45}

.num{font:10.5px/1 var(--mono);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--muted)}
.num.ms{color:var(--faint)}
.chev{color:var(--faint);transition:transform .15s ease;justify-self:end}
.row[open] .chev{transform:rotate(90deg)}

.detail{display:grid;gap:4px;padding:3px 12px 12px 29px;border-top:1px solid var(--line-2)}
.drow{display:grid;grid-template-columns:52px 1fr;gap:10px;align-items:baseline}
.drow .k{font:9.5px/1.6 var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--faint)}
.drow .v{color:var(--muted);min-width:0;overflow-wrap:anywhere;font-size:11.5px}
.drow a{color:var(--fg);text-decoration:none;border-bottom:1px solid var(--line-2)}
.drow a:hover{border-color:var(--fg)}

.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;font-style:normal}

footer{margin-top:30px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
  font:10.5px/1.6 var(--mono);color:var(--faint)}
footer a{color:var(--faint);text-decoration:none;border-bottom:1px solid var(--line-2)}
footer a:hover{color:var(--muted)}

/* admin + login */
.login{max-width:300px;margin:12vh auto 0}
.login .field{margin:10px 0}
.field{display:grid;gap:5px}
.field>label,.flabel{font:9.5px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
input[type=password],textarea{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);
  border-radius:var(--radius);padding:7px 9px;font:12px/1.45 var(--mono);resize:vertical}
input[type=password]:focus,textarea:focus{outline:2px solid color-mix(in srgb,var(--ok) 35%,transparent);outline-offset:1px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--fg);color:var(--bg);
  border:0;border-radius:var(--radius);padding:8px 13px;font:600 11.5px/1 var(--sans);cursor:pointer;text-decoration:none}
.btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.btn:focus-visible{outline:2px solid color-mix(in srgb,var(--ok) 45%,transparent);outline-offset:2px}
.svc{border:1px solid var(--line);border-radius:var(--radius);padding:11px 12px}
.svc+.svc{margin-top:10px}
.svc-h{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}
.svc-h strong{font-size:12.5px;font-weight:600}
.svc-h .id{font:10px/1 var(--mono);color:var(--faint)}
.svc-h .state-tag{margin-left:auto;font:9.5px/1 var(--mono);color:var(--faint)}
.check{display:flex;align-items:center;gap:6px;font:10.5px/1 var(--mono);color:var(--faint);margin-top:7px}
.err{color:var(--bad)}
.mt{margin-top:8px}
footer.sp{margin-top:26px}
.note-ok{color:var(--ok);font:10.5px/1 var(--mono)}
.actions{display:flex;gap:9px;margin-top:16px;align-items:center}

@media (max-width:640px){
  .row>summary{grid-template-columns:6px 1fr 42px 13px;grid-template-areas:"s n u c" ". b b b";gap:6px 10px;padding:9px 11px}
  .state{grid-area:s}.name{grid-area:n}.num.up{grid-area:u}.chev{grid-area:c}
  .beats{grid-area:b;height:20px}.num.ms{display:none}
  .detail{padding-left:12px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const CHEVRON = `<svg class="chev" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`;

/* ------------------------------- render ------------------------------- */

function beatBars(entry) {
  const beats = (entry?.history || []).map(normBeat).slice(-HISTORY);
  const pad = Math.max(0, HISTORY - beats.length);
  const cells = [];
  for (let i = 0; i < pad; i++) cells.push('<i class="beat empty"></i>');
  for (const b of beats) {
    const cls = b.ok ? "up" : "down";
    const label = `${b.ok ? "Up" : "Down"} · ${fmtTime(b.t)}${b.ms != null ? " · " + fmtMs(b.ms) : ""}`;
    cells.push(`<i class="beat ${cls}" title="${esc(label)}"></i>`);
  }
  return cells.join("");
}

function rowHtml(t, live, entry) {
  const last = live || entry?.last || null;
  const state = last ? (last.ok ? "up" : "down") : "unknown";
  const up = uptimeOf(entry);
  const avg = avgMs(entry);
  const beats = (entry?.history || []).map(normBeat);
  const failed = beats.filter((b) => !b.ok).length;

  const link = t.url
    ? `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>`
    : `<span>${esc(t.sub || t.host)}</span>`;

  return `
      <details class="row" data-id="${esc(t.id)}">
        <summary>
          <span class="state ${state}" aria-hidden="true"></span>
          <span class="name">${esc(t.name)}<em class="sr"> — ${state}</em></span>
          <span class="beats">${beatBars(entry)}</span>
          <span class="num up">${up != null ? (up * 100).toFixed(up >= 0.995 ? 1 : 2) + "%" : "–"}</span>
          <span class="num ms">${avg != null ? fmtMs(avg) : "–"}</span>
          ${CHEVRON}
        </summary>
        <div class="detail">
          <div class="drow"><span class="k">host</span><span class="v">${link}</span></div>
          <div class="drow"><span class="k">status</span><span class="v" data-f="p-status">${state}${last?.code ? " · HTTP " + last.code : ""}</span></div>
          <div class="drow"><span class="k">why</span><span class="v" data-f="p-why">${esc(whyText(t, last))}</span></div>
          ${t.about ? `<div class="drow"><span class="k">about</span><span class="v">${esc(t.about)}</span></div>` : ""}
          ${t.note ? `<div class="drow"><span class="k">note</span><span class="v">${esc(t.note)}</span></div>` : ""}
          <div class="drow"><span class="k">fresh</span><span class="v" data-f="p-last">${last?.t ? fmtAgo(last.t) + " · " + fmtTime(last.t) : "never"}</span></div>
          <div class="drow"><span class="k">sample</span><span class="v">${beats.length ? `${beats.length} checks · ${failed} failed` : "no history yet"}</span></div>
        </div>
      </details>`;
}

function groupBlock(group, rows) {
  const items = rows.filter((r) => r.t.group === group);
  if (!items.length) return "";
  const down = items.filter((r) => r.state === "down").length;
  return `
    <section class="group">
      <div class="g-head">
        <h2>${esc(group)}</h2>
        <span class="rule"></span>
        <span class="g-count ${down ? "bad" : ""}">${items.length - down}/${items.length}</span>
      </div>
      <div class="list">${items.map((r) => rowHtml(r.t, r.live, r.entry)).join("")}</div>
    </section>`;
}

function bannerState(rows) {
  const down = rows.filter((r) => r.state === "down").length;
  if (!down) return { cls: "ok", text: "All systems operational" };
  return (down / rows.length) >= 0.5
    ? { cls: "major", text: "Major outage" }
    : { cls: "partial", text: "Partially degraded" };
}

function renderPage(state, live, copy, nonce) {
  const targets = TARGETS.map((t) => effective(t, copy));
  const rows = targets.map((t) => {
    const entry = state[t.id] || null;
    const last = live ? live[t.id] : entry?.last || null;
    return { t, entry, live: last, state: last ? (last.ok ? "up" : "down") : "unknown" };
  });
  const b = bannerState(rows);
  const updated = state.updated || null;
  const total = rows.length;
  const down = rows.filter((r) => r.state === "down").length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ssoggy status</title>
<meta name="color-scheme" content="light dark">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>ssoggy status</h1>
    <span class="meta" id="updated">${updated ? updated.toISOString().slice(11, 19) + " UTC" : "checking"}</span>
  </div>

  <div class="banner ${b.cls}" id="banner">
    <i aria-hidden="true"></i>
    <span id="banner-text">${b.text}</span>
    <span class="n" id="banner-count">${total - down}/${total}</span>
  </div>

  <main id="main">${GROUPS.map((g) => groupBlock(g, rows)).join("")}</main>

  <footer>
    <span>90 samples · 60s · click a row</span>
    <span><a href="/api/status">json</a></span>
  </footer>
</div>
<script nonce="${nonce}">
const MS = (ms) => ms == null ? "–" : ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s";
const T = (t) => t ? new Date(t).toISOString().slice(11, 19) + " UTC" : "–";
function ago(t){ if(!t) return "never"; const s = Math.max(0, Math.round((Date.now()-t)/1000));
  return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s/60) + "m ago" : Math.round(s/3600) + "h ago"; }
function why(t){
  const st = t.status, note = t.error || "";
  if (!t.lastChecked) return "No check data yet — the next run fills this in.";
  if (st === "up") {
    if (t.type === "mc") {
      const p = t.players ? t.players.online + "/" + t.players.max + " players" : "no player data";
      return "Accepting connections. " + p + (t.version ? ", " + t.version : "") + ".";
    }
    if (t.code && t.code >= 400) return "Responding (HTTP " + t.code + ") — up, but the app wants auth or a different path.";
    return "Responding normally" + (t.code ? " (HTTP " + t.code + ")" : "") + " in " + MS(t.ms) + ".";
  }
  if (t.type === "mc") {
    if (/timeout/i.test(note)) return "No answer to the Minecraft handshake within 6s — server down, or the proxy in front is broken.";
    if (/refused/i.test(note)) return "Connection refused — nothing is listening on that port.";
    if (/dns/i.test(note)) return "DNS lookup failed — the hostname doesn't resolve.";
    return "Minecraft check failed: " + (note || "unknown error") + ".";
  }
  if (/^HTTP 5\\d\\d/.test(note)) return note + " — Cloudflare reached the origin, but the app behind it is failing (crash, bad upstream, or TLS at the origin).";
  if (/^HTTP 4\\d\\d/.test(note)) return note + " — the server answered, but not with the page (wrong host, removed route, or auth wall).";
  if (/timeout/i.test(note)) return "No response within 7s — the server is unreachable or hanging.";
  if (/dns/i.test(note)) return "DNS lookup failed — the hostname doesn't resolve.";
  if (/tls/i.test(note)) return "TLS handshake failed — certificate or SNI mismatch at the origin.";
  if (/refused/i.test(note)) return "Connection refused — nothing is listening on 443.";
  return "Request failed: " + (note || "unknown error") + ".";
}
function beats(history){
  const b = (history || []).slice(-90), pad = Math.max(0, 90 - b.length);
  let html = "";
  for (let i = 0; i < pad; i++) html += '<i class="beat empty"></i>';
  for (const x of b){
    const ok = typeof x === "number" ? x === 1 : !!x.ok;
    const ms = x && x.ms != null ? " · " + MS(x.ms) : "";
    const tt = x && x.t ? T(x.t) : "–";
    html += '<i class="beat ' + (ok ? "up" : "down") + '" title="' + (ok ? "Up" : "Down") + " · " + tt + ms + '"></i>';
  }
  return html;
}
async function refresh(){
  try{
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const byId = Object.fromEntries(data.targets.map(t => [t.id, t]));
    let down = 0;
    document.querySelectorAll(".row").forEach((row) => {
      const t = byId[row.dataset.id];
      if (!t) return;
      if (t.status === "down") down++;
      row.querySelector(".state").className = "state " + t.status;
      const sr = row.querySelector(".name .sr");
      if (sr) sr.textContent = " — " + t.status;
      row.querySelector(".beats").innerHTML = beats(t.history);
      row.querySelector(".num.up").textContent = t.uptime != null ? (t.uptime*100).toFixed(t.uptime >= 0.995 ? 1 : 2) + "%" : "–";
      row.querySelector(".num.ms").textContent = t.avgMs != null ? MS(t.avgMs) : "–";
      const ps = row.querySelector('[data-f="p-status"]');
      if (ps) ps.textContent = t.status + (t.code ? " · HTTP " + t.code : "");
      const pw = row.querySelector('[data-f="p-why"]');
      if (pw) pw.textContent = why(t);
      const pl = row.querySelector('[data-f="p-last"]');
      if (pl) pl.textContent = t.lastChecked ? ago(t.lastChecked) + " · " + T(t.lastChecked) : "never";
    });
    document.querySelectorAll(".group").forEach((sec) => {
      const rows = sec.querySelectorAll(".row");
      const bad = Array.from(rows).filter(r => r.querySelector(".state").classList.contains("down")).length;
      const cnt = sec.querySelector(".g-count");
      if (cnt){ cnt.textContent = (rows.length - bad) + "/" + rows.length; cnt.className = "g-count" + (bad ? " bad" : ""); }
    });
    const total = data.targets.length;
    const cls = down === 0 ? "ok" : down / total >= 0.5 ? "major" : "partial";
    const banner = document.getElementById("banner");
    banner.className = "banner " + cls;
    document.getElementById("banner-text").textContent =
      cls === "ok" ? "All systems operational" : cls === "major" ? "Major outage" : "Partially degraded";
    document.getElementById("banner-count").textContent = (total - down) + "/" + total;
    document.getElementById("updated").textContent = T(data.updated);
  }catch(e){}
}
setInterval(refresh, 30000);
</script>
</body>
</html>`;
}

function renderLogin(nonce, error) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ssoggy status · sign in</title>
<meta name="color-scheme" content="light dark">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="login">
    <div class="top"><h1>ssoggy status</h1><span class="meta">admin</span></div>
    <form method="post" action="/admin">
      <div class="field">
        <label for="key">admin key</label>
        <input id="key" name="key" type="password" autocomplete="current-password" autofocus>
      </div>
      ${error ? '<div class="check err">wrong key</div>' : ""}
      <div class="actions"><button class="btn" type="submit">sign in</button></div>
    </form>
    <footer class="sp"><span>&nbsp;</span><span><a href="/">status</a></span></footer>
  </div>
</div>
</body>
</html>`;
}

function renderAdmin(copy, nonce, saved) {
  const groups = GROUPS.map((g) => {
    const items = TARGETS.filter((t) => t.group === g);
    return `
      <section class="group">
        <div class="g-head"><h2>${esc(g)}</h2><span class="rule"></span></div>
        ${items.map((t) => {
          const o = copy[t.id] || {};
          return `
          <div class="svc">
            <div class="svc-h">
              <strong>${esc(t.name)}</strong><span class="id">${esc(t.id)}</span>
              <span class="state-tag">${o.about != null || o.note != null ? "overridden" : "default"}</span>
            </div>
            <div class="field">
              <label for="about-${esc(t.id)}">about</label>
              <textarea id="about-${esc(t.id)}" name="about_${esc(t.id)}" rows="2" placeholder="${esc(t.about || "")}">${esc(o.about ?? "")}</textarea>
            </div>
            <div class="field mt">
              <label for="note-${esc(t.id)}">note</label>
              <textarea id="note-${esc(t.id)}" name="note_${esc(t.id)}" rows="2" placeholder="${esc(t.note || "")}">${esc(o.note ?? "")}</textarea>
            </div>
            <label class="check"><input type="checkbox" name="reset_${esc(t.id)}" value="1"> reset to default</label>
          </div>`;
        }).join("")}
      </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ssoggy status · copy</title>
<meta name="color-scheme" content="light dark">
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>copy editor</h1>
    <span class="meta">${saved ? '<span class="note-ok">saved</span>' : "blank = default"}</span>
  </div>
  <form method="post" action="/admin/save">
    ${groups}
    <div class="actions">
      <button class="btn" type="submit">save</button>
      <a class="btn ghost" href="/">status page</a>
    </div>
  </form>
  <form method="post" action="/admin/logout" class="mt">
    <button class="btn ghost" type="submit">sign out</button>
  </form>
  <footer><span>overrides · kv</span><span><a href="/">status</a></span></footer>
</div>
</body>
</html>`;
}

function jsonPayload(state, live, copy) {
  return {
    updated: state.updated || Date.now(),
    targets: TARGETS.map((t0) => {
      const t = effective(t0, copy);
      const entry = state[t.id] || null;
      const last = (live && live[t.id]) || entry?.last || null;
      return {
        id: t.id, name: t.name, group: t.group, type: t.type,
        url: t.url || `${t.host}:${t.port}`,
        about: t.about ?? null, note: t.note ?? null,
        status: last ? (last.ok ? "up" : "down") : "unknown",
        ms: last?.ms ?? null, code: last?.code ?? null, error: last?.note ?? null,
        players: last?.players ?? null, version: last?.version ?? null,
        lastChecked: last?.t ?? null,
        uptime: uptimeOf(entry), avgMs: avgMs(entry),
        history: (entry?.history || []).map(normBeat),
      };
    }),
  };
}

/* ------------------------------- worker ------------------------------- */

function nonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
}

function headers(n, maxAge) {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    "content-security-policy":
      `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}'; img-src data:; ` +
      `connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "x-robots-tag": "noindex",
  };
}

function html(body, n, maxAge) {
  return new Response(body, { headers: headers(n, maxAge) });
}

function notFound() {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // curl / same-origin form posts without Origin are allowed
  try { return new URL(origin).host === url.host; } catch { return false; }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    /* ---- admin ---- */
    if (path.startsWith("/admin")) {
      const authed = await isAuthed(request, env);

      if (path === "/admin" && method === "POST") {
        if (!env.ADMIN_KEY) return notFound();
        const len = Number(request.headers.get("content-length") || "0");
        if (len > MAX_BODY) return new Response("Too large", { status: 413 });
        const body = await request.text();
        if (body.length > MAX_BODY) return new Response("Too large", { status: 413 });
        const key = (new URLSearchParams(body).get("key") || "").trim();
        const [a, b] = await Promise.all([sha256(key), sha256(env.ADMIN_KEY)]);
        if (!safeEqual(a, b)) {
          const n1 = nonce();
          return html(renderLogin(n1, true), n1, 0);
        }
        const token = await sessionToken(env);
        const n = nonce();
        return new Response(renderAdmin(await readCopy(env), n, false), {
          status: 303,
          headers: {
            ...headers(n, 0),
            location: "/admin",
            "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
          },
        });
      }

      if (path === "/admin/logout" && method === "POST") {
        return new Response(null, {
          status: 303,
          headers: { location: "/", "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` },
        });
      }

      if (path === "/admin/save" && method === "POST") {
        if (!authed) return notFound();
        if (!sameOrigin(request, url)) return new Response("Bad origin", { status: 403 });
        const len = Number(request.headers.get("content-length") || "0");
        if (len > MAX_BODY) return new Response("Too large", { status: 413 });
        const body = await request.text();
        if (body.length > MAX_BODY) return new Response("Too large", { status: 413 });

        const form = new URLSearchParams(body);
        const copy = await readCopy(env);
        for (const t of TARGETS) {
          if (form.get("reset_" + t.id)) { delete copy[t.id]; continue; }
          const about = (form.get("about_" + t.id) || "").trim();
          const note = (form.get("note_" + t.id) || "").trim();
          const entry = {};
          if (about) entry.about = about.slice(0, 500);
          if (note) entry.note = note.slice(0, 500);
          if (Object.keys(entry).length) copy[t.id] = entry;
          else delete copy[t.id];
        }
        if (env.STATUS) await env.STATUS.put(COPY_KEY, JSON.stringify(copy));
        return new Response(null, { status: 303, headers: { location: "/admin?saved=1" } });
      }

      if (path === "/admin" && method === "GET") {
        if (!authed) { const n2 = nonce(); return html(renderLogin(n2, false), n2, 0); }
        const n3 = nonce();
        return html(renderAdmin(await readCopy(env), n3, url.searchParams.get("saved") === "1"), n3, 0);
      }

      return notFound();
    }

    /* ---- api ---- */
    if (path === "/api/status") {
      if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      const state = await readState(env);
      const copy = await readCopy(env);
      let live = null, fresh = state;
      if (!state.updated || Date.now() - state.updated > 90_000) {
        const run = await runAll(env);
        live = run.byId;
        fresh = await readState(env);
      }
      return json(jsonPayload(fresh, live, copy));
    }

    if (path === "/api/check") {
      if (!(await isAuthed(request, env))) return notFound();
      if (method !== "POST") return new Response("Method not allowed", { status: 405 });
      const run = await runAll(env);
      return json({ checked: run.results.length, at: Date.now() });
    }

    /* ---- page ---- */
    if (path !== "/" && path !== "/index.html") return notFound();
    if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    let state = await readState(env);
    let live = null;
    if (!state.updated || Date.now() - state.updated > 90_000) {
      const run = await runAll(env);
      live = run.byId;
      state = await readState(env);
    }
    const copy = await readCopy(env);
    const n = nonce();
    return html(renderPage(state, live, copy, n), n, 20);
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}
