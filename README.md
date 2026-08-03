# gurasees.com

A single full-viewport editorial hero: black/cream, no cards, no scroll.
Gurasees Singh Dhanoa · Aerospace @ IIT Madras.

## Stack

- **Vite + React + TypeScript**
- **Tailwind CSS** (`cream: #efeee9`, `font-hn` maps to Helvetica Neue ME)
- **Lucide React** for the mobile close icon only

## The composition (one viewport, `100dvh`, no scroll)

| Layer | z | Content |
|-------|---|---------|
| BG image | – | full-bleed background (`public/background.jpg`) |
| Marquee | 10 | infinite-scrolling `Gurasees Dhanoa` (30s linear) |
| Cream rule + desktop footer | 10 | rule grows from left, dual footer blocks |
| Front portrait | 20 | cutout (`public/portrait.png`), letters read behind it |
| Header + mobile footer | 30 | brand · year · nav · social |
| Mobile drawer | 40 | right slide-in on `#141414`, blurred backdrop |
| Hamburger / close | 50 | morphs bars to X |

Nav: **About · Gantry · Contact**. Social: **Twitter · LinkedIn · GitHub**.

## Gantry redirect

The **Gantry** nav item points at **`/gantry.html`**, a tiny redirect page
(`public/gantry.html`) that forwards to the live Gantry app.

⚠️ **The target is a trycloudflare quick-tunnel URL; it changes every time the
tunnel restarts.** To update it, edit the **one** `href` in `public/gantry.html`
(the script reads the destination straight from that link):

```html
<a class="cta" id="target" href="http://…trycloudflare.com">Continue</a>
```

For a link that doesn't rot, use a named Cloudflare tunnel with a fixed hostname
(e.g. `gantry.gurasees.com`) and point the href there once.

## Assets

- **`public/portrait.png`** is Gurasees with the background removed locally
  (rembg). **`public/background.jpg`** is the desert dust-devil shot. Swap either
  by replacing the file, or change `PORTRAIT_URL` / `BG_IMAGE` in `src/App.tsx`.
- Socials live in the `SOCIAL` array in `src/App.tsx`; external links open in a
  new tab.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc && vite build  ->  dist/  (includes CNAME + gantry.html)
npm run preview  # serve the production build
```

## Deploy (GitHub Pages, custom domain gurasees.com)

`.github/workflows/deploy.yml` builds the site and publishes `dist/` to Pages.
`public/CNAME` (`gurasees.com`) is copied into `dist/` so the custom domain
sticks. The Helvetica Neue ME font loads from OnlineWebFonts, so an internet
connection is required for the intended look.
