# Kaspanet© Internet

## License

This project is licensed under the GNU Affero General Public License v3.0
(AGPL-3.0) — see the [LICENSE](LICENSE) file for details. Copyright © 2026
KaspaSphere DAO. Source code: https://github.com/KaspaSphereDAO/kaspanet-internet

Because the AGPL covers network use, every user-facing component displays a
prominent "Source Code" link pointing to the repository above, and the desktop
client exposes the source at its `/source` route. If you run a modified version
on a public server or distribute it, you must offer users the corresponding
source under the same license.

---

Kaspanet© Internet is a decentralized web: human-readable `.kas` names registered on the
Kaspa blockDAG (via KNS) point to website content stored on IPFS. There is no
central DNS, no central hosting, and no account required for use.

## Components

**`kasweb/` — desktop client (`kaspanet.exe`)**
A single-file Windows executable (Node.js single-executable application). It
runs a local resolver on `127.0.0.1`, keeps all fetched content in RAM only
(nothing written to disk), and renders sites in the OS browser behind a strict
Content-Security-Policy. Two network modes: **Kaspanet only** (sealed — sites
can't touch the regular internet) and **Kaspanet + Internet** (live legacy web
allowed). Address bar routes `.kas` names to KNS, legacy `.com/.org` to the web,
and unpointed `.kas` domains to their KNS profile card. Home page is the hosted
`webclient.kas` when it's pulling live, otherwise a built-in fallback with a
network-status banner (including an offline indicator).

**`webclient/` — zero-install web client**
One static HTML file (`index.html`) plus an OpenSearch descriptor. Same
resolution protocol, implemented in browser JavaScript (the KNS API is
CORS-open, so no backend is needed). Sites render in a sandboxed iframe on a
per-CID subdomain gateway for real origin isolation. This is what
`webclient.kas` / `kaspanet.online` serves; it can also run standalone from any
IPFS gateway link, and detects when it's embedded inside `kaspanet.exe`.

**`dist-webclient/`: the web client, built for publishing**
`webclient/` with `app.js` inlined into `index.html`, so the client works
when pinned as a single raw file (no directory structure, so no `./app.js`
to fetch). Regenerate with `node tools/build-dist-webclient.js` after any
change to `webclient/`; never edit it by hand.

**`kasparty-ipfs/` — example `.kas` site (Kaspanet portal)**
A React/Vite static site retargeted for IPFS (relative paths, no backend).
Build with `npm install && npm run build`; the `dist/` folder is what you
upload to IPFS. See `kasparty-ipfs/PUBLISH.md`.

## How publishing works

1. Upload a static site folder to IPFS (Pinata Autonomous File Storage free tier works). Copy the CID.
2. In your KNS domain profile (app.knsdomains.org, Kasware wallet), set
   **Website** OR **Redirect URL** to `ipfs://<CID>`.
3. Any Kaspanet Internet client resolves `yourname.kas` → CID → content within minutes.

## Run the web client locally

```
node tools/build-dist-webclient.js
python3 -m http.server 8080 --directory dist-webclient    # or: npx serve dist-webclient
```

Open http://localhost:8080 and enter a `.kas` name (try `rescu.kas`) or an
`ipfs://<CID>` pointer. The mirror bar at the bottom right names the gateway
that served the site. **Try another mirror** switches to the path-style
fallback, where the gateway's own CSP may block the site's scripts; the bar
says so when that mirror is in use.

Opening `index.html` as a `file://` URL is not supported: the page needs a
real origin for gateway probing and for the KNS API calls.

This is the same client the desktop app serves, but not the same experience.
The desktop client (`kasweb/`) runs a proxy on `127.0.0.1`, keeps everything
in RAM, fetches the content itself, and applies a Content-Security-Policy per
network mode: **sealed** (sites cannot reach the regular internet) or **open**
(live web allowed). Served locally as static files, the page fetches from
gateways directly and none of that applies. The client tells the two apart by
a `kaspanet-embedded` meta tag the desktop proxy injects into the HTML it
serves, not by the hostname.

### Gateways

The gateway list lives in `webclient/app.js` and `kasweb/kaspanet.js`, same
order in both. Each entry is a host plus the URL style that host serves:

| Style | URL | Notes |
| --- | --- | --- |
| `subdomain` | `https://<cid>.ipfs.<host>/` | One browser origin per CID. Preferred. |
| `path` | `https://<host>/ipfs/<cid>/` | For hosts with no wildcard subdomain certificate. |

Current default: `ipfs.hypha.coop` (subdomain), then `ipfs.filebase.io`
(path). In `kasweb/` the `GATEWAYS` env var overrides it, taking bare hosts,
comma separated, each optionally suffixed with `:path` or `:subdomain`
(`subdomain` is the default):

```
GATEWAYS="ipfs.hypha.coop,ipfs.filebase.io:path" node kaspanet.js
```

Verify any new host against a real CID before adding it. Several public
gateways now redirect browser traffic to a service-worker gateway, which
cannot run inside the client's sandboxed iframe.

## Building the desktop client

HOW TO LAUNCH DESKTOP CLIENT:  MAKE SURE TO DOWNLOAD WHOLE GITHUB REPO, UNZIP FILE, THEN GOTO kaspanet-internet-main -> webclient -> index.html to Run!

...OR REBUILD AN EXE WITH Node.js(advanced):
(The `.exe` is a Node.js SEA. To rebuild from `kasweb/kaspanet.js`)
```
node --experimental-sea-config sea-config.json      # produces sea-prep.blob
# copy a node.exe, then inject:
npx postject kaspanet.exe NODE_SEA_BLOB sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

Runtime flags: `--internet` (start in Kaspanet + Internet mode),
`--allowlist=a.kas,b.kas` (curated mode). Env: `KNS_API`, `GATEWAYS`,
`WEBCLIENT_DOMAIN`.
