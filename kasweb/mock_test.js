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

// testsite.kas stands in for the home domain (WEBCLIENT_DOMAIN below);
// othersite.kas is an ordinary third-party site, to check it is proxied
// untouched.
const KNS_DOMAINS = { "testsite.kas": "abc123i0", "othersite.kas": "def456i0" };

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
    const domain = decodeURIComponent(m[1]);
    if (domain in KNS_DOMAINS) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ success: true, data: { assetId: KNS_DOMAINS[domain], asset: domain, owner: "kaspa:qtest" } }));
    }
    res.writeHead(404);
    return res.end(JSON.stringify({ success: false }));
  }
  m = u.pathname.match(/^\/api\/v1\/domain\/([^/]+)\/profile$/);
  if (m) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ success: true, data: { assetId: m[1], profile: { website: "ipfs://" + CID, redirectUrl: null } } }));
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
  process.env.WEBCLIENT_DOMAIN = "testsite.kas";
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

/* ------------------------------------------------- embedded marker tests */
// The desktop client marks the web client HTML it serves so the client can
// tell it is embedded. A hostname check cannot do this: the proxy is on
// 127.0.0.1, and so is any static server used to serve dist-webclient in
// development.

// Drives the real proxy over a socket, so these exercise the route rather
// than the injection helper on its own.
function proxyGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: kaspanet.server.address().port, path },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode,
          type: res.headers["content-type"] || "",
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
  });
}

test("kasweb marks the web client HTML it serves", async () => {
  kaspanet.setGateways([gwSpec(GW_OK)]);
  await new Promise(r => kaspanet.server.listen(0, "127.0.0.1", r));
  try {
    const home = await proxyGet("/site/testsite.kas/");
    assert.equal(home.status, 200);
    assert.match(home.type, /^text\/html/);
    assert.ok(home.body.includes(kaspanet.EMBED_MARKER), "the marker should be present");
    assert.match(home.body, /<head[^>]*>\s*<meta name="kaspanet-embedded"/, "it belongs in the head");
    assert.match(home.body, /Hello from testsite\.kas/, "the page itself must survive");

    // A third-party .kas site is proxied byte for byte.
    const other = await proxyGet("/site/othersite.kas/");
    assert.equal(other.status, 200);
    assert.ok(!other.body.includes("kaspanet-embedded"), "other sites must not be marked");

    // Only HTML is touched, never assets.
    const css = await proxyGet("/site/testsite.kas/style.css");
    assert.equal(css.body, "h1{color:teal}");
  } finally {
    await new Promise(r => kaspanet.server.close(r));
  }
});

test("markEmbedded only touches HTML, and only once", () => {
  const html = Buffer.from("<html><head><title>x</title></head><body>hi</body></html>");
  const marked = kaspanet.markEmbedded(html, "text/html").toString("utf8");
  assert.ok(marked.includes(kaspanet.EMBED_MARKER));
  assert.ok(marked.includes("<title>x</title>"), "existing head content is kept");
  // Re-marking is a no-op, so a cached-then-reserved page cannot collect two.
  assert.equal(kaspanet.markEmbedded(Buffer.from(marked), "text/html").toString("utf8"), marked);
  // Non-HTML is returned untouched, as the same buffer.
  const css = Buffer.from("h1{color:teal}");
  assert.equal(kaspanet.markEmbedded(css, "text/css"), css);
  assert.equal(kaspanet.markEmbedded(css, ""), css);
  // HTML with no head still gets the marker rather than losing it.
  assert.match(kaspanet.markEmbedded(Buffer.from("<p>bare</p>"), "text/html; charset=utf-8").toString("utf8"),
    /^<meta name="kaspanet-embedded" content="1">\n<p>bare<\/p>$/);
});
