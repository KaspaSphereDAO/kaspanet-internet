# Publishing Kaspanet to IPFS via Pinata

## One-time setup
1. Create a free account at https://pinata.cloud
2. No bucket needed — Pinata pins files directly (free tier allows HTML)

## Each release
1. Build. There is no `dist/` in the repo, so this step is always required:
   ```
   npm install
   npm run build
   ```
2. In the Pinata dashboard, upload the **contents of the `dist/` folder as a folder upload** (index.html at the root of the upload).
3. Pinata shows a **CID** for the uploaded folder (starts with `bafy...`). Copy it.
4. Sanity-check in a normal browser through the **first gateway in our list**,
   `ipfs.hypha.coop`, using the subdomain form the clients use:
   ```
   https://<CID>.ipfs.ipfs.hypha.coop/
   ```
   The site should render directly. Do not check with `ipfs.io` or
   `dweb.link`: both now hand browser traffic to the `inbrowser.link`
   service-worker gateway, so what you see there tells you nothing about
   what the clients will get. The second gateway, `ipfs.filebase.io`, is
   path style and worth a look too, at
   `https://ipfs.filebase.io/ipfs/<CID>/`, though it sends a CSP that can
   block a site's own scripts.
   The current gateway list lives in `webclient/app.js` and
   `kasweb/kaspanet.js`; check there if these hosts have moved on.
5. Open your KNS dashboard (app.knsdomains.org, Kasware wallet connected), edit the profile of **webclient.kas**, and set **Website** to:
   ```
   ipfs://<CID>
   ```
6. Done. kaspanet resolves `webclient.kas` → your new CID within ~5 minutes
   (resolution cache TTL). The browser's home page automatically switches from
   the built-in fallback to the hosted client once it detects the site pulling
   live from IPFS (`/status` shows the current state).

## Rules that keep it working
- All asset links must stay **relative** (`./x`, not `/x`) — enforced by `base: './'` in vite.config.ts. Don't add absolute paths in components.
- `index.html` must be at the top level of the uploaded folder.
- No server-side anything: no SSR, no API routes, no databases.
- In the browser's **Kaspanet only** mode, external API calls (CoinGecko in
  TokenLeaderboard, Google Custom Search in SearchSection) are blocked by CSP;
  they work in **Kaspanet + Internet** mode. Design components to fail quietly.
- Each upload produces a **new CID** — update the KNS Website field each release.

## What was removed for the IPFS version
- ChatWidget, Forums, ForumsPage, ModeratorPanel, supabaseClient, schema.sql
  (required a live Supabase backend — not viable on static IPFS hosting)
- Events section (removed by request — inscriptions are permanent on-chain)
- framer-motion (replaced with CSS animations; smaller bundle, fewer deps)
