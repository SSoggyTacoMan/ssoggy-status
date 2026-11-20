import { connect } from "cloudflare:sockets";

/**
 * ssoggy status — Cloudflare Worker
 *
 * Public:  GET /            status page
 *          GET /api/status  JSON
 * Admin:   GET  /admin     login / copy editor
 *          POST /admin     login
 *          POST /admin/save
 *          POST /admin/test
 *          POST /admin/logout
 *
 * Cron: every 2 minutes (free KV tier allows 1,000 writes/day; 1/min would be 1,440).
 */

const TARGETS = [
  {
    id: "minecraft", name: "Minecraft", group: "Game", type: "mc", host: "mc.ssoggy.com", port: 25565,
    sub: "mc.ssoggy.com:25565",
    about: "Velocity proxy on the Oracle box, forwarding to the Nest container. mc.ssoggy.com takes the same A → haproxy path as .me, verified by TXT (no CNAME).",
  },

  { id: "taalswipe", name: "TaalSwipe", group: "Vercel", type: "http", url: "https://taalswipe.ssoggy.com/", about: "Vercel · production branch." },
  { id: "minimusiclab", name: "MiniMusicLab", group: "Vercel", type: "http", url: "https://minimusiclab.ssoggy.com/", about: "Vercel · static site." },
  { id: "sprig", name: "Sprig", group: "Vercel", type: "http", url: "https://sprig.ssoggy.com/", about: "Vercel · slow on cold start." },
  { id: "excel-dash", name: "Excel Dash (preview)", group: "Vercel", type: "http", url: "https://excel-dash-preview.ssoggy.com/", about: "Vercel · preview build." },
  { id: "ssoggysouls", name: "SSoggySouls Docs", group: "Vercel", type: "http", url: "https://ssoggysouls.ssoggy.com/", about: "Jekyll docs, built by Vercel from the mod repo." },
  { id: "portfolio", name: "Portfolio", group: "Vercel", type: "http", url: "https://maarenaurich.com/", about: "Vercel · apex of maarenaurich.com." },
  { id: "vishandel", name: "Vishandel Volendam", group: "Vercel", type: "http", url: "https://vishandelvolendam.maarenaurich.com/", about: "Vercel · client site." },

  { id: "ai", name: "AI Chat", group: "Cloudflare Pages", type: "http", url: "https://ai.ssoggy.com/", about: "Cloudflare Pages · ai-chat-export." },
  { id: "oba", name: "Beleggers Academie", group: "Cloudflare Pages", type: "http", url: "https://oba.ssoggy.com/", about: "Cloudflare Pages · online-beleggers-academie." },
  { id: "cev", name: "CEV Dashboard", group: "Cloudflare Pages", type: "http", url: "https://cev.ssoggy.com/", about: "Cloudflare Pages · same project as OBA, different route." },

  { id: "panel", name: "Pterodactyl Panel", group: "Nest VPS", type: "http", url: "https://panel.ssoggy.me/", okUpTo: 499, about: "Nest container, behind the hackclub reverse proxy. .com: panel.ssoggy.com (waiting on Nest cert)." },
  { id: "router", name: "Router", group: "Nest VPS", type: "http", url: "https://router.ssoggy.me/", okUpTo: 499, about: "Nest container, port 20128. .com: router.ssoggy.com (waiting on Nest cert)." },
  {
    id: "chat", name: "OpenWebUI (chat)", group: "Nest VPS", type: "http", url: "https://chat.ssoggy.me/", okUpTo: 499,
    about: "OpenWebUI on the Nest container, port 3000. .com: chat.ssoggy.com (waiting on Nest cert).",
    note: "Returns 502 whenever the container restarts — the proxy is fine, the app isn't up yet.",
  },
  { id: "node", name: "Pterodactyl Node", group: "Nest VPS", type: "http", url: "https://node.ssoggy.me/", okUpTo: 499, about: "Wings daemon. 401 is expected — it means it's alive. .com: node.ssoggy.com (waiting on Nest cert)." },
];

const GROUPS = ["Game", "Vercel", "Cloudflare Pages", "Nest VPS"];
const HISTORY = 90;
const HTTP_TIMEOUT = 7000;
const MC_TIMEOUT = 6000;
const KV_KEY = "state:v3";
const KV_KEY_OLD = "state:v2";
const COPY_KEY = "copy:v1";
const NOTICE_KEY = "notice:v1";
const MAX_BODY = 20_000;
const COOKIE = "__Host-ssoggy_admin";
const LOGIN_MAX = 10;
const LOGIN_WINDOW = 900;

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

/* ------------------------------- store ------------------------------- */

async function readJson(env, key, fallback) {
  if (!env.STATUS) return fallback;
  try {
    const v = await env.STATUS.get(key, "json");
    return v && typeof v === "object" ? v : fallback;
  } catch { return fallback; }
}

