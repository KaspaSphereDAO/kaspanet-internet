/*
 * Kaspanet test mock — Copyright (C) 2026 KaspaSphere DAO
 * Free software under the GNU Affero General Public License v3 or later.
 * No warranty. Source: https://github.com/KaspaSphereDAO/kaspanet-internet
 */
// Offline end-to-end tests for KNS resolution and the gateway fetch chain.
//
// The mock serves both the KNS indexer and several fake IPFS gateways from
// one socket. Gateways are told apart by the Host header, because CIDv1
// content is fetched subdomain style (<cid>.ipfs.<host>/...) and there is no
// path in that URL to key off. kaspanet.js exposes a dns lookup seam so every
// hostname resolves to 127.0.0.1 while the URL and Host header keep the
// gateway's real name.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const SITE = {
  "/index.html": ["text/html", "<html><head><link rel='stylesheet' href='./style.css'></head><body><h1>Hello from testsite.kas</h1></body></html>"],
  "/style.css": ["text/css", "h1{color:teal}"],
};

// Per-gateway behaviour, keyed by the host part of the Host header.
//   ok        serves the site
//   redirect  302s to inbrowser.link, the way dweb.link does today
//   notfound  404s every request
const GW_OK = "gw-ok.test";
const GW_REDIRECT = "gw-redirect.test";
const GW_404 = "gw-404.test";
const GW_PATH = "gw-path.test";
// The service-worker gateway dweb.link hands browser traffic to. It answers,
// but with a bootstrap page rather than the file, which is why following the
// redirect has to count as a dead gateway and not a valid hop.
const GW_INBROWSER = "inbrowser.link";

// Requests each gateway actually received, so a test can assert that a
// fall-through really moved on rather than silently reusing a cache.
const hits = { [GW_OK]: 0, [GW_REDIRECT]: 0, [GW_404]: 0, [GW_PATH]: 0, [GW_INBROWSER]: 0 };

function serveSite(res, path) {
  let p = path || "/";
  if (p.endsWith("/")) p += "index.html";
  const f = SITE[p];
  if (!f) { res.writeHead(404); return res.end("no such file"); }
  res.writeHead(200, { "content-type": f[0] });
  res.end(f[1]);
}

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const hostHeader = (req.headers.host || "").split(":")[0];

  // KNS indexer. Reached over a plain 127.0.0.1 URL, so it answers on any host.
  let m = u.pathname.match(/^\/api\/v1\/([^/]+)\/owner$/);
  if (m) {
    if (decodeURIComponent(m[1]) === "testsite.kas") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ success: true, data: { assetId: "abc123i0", asset: "testsite.kas", owner: "kaspa:qtest" } }));
    }
    res.writeHead(404);
    return res.end(JSON.stringify({ success: false }));
  }
  m = u.pathname.match(/^\/api\/v1\/domain\/([^/]+)\/profile$/);
  if (m) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ success: true, data: { assetId: "abc123i0", profile: { website: "ipfs://" + CID, redirectUrl: null } } }));
  }

  // Gateway requests. Subdomain form puts the CID in the hostname, path form
  // in the URL path; work out which gateway is being addressed either way.
  let gw = hostHeader, kind = null, cid = null, path = u.pathname;
  const sub = hostHeader.match(/^([^.]+)\.(ipfs|ipns)\.(.+)$/);
  if (sub) {
    cid = sub[1]; kind = sub[2]; gw = sub[3];
  } else {
    const pm = u.pathname.match(/^\/(ipfs|ipns)\/([^/]+)(\/.*)?$/);
    if (pm) { kind = pm[1]; cid = pm[2]; path = pm[3] || "/"; }
  }

  if (!(gw in hits)) { res.writeHead(404); return res.end("unknown gateway " + gw); }
  hits[gw]++;

  if (gw === GW_REDIRECT) {
    // What dweb.link does to browser traffic today. kaspanet.js must refuse
    // to follow this rather than treating it as a valid hop.
    res.writeHead(302, { location: "https://" + cid + ".ipfs.inbrowser.link" + path });
    return res.end();
  }
  if (gw === GW_INBROWSER) {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<html><body>Loading via service worker\u2026</body></html>");
  }
  if (gw === GW_404) { res.writeHead(404); return res.end("not here"); }
  if (cid !== CID) { res.writeHead(404); return res.end("wrong cid"); }
  return serveSite(res, path);
});

// Start the mock before requiring the client, since KNS_API is read from the
// environment at module load and needs the port the mock landed on.
let kaspanet;

test.before(async () => {
  await new Promise(r => mock.listen(0, "127.0.0.1", r));
  const port = mock.address().port;
  process.env.KNS_API = "http://127.0.0.1:" + port;
  process.env.KASPANET_NO_SERVER = "1";
  kaspanet = require("./kaspanet.js");
  // Point every hostname at the mock, leaving the URL and Host header alone.
  kaspanet.setDnsLookup((hostname, opts, cb) => {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    if (opts && opts.all) return cb(null, [{ address: "127.0.0.1", family: 4 }]);
    cb(null, "127.0.0.1", 4);
  });
});

