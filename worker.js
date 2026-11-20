import { connect } from "cloudflare:sockets";

/**
 * ssoggy status — Cloudflare Worker
 * Each monitor expands (click) to show its link, last check, response time and why it's down.
 */

const TARGETS = [
  // ---- Game ----
  { id: "minecraft", name: "Minecraft", group: "Game", type: "mc", host: "mc.ssoggy.com", port: 25565, sub: "mc.ssoggy.com:25565" },

  // ---- Vercel ----
  { id: "taalswipe", name: "TaalSwipe", group: "Vercel", type: "http", url: "https://taalswipe.ssoggy.com/" },
  { id: "minimusiclab", name: "MiniMusicLab", group: "Vercel", type: "http", url: "https://minimusiclab.ssoggy.com/" },
  { id: "sprig", name: "Sprig", group: "Vercel", type: "http", url: "https://sprig.ssoggy.com/" },
  { id: "excel-dash", name: "Excel Dash (preview)", group: "Vercel", type: "http", url: "https://excel-dash-preview.ssoggy.com/" },
  { id: "ssoggysouls", name: "SSoggySouls Docs", group: "Vercel", type: "http", url: "https://ssoggysouls.ssoggy.com/" },
  { id: "portfolio", name: "Portfolio", group: "Vercel", type: "http", url: "https://maarenaurich.com/" },
  { id: "vishandel", name: "Vishandel Volendam", group: "Vercel", type: "http", url: "https://vishandelvolendam.maarenaurich.com/" },

  // ---- Cloudflare Pages ----
  { id: "ai", name: "AI Chat", group: "Cloudflare Pages", type: "http", url: "https://ai.ssoggy.com/" },
  { id: "oba", name: "Beleggers Academie", group: "Cloudflare Pages", type: "http", url: "https://oba.ssoggy.com/" },
  { id: "cev", name: "CEV Dashboard", group: "Cloudflare Pages", type: "http", url: "https://cev.ssoggy.com/" },

  // ---- GitHub Pages ----
  { id: "ghpages", name: "GitHub Pages", group: "GitHub Pages", type: "http", url: "https://ssoggytacoblud.github.io/" },

  // ---- Nest VPS ----
  { id: "panel", name: "Pterodactyl Panel", group: "Nest VPS", type: "http", url: "https://panel.ssoggy.me/", okUpTo: 499 },
  { id: "router", name: "Router", group: "Nest VPS", type: "http", url: "https://router.ssoggy.me/", okUpTo: 499 },
  { id: "chat", name: "OpenWebUI (chat)", group: "Nest VPS", type: "http", url: "https://chat.ssoggy.me/", okUpTo: 499 },
  { id: "node", name: "Pterodactyl Node", group: "Nest VPS", type: "http", url: "https://node.ssoggy.me/", okUpTo: 499 },
];

const GROUPS = ["Game", "Vercel", "Cloudflare Pages", "GitHub Pages", "Nest VPS"];
const HISTORY = 90;
const HTTP_TIMEOUT = 7000;
const MC_TIMEOUT = 6000;
const KV_KEY = "state:v2";
const KV_KEY_OLD = "state:v1";

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
      headers: { "user-agent": "ssoggy-status/2.1 (+status.ssoggy.com)" },
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

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