const readCopy = (env) => readJson(env, COPY_KEY, {});
const readNotice = (env) => readJson(env, NOTICE_KEY, { level: "info", text: "" });

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
      headers: { "user-agent": "ssoggy-status/5.0 (+status.ssoggy.com)" },
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

/* ---- Minecraft handshake ---- */

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

async function runOne(t) {
  const r = t.type === "mc" ? await checkMinecraft(t) : await checkHttp(t);
  return {
    id: t.id, t: Date.now(), ok: !!r.ok, ms: r.ms ?? null, code: r.code ?? null,
    note: r.note ?? null, players: r.players ?? null, version: r.version ?? null, motd: r.motd ?? null,
  };
}

function record(state, r) {
  const prev = state[r.id] || { history: [], total: 0, up: 0 };
  const history = (prev.history || []).map(normBeat);
  history.push({ t: r.t, ok: r.ok, ms: r.ms });
  while (history.length > HISTORY) history.shift();
  state[r.id] = { history, total: (prev.total || 0) + 1, up: (prev.up || 0) + (r.ok ? 1 : 0), last: r };
  return state;
}

async function runAll(env) {
  const results = await Promise.all(TARGETS.map(runOne));
  const state = await readState(env);
  for (const r of results) record(state, r);
  state.updated = Date.now();
  if (env.STATUS) {
    try { await env.STATUS.put(KV_KEY, JSON.stringify(state)); } catch {}
  }
  return { results, byId: Object.fromEntries(results.map((r) => [r.id, r])) };
}

function normBeat(b) {
  if (typeof b === "number") return { t: null, ok: b === 1, ms: null };
  return b || { t: null, ok: false, ms: null };
}

async function readState(env) {
  const cur = await readJson(env, KV_KEY, null);
  if (cur) return cur;
  const old = await readJson(env, KV_KEY_OLD, null);
  if (!old) return {};
  const migrated = { updated: old.updated };
  for (const [k, v] of Object.entries(old)) {
    if (k === "updated") continue;
    migrated[k] = { history: (v.history || []).map(normBeat), total: v.total || 0, up: v.up || 0, last: v.last || null };
  }
  return migrated;
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
  if (!entry) return null;
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
const fmtDuration = (ms) => {
  if (ms == null) return "–";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "m";
};

// How long a target has held its current state, from the trailing run of
// identical beats in its history.
function stateFor(entry, state) {
  const beats = (entry?.history || []).map(normBeat).filter((b) => typeof b.ok === "boolean");
  if (!beats.length || state === "unknown") return null;
  let since = null;
  for (let i = beats.length - 1; i >= 0; i--) {
    if ((state === "up") !== !!beats[i].ok) break;
    if (beats[i].t) since = beats[i].t;
  }
  return since == null ? null : Date.now() - since;
}

function overallStats(rows) {
  let beats = 0, upBeats = 0, lat = 0, latN = 0, up = 0;
  for (const r of rows) {
    const h = (r.entry?.history || []).map(normBeat).filter((b) => typeof b.ok === "boolean");
    beats += h.length;
    upBeats += h.filter((b) => b.ok).length;
    if (r.state === "up") up++;
    const a = avgMs(r.entry);
    if (a != null && r.state === "up") { lat += a; latN++; }
  }
  return { uptime: beats ? upBeats / beats : null, avg: latN ? lat / latN : null, up };
}

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
  --bg:#fff; --fg:#14161a; --muted:#6a6f77; --faint:#9aa0a8;
  --line:#e6e8eb; --line-2:#f2f3f5;
  --ok:#189a50; --bad:#ce312c; --warn:#a06a06; --empty:#e9ebee;
  --panel:#fbfbfc; --field:#fff; --radius:5px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  --shadow:0 1px 2px rgba(16,18,22,.04);
}
:root[data-theme="dark"]{
  --bg:#0b0d10; --fg:#e9ebee; --muted:#8b9199; --faint:#5e646d;
  --line:#20242b; --line-2:#161a20;
  --ok:#33c46a; --bad:#ff635d; --warn:#d8a13a; --empty:#20242b;
  --panel:#0f1216; --field:#0f1216; --shadow:none;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0b0d10; --fg:#e9ebee; --muted:#8b9199; --faint:#5e646d;
    --line:#20242b; --line-2:#161a20;
    --ok:#33c46a; --bad:#ff635d; --warn:#d8a13a; --empty:#20242b;
    --panel:#0f1216; --field:#0f1216; --shadow:none;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 var(--sans);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
::selection{background:color-mix(in srgb,var(--ok) 22%,transparent)}
a{color:inherit}
.wrap{max-width:780px;margin:0 auto;padding:36px 20px 52px}

.top{display:flex;align-items:flex-start;gap:12px;margin-bottom:22px}
.brand h1{font-size:13.5px;font-weight:600;margin:0;letter-spacing:.005em}
.brand p{margin:2px 0 0;font-size:11.5px;color:var(--muted)}
.top-right{margin-left:auto;display:flex;align-items:center;gap:10px}
.meta{font:10px/1 var(--mono);color:var(--faint);letter-spacing:.03em}
.iconbtn{appearance:none;background:none;border:1px solid var(--line);border-radius:var(--radius);
  width:26px;height:26px;display:grid;place-items:center;color:var(--muted);cursor:pointer;padding:0}
.iconbtn:hover{color:var(--fg);border-color:var(--faint)}
.iconbtn:focus-visible{outline:2px solid color-mix(in srgb,var(--ok) 45%,transparent);outline-offset:2px}

.notice{display:flex;gap:9px;align-items:flex-start;font-size:12px;padding:9px 11px;margin-bottom:14px;
  border:1px solid var(--line);border-left-width:2px;border-radius:var(--radius);color:var(--muted)}
.notice.info{border-left-color:var(--muted)}
.notice.warn{border-left-color:var(--warn);color:var(--warn);background:color-mix(in srgb,var(--warn) 5%,transparent)}
.notice.down{border-left-color:var(--bad);color:var(--bad);background:color-mix(in srgb,var(--bad) 5%,transparent)}
.notice b{font-weight:600}

.banner{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:550;padding:8px 11px;
  margin-bottom:24px;border:1px solid var(--line);border-radius:var(--radius)}
.banner i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
.banner.ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 28%,var(--line));background:color-mix(in srgb,var(--ok) 5%,transparent)}
.banner.partial{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 28%,var(--line));background:color-mix(in srgb,var(--warn) 5%,transparent)}
.banner.major{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 28%,var(--line));background:color-mix(in srgb,var(--bad) 5%,transparent)}
.banner.empty{color:var(--faint);border-color:color-mix(in srgb,var(--faint) 22%,var(--line))}
.banner .n{margin-left:auto;font:10px/1 var(--mono);opacity:.8}

