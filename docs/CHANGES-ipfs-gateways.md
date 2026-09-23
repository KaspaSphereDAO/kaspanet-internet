# IPFS gateway fix, September 2026

What changed in the gateway handling of both clients, and the deploy steps
for `kaspanet.online` that go with it. Kept in the repo so those steps do not
live only in a pull request description.

## Why

Every .kas site in the web client was showing the "This IPFS gateway is
switching to a service worker gateway only" notice instead of loading.

`w3s.link`, first in our gateway list, now 301s to `dweb.link`, which hands
browser traffic to the `inbrowser.link` service-worker gateway. Service
workers cannot register inside our sandboxed iframe, which is precisely what
keeps a random .kas site off the client's own origin, so the site never
rendered. The rest of the list was no better: `nftstorage.link` also
redirects to `dweb.link` and is defunct, `trustless-gateway.link` serves
raw/CAR only, and the code comments described a list the code did not
contain.

## What was verified

Every candidate was checked with curl against a real .kas site, CID
`bafybeibg6g6j6k6j3c2urpit2uunzqxvakq3qgx53dydvyy5bpli34utmi`: status and
content type, every `Location` header in the redirect chain, `X-Frame-Options`
and CSP `frame-ancestors`, a non-HTML subresource, and response time.
Candidates came from the current `ipfs/public-gateway-checker` `gateways.json`,
three historical revisions of it, and the hosts already in our code, plus a
wider sweep of community gateways.

Of roughly 40 hosts, exactly one passes on subdomain URLs:

| Host | Result |
| --- | --- |
| `ipfs.hypha.coop` | 200 `text/html`, no redirects, no framing headers, `ACAO: *`, subresource 200, about 2.5s warm |
| `ipfs.filebase.io` | identical, but path style only: no TLS certificate covers `<cid>.ipfs.ipfs.filebase.io` |
| `w3s.link`, `nftstorage.link`, `storacha.link` | 301/302 to `dweb.link` |
| `dweb.link`, `ipfs.io` | redirect to `inbrowser.link` |
| `trustless-gateway.link` | 406 on an HTML request, raw/CAR only, no wildcard subdomain DNS |
| `4everland.io` | 504 on both styles, for our CID and an unrelated control CID |
| `dget.top` | 403, blocks `text/html` directly |
| everything else | NXDOMAIN, TLS failure, timeout, 5xx, or a parked domain |

The failures are gateway-side, not content availability: re-running against an
unrelated widely-available control CID (the dnslink target for ipfs.tech)
produced the same verdicts host for host.

Upstream agrees on the removals: `ipfs/public-gateway-checker` `bd0fa45c22`
"remove w3s.link (redirects to dweb.link)" (2026-06-12) and `14b730f487`
"remove nftstorage.link" (2025-12-18).

## Changes

**Gateways (both clients).** A gateway entry is now `{host, style}` where
style is `subdomain` or `path`, and `gatewayUrl()` / `gatewayFetchUrl()`
honour it. The list is `ipfs.hypha.coop` (subdomain) then `ipfs.filebase.io`
(path), same order in both clients. A subdomain gateway still falls back to
path style for CIDv0, which cannot be a DNS label. The `GATEWAYS` env var in
kasweb still works and each host takes an optional `:path` or `:subdomain`
suffix, for example `GATEWAYS="ipfs.hypha.coop,ipfs.filebase.io:path"`.
The gateway comments in both files were rewritten to match the code, with a
dated note on each removal.

**kasweb.** `fetchRaw` now rejects redirects to `dweb.link` and `ipfs.io` as
well as `inbrowser.link`, so a bad hop fails fast and `fetchSiteFile` falls
through to the next gateway rather than chasing the chain.

**webclient.** Before setting the iframe `src`, each gateway is probed with
`fetch(url, {redirect: "manual"})` and an 8 second timeout. A redirect
(`opaqueredirect`), a timeout or a non-200 is a failure and the next gateway
is tried automatically. A CORS-only rejection is indistinguishable from a
network error and says nothing about whether the iframe would load, since the
iframe is not bound by CORS, so such a gateway is marked unknown and used only
if nothing probes clean. The mirror bar names the gateway that is serving and,
on filebase, warns that the gateway's CSP may block the site's own scripts.
"Try another mirror" still advances through the list and wraps.

