# How the site is built and served

The public site, the dashboard and the docs are one static build in
`web/dist`, served by the same Hono process as the API. This page is the map:
what `npm run build:web` produces, how each URL finds its file, what the dev
server does differently, and which cache headers go out.

## The pieces

| Piece | Source | Built by | Served at |
|---|---|---|---|
| Landing page | `web/landing.html`, `web/src/landing.ts`, `web/src/landing.css` | Vite | `/` |
| Oracle board | `web/index.html`, `web/src/oracle.ts` | Vite | `/app` |
| Arms | `web/arm.html`, `web/src/arm.ts` | Vite | `/app/arm` |
| Positions | `web/positions.html`, `web/src/positions.ts` | Vite | `/app/positions` |
| One launch | `web/coin.html`, `web/src/coin.ts` | Vite | `/app/coin/:token` |
| Docs pages | `docs/*.md` rendered through `web/docs.html` | `scripts/build-docs.ts` | `/docs`, `/docs/:slug`, `/litepaper` |
| Not found | `web/404.html` | Vite | any unknown browser navigation, status 404 |
| Shared chrome | `web/src/shell.ts` (dashboard), `web/src/styles.css` (tokens) | Vite | with every page |

Vite runs in multi-page mode (`appType: 'mpa'` in `web/vite.config.ts`) with
one Rollup input per HTML file. Each page's TypeScript and CSS are bundled
under `web/dist/assets/` with a content hash in the file name, and the HTML
is rewritten to point at the hashed files. The dashboard pages import the
API's wire types (`src/api/contract.ts`) type-only, so a renamed field fails
`npm run typecheck` for the web instead of rendering `undefined`.

## `npm run build:web`, in order

```bash
vite build --config web/vite.config.ts   # 1. pages + assets into web/dist
tsx scripts/build-docs.ts                # 2. docs/*.md into web/dist/docs/
```

The order matters. `web/docs.html` is the layout for every docs page and it
goes through Vite first, so its stylesheet (`web/src/docs.css`) and script
(`web/src/docs.ts`) come out as hashed assets. `build-docs` then reads the
processed `web/dist/docs.html`, fills the `{{title}}`, `{{sidebar}}`,
`{{content}}`, `{{toc}}`, `{{prevnext}}` and `{{source}}` slots once per
document, writes `web/dist/docs/<slug>.html`, writes the docs overview to
`web/dist/docs/index.html`, and deletes the template. Running `build-docs`
before Vite fails with a message saying so, and running Vite again empties
`web/dist` (`emptyOutDir`), which is why `build:web` chains them and the
Dockerfile runs `npm run build`.

### What build-docs does to the markdown