.stats{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);
  border-radius:var(--radius);margin:0 0 22px;overflow:hidden;box-shadow:var(--shadow)}
.stat{padding:9px 12px;border-left:1px solid var(--line-2)}
.stat:first-child{border-left:0}
.stat .k{display:block;font:9px/1.6 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.stat .v{font:600 15px/1.25 var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.01em}

.group{margin:0 0 24px}
.g-head{display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:0 1px}
.g-head h2{font:600 9.5px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0}
.g-head .rule{flex:1;height:1px;background:var(--line-2)}
.g-count{font:500 9.5px/1 var(--mono);color:var(--faint)}
.g-count.bad{color:var(--bad)}

.list{border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)}
.row{border-top:1px solid var(--line-2)}
.row:first-child{border-top:0}
.row>summary{display:grid;grid-template-columns:6px minmax(108px,1fr) minmax(0,2.4fr) 46px 50px 12px;
  gap:11px;align-items:center;padding:8px 12px;cursor:pointer;list-style:none;user-select:none}
.row>summary::-webkit-details-marker{display:none}
.row>summary::marker{content:""}
.row>summary:hover{background:var(--panel)}
.row>summary:focus-visible{outline:2px solid color-mix(in srgb,var(--ok) 40%,transparent);outline-offset:-2px}
.row[open]{background:var(--panel)}
.state{width:5px;height:5px;border-radius:50%;background:var(--faint);justify-self:start}
.state.up{background:var(--ok)}
.state.down{background:var(--bad)}
.name{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.beats{display:flex;gap:2px;height:24px;align-items:stretch;min-width:0}
.beat{flex:1 1 0;min-width:2px;border-radius:1.5px;background:var(--empty)}
.beat.up{background:var(--ok);opacity:.62}
.beat.down{background:var(--bad);opacity:.95}
.beat.empty{opacity:.4}

.num{font:10px/1 var(--mono);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--muted)}
.num.ms{color:var(--faint)}
.chev{color:var(--faint);transition:transform .16s ease;justify-self:end}
.row[open] .chev{transform:rotate(90deg)}

.detail{display:grid;gap:5px;padding:4px 12px 12px 29px;border-top:1px solid var(--line-2)}
.drow{display:grid;grid-template-columns:50px 1fr;gap:10px;align-items:baseline}
.drow .k{font:9px/1.7 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.drow .v{color:var(--muted);min-width:0;overflow-wrap:anywhere;font-size:11.5px}
.drow a{color:var(--fg);text-decoration:none;border-bottom:1px solid var(--line-2)}
.drow a:hover{border-color:var(--fg)}

.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;font-style:normal}

footer{margin-top:32px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;
  font:10px/1.6 var(--mono);color:var(--faint)}