Unchanged, as asked: KNS resolution, the CSP presets, the iframe sandbox
attributes, the AGPL headers. The web client is still zero-build, static,
relative-path only, with no dependencies, so it still runs served from IPFS.

**Tests.** `kasweb/mock_test.js` is rewritten with `node:test`. It mocked only
path-style URLs and asserted nothing; it now serves the KNS indexer and
several fake gateways from one socket, telling them apart by the Host header,
which is the only thing that distinguishes subdomain-style requests. Nine
tests cover: testsite.kas resolving and serving index.html; a first gateway
that 302s to `inbrowser.link` falling through to the second without the
redirect being followed; a gateway returning 404 being skipped; every gateway
failing surfacing an error; a path-style gateway being fetched path style; and
the banned-host and spec-parser behaviour. The guard assertions were confirmed
to fail when the redirect check is disabled.

To make this testable, `kaspanet.js` exports its internals, skips starting its
server under `KASPANET_NO_SERVER`, and accepts a custom dns `lookup` so every
hostname resolves to 127.0.0.1 while the URL and Host header keep the
gateway's real name. The server guard is an env flag rather than a
`require.main` check because `require.main` is not set in the SEA build.

`kasweb/package.json` gains `"test": "node --test mock_test.js"`, and
`.github/workflows/test.yml` runs it on push and pull request against node 18
and 22, plus a parse check for the web client. The suite is fully offline.

The web client's probe and fallback logic was also exercised locally against a
stubbed DOM and fetch (15 checks: clean first gateway, redirect fall-through,
timeout, 404, CORS-unknown preference, all-unknown fallback, total failure
panel, mirror cycling, CIDv0 path fallback). That harness is not committed,
since the scope here was the kasweb suite.

**Docs.** `kasparty-ipfs/PUBLISH.md` no longer tells publishers to
sanity-check on `ipfs.io`, which now proves nothing, and points at the first
gateway in our list in the subdomain form the clients use. It also drops the
claim that a built `dist/` ships in the repo; it does not, and never has in
the git history.

## Local development

`EMBEDDED` in the web client used to be inferred from the page being on
`127.0.0.1` or `localhost`. That is equally true of any ordinary static
server, so serving `dist-webclient/` locally to test it made the client route
every navigation to `/go?d=...`, a route only the desktop proxy answers, and
the static server returned 404.

kasweb serves the web client by proxying raw bytes from IPFS at
`/site/<home domain>/` under the sealed CSP, so the marker is a
`<meta name="kaspanet-embedded" content="1">` tag injected into that HTML at
serve time. It is the least invasive option available there: it needs no
inline script, so it never interacts with the CSP, and it is inert for
anything else reading the page. The web client sets `EMBEDDED` only when that
tag is present.

Only the home domain's HTML is marked. Third-party .kas sites are still
proxied byte for byte, non-HTML responses are returned untouched, and the RAM
cache keeps unmodified bytes, since the tag is added on the way out.
Re-marking is a no-op. Behaviour inside the desktop client is unchanged.

Two tests cover it, driving the real proxy over a socket: the marker is
present on the home domain, absent on a third-party site and absent from
assets, and `markEmbedded` touches HTML only and only once. Verified they
fail when the injection is removed.

The README gains a "Run the web client locally" section: build, serve, what
to try, why `file://` is not supported, how the desktop client differs, and
the gateway config including the `GATEWAYS` env var with its `:path` and
`:subdomain` suffixes.

## Deploy

`kaspanet.online` is not served from this repo. There is no CNAME, no
workflow, no netlify/vercel/pages config, and none has ever been tracked in
git. The domain is a Namecheap URL forward:

```
kaspanet.online.  A   138.68.125.144   (ns: registrar-servers.com)

GET https://kaspanet.online/
  HTTP/2 301   server: domain-forward
  location: https://bafkreifa47bsr4qsqsjgqmd7j2uk3qyms36pcxkz6yph6p4lq4ns5wmtd4.ipfs.dweb.link
```

So the domain forwards straight to `dweb.link`, and the whole site is broken
at the front door, before any of the gateway logic in this PR runs. Fixing
that is a registrar change, not a code change.

