import { connect } from "cloudflare:sockets";

/**
 * ssoggy status — Cloudflare Worker
 *
 * Per-service copy lives in TARGETS below:
 *   about: what the thing is (shown in the expanded row)
 *   note:  anything you want to say — known issues, quirks, "ignore the 502 on Tuesdays"
 *          Shown in the expanded row under "Note". Leave it out if there's nothing to say.
 */

const TARGETS = [
  // ---- Game ----
  {
    id: "minecraft", name: "Minecraft", group: "Game", type: "mc", host: "mc.ssoggy.com", port: 25565,
    sub: "mc.ssoggy.com:25565",
    about: "Velocity proxy on the Oracle box, forwarding to the Nest container.",
    // note: "",
  },

  // ---- Vercel ----
  { id: "taalswipe", name: "TaalSwipe", group: "Vercel", type: "http", url: "https://taalswipe.ssoggy.com/", about: "Vercel · production branch." },
  { id: "minimusiclab", name: "MiniMusicLab", group: "Vercel", type: "http", url: "https://minimusiclab.ssoggy.com/", about: "Vercel · static site." },
  { id: "sprig", name: "Sprig", group: "Vercel", type: "http", url: "https://sprig.ssoggy.com/", about: "Vercel · takes a couple of seconds on cold start." },
  { id: "excel-dash", name: "Excel Dash (preview)", group: "Vercel", type: "http", url: "https://excel-dash-preview.ssoggy.com/", about: "Vercel · preview build." },
  { id: "ssoggysouls", name: "SSoggySouls Docs", group: "Vercel", type: "http", url: "https://ssoggysouls.ssoggy.com/", about: "Jekyll docs, built by Vercel from the mod repo." },
  { id: "portfolio", name: "Portfolio", group: "Vercel", type: "http", url: "https://maarenaurich.com/", about: "Vercel · apex of maarenaurich.com." },
  { id: "vishandel", name: "Vishandel Volendam", group: "Vercel", type: "http", url: "https://vishandelvolendam.maarenaurich.com/", about: "Vercel · client site." },

  // ---- Cloudflare Pages ----
  { id: "ai", name: "AI Chat", group: "Cloudflare Pages", type: "http", url: "https://ai.ssoggy.com/", about: "Cloudflare Pages · ai-chat-export." },
  { id: "oba", name: "Beleggers Academie", group: "Cloudflare Pages", type: "http", url: "https://oba.ssoggy.com/", about: "Cloudflare Pages · online-beleggers-academie." },
  { id: "cev", name: "CEV Dashboard", group: "Cloudflare Pages", type: "http", url: "https://cev.ssoggy.com/", about: "Cloudflare Pages · same project as OBA, different route." },

  // ---- GitHub Pages ----
  { id: "ghpages", name: "GitHub Pages", group: "GitHub Pages", type: "http", url: "https://ssoggytacoblud.github.io/", about: "Static site served by GitHub Pages." },

  // ---- Nest VPS ----
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
      headers: { "user-agent": "ssoggy-status/3.0 (+status.ssoggy.com)" },
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

/* ------------------------------- render ------------------------------- */

const CHEVRON = `<svg class="chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>`;

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
  const bits = [];
  if (last?.ms != null) bits.push(fmtMs(last.ms));
  if (last?.players) bits.push(`${last.players.online}/${last.players.max} players`);
  if (last?.version) bits.push(last.version);
  if (last?.code) bits.push("HTTP " + last.code);
  if (last?.note && state !== "up") bits.push(last.note);
  const sub = bits.length ? bits.join(" · ") : (t.sub || t.url);

  const link = t.url
    ? `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>`
    : `<span>${esc(t.sub || t.host)}</span>`;
  const beats = (entry?.history || []).map(normBeat);
  const failed = beats.filter((b) => !b.ok).length;

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
  --bg:#ffffff; --fg:#16181c; --muted:#70757d; --faint:#9aa0a8;
  --line:#e4e6ea; --line-2:#f0f1f4;
  --ok:#1a9d54; --bad:#d1332e; --warn:#a8710a; --empty:#e9ebee;
  --panel:#fafbfc;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#0d0f12; --fg:#e7e9ec; --muted:#8b9199; --faint:#666c75;
    --line:#232730; --line-2:#1a1e25; --ok:#35c46b; --bad:#ff6361; --warn:#d29922; --empty:#232730; --panel:#111418; }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:13.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.wrap{max-width:820px;margin:0 auto;padding:30px 20px 44px}
.top{display:flex;align-items:baseline;gap:10px;margin-bottom:18px}
h1{font-size:14px;font-weight:600;margin:0;letter-spacing:-.005em}
.meta{margin-left:auto;font-size:11px;color:var(--faint);font-family:var(--mono)}
.banner{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:550;
  padding:9px 12px;margin-bottom:22px;border:1px solid var(--line);border-left-width:3px;border-radius:3px}
.banner.ok{border-left-color:var(--ok);color:var(--ok);background:color-mix(in srgb,var(--ok) 6%,transparent)}
.banner.partial{border-left-color:var(--warn);color:var(--warn);background:color-mix(in srgb,var(--warn) 7%,transparent)}
.banner.major{border-left-color:var(--bad);color:var(--bad);background:color-mix(in srgb,var(--bad) 7%,transparent)}
.banner .n{margin-left:auto;font-weight:500;font-family:var(--mono);font-size:11px;opacity:.9}
.group{margin:0 0 20px}
.g-head{display:flex;align-items:baseline;gap:8px;margin:0 0 7px}
.g-head h2{font-size:10.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0}
.g-count{margin-left:auto;font-family:var(--mono);font-size:10.5px;color:var(--faint)}
.g-count.bad{color:var(--bad)}
.list{border:1px solid var(--line);border-radius:3px;overflow:hidden}
.row{border-top:1px solid var(--line-2)}
.row:first-child{border-top:0}
.row>summary{display:grid;grid-template-columns:8px minmax(120px,1fr) minmax(0,2.2fr) 52px 58px 14px;
  gap:12px;align-items:center;padding:8px 12px;cursor:pointer;list-style:none;user-select:none}
.row>summary::-webkit-details-marker{display:none}
.row>summary::marker{content:""}
.row>summary:hover{background:var(--panel)}
.row[open]{background:var(--panel)}
.state{width:6px;height:6px;border-radius:50%;background:var(--faint)}
.state.up{background:var(--ok)}
.state.down{background:var(--bad)}
.name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.beats{display:flex;gap:2px;height:24px;align-items:stretch;min-width:0}
.beat{flex:1 1 0;min-width:1px;border-radius:1px;background:var(--empty)}
.beat.up{background:var(--ok);opacity:.75}
.beat.down{background:var(--bad)}
.beat.empty{opacity:.5}
.num{font-family:var(--mono);font-size:11px;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.num.ms{color:var(--faint)}
.chev{color:var(--faint);transition:transform .14s ease;justify-self:end}
.row[open] .chev{transform:rotate(90deg)}
.detail{display:grid;gap:3px;padding:2px 12px 11px 32px;font-size:12px}
.drow{display:grid;grid-template-columns:56px 1fr;gap:10px}
.drow .k{font-family:var(--mono);font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);padding-top:2px}
.drow .v{color:var(--muted);min-width:0;overflow-wrap:anywhere}
.drow a{color:var(--fg);text-decoration:none;border-bottom:1px solid var(--line)}
.drow a:hover{border-color:var(--fg)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;font-style:normal}
footer{margin-top:26px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;
  font-size:11px;color:var(--faint);font-family:var(--mono)}
footer a{color:var(--faint);text-decoration:none;border-bottom:1px solid var(--line)}
footer a:hover{color:var(--fg)}
@media (max-width:640px){
  .row>summary{grid-template-columns:8px 1fr 44px 14px;grid-template-areas:"state name up chev" ". beats beats beats";gap:5px 10px;padding:9px 11px}
  .state{grid-area:state}.name{grid-area:name}.num.up{grid-area:up}.chev{grid-area:chev}
  .beats{grid-area:beats;height:20px}.num.ms{display:none}
  .detail{padding-left:14px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1>ssoggy status</h1>
    <span class="meta"><span id="updated">${updated ? "Updated " + fmtAgo(updated) : "checking…"}</span></span>
  </div>

  <div class="banner ${b.cls}" id="banner">
    <span id="banner-text">${b.text}</span>
    <span class="n" id="banner-count">${total - down}/${total}</span>
  </div>

  <main id="main">${GROUPS.map((g) => groupBlock(g, rows)).join("")}</main>

  <footer>
    <span>90 samples · 60s interval · click a row</span>
    <span><a href="/api/status">json</a></span>
  </footer>
</div>
<script>
const MS = (ms) => ms == null ? "–" : ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(2) + " s";
const T = (t) => t ? new Date(t).toISOString().slice(11, 19) + " UTC" : "–";
function ago(t){ if(!t) return "never"; const s = Math.max(0, Math.round((Date.now()-t)/1000));
  return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s/60) + "m ago" : Math.round(s/3600) + "h ago"; }
function why(t){
  const st = t.status, note = t.note || "";
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
    document.getElementById("updated").textContent = "Updated " + ago(data.updated);
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
      let live = null, fresh = state;
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