.legend{display:flex;gap:10px;align-items:center}
.legend span{display:inline-flex;align-items:center;gap:4px}
.sw{width:7px;height:7px;border-radius:2px;display:inline-block}
.sw.up{background:var(--ok);opacity:.62}
.sw.down{background:var(--bad)}
.sw.empty{background:var(--empty)}
footer a{color:var(--faint);text-decoration:none;border-bottom:1px solid var(--line-2)}
footer a:hover{color:var(--muted)}

/* ---------- admin ---------- */
.bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:10px;padding:10px 0 11px;
  background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(6px);border-bottom:1px solid var(--line);margin-bottom:18px}
.bar h1{font-size:13px;font-weight:600;margin:0}
.bar .sp{flex:1}
.dirty{font:10px/1 var(--mono);color:var(--warn)}
.saved{font:10px/1 var(--mono);color:var(--ok)}
.btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--fg);color:var(--bg);
  border:1px solid var(--fg);border-radius:var(--radius);padding:7px 12px;font:600 11.5px/1 var(--sans);cursor:pointer;text-decoration:none}
.btn:hover{opacity:.9}
.btn.ghost{background:transparent;color:var(--muted);border-color:var(--line)}
.btn.ghost:hover{color:var(--fg);border-color:var(--faint);opacity:1}
.btn.tiny{padding:4px 8px;font-size:10.5px;font-weight:500}
.btn:focus-visible{outline:2px solid color-mix(in srgb,var(--ok) 45%,transparent);outline-offset:2px}
.field{display:grid;gap:5px}
.field>label{font:9px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
input[type=password],input[type=text],textarea,select{width:100%;background:var(--field);color:var(--fg);
  border:1px solid var(--line);border-radius:var(--radius);padding:7px 9px;font:12px/1.45 var(--mono);resize:vertical}
select{font-family:var(--sans)}
input:focus,textarea:focus,select:focus{outline:2px solid color-mix(in srgb,var(--ok) 32%,transparent);outline-offset:1px;border-color:var(--line)}
.svc{border:1px solid var(--line);border-radius:var(--radius);padding:11px 12px;background:var(--bg)}
.svc+.svc{margin-top:9px}
.svc-h{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.svc-h .state{justify-self:auto}
.svc-h strong{font-size:12.5px;font-weight:600}
.svc-h .id{font:9.5px/1 var(--mono);color:var(--faint)}
.svc-h .tag{margin-left:auto;font:9px/1 var(--mono);color:var(--faint);text-transform:uppercase;letter-spacing:.05em}
.svc-h .tag.on{color:var(--warn)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.check{display:flex;align-items:center;gap:6px;font:10px/1 var(--mono);color:var(--faint);margin-top:8px}
.filter{margin-bottom:14px}
.empty{padding:20px;text-align:center;color:var(--faint);font:11px/1.6 var(--mono)}
.err{color:var(--bad)}
.login{max-width:320px;margin:14vh auto 0}
.login .field{margin:10px 0}
@media (max-width:640px){
  .row>summary{grid-template-columns:6px 1fr 42px 12px;grid-template-areas:"s n u c" ". b b b";gap:6px 10px;padding:9px 11px}
  .state{grid-area:s}.name{grid-area:n}.num.up{grid-area:u}.chev{grid-area:c}
  .beats{grid-area:b;height:20px}.num.ms{display:none}
  .detail{padding-left:12px}
  .grid2{grid-template-columns:1fr}
  .stat{padding:8px 10px}
  .stat .v{font-size:13px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

const CHEVRON = `<svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`;
const SUNMOON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.4v1.4M8 13.2v1.4M1.4 8h1.4M13.2 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M12.7 3.3l-1 1M4.3 11.7l-1 1"/></svg>`;

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
  const since = stateFor(entry, state);

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
          <div class="drow"><span class="k">for</span><span class="v" data-f="p-for">${since != null ? fmtDuration(since) + (state === "up" ? " up" : " down") : "–"}</span></div>
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
  const up = items.filter((r) => r.state === "up").length;
  const down = items.filter((r) => r.state === "down").length;
  return `
    <section class="group" data-group="${esc(group)}">
      <div class="g-head">
        <h2>${esc(group)}</h2>
        <span class="rule"></span>
        <span class="g-count ${down ? "bad" : ""}">${up}/${items.length}</span>
      </div>
      <div class="list">${items.map((r) => rowHtml(r.t, r.live, r.entry)).join("")}</div>
    </section>`;
}

function bannerState(rows) {
  const known = rows.filter((r) => r.state !== "unknown");
  const down = known.filter((r) => r.state === "down").length;
  if (!known.length) return { cls: "empty", text: "Starting up — first check in progress" };
  if (!down) return { cls: "ok", text: "All systems operational" };
  return (down / known.length) >= 0.5
    ? { cls: "major", text: "Major outage" }
    : { cls: "partial", text: "Partially degraded" };
}

const THEME_BOOT = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

function head(title, nonce, desc) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="color-scheme" content="light dark">
<style nonce="${nonce}">${CSS}</style>
<script nonce="${nonce}">${THEME_BOOT}</script>`;
}

function renderPage(state, live, copy, notice, nonce) {
  const targets = TARGETS.map((t) => effective(t, copy));
  const rows = targets.map((t) => {
    const entry = state[t.id] || null;
    const last = live ? live[t.id] : entry?.last || null;
    return { t, entry, live: last, state: last ? (last.ok ? "up" : "down") : "unknown" };
  });
  const b = bannerState(rows);
  const total = rows.length;
  const st = overallStats(rows);
  const pct = (v) => (v == null ? "–" : (v * 100).toFixed(v >= 0.995 ? 1 : 2) + "%");
  const hasNotice = notice && notice.text && notice.text.trim();

  return `<!doctype html>
<html lang="en">
<head>
${head("ssoggy status", nonce, "Live status for everything I host.")}
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="brand">
      <h1>ssoggy status</h1>
      <p>Everything I host, checked from Cloudflare's edge.</p>
    </div>
    <div class="top-right">
      <span class="meta" id="updated">${state.updated ? fmtTime(state.updated) : "checking"}</span>
      <button class="iconbtn" id="theme" type="button" title="Toggle theme" aria-label="Toggle theme">${SUNMOON}</button>
    </div>
  </div>

  ${hasNotice ? `<div class="notice ${esc(notice.level || "info")}"><span>${esc(notice.text)}</span></div>` : ""}

  <div class="banner ${b.cls}" id="banner">
    <i aria-hidden="true"></i>
    <span id="banner-text">${b.text}</span>
    <span class="n" id="banner-count">${st.up}/${total}</span>
  </div>

  <div class="stats">
    <div class="stat"><span class="k">services</span><span class="v" id="s-up">${st.up}/${total}</span></div>
    <div class="stat"><span class="k">uptime · ${HISTORY} checks</span><span class="v" id="s-uptime">${pct(st.uptime)}</span></div>
    <div class="stat"><span class="k">avg latency</span><span class="v" id="s-latency">${st.avg != null ? fmtMs(st.avg) : "–"}</span></div>
  </div>

  <main id="main">${GROUPS.map((g) => groupBlock(g, rows)).join("")}</main>

  <footer>
    <span class="legend">
      <span><i class="sw up"></i>up</span>
      <span><i class="sw down"></i>down</span>
      <span><i class="sw empty"></i>no data</span>
      <span>· 90 checks @ 2 min</span>
    </span>
    <span><a href="/api/status">json</a></span>
  </footer>
</div>
<script nonce="${nonce}">
(function(){
  var btn=document.getElementById("theme");
  btn.addEventListener("click",function(){
    var cur=document.documentElement.getAttribute("data-theme");
    var pref=cur||"auto";
    var next=pref==="auto"?"light":pref==="light"?"dark":"auto";
    try{ if(next==="auto"){localStorage.removeItem("theme");document.documentElement.removeAttribute("data-theme");}
         else {localStorage.setItem("theme",next);document.documentElement.setAttribute("data-theme",next);} }catch(e){}
  });
})();
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
function dur(ms){
  if (ms == null) return "–";
  const s = Math.max(0, Math.round(ms/1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s/60) + "m";
  return Math.floor(s/3600) + "h " + Math.round((s%3600)/60) + "m";
}
function sinceFor(history, status){
  const b = (history || []).filter(x => x && typeof x.ok === "boolean");
  if (!b.length || status === "unknown") return null;
  let since = null;
  for (let i = b.length - 1; i >= 0; i--){
    if ((status === "up") !== !!b[i].ok) break;
    if (b[i].t) since = b[i].t;
  }
  return since == null ? null : Date.now() - since;
}
async function refresh(){
  try{
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const byId = Object.fromEntries(data.targets.map(t => [t.id, t]));
    document.querySelectorAll(".row").forEach((row) => {
      const t = byId[row.dataset.id];
      if (!t) return;
      row.querySelector(".state").className = "state " + t.status;
      const sr = row.querySelector(".name .sr");
      if (sr) sr.textContent = " — " + t.status;
      const be = row.querySelector(".beats");
      be.innerHTML = beats(t.history);
      be.setAttribute("aria-label", "Last " + (t.history || []).length + " checks");
      row.querySelector(".num.up").textContent = t.uptime != null ? (t.uptime*100).toFixed(t.uptime >= 0.995 ? 1 : 2) + "%" : "–";
      row.querySelector(".num.ms").textContent = t.avgMs != null ? MS(t.avgMs) : "–";
      const ps = row.querySelector('[data-f="p-status"]');
      if (ps) ps.textContent = t.status + (t.code ? " · HTTP " + t.code : "");
      const pf = row.querySelector('[data-f="p-for"]');
      if (pf){ const d = sinceFor(t.history, t.status);
        pf.textContent = d != null ? dur(d) + (t.status === "up" ? " up" : " down") : "–"; }
      const pw = row.querySelector('[data-f="p-why"]');
      if (pw) pw.textContent = why(t);
      const pl = row.querySelector('[data-f="p-last"]');
      if (pl) pl.textContent = t.lastChecked ? ago(t.lastChecked) + " · " + T(t.lastChecked) : "never";
    });
    document.querySelectorAll(".group").forEach((sec) => {
      const rows = sec.querySelectorAll(".row");
      const upRows = Array.from(rows).filter(r => r.querySelector(".state").classList.contains("up")).length;
      const bad = Array.from(rows).filter(r => r.querySelector(".state").classList.contains("down")).length;
      const cnt = sec.querySelector(".g-count");
      if (cnt){ cnt.textContent = upRows + "/" + rows.length; cnt.className = "g-count" + (bad ? " bad" : ""); }
    });
    const known = data.targets.filter(t => t.status !== "unknown");
    const up = data.targets.filter(t => t.status === "up").length;
    const down = known.filter(t => t.status === "down").length;
    const total = data.targets.length;
    const cls = !known.length ? "empty" : down === 0 ? "ok" : down / known.length >= 0.5 ? "major" : "partial";
    const banner = document.getElementById("banner");
    banner.className = "banner " + cls;
    document.getElementById("banner-text").textContent =
      cls === "empty" ? "Starting up — first check in progress" : cls === "ok" ? "All systems operational" : cls === "major" ? "Major outage" : "Partially degraded";
    document.getElementById("banner-count").textContent = up + "/" + total;
    let beatsN = 0, upN = 0, lat = 0, latN = 0;
    data.targets.forEach(t => {
      const h = (t.history || []).filter(x => x && typeof x.ok === "boolean");
      beatsN += h.length; upN += h.filter(x => x.ok).length;
      if (t.avgMs != null && t.status === "up"){ lat += t.avgMs; latN++; }
    });
    document.getElementById("s-up").textContent = up + "/" + total;
    document.getElementById("s-uptime").textContent =
      beatsN ? (upN / beatsN * 100).toFixed(upN / beatsN >= 0.995 ? 1 : 2) + "%" : "–";
    document.getElementById("s-latency").textContent = latN ? MS(lat / latN) : "–";
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
${head("ssoggy status · sign in", nonce, "Admin sign in.")}
<meta name="robots" content="noindex,nofollow">
</head>
<body>
<div class="wrap">
  <div class="login">
    <div class="top">
      <div class="brand"><h1>ssoggy status</h1><p>admin</p></div>
    </div>
    <form method="post" action="/admin">
      <div class="field">
        <label for="key">admin key</label>
        <input id="key" name="key" type="password" autocomplete="current-password" autofocus required>
      </div>
      ${error ? '<div class="check err">wrong key</div>' : ""}
      <div style="margin-top:14px"><button class="btn" type="submit">sign in</button></div>
    </form>
    <footer><span></span><span><a href="/">status</a></span></footer>
  </div>
</div>
</body>
</html>`;
}

function renderAdmin(copy, notice, nonce, saved) {
  const groups = GROUPS.map((g) => {
    const items = TARGETS.filter((t) => t.group === g);
    return `
      <section class="group" data-group="${esc(g)}">
        <div class="g-head"><h2>${esc(g)}</h2><span class="rule"></span></div>
        <div class="list-svc">
        ${items.map((t) => {
          const o = copy[t.id] || {};
          const over = o.about != null || o.note != null;
          return `
          <div class="svc" data-id="${esc(t.id)}" data-name="${esc((t.name + " " + t.id + " " + t.group).toLowerCase())}">
            <div class="svc-h">
              <span class="state" data-live></span>
              <strong>${esc(t.name)}</strong>
              <span class="id">${esc(t.id)}</span>
              <button class="btn ghost tiny" type="button" data-test="${esc(t.id)}">test</button>
              <span class="tag ${over ? "on" : ""}">${over ? "overridden" : "default"}</span>
            </div>
            <div class="grid2">
              <div class="field">
                <label for="about-${esc(t.id)}">about</label>
                <textarea id="about-${esc(t.id)}" name="about_${esc(t.id)}" rows="2" placeholder="${esc(t.about || "")}">${esc(o.about ?? "")}</textarea>
              </div>
              <div class="field">
                <label for="note-${esc(t.id)}">note</label>
                <textarea id="note-${esc(t.id)}" name="note_${esc(t.id)}" rows="2" placeholder="${esc(t.note || "")}">${esc(o.note ?? "")}</textarea>
              </div>
            </div>
            <label class="check"><input type="checkbox" name="reset_${esc(t.id)}" value="1"> reset to default</label>
          </div>`;
        }).join("")}
        </div>
      </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
${head("ssoggy status · copy", nonce, "Copy editor.")}
<meta name="robots" content="noindex,nofollow">
</head>
<body>
<div class="wrap">
  <div class="bar">
    <h1>copy editor</h1>
    <span class="sp"></span>
    <span id="state" class="${saved ? "saved" : ""}">${saved ? "saved" : ""}</span>
    <button class="btn" type="submit" form="form" id="save">save</button>
    <a class="btn ghost" href="/">status</a>
    <form method="post" action="/admin/logout"><button class="btn ghost" type="submit">sign out</button></form>
  </div>

  <form id="form" method="post" action="/admin/save">
    <section class="group">
      <div class="g-head"><h2>notice</h2><span class="rule"></span></div>
      <div class="svc">
        <div class="grid2">
          <div class="field">
            <label for="notice_level">level</label>
            <select id="notice_level" name="notice_level">
              <option value="info"${(notice.level || "info") === "info" ? " selected" : ""}>info</option>
              <option value="warn"${notice.level === "warn" ? " selected" : ""}>warn</option>
              <option value="down"${notice.level === "down" ? " selected" : ""}>down</option>
            </select>
          </div>
          <div class="field">
            <label for="notice_text">banner text (blank hides it)</label>
            <input id="notice_text" name="notice_text" type="text" value="${esc(notice.text || "")}" placeholder="e.g. Pterodactyl maintenance until 18:00 UTC">
          </div>
        </div>
      </div>
    </section>

    <div class="filter field">
      <label for="q">filter</label>
      <input id="q" type="text" placeholder="type to filter services…" autocomplete="off">
    </div>

    ${groups}
  </form>

  <footer><span>overrides · kv</span><span><a href="/">status</a></span></footer>
</div>
<script nonce="${nonce}">
(function(){
  const form=document.getElementById("form");
  const statusEl=document.getElementById("state");
  let dirty=false;
  const mark=(v)=>{dirty=v;statusEl.className=v?"dirty":"saved";statusEl.textContent=v?"unsaved":statusEl.textContent;};
  form.addEventListener("input",()=>{ if(!dirty){dirty=true;statusEl.className="dirty";statusEl.textContent="unsaved";} });
  form.addEventListener("submit",()=>{ statusEl.className="saved";statusEl.textContent="saving…"; });
  window.addEventListener("beforeunload",(e)=>{ if(dirty){ e.preventDefault(); e.returnValue=""; } });
  document.addEventListener("keydown",(e)=>{
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="s"){ e.preventDefault(); form.requestSubmit(); }
  });
  document.getElementById("q").addEventListener("input",(e)=>{
    const q=e.target.value.trim().toLowerCase();
    document.querySelectorAll(".svc[data-name]").forEach((el)=>{
      el.style.display = !q || el.dataset.name.includes(q) ? "" : "none";
    });
  });
  document.querySelectorAll("[data-test]").forEach((btn)=>{
    btn.addEventListener("click",async()=>{
      const id=btn.dataset.test, card=btn.closest(".svc"), dot=card.querySelector("[data-live]");
      btn.disabled=true; const old=btn.textContent; btn.textContent="…";
      try{
        const res=await fetch("/admin/test",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id})});
        if(res.ok){ const j=await res.json(); dot.className="state "+(j.ok?"up":"down"); dot.title=(j.ok?"up":"down")+" · "+(j.code||"")+" "+Math.round(j.ms||0)+"ms"; }
        else { dot.className="state unknown"; }
      }catch(e){ dot.className="state unknown"; }
      finally{ btn.disabled=false; btn.textContent=old; }
    });
  });
})();
</script>
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

/* ------------------------------- http ------------------------------- */

function nonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
}

function headers(n, maxAge) {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": maxAge ? `private, max-age=${maxAge}` : "no-store",
    "content-security-policy":
      `default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}'; img-src data:; ` +
      `connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(), microphone=(), camera=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "x-robots-tag": "noindex",
  };
}

const html = (body, n, maxAge) => new Response(body, { headers: headers(n, maxAge) });
const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
const tooLarge = () => new Response("Too large", { status: 413, headers: { "content-type": "text/plain; charset=utf-8" } });

function sameSite(request, url) {
  const sfs = request.headers.get("sec-fetch-site");
  if (sfs && sfs !== "same-origin" && sfs !== "none") return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try { if (new URL(origin).host !== url.host) return false; } catch { return false; }
  }
  return true;
}

async function readBody(request) {
  const len = Number(request.headers.get("content-length") || "0");
  if (len > MAX_BODY) return null;
  const body = await request.text();
  return body.length > MAX_BODY ? null : body;
}

async function loginBlocked(env, ip) {
  if (!env.STATUS) return false;
  try {
    const v = await env.STATUS.get("rl:" + ip, "json");
    return !!v && v.n >= LOGIN_MAX;
  } catch { return false; }
}

async function noteFailure(env, ip) {
  if (!env.STATUS) return;
  try {
    const v = (await env.STATUS.get("rl:" + ip, "json")) || { n: 0 };
    v.n += 1;
    await env.STATUS.put("rl:" + ip, JSON.stringify(v), { expirationTtl: LOGIN_WINDOW });
  } catch {}
}

/* ------------------------------- worker ------------------------------- */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;
    const ip = request.headers.get("cf-connecting-ip") || "unknown";

    /* ---------- admin ---------- */
    if (path === "/admin" || path.startsWith("/admin/")) {
      if (path === "/admin" && method === "POST") {
        if (!env.ADMIN_KEY) return notFound();
        if (await loginBlocked(env, ip)) {
          return new Response("Too many attempts", { status: 429, headers: { "retry-after": String(LOGIN_WINDOW) } });
        }
        const body = await readBody(request);
        if (body === null) return tooLarge();
        const key = (new URLSearchParams(body).get("key") || "").trim();
        const [a, b] = await Promise.all([sha256(key), sha256(env.ADMIN_KEY)]);
        if (!safeEqual(a, b)) {
          await noteFailure(env, ip);
          const n = nonce();
          return html(renderLogin(n, true), n, 0);
        }
        const token = await sessionToken(env);
        const n = nonce();
        return new Response(renderAdmin(await readCopy(env), await readNotice(env), n, false), {
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
          headers: {
            location: "/",
            "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
            "clear-site-data": '"cache", "cookies", "storage"',
          },
        });
      }

      const authed = await isAuthed(request, env);
      if (!authed) {
        if (path === "/admin" && (method === "GET" || method === "HEAD")) {
          const n = nonce();
          return html(renderLogin(n, false), n, 0);
        }
        return notFound();
      }

      if (path === "/admin/save" && method === "POST") {
        if (!sameSite(request, url)) return new Response("Bad origin", { status: 403 });
        const body = await readBody(request);
        if (body === null) return tooLarge();
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

        const level = ["info", "warn", "down"].includes(form.get("notice_level") || "") ? form.get("notice_level") : "info";
        const text = (form.get("notice_text") || "").trim().slice(0, 300);
        if (env.STATUS) {
          await env.STATUS.put(COPY_KEY, JSON.stringify(copy));
          await env.STATUS.put(NOTICE_KEY, JSON.stringify({ level, text }));
        }
        return new Response(null, { status: 303, headers: { location: "/admin?saved=1" } });
      }

      if (path === "/admin/test" && method === "POST") {
        if (!sameSite(request, url)) return new Response("Bad origin", { status: 403 });
        const body = await readBody(request);
        if (body === null) return tooLarge();
        let id = null;
        try { id = JSON.parse(body).id; } catch {}
        const target = TARGETS.find((t) => t.id === id);
        if (!target) return notFound();
        const r = await runOne(target);
        const state = await readState(env);
        record(state, r);
        state.updated = state.updated || Date.now();
        if (env.STATUS) { try { await env.STATUS.put(KV_KEY, JSON.stringify(state)); } catch {} }
        return json({ id: r.id, ok: r.ok, ms: r.ms, code: r.code, note: r.note });
      }

      if (path === "/admin" && (method === "GET" || method === "HEAD")) {
        const n = nonce();
        return html(renderAdmin(await readCopy(env), await readNotice(env), n, url.searchParams.get("saved") === "1"), n, 0);
      }

      return notFound();
    }

    /* ---------- api ---------- */
    if (path === "/api/status") {
      if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      const state = await readState(env);
      const copy = await readCopy(env);
      let live = null, fresh = state;
      if (!state.updated || Date.now() - state.updated > 180_000) {
        const run = await runAll(env);
        live = run.byId;
        fresh = await readState(env);
      }
      return json(jsonPayload(fresh, live, copy));
    }

    if (path === "/api/check") {
      if (method !== "POST") return new Response("Method not allowed", { status: 405 });
      if (!(await isAuthed(request, env))) return notFound();
      const run = await runAll(env);
      return json({ checked: run.results.length, at: Date.now() });
    }

    /* ---------- page ---------- */
    if (path !== "/" && path !== "/index.html") return notFound();
    if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });

    let state = await readState(env);
    let live = null;
    if (!state.updated || Date.now() - state.updated > 180_000) {
      const run = await runAll(env);
      live = run.byId;
      state = await readState(env);
    }
    const copy = await readCopy(env);
    const notice = await readNotice(env);
    const n = nonce();
    return html(renderPage(state, live, copy, notice, n), n, 20);
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "strict-transport-security": "max-age=31536000",
    },
  });
}
