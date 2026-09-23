/*
 * Kaspanet web client probe tests — Copyright (C) 2026 KaspaSphere DAO
 * Free software under the GNU Affero General Public License v3 or later.
 * No warranty. Source: https://github.com/KaspaSphereDAO/kaspanet-internet
 */
// Tests for the gateway probe race in webclient/app.js.
//
// The web client is deliberately zero-build and dependency-free, so there is
// nothing to import it with. Instead it runs in a vm context with a stubbed
// DOM and fetch, which is enough to drive openSite()/retryMirror() and read
// back the iframe src and the mirror bar text.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");

const CID = "bafybeibg6g6j6k6j3c2urpit2uunzqxvakq3qgx53dydvyy5bpli34utmi";
const HYPHA = `https://${CID}.ipfs.ipfs.hypha.coop/`;
const FILEBASE = `https://ipfs.filebase.io/ipfs/${CID}/`;

// A fetch stub. `plan` maps a substring of the URL to what that gateway does:
//   {status}           resolve with this status after `after` ms
//   {redirect:true}    resolve as an opaqueredirect
//   {cors:true}        reject with a TypeError, as a CORS block does
//   {hang:true}        never resolve, so the probe's own timeout decides
function makeFetch(plan, clock) {
  return (url, opts) => {
    const key = Object.keys(plan).find(k => url.includes(k));
    const spec = key ? plan[key] : { status: 404 };
    const after = spec.after || 0;
    return new Promise((resolve, reject) => {
      // The real code passes AbortSignal.timeout(PROBE_MS); the stub signal
      // records the deadline so the fake clock can fire it.
      if (opts && opts.signal && opts.signal.__onTimeout) {
        clock.at(opts.signal.__timeout, () => {
          const e = new Error("timeout");
          e.name = "TimeoutError";
          reject(e);
        });
      }
      if (spec.hang) return;
      clock.at(after, () => {
        if (spec.cors) return reject(new TypeError("Failed to fetch"));
        if (spec.redirect) return resolve({ type: "opaqueredirect", status: 0 });
        resolve({ type: "basic", status: spec.status });
      });
    });
  };
}

// Minimal virtual clock: lets a test assert what happens at, say, 3s without
// waiting 3s, and makes the head start observable.
function makeClock() {
  let now = 0;
  let timers = [];
  let seq = 0;
  return {
    now: () => now,
    at(delay, fn) {
      const id = ++seq;
      timers.push({ at: now + (delay || 0), fn, id });
      return id;
    },
    clear(id) { timers = timers.filter(t => t.id !== id); },
    // Run every timer in time order, yielding to the microtask queue between
    // each so awaited promises inside the client can settle.
    async run() {
      for (let guard = 0; guard < 1000 && timers.length; guard++) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = timers.shift();
        now = Math.max(now, t.at);
        t.fn();
        await new Promise(r => setImmediate(r));
      }
    },
  };
}

function load(plan) {
  const clock = makeClock();
  const els = {};
  const mk = id => (els[id] = {
    id, style: {}, src: null, textContent: "", innerHTML: "", value: "",
    addEventListener() {}, closest: () => null,
  });
  ["frame", "mirrorBar", "panel", "content", "addr", "goBtn", "brand", "mirrorRetry", "mirrorInfo"].forEach(mk);

  // Record the virtual time at which the iframe src is set, so a test can
  // assert when the decision was made. Reading clock.now() afterwards would
  // only show the end of the timer queue.
  let src = null;
  els.frame.srcAt = null;
  Object.defineProperty(els.frame, "src", {
    get: () => src,
    set(v) { src = v; els.frame.srcAt = clock.now(); },
  });

  const ctx = {
    console,
    document: {
      getElementById: id => els[id] || mk(id),
      querySelector: () => null, // not embedded in the desktop client
      addEventListener() {},
    },
    location: { hostname: "kaspanet.online", hash: "", search: "", pathname: "/", href: "https://kaspanet.online/" },
    navigator: { onLine: true },
    addEventListener() {},
    URLSearchParams,
    AbortSignal: { timeout: ms => ({ __onTimeout: true, __timeout: ms }) },
    setTimeout: (fn, ms) => clock.at(ms, fn),
    clearTimeout: id => clock.clear(id),
  };
  ctx.fetch = makeFetch(plan, clock);
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, els, clock };
}