/** Human explanation of the current state. */
function whyText(t, last) {
  if (!last) return "No check data yet — the next run will fill this in.";
  if (last.ok) {
    if (t.type === "mc") {
      const p = last.players ? `${last.players.online}/${last.players.max} players` : "no player data";
      return `Accepting connections. ${p}${last.version ? ", " + last.version : ""}.`;
    }
    const code = last.code ? `HTTP ${last.code}` : "connected";
    if (last.code && last.code >= 400) return `Responding (${code}) — it's up, but the app wants auth or a different path.`;
    return `Responding normally (${code}) in ${fmtMs(last.ms)}.`;
  }
  const note = last.note || "";
  if (t.type === "mc") {
    if (/timeout/i.test(note)) return "No answer to the Minecraft handshake within 6s — server down, or the proxy in front is broken.";
    if (/refused/i.test(note)) return "Connection refused — nothing is listening on that port.";
    if (/dns/i.test(note)) return "DNS lookup failed — the hostname doesn't resolve.";
    return `Minecraft check failed: ${note || "unknown error"}.`;
  }
  if (/^HTTP 5\d\d/.test(note)) return `${note} — Cloudflare reached the origin, but the app behind it is failing (crash, bad upstream, or TLS on the origin).`;
  if (/^HTTP 4\d\d/.test(note)) return `${note} — the server answered, but not with the page (wrong host, removed route, or auth wall).`;
  if (/timeout/i.test(note)) return "No response within 7s — the server is unreachable or hanging.";
  if (/dns/i.test(note)) return "DNS lookup failed — the hostname doesn't resolve.";
  if (/tls/i.test(note)) return "TLS handshake failed — certificate or SNI mismatch at the origin.";
  if (/refused/i.test(note)) return "Connection refused — nothing is listening on 443.";
  return `Request failed: ${note || "unknown error"}.`;
}

/* ------------------------------- render ------------------------------- */

function beatBars(entry) {
  const beats = (entry?.history || []).map(normBeat).slice(-HISTORY);
  const pad = Math.max(0, HISTORY - beats.length);
  const cells = [];
  for (let i = 0; i < pad; i++) cells.push('<span class="beat empty"></span>');
  for (const b of beats) {
    const cls = b.ok ? "up" : "down";
    const label = `${b.ok ? "Up" : "Down"} · ${fmtTime(b.t)}${b.ms != null ? " · " + fmtMs(b.ms) : ""}`;
    cells.push(`<span class="beat ${cls}" title="${esc(label)}"></span>`);
  }
  return cells.join("");
}

function panelHtml(t, last, entry) {
  const state = last ? (last.ok ? "up" : "down") : "unknown";
  const link = t.url
    ? `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.url)}</a>`
    : `<span class="v">${esc(t.sub || t.host)}</span>`;
  const beats = (entry?.history || []).map(normBeat);
  const downBeats = beats.filter((b) => !b.ok).length;
  const range = beats.length
    ? `${beats.length} checks · ${downBeats} failed`
    : "no history yet";

  return `
      <div class="panel">
        <div class="prow"><span class="k">Link</span><span class="v">${link}</span></div>
        <div class="prow"><span class="k">Status</span><span class="v" data-f="p-status">${state}${last?.code ? " · HTTP " + last.code : ""}</span></div>
        <div class="prow"><span class="k">Why</span><span class="v" data-f="p-why">${esc(whyText(t, last))}</span></div>
        <div class="prow"><span class="k">Last check</span><span class="v" data-f="p-last">${last?.t ? fmtAgo(last.t) + " · " + fmtTime(last.t) : "never"}</span></div>
        <div class="prow"><span class="k">History</span><span class="v">${esc(range)}</span></div>
      </div>`;
}

function monitorRow(t, live, entry) {
  const last = live || entry?.last || null;
  const state = last ? (last.ok ? "up" : "down") : "unknown";
  const up = uptimeOf(entry);
  const avg = avgMs(entry);
  const bits = [];
  if (last?.ms != null) bits.push(fmtMs(last.ms));
  if (last?.players) bits.push(`${last.players.online}/${last.players.max} players`);
  if (last?.version) bits.push(last.version);
  if (last?.code) bits.push("HTTP " + last.code);
  if (last?.note && state !== "up") bits.push(last.note);
  const sub = bits.length ? bits.join(" · ") : (t.sub || t.url);

  return `
      <details class="mon" data-id="${esc(t.id)}">
        <summary class="monitor">
          <div class="m-left">
            <span class="caret" aria-hidden="true"></span>
            <span class="pill ${state}" aria-hidden="true"></span>
            <div class="m-text">
              <div class="m-name">${esc(t.name)}<span class="sr"> — ${state}</span></div>
              <div class="m-sub" title="${esc(sub)}">${esc(sub)}</div>
            </div>
          </div>
          <div class="m-beats" aria-label="${esc(t.name)} heartbeats">${beatBars(entry)}</div>
          <div class="m-right">
            <div class="m-uptime">${up != null ? (up * 100).toFixed(up >= 0.995 ? 1 : 2) + "%" : "–"}</div>
            <div class="m-ping">${avg != null ? fmtMs(avg) : "–"}</div>
          </div>
        </summary>
        ${panelHtml(t, last, entry)}
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
        <span class="g-count ${down ? "bad" : ""}">${items.length - down}/${items.length} up</span>
      </div>
      <div class="card">${items.map((r) => monitorRow(r.t, r.live, r.entry)).join("")}</div>
    </section>`;
}