- Renders with [`marked`](https://www.npmjs.com/package/marked) in GFM mode:
  tables, fenced code, task lists.
- Every `h2` to `h4` gets an id slugified from its text (`## The promotion
  gate` becomes `#the-promotion-gate`) and a hover anchor link. Duplicate
  headings get `-2`, `-3` suffixes.
- Links between docs are rewritten: `guardrails.md` becomes
  `/docs/guardrails`, `oracle.md#the-labels` becomes `/docs/oracle#the-labels`.
  `../README.md` goes to the repository README on GitHub, and any other
  relative path becomes a link to that file on GitHub, so a doc can cite
  `src/guards/risk.ts` and the link resolves.
- Fenced code blocks get a copy button and a language tag. Tables are wrapped
  so a wide one scrolls inside its own box rather than the page.
- The sidebar order and grouping are the `GROUPS` table at the top of the
  script. A new `docs/<name>.md` appears automatically under "More" until it
  is placed in a group. The file name must be lowercase letters, digits and
  hyphens, because it is the URL.
- The first paragraph of each doc becomes its description in the overview
  cards and the page's `<meta name="description">`.

### The dead-link check

After writing the pages, `build-docs` reads **every** HTML file in `web/dist`
(the docs it just wrote, the landing page, the dashboard pages, the 404) and
checks every `href`:

- `#anchor` must match an element id on that page.
- `/docs/<slug>` and `/litepaper` must have a rendered page, and a
  `#fragment` on them must match a heading id in that doc.
- Any other site-internal path must be a route in `src/api/site-routes.ts`
  (`/`, `/app`, `/app/arm`, `/app/positions`, `/app/coin/0x…`, `/docs`,
  `/litepaper`). A fragment on `/` must be a section id on the landing page.
- `/assets/...` must exist in `web/dist`.
- Relative links are refused outright; site links are absolute.
- `http(s)` links are not fetched. Nothing in the build touches the network.

A single dead link prints `dead link: <page>: <href> (<why>)` for each hit
and exits 1, so a renamed heading or a deleted doc fails `npm run build`
rather than shipping a 404.

## How a URL finds its file

`src/api/site-routes.ts` is the whole table, and it is pure (no imports), so
the Hono static mount, the Vite dev server and the docs link check all read
the same one:

| Request | Serves | Notes |
|---|---|---|
| `/` | `landing.html` | |
| `/app`, `/app/oracle` | `index.html` | the oracle board |
| `/app/arm`, `/app/arms` | `arm.html` | |
| `/app/positions` | `positions.html` | |
| `/app/coin/:token` | `coin.html` | the page reads the token from the path |
| `/docs` | `docs/index.html` | |
| `/docs/:slug` | `docs/<slug>.html` | slug: `[a-z0-9-]+` |
| `/litepaper` | `docs/litepaper.html` | the same page as `/docs/litepaper` |
| `/assets/*` | the file | hashed bundles |
| `/index` | 301 to `/app` | |
| `/arm`, `/arms` | 301 to `/app/arm` | query string kept |
| `/positions` | 301 to `/app/positions` | query string kept |
| `/coin/:token` | 301 to `/app/coin/:token` | |
| anything else, browser navigation | `404.html` with status 404 | |
| anything else, `Accept` without `text/html` | JSON `{ error: "not_found" }` | same body as an unknown API route |

A trailing slash is ignored (`/app/positions/` is `/app/positions`). The
dashboard moved under `/app` when the landing page took the root, and the
redirects exist so links in journals, alerts and bookmarks written before the
move keep working.

`src/api/static.ts` mounts this after every `/api` route: first the 301s,
then `serveStatic` from `@hono/node-server` rooted at `WEB_DIST` (default
`web/dist`, `/app/web/dist` in the container) with `rewriteRequestPath`
pointed at the table, then the 404 page for anything that fell through and
asked for HTML. When `web/dist` is missing at boot the server logs a warning
and the API keeps working; the pages answer 404 until `npm run build:web`
has run.

## Cache headers

| What | `Cache-Control` | Why |
|---|---|---|
| `/assets/*` | `public, max-age=31536000, immutable` | the file name carries a content hash; a new build is a new URL |
| every HTML page, docs included | `no-cache` | the browser may keep a copy but must revalidate, so a deploy shows up on the next load |
| the 404 page | `no-cache` | |
| `/api/*` | none set by the static layer | API responses are dynamic; see [api.md](api.md) |

Every response also carries `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin` and `X-Frame-Options: DENY` from the app-wide
middleware in `src/api/app.ts`.

## The dev server

`npm run dev:web` starts Vite on port 5173 and proxies `/api` to the engine
on 8080 (`npm run dev` in another terminal). The `hood-site-routes` plugin in
`web/vite.config.ts` mirrors the production table: clean URLs map to page
files, legacy paths answer 301, and `/docs/:slug` and `/litepaper` are served
from `web/dist/docs/` if `npm run build:docs` has been run (there is no
markdown pipeline inside Vite; the docs are always the pre-rendered files).
Without a docs build those URLs answer 503 with the command to run.

The same plugin is what makes `/app/coin/0x…` load `coin.html` in dev, so
deep links behave the same on 5173 and 8080.

## The container

The Dockerfile's build stage copies `src`, `scripts`, `web` and `docs`,
runs `npm run build` (`build:web` first), and the runtime stage copies
`web/dist` to `/app/web/dist` with `WEB_DIST` pointed at it. `docs/` is
deliberately not in `.dockerignore`: the docs pages are rendered during the
image build, and without the markdown the build fails at `build-docs` rather
than shipping a site whose `/docs` is empty.

## Adding a page

1. A dashboard page: add `web/<name>.html` and `web/src/<name>.ts`, add the
   input to `rollupOptions.input` in `web/vite.config.ts`, and add its clean
   URL to `PAGE_ROUTES` in `src/api/site-routes.ts`. `mountShell` in
   `web/src/shell.ts` gives it the header, health strip and event stream.
2. A doc: add `docs/<slug>.md` with an `# H1` title and a first paragraph
   that reads as its summary. Place it in a `GROUPS` entry in
   `scripts/build-docs.ts` if it belongs somewhere specific. Link to sibling
   docs as `other.md`; the build rewrites and checks the link.
3. Run `npm run build:web` and read the last line: it lists every page it
   rendered and confirms every internal link resolves.