// Drives openSite to completion against the virtual clock.
async function open(env, cid = CID) {
  const done = env.ctx.openSite("ipfs", cid, "");
  await new Promise(r => setImmediate(r));
  await env.clock.run();
  await done;
  return {
    src: env.els.frame.src,
    srcAt: env.els.frame.srcAt,
    bar: env.els.mirrorInfo.textContent,
    panel: env.els.content.innerHTML,
  };
}

test("a script-capable gateway that passes wins outright", async () => {
  const env = load({ "hypha": { status: 200, after: 500 }, "filebase": { status: 200, after: 100 } });
  const r = await open(env);
  assert.equal(r.src, HYPHA, "hypha should serve even though filebase answered first");
  assert.equal(r.bar, "Mirror: ipfs.hypha.coop");
});

test("a slow script-capable winner still beats a fast restricted one", async () => {
  // filebase passes at 100ms, hypha at 2500ms, inside the 3s head start.
  const env = load({ "hypha": { status: 200, after: 2500 }, "filebase": { status: 200, after: 100 } });
  const r = await open(env);
  assert.equal(r.src, HYPHA, "the head start should have waited for hypha");
  assert.ok(!/block the site's scripts/.test(r.bar), "no script warning when hypha serves");
});

test("the head start expires and the restricted gateway is used", async () => {
  // hypha hangs past its own 15s timeout, which is what the live gateway does
  // for our CIDs, so the 3s head start expires with nothing better to take.
  const env = load({ "hypha": { hang: true }, "filebase": { status: 200, after: 100 } });
  const r = await open(env);
  assert.equal(r.src, FILEBASE);
  assert.match(r.bar, /^Mirror: ipfs\.filebase\.io/);
  assert.match(r.bar, /block the site's scripts/, "the script warning must show");
  assert.ok(r.srcAt >= 3000, "it should not give up before the head start: " + r.srcAt);
  assert.ok(r.srcAt < 15000, "and it must not wait out hypha's whole timeout: " + r.srcAt);
});

test("only the restricted gateway passes, so it is used with the warning", async () => {
  const env = load({ "hypha": { status: 500, after: 200 }, "filebase": { status: 200, after: 900 } });
  const r = await open(env);
  assert.equal(r.src, FILEBASE);
  assert.match(r.bar, /block the site's scripts/);
});

test("a restricted pass is taken at once when nothing capable is in flight", async () => {
  // hypha fails at 200ms, filebase passes at 900ms: by then there is no
  // script-capable gateway left, so there is nothing to hold it for.
  const env = load({ "hypha": { status: 404, after: 200 }, "filebase": { status: 200, after: 900 } });
  const r = await open(env);
  assert.equal(r.src, FILEBASE);
  assert.ok(r.srcAt < 3000, "it should not sit through the head start: " + r.srcAt);
});

test("no gateway passes, so the failure panel is shown", async () => {
  const env = load({ "hypha": { status: 500, after: 100 }, "filebase": { status: 503, after: 200 } });
  const r = await open(env);
  assert.match(r.panel, /No mirror could serve this site/);
  assert.equal(env.els.frame.style.display, "none");
});

test("a redirect counts as a failure", async () => {
  const env = load({ "hypha": { redirect: true, after: 100 }, "filebase": { status: 200, after: 200 } });
  const r = await open(env);
  assert.equal(r.src, FILEBASE, "a redirecting gateway must not be used");
});

test("a CORS-only failure is a last resort, behind any pass", async () => {
  const env = load({ "hypha": { cors: true, after: 100 }, "filebase": { status: 200, after: 300 } });
  const r = await open(env);
  assert.equal(r.src, FILEBASE, "a verified pass beats an unknown");
});

test("an unknown gateway is used when nothing passes, and marked unverified", async () => {
  const env = load({ "hypha": { cors: true, after: 100 }, "filebase": { status: 500, after: 200 } });
  const r = await open(env);
  assert.equal(r.src, HYPHA);
  assert.match(r.bar, /unverified/);
});

test("Try another mirror overrides the race without re-probing", async () => {
  const env = load({ "hypha": { status: 200, after: 100 }, "filebase": { status: 200, after: 100 } });
  const first = await open(env);
  assert.equal(first.src, HYPHA);

  env.ctx.retryMirror();
  assert.equal(env.els.frame.src, FILEBASE, "it should switch immediately, with no probe");
  assert.match(env.els.mirrorInfo.textContent, /block the site's scripts/);

  env.ctx.retryMirror();
  assert.equal(env.els.frame.src, HYPHA, "and wrap back round");
});

test("a CIDv0 falls back to path style on a subdomain gateway", async () => {
  const env = load({ "hypha": { status: 200, after: 100 }, "filebase": { status: 200, after: 100 } });
  const v0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const r = await open(env, v0);
  assert.equal(r.src, "https://ipfs.hypha.coop/ipfs/" + v0 + "/");
});

test("probes run concurrently, not one after another", async () => {
  // Both gateways are asked before either has answered.
  const seen = [];
  const env = load({ "hypha": { hang: true }, "filebase": { status: 200, after: 100 } });
  const origFetch = env.ctx.fetch;
  env.ctx.fetch = (url, opts) => { seen.push(url); return origFetch(url, opts); };
  await open(env);
  assert.equal(seen.length, 2, "both gateways should have been probed");
  assert.ok(seen.some(u => u.includes("hypha")) && seen.some(u => u.includes("filebase")));
});

/* ----------------------------- the home page "open decentralized copy" link */
// The link used to bake GATEWAYS[gwIndex] into its href at render time, before
// any race had run, so on a fresh load it pointed at the first gateway whether
// or not that gateway could serve the content. It now resolves on click.

// A link element the handler can write status text into.
const linkEl = () => ({ textContent: "open decentralized copy" });

test("the copy link races on click instead of trusting the first gateway", async () => {
  const env = load({ "hypha": { hang: true }, "filebase": { status: 200, after: 100 } });
  const el = linkEl();
  const done = env.ctx.openDecentralizedCopy("ipfs", CID, el);
  await new Promise(r => setImmediate(r));
  await env.clock.run();
  await done;
  assert.equal(env.ctx.location.href, FILEBASE, "it must not send you to a gateway that cannot serve it");
});

test("the copy link reuses the gateway already chosen this session", async () => {
  const env = load({ "hypha": { hang: true }, "filebase": { status: 200, after: 100 } });
  await open(env); // a race runs and settles on filebase
  const before = [];
  const orig = env.ctx.fetch;
  env.ctx.fetch = (u, o) => { before.push(u); return orig(u, o); };

  const el = linkEl();
  env.ctx.openDecentralizedCopy("ipfs", CID, el);
  // Deliberately does not drive the clock: reusing the chosen gateway must
  // settle on microtasks alone. If it ever starts probing again this fails
  // fast here instead of hanging on a race that nothing advances.
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.equal(env.ctx.location.href, FILEBASE, "it should navigate without waiting on a probe");
  assert.equal(before.length, 0, "it should not re-probe when a gateway is already in use");
});

test("the copy link reports failure rather than navigating nowhere", async () => {
  const env = load({ "hypha": { status: 500, after: 100 }, "filebase": { status: 503, after: 200 } });
  const el = linkEl();
  const started = env.ctx.location.href;
  const done = env.ctx.openDecentralizedCopy("ipfs", CID, el);
  await new Promise(r => setImmediate(r));
  await env.clock.run();
  await done;
  assert.equal(env.ctx.location.href, started, "it must not navigate when nothing passed");
  assert.match(el.textContent, /no mirror could serve it/);
});

test("the copy link prefers a script-capable gateway too", async () => {
  const env = load({ "hypha": { status: 200, after: 2500 }, "filebase": { status: 200, after: 100 } });
  const el = linkEl();
  const done = env.ctx.openDecentralizedCopy("ipfs", CID, el);
  await new Promise(r => setImmediate(r));
  await env.clock.run();
  await done;
  assert.equal(env.ctx.location.href, HYPHA, "the head start applies here as well");
});