test.after(() => new Promise(r => mock.close(r)));

test.beforeEach(() => {
  kaspanet.resetCaches();
  for (const k of Object.keys(hits)) hits[k] = 0;
});

const gwSpec = (host, style) => {
  const port = mock.address().port;
  return "http://" + host + ":" + port + (style ? ":" + style : "");
};

test("testsite.kas resolves and serves index.html", async () => {
  kaspanet.setGateways([gwSpec(GW_OK)]);
  const entry = await kaspanet.resolveKas("testsite.kas");
  assert.equal(entry.kind, "ipfs");
  assert.equal(entry.cid, CID);
  const r = await kaspanet.fetchSiteFile(entry.kind, entry.cid, entry.base + "/");
  assert.equal(r.type, "text/html");
  assert.match(r.buf.toString("utf8"), /Hello from testsite\.kas/);
  assert.equal(hits[GW_OK], 1, "the site should come from the first gateway");
});

test("a gateway that 302s to inbrowser.link falls through to the next", async () => {
  kaspanet.setGateways([gwSpec(GW_REDIRECT), gwSpec(GW_OK)]);
  const r = await kaspanet.fetchSiteFile("ipfs", CID, "/index.html");
  assert.match(r.buf.toString("utf8"), /Hello from testsite\.kas/);
  assert.equal(hits[GW_REDIRECT], 1, "the first gateway should have been tried");
  assert.equal(hits[GW_OK], 1, "and the second should have served the file");
  assert.equal(hits[GW_INBROWSER], 0, "the redirect must not be followed");
});

test("the inbrowser.link redirect is rejected, not followed", async () => {
  kaspanet.setGateways([gwSpec(GW_REDIRECT)]);
  await assert.rejects(
    kaspanet.fetchSiteFile("ipfs", CID, "/index.html"),
    /inbrowser\.link/,
    "the redirect target should be named in the error",
  );
});

test("a gateway returning 404 is skipped", async () => {
  kaspanet.setGateways([gwSpec(GW_404), gwSpec(GW_OK)]);
  const r = await kaspanet.fetchSiteFile("ipfs", CID, "/index.html");
  assert.match(r.buf.toString("utf8"), /Hello from testsite\.kas/);
  assert.equal(hits[GW_404], 1);
  assert.equal(hits[GW_OK], 1);
});

test("every gateway failing surfaces an error", async () => {
  kaspanet.setGateways([gwSpec(GW_404), gwSpec(GW_REDIRECT)]);
  await assert.rejects(kaspanet.fetchSiteFile("ipfs", CID, "/index.html"));
  assert.equal(hits[GW_404], 1);
  assert.equal(hits[GW_REDIRECT], 1);
});

test("a path-style gateway is fetched path style", async () => {
  kaspanet.setGateways([gwSpec(GW_PATH, "path")]);
  const r = await kaspanet.fetchSiteFile("ipfs", CID, "/index.html");
  assert.match(r.buf.toString("utf8"), /Hello from testsite\.kas/);
  assert.equal(hits[GW_PATH], 1);
});

test("dweb.link and ipfs.io redirects are refused as well", () => {
  for (const h of ["inbrowser.link", "x.inbrowser.link", "dweb.link", "bafy.ipfs.dweb.link", "ipfs.io"])
    assert.ok(kaspanet.BANNED_REDIRECT_HOSTS.test(h), h + " should be refused");
  for (const h of ["ipfs.hypha.coop", "ipfs.filebase.io", "notdweb.link", "ipfs.iogood.example"])
    assert.ok(!kaspanet.BANNED_REDIRECT_HOSTS.test(h), h + " should be allowed");
});

test("gateway specs parse host, style and scheme", () => {
  assert.deepEqual(kaspanet.parseGatewaySpec("ipfs.hypha.coop"), { host: "ipfs.hypha.coop", style: "subdomain", scheme: "https" });
  assert.deepEqual(kaspanet.parseGatewaySpec("ipfs.filebase.io:path"), { host: "ipfs.filebase.io", style: "path", scheme: "https" });
  assert.deepEqual(kaspanet.parseGatewaySpec(" http://127.0.0.1:9310 "), { host: "127.0.0.1:9310", style: "subdomain", scheme: "http" });
  assert.equal(kaspanet.parseGatewaySpec("   "), null);
});

test("CIDv1 uses the subdomain form, CIDv0 falls back to a path", () => {
  const gw = kaspanet.parseGatewaySpec("ipfs.hypha.coop");
  assert.equal(kaspanet.gatewayFetchUrl(gw, "ipfs", CID, "/index.html"),
    "https://" + CID + ".ipfs.ipfs.hypha.coop/index.html");
  const v0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  assert.equal(kaspanet.gatewayFetchUrl(gw, "ipfs", v0, "/index.html"),
    "https://ipfs.hypha.coop/ipfs/" + v0 + "/index.html");
});
