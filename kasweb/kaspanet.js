#!/usr/bin/env node
/*
 * kaspanet — a RAM-only decentralized web client for .kas domains
 *
 * Copyright (C) 2026 KaspaSphere DAO
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * Source code: https://github.com/KaspaSphereDAO/kaspanet
 *
 * Resolution chain:
 *   name.kas
 *     -> KNS indexer:  GET {KNS_API}/api/v1/{domain}/owner        (domain -> assetId)
 *     -> KNS indexer:  GET {KNS_API}/api/v1/domain/{assetId}/profile
 *     -> profile.website / profile.redirectUrl must contain an IPFS pointer
 *        (ipfs://CID, ipns://name, /ipfs/CID, gateway URL, or bare CID)
 *     -> site files fetched via moderated public IPFS gateways (Bad Bits denylist)
 *
 * Security model:
 *   - ALL content lives in volatile RAM only. Nothing is ever written to disk.
 *   - Content renders in the OS browser sandbox behind a strict CSP:
 *       no external network access, no form submission, no frames.
 *   - Server binds 127.0.0.1 only.
 *   - Client-side blocklist (CIDs + domains) checked before any fetch.
 *   - Optional allowlist mode: only listed domains resolve (--allowlist a.kas,b.kas)
 *   - Legacy https:// pointers are shown as a warning page, never auto-followed.
 */
"use strict";

const http = require("http");
const https = require("https");
const { execFile } = require("child_process");

/* ------------------------------------------------------------------ config */

const KNS_API = process.env.KNS_API || "https://api.knsdomains.org/mainnet";
const GATEWAYS = (process.env.GATEWAYS ||
  "https://ipfs.io,https://dweb.link,https://gateway.pinata.cloud"
).split(",").map(s => s.trim()).filter(Boolean);

const MAX_FILE_BYTES = 25 * 1024 * 1024;   // 25 MB per file
const MAX_CACHE_BYTES = 100 * 1024 * 1024; // 100 MB total RAM cache
const CACHE_TTL_MS = 15 * 60 * 1000;       // 15 min
const RESOLVE_TTL_MS = 5 * 60 * 1000;      // 5 min domain->CID cache

// Client-side moderation. Add known-bad CIDs / domains here or ship a list.
const BLOCKED_CIDS = new Set([]);
const BLOCKED_DOMAINS = new Set([]);

// The canonical hosted home page of the Kaspanet browser. When this domain's
// IPFS site pulls live, it IS the default/new-tab page; otherwise the built-in
// fallback UI below (same functionality) is used and the status is shown.
const HOME_DOMAIN = process.env.WEBCLIENT_DOMAIN || "webclient.kas";

let ALLOWLIST = null; // null = open mode; Set = only these domains resolve
const alArg = process.argv.find(a => a.startsWith("--allowlist="));
if (alArg) ALLOWLIST = new Set(alArg.slice(12).split(",").map(s => s.trim().toLowerCase()).filter(Boolean));

// Network mode (RAM state, resets to sealed on every launch):
//   "sealed" — Kaspanet only. Sites cannot touch the regular internet at all.
//   "open"   — Kaspanet + Internet. Sites may call live web APIs / load live
//              resources, and legacy https:// pointers are followed. Live, not
//              snapshots: pages talk to the real internet directly.
let NET_MODE = process.argv.includes("--internet") ? "open" : "sealed";

/* -------------------------------------------------------- RAM-only caches */

const fileCache = new Map();   // key -> {buf, type, at}
let fileCacheBytes = 0;
const resolveCache = new Map(); // domain -> {cid, kind, at} | {legacy, at} | {err, at}

function cachePut(key, buf, type) {
  if (buf.length > MAX_FILE_BYTES) return;
  while (fileCacheBytes + buf.length > MAX_CACHE_BYTES && fileCache.size) {
    const k = fileCache.keys().next().value;
    fileCacheBytes -= fileCache.get(k).buf.length;
    fileCache.delete(k);
  }
  fileCache.set(key, { buf, type, at: Date.now() });
  fileCacheBytes += buf.length;
}
function cacheGet(key) {
  const e = fileCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    fileCacheBytes -= e.buf.length;
    fileCache.delete(key);
    return null;
  }
  return e;
}

/* ------------------------------------------------------------- http utils */