That deployed CID is a raw single-file CID: one self-contained `index.html`
with `app.js` inlined, and no `opensearch.xml`. Fetching and diffing it showed
the inlined copy had already drifted from `webclient/app.js`, having been kept
in sync by hand. `dist-webclient/` is that same shape, generated by
`tools/build-dist-webclient.js` instead of hand-edited, with `opensearch.xml`
beside it so a folder upload works too.

Steps, none of which have been done:

1. Upload `dist-webclient/` to Pinata. A folder upload (index.html at the root
   of the upload) gives a `bafybei...` folder CID and keeps `opensearch.xml`;
   pinning `index.html` alone gives a `bafkrei...` raw CID, matching what is
   deployed today. Either works.
2. Retarget the Namecheap URL forward for `kaspanet.online` to
   `https://<new-cid>.ipfs.ipfs.hypha.coop`. The subdomain form is the same
   for a folder CID and a raw CID; add a trailing `/` for a folder CID.
3. Set the **Website** field of `webclient.kas` in KNS to `ipfs://<new-cid>`.

One caveat: a Namecheap forward drops the path and query, as the 301 above
shows (its `Location` carries no path). So the `?q=` omnibox search in
`webclient/opensearch.xml`, which posts to `https://kaspanet.online/?q=...`,
will not survive the forward and will land on the home page instead. Serving
the domain properly, rather than forwarding it, is the only fix for that, and
it is out of scope here.

## Manual test steps

With `rescu.kas` and CID
`bafybeibg6g6j6k6j3c2urpit2uunzqxvakq3qgx53dydvyy5bpli34utmi`:

1. Build and serve the client:
   ```
   node tools/build-dist-webclient.js
   python3 -m http.server 8080 --directory dist-webclient
   ```
   Open `http://localhost:8080`. Type `rescu.kas` and
   press Enter. The site should render in the frame, and the mirror bar at the
   bottom right should read `Mirror: ipfs.hypha.coop`. No `inbrowser.link`
   notice should appear.
2. Click **Try another mirror**. The frame should reload through
   `https://ipfs.filebase.io/ipfs/<cid>/` and the bar should read
   `Mirror: ipfs.filebase.io - this mirror may block the site's scripts`.
   Click again to wrap back to hypha.
3. Paste `ipfs://bafybeibg6g6j6k6j3c2urpit2uunzqxvakq3qgx53dydvyy5bpli34utmi`
   into the address bar. The DAO governance page should render. Confirm in
   DevTools that the frame URL is
   `https://bafybeibg6g6j6k6j3c2urpit2uunzqxvakq3qgx53dydvyy5bpli34utmi.ipfs.ipfs.hypha.coop/`
   and that there is no redirect to `inbrowser.link`, `dweb.link` or
   `ipfs.io` in the Network tab.
4. Check the subresource loads: open
   `https://bafybeibg6g6j6k6j3c2urpit2uunzqxvakq3qgx53dydvyy5bpli34utmi.ipfs.ipfs.hypha.coop/dao_treasury.sil`
   in a tab. It should return the SilverScript source, not a 404.
5. Simulate a dead primary: in DevTools, block
   `*ipfs.hypha.coop*` under Network request blocking, then reload the site.
   It should fall through to filebase on its own, with the warning in the bar,
   rather than hanging.
6. Desktop client: `cd kasweb && node kaspanet.js`, then visit
   `/site/rescu.kas/` on the local port it prints. The page should render from
   RAM. Repeat with the fallback forced, `GATEWAYS="ipfs.filebase.io:path"
   node kaspanet.js`, and with a deliberately dead primary,
   `GATEWAYS="dweb.link,ipfs.filebase.io:path" node kaspanet.js`, which should
   still serve after the dweb.link hop is refused.
7. Confirm the embedded marker only fires in the desktop client. Served from
   `http://localhost:8080`, "View source" should show no
   `kaspanet-embedded` meta tag, and entering a name should drive the iframe
   rather than navigating to `/go?d=...`. Inside the desktop client, the same
   page at `/site/webclient.kas/` should carry the tag in its `<head>` and
   navigation should go through `/go?d=...` as before.
8. `cd kasweb && npm test` should report 11 passing tests, with no network
   access needed.
9. Rebuild check: `node tools/build-dist-webclient.js && git diff --exit-code
   dist-webclient` should be clean, confirming the published build matches
   `webclient/`.
