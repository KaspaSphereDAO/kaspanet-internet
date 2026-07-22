"use strict";
/*
 * Kaspanet Browser — a zero-install decentralized web client for .kas domains.
 * Copyright (C) 2026 KaspaSphere DAO
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * for more details. You should have received a copy of the GNU Affero General
 * Public License along with this program. If not, see
 * <https://www.gnu.org/licenses/>.
 *
 * Source code (AGPL §13): https://github.com/KaspaSphereDAO/kaspanet
 *
 * Same protocol as kaspanet.exe: KNS naming on Kaspa -> ipfs:// pointer ->
 * content from IPFS gateways. Runs entirely client-side (KNS API is CORS-open).
 * Sites render in a sandboxed iframe on a *subdomain* gateway so every site
 * gets its own browser origin (real same-origin isolation; sandbox has no
 * allow-same-origin so the framed origin is opaque).
 */

const KNS_API    = "https://api.knsdomains.org/mainnet";
const GATEWAY    = "https://dweb.link";   // redirects path->subdomain per-CID origins
const HOME_KAS   = "webclient.kas";
const CANONICAL  = "https://kaspanet.online";
const SOURCE_URL = "https://github.com/KaspaSphereDAO/kaspanet";
const BLOCKED_DOMAINS = new Set([]);
const BLOCKED_CIDS = new Set([]);

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|ba[a-z2-7]{20,})$/;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const resolveCache = new Map(); // domain -> {at, entry}

// Running inside kaspanet.exe? Delegate navigation to the local proxy
// (it enforces RAM-only + sealed-mode CSP, which a plain page cannot).
const EMBEDDED = location.hostname === "127.0.0.1" || location.hostname === "localhost";

