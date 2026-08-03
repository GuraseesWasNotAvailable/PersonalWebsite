# gurasees.com

A single full-viewport editorial hero — black/cream, no cards, no scroll.
Gurasees Singh Dhanoa · Aerospace @ IIT Madras.

## Stack

- **Vite + React + TypeScript**
- **Tailwind CSS** (`cream: #efeee9`, `font-hn` → Helvetica Neue ME)
- **Lucide React** — mobile close icon only

## The composition (one viewport, `100dvh`, no scroll)

| Layer | z | Content |
|-------|---|---------|
| BG image | – | full-bleed background |
| Marquee | 10 | infinite-scrolling `Gurasees — Dhanoa` (30s linear) |
| Cream rule + desktop footer | 10 | rule grows from left, dual footer blocks |
| Front portrait | 20 | cutout over the marquee (letters read behind it) |
| Header + mobile footer | 30 | brand · year · nav · social |
| Mobile drawer | 40 | right slide-in on `#141414`, blurred backdrop |
| Hamburger / close | 50 | morphs bars ↔ X |

Nav: **About · Gantry Three · Contact**. Social: **Twitter · LinkedIn · GitHub**.

## Gantry Three → live build

The "Gantry Three" nav item points at **`/gantry.html`**, a tiny redirect page
(`public/gantry.html`) that forwards to the live Gantry app.

⚠️ **The target is a trycloudflare quick-tunnel URL — it changes every time the
tunnel restarts.** To update it, edit the **one** `href` in `public/gantry.html`
(the script reads the destination straight from that link):

```html
<a class="cta" id="target" href="http://…trycloudflare.com">Continue →</a>
```

For a link that doesn't rot, use a named Cloudflare tunnel with a fixed hostname
(e.g. `gantry.gurasees.com`) and point the href there once.

## To personalize further

- **Portrait + background** are still the template placeholders — swap `PORTRAIT_URL`
  and `BG_IMAGE` in `src/App.tsx` (or drop files in `public/` and reference them).
- **Twitter / LinkedIn** are `#` placeholders — set real URLs in the `SOCIAL` array
  in `src/App.tsx`. GitHub already points to `GuraseesWasNotAvailable`.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build  →  dist/  (includes CNAME + gantry.html)
npm run preview  # serve the production build
```

## Deploy (GitHub Pages → gurasees.com)

`.github/workflows/deploy.yml` builds the site and publishes `dist/` to Pages.
`public/CNAME` (`gurasees.com`) is copied into `dist/` so the custom domain sticks.
The font loads from OnlineWebFonts and the portrait/background are remote URLs, so
an internet connection is required for the intended look.
