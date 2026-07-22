/*
 * Kaspanet test mock — Copyright (C) 2026 KaspaSphere DAO
 * Free software under the GNU Affero General Public License v3 or later.
 * No warranty. Source: https://github.com/KaspaSphereDAO/kaspanet
 */
// Mock KNS indexer + IPFS gateway for offline end-to-end testing.
"use strict";
const http = require("http");

const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const SITE = {
  "/index.html": ["text/html", "<html><head><link rel='stylesheet' href='./style.css'></head><body><h1>Hello from testsite.kas</h1></body></html>"],
  "/style.css": ["text/css", "h1{color:teal}"],
};

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  // KNS owner endpoint
  let m = u.pathname.match(/^\/api\/v1\/([^/]+)\/owner$/);
  if (m) {
    if (decodeURIComponent(m[1]) === "testsite.kas") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ success: true, data: { assetId: "abc123i0", asset: "testsite.kas", owner: "kaspa:qtest" } }));
    }
    res.writeHead(404); return res.end(JSON.stringify({ success: false }));
  }
  // KNS profile endpoint
  m = u.pathname.match(/^\/api\/v1\/domain\/([^/]+)\/profile$/);
  if (m) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ success: true, data: { assetId: "abc123i0", profile: { website: "ipfs://" + CID, redirectUrl: null } } }));
  }
  // IPFS gateway
  m = u.pathname.match(/^\/ipfs\/([^/]+)(\/.*)?$/);
  if (m && m[1] === CID) {
    let p = m[2] || "/";
    if (p.endsWith("/")) p += "index.html";
    const f = SITE[p];
    if (f) { res.writeHead(200, { "content-type": f[0] }); return res.end(f[1]); }
    res.writeHead(404); return res.end("no such file");
  }
  res.writeHead(404); res.end("mock 404");
});

mock.listen(9310, "127.0.0.1", () => console.log("mock up on 9310"));