function fetchRaw(url, maxBytes, redirects) {
  redirects = redirects === undefined ? 4 : redirects;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error("bad url")); }
    if (u.protocol !== "https:" && u.protocol !== "http:") return reject(new Error("bad protocol"));
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(u, { headers: { "User-Agent": "kaspanet/0.1", "Accept": "*/*" } }, res => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchRaw(new URL(res.headers.location, u).href, maxBytes, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error("HTTP " + res.statusCode));
      }
      const chunks = [];
      let n = 0;
      res.on("data", c => {
        n += c.length;
        if (n > maxBytes) { req.destroy(); return reject(new Error("file exceeds size cap")); }
        chunks.push(c);
      });
      res.on("end", () => resolve({ buf: Buffer.concat(chunks), type: res.headers["content-type"] || "" }));
      res.on("error", reject);
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

async function fetchJSON(url) {
  const { buf } = await fetchRaw(url, 1024 * 1024);
  return JSON.parse(buf.toString("utf8"));
}

/* --------------------------------------------------------- KNS resolution */

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|ba[a-z2-7]{20,})$/;

// Accepts: ipfs://CID[/p], ipns://name[/p], /ipfs/CID, https://gw/ipfs/CID, bare CID
function parsePointer(s) {
  if (!s || typeof s !== "string") return null;
  s = s.trim();
  let m;
  if ((m = s.match(/^ipfs:\/\/([^/?#]+)(\/[^?#]*)?/i)))
    return CID_RE.test(m[1]) ? { kind: "ipfs", cid: m[1], base: m[2] || "" } : null;
  if ((m = s.match(/^ipns:\/\/([^/?#]+)(\/[^?#]*)?/i)))
    return { kind: "ipns", cid: m[1], base: m[2] || "" };
  if ((m = s.match(/^(?:https?:\/\/[^/]+)?\/(ipfs|ipns)\/([^/?#]+)(\/[^?#]*)?/i)))
    return { kind: m[1].toLowerCase(), cid: m[2], base: m[3] || "" };
  if (CID_RE.test(s)) return { kind: "ipfs", cid: s, base: "" };
  return null;
}

async function resolveKas(domain) {
  domain = domain.toLowerCase();
  if (!/^[^\s/\\]+\.kas$/.test(domain)) throw new Error("not a .kas name");
  if (BLOCKED_DOMAINS.has(domain)) throw new Error("domain is blocklisted");
  if (ALLOWLIST && !ALLOWLIST.has(domain)) throw new Error("domain not in allowlist (client is in curated mode)");

  const c = resolveCache.get(domain);
  if (c && Date.now() - c.at < RESOLVE_TTL_MS) {
    if (c.err) throw new Error(c.err);
    return c;
  }

  let entry;
  try {
    const owner = await fetchJSON(KNS_API + "/api/v1/" + encodeURIComponent(domain) + "/owner");
    if (!owner || !owner.success || !owner.data || !owner.data.assetId)
      throw new Error("domain not registered on KNS");
    const prof = await fetchJSON(KNS_API + "/api/v1/domain/" + encodeURIComponent(owner.data.assetId) + "/profile");
    const p = (prof && prof.data && prof.data.profile) || {};
    // Auto-detect the IPFS site pointer from EITHER inscription field: a domain
    // may put ipfs://CID in its Website, or in its Redirect URL — both work.
    const ptr = parsePointer(p.website) || parsePointer(p.redirectUrl);
    if (ptr) {
      if (BLOCKED_CIDS.has(ptr.cid)) throw new Error("content is blocklisted");
      entry = { kind: ptr.kind, cid: ptr.cid, base: ptr.base, owner: owner.data.owner, at: Date.now() };
    } else {
      // No decentralized pointer yet — show the domain's KNS card instead.
      entry = { card: p, owner: owner.data.owner, at: Date.now() };
    }
  } catch (e) {
    resolveCache.set(domain, { err: e.message, at: Date.now() });
    throw e;
  }
  resolveCache.set(domain, entry);
  return entry;
}

/* -------------------------------------------- webclient.kas live check */

const OFFLINE_RE = /ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|timeout/i;
let webclientStatus = { at: 0, ok: false, offline: false, reason: "not checked yet" };

async function checkWebclient() {
  if (Date.now() - webclientStatus.at < 30000) return webclientStatus;
  let s;
  try {
    const entry = await resolveKas(HOME_DOMAIN);
    if (entry.card) {
      s = { ok: false, offline: false, reason: HOME_DOMAIN + " is registered but has no ipfs:// pointer yet" };
    } else {
      await fetchSiteFile(entry.kind, entry.cid, entry.base + "/");
      s = { ok: true, offline: false, reason: "pulling live from IPFS" };
    }
  } catch (e) {
    s = OFFLINE_RE.test(e.message)
      ? { ok: false, offline: true, reason: "network unreachable — you appear to be offline" }
      : { ok: false, offline: false, reason: e.message };
  }
  s.at = Date.now();
  webclientStatus = s;
  return s;
}

async function fetchSiteFile(kind, cid, path) {
  const key = kind + "/" + cid + path;
  const hit = cacheGet(key);
  if (hit) return hit;
  let lastErr;
  for (const gw of GATEWAYS) {
    try {
      const r = await fetchRaw(gw + "/" + kind + "/" + cid + path, MAX_FILE_BYTES);
      cachePut(key, r.buf, r.type);
      return r;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("all gateways failed");
}

/* ----------------------------------------------------------------- server */

// CSP presets. Sealed: page may use its own inline scripts/styles but has NO
// external network access, cannot submit forms, cannot be framed.
// Open: page may reach the live internet over https (APIs, images, media),
// but forms, frames and plugins stay blocked in both modes.
const CSP_SEALED = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");
const CSP_OPEN = [
  "default-src 'self' https:",
  "script-src 'self' 'unsafe-inline' https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https:",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join("; ");
const siteCsp = () => (NET_MODE === "open" ? CSP_OPEN : CSP_SEALED);

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function shell(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  body{background:#0b0e14;color:#d7dce2;font-family:system-ui,sans-serif;max-width:780px;margin:40px auto;padding:0 20px}
  a{color:#49EACB}input{background:#151a23;border:1px solid #2a3140;color:#d7dce2;padding:12px 14px;border-radius:8px;width:70%;font-size:16px}
  button{background:#49EACB;border:0;color:#06281f;padding:12px 22px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer}
  .card{background:#11151d;border:1px solid #222a38;border-radius:12px;padding:22px;margin:18px 0}
  code{background:#151a23;padding:2px 6px;border-radius:4px}
  .warn{border-color:#8a6d1a}.err{border-color:#7a2733}
  h1{font-weight:600}.dim{color:#8b93a1;font-size:14px}
  </style></head><body>${body}</body></html>`;
}

function homePage(status) {
  const sealed = NET_MODE !== "open";
  const st = status || webclientStatus;
  const stBadge = st.ok
    ? `<span style="color:#49EACB">&#9679;</span> <code>${esc(HOME_DOMAIN)}</code> pulling live from IPFS &mdash; <a href="/site/${esc(HOME_DOMAIN)}/">open hosted client</a>`
    : st.offline
      ? `<span style="color:#e05561">&#9679;</span> <b>Offline</b> &mdash; check your Wi-Fi / internet connection. Using built-in fallback client.`
      : `<span style="color:#d7a021">&#9679;</span> <code>${esc(HOME_DOMAIN)}</code> not live: ${esc(st.reason)}. Using built-in fallback client.`;
  return shell("Kaspanet Browser", `
  <h1>Kaspa<span style="color:#49EACB">net</span> Browser</h1>
  <p class="dim">RAM-only client for the .kas decentralized web &mdash; KNS naming on Kaspa, content over IPFS. Nothing is ever saved to your disk.</p>
  <div class="card${st.ok ? "" : st.offline ? " err" : " warn"}"><span class="dim">${stBadge}</span></div>
  <div class="card"><form action="/go" method="GET" onsubmit="return true">
    <input name="d" placeholder="name.kas, example.com, or ipfs://CID" autofocus autocomplete="off">
    <button>Visit</button>
  </form></div>
  <div class="card${sealed ? "" : " warn"}"><b>Network mode</b><br><br>
    <a href="/mode?m=sealed&then=%2Fhome" style="text-decoration:none"><button ${sealed ? "" : 'style="background:#2a3140;color:#8b93a1"'}>Kaspanet only</button></a>
    &nbsp;
    <a href="/mode?m=open&then=%2Fhome" style="text-decoration:none"><button ${sealed ? 'style="background:#2a3140;color:#8b93a1"' : ""}>Kaspanet + Internet</button></a>
    <p class="dim">${sealed
      ? "Sealed: sites cannot reach the regular internet at all. Maximum privacy, fully self-contained."
      : "Open: sites may talk to the live internet (live APIs, prices, streams) and legacy web links are followed. Pages can see your IP like normal browsing."}</p></div>
  <div class="card"><b>Publish a site</b><p class="dim">1. Upload a static site folder to IPFS (relative links, index.html at root) and copy its CID.<br>
  2. In your KNS domain profile, set <b>Website</b> to <code>ipfs://&lt;CID&gt;</code>.<br>
  3. Anyone running this client can then visit <code>yourname.kas</code>.</p></div>
  <p class="dim">Naming: ${ALLOWLIST ? "curated allowlist (" + ALLOWLIST.size + " domains)" : "open (moderated gateways + blocklist)"} &middot; cache: RAM only, ${Math.round(MAX_CACHE_BYTES / 1e6)} MB cap</p>
  <p class="dim">kaspanet &copy; 2026 KaspaSphere DAO. This program comes with ABSOLUTELY NO WARRANTY.
  Free software under <a href="/source">AGPLv3</a>; you may redistribute it under those terms.
  <a href="/source">Source code</a>.</p>`);
}

// KNS profile card for .kas domains that have no ipfs:// pointer yet.
function knsCard(domain, p, owner) {
  const open = NET_MODE === "open";
  const link = (url, label) => open
    ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(label)}</a>`
    : `<code>${esc(label)}</code>`;
  const rows = [];
  if (p.bio) rows.push(`<p>${esc(p.bio)}</p>`);
  if (p.x) rows.push(`X: ${link("https://x.com/" + p.x, "@" + p.x)}`);
  if (p.telegram) rows.push(`Telegram: ${link("https://t.me/" + p.telegram, "@" + p.telegram)}`);
  if (p.github) rows.push(`GitHub: ${link("https://github.com/" + p.github, p.github)}`);
  if (p.discord) rows.push(`Discord: <code>${esc(p.discord)}</code>`);
  if (p.contactEmail) rows.push(`Email: <code>${esc(p.contactEmail)}</code>`);
  const site = p.website || p.redirectUrl;
  if (site) rows.push(`Website (legacy web): ${link(site, site)}${open ? "" : ' <span class="dim">— switch to Kaspanet + Internet to follow</span>'}`);
  return shell(domain, `
  ${p.bannerUrl ? `<img src="${esc(p.bannerUrl)}" style="width:100%;max-height:180px;object-fit:cover;border-radius:12px">` : ""}
  <div class="card" style="margin-top:${p.bannerUrl ? "-40px" : "18px"}">
    ${p.avatarUrl ? `<img src="${esc(p.avatarUrl)}" style="width:84px;height:84px;border-radius:50%;border:3px solid #49EACB;object-fit:cover">` : ""}
    <h1 style="margin:10px 0 4px">${esc(domain)}</h1>
    <p class="dim" style="word-break:break-all">Owner: <code>${esc(owner || "unknown")}</code></p>
    ${rows.map(r => `<p>${r}</p>`).join("")}
    <p class="dim">This domain is registered on KNS but hasn't published a decentralized site yet.
    The owner can set <b>Website</b> to <code>ipfs://&lt;CID&gt;</code> in their KNS profile to go live.</p>
    <p><a href="/">&larr; home</a></p>
  </div>`);
}

function send(res, code, type, body, extra) {
  const h = Object.assign({
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  }, extra || {});
  res.writeHead(code, h);
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://127.0.0.1");
    const path = u.pathname;

    // Default / new-tab page: hosted webclient.kas when it pulls live,
    // otherwise the built-in fallback client with a status banner.
    if (path === "/") {
      const st = await checkWebclient();
      if (st.ok) return send(res, 302, "text/plain", "", { Location: "/site/" + HOME_DOMAIN + "/" });
      return send(res, 200, "text/html; charset=utf-8", homePage(st));
    }

    // Built-in fallback client, always reachable even when webclient.kas is live.
    if (path === "/home") {
      const st = await checkWebclient();
      return send(res, 200, "text/html; charset=utf-8", homePage(st));
    }

    // AGPL §13: give network users a way to obtain the Corresponding Source.
    if (path === "/source")
      return send(res, 302, "text/plain", "", { Location: "https://github.com/KaspaSphereDAO/kaspanet" });

    if (path === "/status") {
      const st = await checkWebclient();
      return send(res, 200, "application/json",
        JSON.stringify({ webclient: HOME_DOMAIN, live: st.ok, offline: st.offline, detail: st.reason, mode: NET_MODE }));
    }

    if (path === "/mode") {
      const m = u.searchParams.get("m");
      if (m === "open" || m === "sealed") NET_MODE = m;
      const then = u.searchParams.get("then") || "/";
      const dest = (then.startsWith("/") || (/^https:\/\//i.test(then) && NET_MODE === "open")) ? then : "/";
      return send(res, 302, "text/plain", "", { Location: dest });
    }

    if (path === "/go") {
      const d = (u.searchParams.get("d") || "").trim();
      const ptr = parsePointer(d);
      if (ptr) return send(res, 302, "text/plain", "", { Location: "/" + ptr.kind + "/" + ptr.cid + (ptr.base || "/") });
      if (/\.kas(\/|$)/i.test(d.replace(/^kas:\/\//i, "").split(/[?#]/)[0]))
        return send(res, 302, "text/plain", "", { Location: "/site/" + encodeURIComponent(d.replace(/^kas:\/\//i, "").split(/[/?#]/)[0].toLowerCase()) + "/" });

      // Legacy internet detection: full URL or bare domain.tld (.com, .org, ...)
      let legacyUrl = null;
      if (/^https?:\/\/\S+$/i.test(d)) legacyUrl = d;
      else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(d)) legacyUrl = "https://" + d;
      if (legacyUrl) {
        if (NET_MODE === "open") return send(res, 302, "text/plain", "", { Location: legacyUrl });
        return send(res, 200, "text/html; charset=utf-8",
          shell("legacy web", `<div class="card warn"><b>Legacy internet address:</b><br><br><code>${esc(legacyUrl)}</code><br><br>
          <span class="dim">You're in Kaspanet-only mode, which never touches the regular internet.</span><br><br>
          <a href="/mode?m=open&then=${encodeURIComponent(legacyUrl)}" style="text-decoration:none"><button>Switch to Kaspanet + Internet &amp; visit</button></a>
          <p><a href="/">&larr; home</a></p></div>`));
      }
      return send(res, 200, "text/html; charset=utf-8",
        shell("error", `<div class="card err"><b>Not a .kas name, web address, or IPFS pointer:</b> ${esc(d)}<p><a href="/">&larr; home</a></p></div>`));
    }

    // /site/name.kas/...  — resolve via KNS then proxy from gateways
    let m = path.match(/^\/site\/([^/]+)$/);
    if (m) return send(res, 302, "text/plain", "", { Location: path + "/" });

    m = path.match(/^\/site\/([^/]+)\/(.*)$/);
    if (m) {
      const domain = decodeURIComponent(m[1]);
      const rest = "/" + m[2];
      let entry;
      try {
        entry = await resolveKas(domain);
      } catch (e) {
        return send(res, 200, "text/html; charset=utf-8",
          shell("error", `<div class="card err"><b>${esc(domain)}</b> &mdash; ${esc(e.message)}<p><a href="/">&larr; home</a></p></div>`));
      }
      if (entry.card)
        return send(res, 200, "text/html; charset=utf-8", knsCard(domain, entry.card, entry.owner));
      const { buf, type } = await fetchSiteFile(entry.kind, entry.cid, entry.base + rest);
      return send(res, 200, type || "application/octet-stream", buf, { "Content-Security-Policy": siteCsp() });
    }

    // /ipfs/CID/... or /ipns/name/... — direct pointer browsing
    m = path.match(/^\/(ipfs|ipns)\/([^/]+)$/);
    if (m) return send(res, 302, "text/plain", "", { Location: path + "/" });
    m = path.match(/^\/(ipfs|ipns)\/([^/]+)\/(.*)$/);
    if (m) {
      if (BLOCKED_CIDS.has(m[2])) return send(res, 403, "text/plain", "blocked");
      if (ALLOWLIST) return send(res, 403, "text/plain", "direct CID browsing disabled in curated mode");
      const { buf, type } = await fetchSiteFile(m[1], m[2], "/" + m[3]);
      return send(res, 200, type || "application/octet-stream", buf, { "Content-Security-Policy": siteCsp() });
    }

    send(res, 404, "text/plain", "not found");
  } catch (e) {
    send(res, 200, "text/html; charset=utf-8",
      shell("error", `<div class="card err"><b>Error:</b> ${esc(e.message)}<p><a href="/">&larr; home</a></p></div>`));
  }
});

server.listen(0, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + server.address().port + "/";
  console.log("kaspanet running at " + url + "  (RAM-only; close this window to wipe everything)");
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  if (!process.env.NO_OPEN) execFile(opener[0], opener[1], () => {});
});