function bannerState(rows) {
  const down = rows.filter((r) => r.state === "down").length;
  if (!down) return { cls: "ok", text: "All Systems Operational" };
  return (down / rows.length) >= 0.5
    ? { cls: "major", text: "Major Outage" }
    : { cls: "partial", text: "Partially Degraded Service" };
}

function renderPage(state, live) {
  const rows = TARGETS.map((t) => {
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
<style>
:root{
  --bg:#f6f7f8; --card:#fff; --line:#dee2e6; --line-soft:#eceef0;
  --text:#212529; --muted:#6c757d; --ok:#4fae4f; --bad:#dc3545; --warn:#e0a03a; --empty:#e9ecef;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#121212; --card:#1b1b1b; --line:#2e2e2e; --line-soft:#252525; --text:#e9ecef; --muted:#9aa0a6; --empty:#2e2e2e; }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:26px 16px 44px}
.top{display:flex;align-items:baseline;gap:12px;margin-bottom:14px}
h1{font-size:18px;font-weight:600;margin:0;letter-spacing:-.01em}
.meta{margin-left:auto;color:var(--muted);font-size:12px}
.banner{background:var(--ok);color:#fff;border-radius:6px;padding:11px 14px;font-weight:600;font-size:14px;
  display:flex;align-items:center;gap:10px;margin-bottom:20px}
.banner.partial{background:var(--warn)}
.banner.major{background:var(--bad)}
.banner .n{margin-left:auto;font-weight:500;font-size:12.5px;opacity:.95}
.group{margin:0 0 16px}
.g-head{display:flex;align-items:baseline;gap:8px;margin:0 0 6px;padding:0 2px}
.g-head h2{font-size:13.5px;font-weight:600;margin:0}
.g-count{margin-left:auto;font-size:12px;color:var(--muted)}
.g-count.bad{color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden}
.mon{border-top:1px solid var(--line-soft)}
.mon:first-child{border-top:0}
.mon>summary{list-style:none;cursor:pointer;user-select:none}
.mon>summary::-webkit-details-marker{display:none}
.mon>summary::marker{content:""}
.mon>summary:hover{background:color-mix(in srgb,var(--text) 3%,transparent)}
.mon[open]>summary{background:color-mix(in srgb,var(--text) 4%,transparent)}
.caret{width:0;height:0;border-left:4px solid var(--muted);border-top:3.5px solid transparent;
  border-bottom:3.5px solid transparent;flex:0 0 auto;transition:transform .12s ease;margin-right:-3px}
.mon[open] .caret{transform:rotate(90deg)}
.monitor{display:grid;grid-template-columns:minmax(150px,1.15fr) minmax(0,2.4fr) 74px;gap:14px;align-items:center;
  padding:9px 13px}
.m-left{display:flex;align-items:center;gap:8px;min-width:0}
.pill{width:6px;height:6px;border-radius:50%;background:var(--muted);flex:0 0 auto}
.pill.up{background:var(--ok)}
.pill.down{background:var(--bad)}
.m-text{min-width:0}
.m-name{font-size:13.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m-sub{font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.m-beats{display:flex;gap:2px;height:30px;align-items:stretch;min-width:0}
.beat{flex:1 1 0;min-width:2px;border-radius:2px;background:var(--empty)}
.beat.up{background:var(--ok)}
.beat.down{background:var(--bad)}
.beat.empty{opacity:.85}
.m-right{text-align:right;font-variant-numeric:tabular-nums;line-height:1.3}
.m-uptime{font-size:12.5px;font-weight:500}
.m-ping{font-size:11.5px;color:var(--muted)}
.panel{padding:2px 13px 12px 32px;font-size:12.5px;display:grid;gap:5px;border-top:1px dashed var(--line-soft)}
.prow{display:grid;grid-template-columns:88px 1fr;gap:10px}
.prow .k{color:var(--muted)}
.prow .v{min-width:0;overflow-wrap:anywhere}
.panel a{color:inherit;text-decoration:none;border-bottom:1px solid var(--line)}
.panel a:hover{color:var(--ok);border-color:var(--ok)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
footer{margin-top:22px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);
  font-size:12px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
footer a{color:inherit;text-decoration:none;border-bottom:1px solid var(--line)}
footer a:hover{color:var(--text)}
@media (max-width:620px){
  .monitor{grid-template-columns:1fr 66px;grid-template-areas:"left right" "beats beats";gap:6px 10px;padding:10px 12px}
  .m-left{grid-area:left}.m-right{grid-area:right}.m-beats{grid-area:beats;height:24px}
  .prow{grid-template-columns:76px 1fr}
  .panel{padding-left:14px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>ssoggy status</h1>
    <div class="meta"><span id="updated">${updated ? "Last updated " + fmtAgo(updated) : "checking…"}</span></div>
  </div>

  <div class="banner ${b.cls}" id="banner">
    <span id="banner-text">${b.text}</span>
    <span class="n" id="banner-count">${total - down}/${total} up</span>
  </div>

  <main id="main">${GROUPS.map((g) => groupBlock(g, rows)).join("")}</main>

  <footer>
    <span>90 beats · 1 minute each · click a row for details</span>
    <span><a href="/api/status">JSON</a></span>
  </footer>
</div>
<script>
const MS = (ms) => ms == null ? "–" : ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s";
const T = (t) => t ? new Date(t).toISOString().slice(11, 19) + " UTC" : "–";
function ago(t){ if(!t) return "never"; const s = Math.max(0, Math.round((Date.now()-t)/1000));
  return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s/60) + "m ago" : Math.round(s/3600) + "h ago"; }
function why(t){
  const L = t.lastChecked, st = t.status, note = t.note || "";
  if (!L) return "No check data yet — the next run will fill this in.";
  if (st === "up") {
    if (t.type === "mc") {
      const p = t.players ? t.players.online + "/" + t.players.max + " players" : "no player data";
      return "Accepting connections. " + p + (t.version ? ", " + t.version : "") + ".";
    }
    if (t.code && t.code >= 400) return "Responding (HTTP " + t.code + ") — it's up, but the app wants auth or a different path.";
    return "Responding normally" + (t.code ? " (HTTP " + t.code + ")" : "") + " in " + MS(t.ms) + ".";
  }
  if (t.type === "mc") {
    if (/timeout/i.test(note)) return "No answer to the Minecraft handshake within 6s — server down, or the proxy in front is broken.";
    if (/refused/i.test(note)) return "Connection refused — nothing is listening on that port.";
    if (/dns/i.test(note)) return "DNS lookup failed — the hostname doesn't resolve.";
    return "Minecraft check failed: " + (note || "unknown error") + ".";
  }
  if (/^HTTP 5\\d\\d/.test(note)) return note + " — Cloudflare reached the origin, but the app behind it is failing (crash, bad upstream, or TLS on the origin).";
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
  for (let i = 0; i < pad; i++) html += '<span class="beat empty"></span>';
  for (const x of b){
    const ok = typeof x === "number" ? x === 1 : !!x.ok;
    const ms = x && x.ms != null ? " · " + MS(x.ms) : "";
    const t = x && x.t ? T(x.t) : "–";
    html += '<span class="beat ' + (ok ? "up" : "down") + '" title="' + (ok ? "Up" : "Down") + " · " + t + ms + '"></span>';
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
    document.querySelectorAll(".mon").forEach((det) => {
      const t = byId[det.dataset.id];
      if (!t) return;
      if (t.status === "down") down++;
      det.querySelector(".pill").className = "pill " + t.status;
      const sr = det.querySelector(".m-name .sr");
      if (sr) sr.textContent = " — " + t.status;
      const bits = [];
      if (t.ms != null) bits.push(MS(t.ms));
      if (t.players) bits.push(t.players.online + "/" + t.players.max + " players");
      if (t.version) bits.push(t.version);
      if (t.code) bits.push("HTTP " + t.code);
      if (t.note && t.status !== "up") bits.push(t.note);
      if (bits.length) det.querySelector(".m-sub").textContent = bits.join(" · ");
      det.querySelector(".m-beats").innerHTML = beats(t.history);
      det.querySelector(".m-uptime").textContent = t.uptime != null ? (t.uptime*100).toFixed(t.uptime >= 0.995 ? 1 : 2) + "%" : "–";
      det.querySelector(".m-ping").textContent = t.avgMs != null ? MS(t.avgMs) : "–";
      const ps = det.querySelector('[data-f="p-status"]');
      if (ps) ps.textContent = t.status + (t.code ? " · HTTP " + t.code : "");
      const pw = det.querySelector('[data-f="p-why"]');
      if (pw) pw.textContent = why(t);
      const pl = det.querySelector('[data-f="p-last"]');
      if (pl) pl.textContent = t.lastChecked ? ago(t.lastChecked) + " · " + T(t.lastChecked) : "never";
    });
    document.querySelectorAll(".group").forEach((sec) => {
      const rows = sec.querySelectorAll(".mon");
      const bad = Array.from(rows).filter(r => r.querySelector(".pill").classList.contains("down")).length;
      const cnt = sec.querySelector(".g-count");
      if (cnt){ cnt.textContent = (rows.length - bad) + "/" + rows.length + " up"; cnt.className = "g-count" + (bad ? " bad" : ""); }
    });
    const total = data.targets.length;
    const cls = down === 0 ? "ok" : down / total >= 0.5 ? "major" : "partial";
    const banner = document.getElementById("banner");
    banner.className = "banner " + cls;
    document.getElementById("banner-text").textContent =
      cls === "ok" ? "All Systems Operational" : cls === "major" ? "Major Outage" : "Partially Degraded Service";
    document.getElementById("banner-count").textContent = (total - down) + "/" + total + " up";
    document.getElementById("updated").textContent = "Last updated " + ago(data.updated);
  }catch(e){}
}
setInterval(refresh, 30000);
</script>
</body>
</html>`;
}

function jsonPayload(state, live) {
  return {
    updated: state.updated || Date.now(),
    targets: TARGETS.map((t) => {
      const entry = state[t.id] || null;
      const last = (live && live[t.id]) || entry?.last || null;
      return {
        id: t.id, name: t.name, group: t.group, type: t.type,
        url: t.url || `${t.host}:${t.port}`,
        status: last ? (last.ok ? "up" : "down") : "unknown",
        ms: last?.ms ?? null, code: last?.code ?? null, note: last?.note ?? null,
        players: last?.players ?? null, version: last?.version ?? null,
        lastChecked: last?.t ?? null,
        uptime: uptimeOf(entry), avgMs: avgMs(entry),
        history: (entry?.history || []).map(normBeat),
      };
    }),
  };
}

/* ------------------------------- worker ------------------------------- */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/status" || path === "/api/check") {
      const state = await readState(env);
      const stale = path === "/api/check" || !state.updated || Date.now() - state.updated > 90_000;
      let live = null;
      let fresh = state;
      if (stale) {
        const run = await runAll(env);
        live = run.byId;
        fresh = await readState(env);
      }
      return json(jsonPayload(fresh, live));
    }

    if (path !== "/" && path !== "/index.html") {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    let state = await readState(env);
    let live = null;
    if (!state.updated || Date.now() - state.updated > 90_000) {
      const run = await runAll(env);
      live = run.byId;
      state = await readState(env);
    }
    return new Response(renderPage(state, live), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=20",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  },
};

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