function parsePointer(s) {
  if (!s || typeof s !== "string") return null;
  s = s.trim(); let m;
  if ((m = s.match(/^ipfs:\/\/([^/?#]+)(\/[^?#]*)?/i))) return CID_RE.test(m[1]) ? { kind:"ipfs", cid:m[1], base:m[2]||"" } : null;
  if ((m = s.match(/^ipns:\/\/([^/?#]+)(\/[^?#]*)?/i))) return { kind:"ipns", cid:m[1], base:m[2]||"" };
  if ((m = s.match(/^(?:https?:\/\/[^/]+)?\/(ipfs|ipns)\/([^/?#]+)(\/[^?#]*)?/i))) return { kind:m[1].toLowerCase(), cid:m[2], base:m[3]||"" };
  if (CID_RE.test(s)) return { kind:"ipfs", cid:s, base:"" };
  return null;
}

async function jfetch(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function resolveKas(domain) {
  domain = domain.toLowerCase();
  if (BLOCKED_DOMAINS.has(domain)) throw new Error("domain is blocklisted");
  const c = resolveCache.get(domain);
  if (c && Date.now() - c.at < 300000) return c.entry;
  const owner = await jfetch(`${KNS_API}/api/v1/${encodeURIComponent(domain)}/owner`);
  if (!owner?.success || !owner?.data?.assetId) throw new Error("domain not registered on KNS");
  const prof = await jfetch(`${KNS_API}/api/v1/domain/${encodeURIComponent(owner.data.assetId)}/profile`);
  const p = prof?.data?.profile || {};
  const ptr = parsePointer(p.website) || parsePointer(p.redirectUrl);
  let entry;
  if (ptr) {
    if (BLOCKED_CIDS.has(ptr.cid)) throw new Error("content is blocklisted");
    entry = { ptr, owner: owner.data.owner };
  } else {
    entry = { card: p, owner: owner.data.owner };
  }
  resolveCache.set(domain, { at: Date.now(), entry });
  return entry;
}

/* ---------------- UI ---------------- */

function showPanel(html) { $("frame").style.display = "none"; $("panel").style.display = "block"; $("content").innerHTML = html; }
function showFrame(url)  { $("panel").style.display = "none"; const f = $("frame"); f.style.display = "block"; f.src = url; }

const OFFLINE_HTML = `<div class="card err"><b><span class="dot bad">&#9679;</span> Offline</b>
  <p class="dim">The KNS indexer can't be reached. Check your Wi-Fi / internet connection and try again.</p>
  <p><a href="#" data-home>&larr; retry</a></p></div>`;

function isNetErr(e) {
  return e.name === "TypeError" || e.name === "TimeoutError" || /Failed to fetch|NetworkError|timeout/i.test(e.message) || !navigator.onLine;
}

function knsCard(domain, p, owner) {
  const link = (u, l) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(l)}</a>`;
  const rows = [];
  if (p.bio) rows.push(esc(p.bio));
  if (p.x) rows.push("X: " + link("https://x.com/" + p.x, "@" + p.x));
  if (p.telegram) rows.push("Telegram: " + link("https://t.me/" + p.telegram, "@" + p.telegram));
  if (p.github) rows.push("GitHub: " + link("https://github.com/" + p.github, p.github));
  if (p.discord) rows.push("Discord: <code>" + esc(p.discord) + "</code>");
  if (p.contactEmail) rows.push("Email: <code>" + esc(p.contactEmail) + "</code>");
  const site = p.website || p.redirectUrl;
  if (site) rows.push("Website (legacy web): " + link(site, site));
  return `
  ${p.bannerUrl ? `<img src="${esc(p.bannerUrl)}" style="width:100%;max-height:180px;object-fit:cover;border-radius:12px">` : ""}
  <div class="card">
    ${p.avatarUrl ? `<img src="${esc(p.avatarUrl)}" style="width:84px;height:84px;border-radius:50%;border:3px solid var(--accent);object-fit:cover">` : ""}
    <h1 style="margin:10px 0 4px">${esc(domain)}</h1>
    <p class="dim">Owner: <code>${esc(owner || "unknown")}</code></p>
    ${rows.map(r => `<p>${r}</p>`).join("")}
    <p class="dim">This domain is registered on KNS but hasn't published a decentralized site yet.
    The owner can set <b>Website</b> to <code>ipfs://&lt;CID&gt;</code> in their KNS profile to go live.</p>
  </div>`;
}

async function openKas(domain) {
  showPanel(`<div class="card"><span class="dim">Resolving <code>${esc(domain)}</code> on Kaspa&hellip;</span></div>`);
  try {
    const entry = await resolveKas(domain);
    if (entry.card) return showPanel(knsCard(domain, entry.card, entry.owner));
    const { kind, cid, base } = entry.ptr;
    showFrame(`${GATEWAY}/${kind}/${cid}${base}/`);
  } catch (e) {
    showPanel(isNetErr(e) ? OFFLINE_HTML
      : `<div class="card err"><b>${esc(domain)}</b> &mdash; ${esc(e.message)}<p><a href="#" data-home>&larr; home</a></p></div>`);
  }
}

function go(input) {
  const d = (input ?? $("addr").value).trim();
  if (!d) return;
  $("addr").value = d;
  if (EMBEDDED) { location.href = "/go?d=" + encodeURIComponent(d); return; }
  const ptr = parsePointer(d);
  if (ptr) return showFrame(`${GATEWAY}/${ptr.kind}/${ptr.cid}${ptr.base}/`);
  const bare = d.replace(/^kas:\/\//i, "").split(/[/?#]/)[0];
  if (/\.kas$/i.test(bare)) { location.hash = bare.toLowerCase(); return openKas(bare.toLowerCase()); }
  if (/^https?:\/\/\S+$/i.test(d)) return void window.open(d, "_blank", "noopener");
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(d)) return void window.open("https://" + d, "_blank", "noopener");
  showPanel(`<div class="card err"><b>Not a .kas name, web address, or IPFS pointer:</b> ${esc(d)}<p><a href="#" data-home>&larr; home</a></p></div>`);
}

async function goHome() {
  location.hash = "";
  showPanel(`<div class="card"><span class="dim">Checking network&hellip;</span></div>`);
  let badge;
  if (EMBEDDED) {
    // Inside kaspanet.exe the sealed CSP blocks direct KNS calls (by design).
    // Ask the local proxy's same-origin /status endpoint instead.
    try {
      const r = await (await fetch("/status", { signal: AbortSignal.timeout(10000) })).json();
      if (r.offline) return showPanel(OFFLINE_HTML);
      badge = r.live
        ? `<span class="dot ok">&#9679;</span> <code>${esc(r.webclient || HOME_KAS)}</code> pulling live from IPFS &mdash; you are on the hosted client inside kaspanet (${esc(r.mode)} mode)`
        : `<span class="dot mid">&#9679;</span> <code>${esc(r.webclient || HOME_KAS)}</code> not live: ${esc(r.detail)}`;
    } catch (e) {
      badge = `<span class="dot mid">&#9679;</span> local status unavailable`;
    }
    return renderHome(badge);
  }
  try {
    const entry = await resolveKas(HOME_KAS);
    if (entry.ptr) {
      const onIt = location.hostname.includes(entry.ptr.cid);
      badge = `<span class="dot ok">&#9679;</span> <code>${esc(HOME_KAS)}</code> pulling live from IPFS`
        + (onIt ? " &mdash; you are on the live decentralized copy" : ` &mdash; <a href="${GATEWAY}/ipfs/${esc(entry.ptr.cid)}/">open decentralized copy</a>`);
    } else {
      badge = `<span class="dot mid">&#9679;</span> <code>${esc(HOME_KAS)}</code> registered but no ipfs:// pointer yet`;
    }
  } catch (e) {
    if (isNetErr(e)) return showPanel(OFFLINE_HTML);
    badge = `<span class="dot mid">&#9679;</span> <code>${esc(HOME_KAS)}</code> not live: ${esc(e.message)}`;
  }
  renderHome(badge);
}

function renderHome(badge) {
  showPanel(`
  <h1>Kaspa<span style="color:var(--accent)">net</span> Browser</h1>
  <p class="dim">Zero-install client for the .kas decentralized web &mdash; KNS naming on Kaspa, content over IPFS. Runs entirely in your browser; no server, no account.</p>
  <div class="card"><span class="dim">${badge}</span></div>
  <div class="card"><b>Search from your address bar</b>
    <p class="dim">Chrome &rarr; Settings &rarr; Search engine &rarr; Manage &rarr; Add:<br>
    URL <code>${CANONICAL}/#%s</code>, shortcut <code>kas</code>.<br>
    Then type <code>kas&nbsp;yourname.kas</code> straight in the omnibox.</p></div>
  <div class="card"><b>Publish a site</b>
    <p class="dim">Upload a static folder to IPFS (relative links, index.html at root), copy the CID,
    and set <b>Website</b> to <code>ipfs://&lt;CID&gt;</code> in your KNS domain profile.</p></div>
  <p class="dim">Sites render in a sandboxed frame with per-site origins (subdomain gateway).
  For the RAM-only, sealed-mode experience, use the kaspanet desktop client.</p>
  <p class="dim">Kaspanet &copy; 2026 KaspaSphere DAO. This software comes with ABSOLUTELY NO WARRANTY.
  Free software under <a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">AGPLv3</a>; you may
  redistribute it under those terms. <a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">Source code</a>.</p>`);
}

addEventListener("DOMContentLoaded", () => {
  $("goBtn").addEventListener("click", () => go());
  $("brand").addEventListener("click", () => goHome());
  $("addr").addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  // delegated handler for "home / retry" links rendered into the result panel
  $("content").addEventListener("click", e => {
    const a = e.target.closest("a[data-home]");
    if (a) { e.preventDefault(); goHome(); }
  });
  const q = new URLSearchParams(location.search).get("q") || decodeURIComponent(location.hash.slice(1));
  if (q) go(q); else goHome();
});
addEventListener("hashchange", () => {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && h !== $("addr").value) go(h);
});
