import { useEffect, useRef, useState } from 'react'
import { X, ChevronDown } from 'lucide-react'

// ------------------------------------------------------------------ //
// Assets: swap PORTRAIT_URL / BG_IMAGE for your own shots when ready.  //
// portrait.png is Gurasees (bg removed); background.jpg is the desert. //
// ------------------------------------------------------------------ //
const BG_IMAGE = '/background.jpg'

const PORTRAIT_URL = '/portrait.png'

// ------------------------------------------------------------------ //
// Nav + social. Gantry points at the /gantry.html redirect page,       //
// which forwards to the live build (see public/gantry.html).           //
// ------------------------------------------------------------------ //
const CONTACT_EMAIL = 'ae23b064@smail.iitm.ac.in'
const GITHUB_URL = 'https://github.com/GuraseesWasNotAvailable'

type Link = { label: string; href: string }

const NAV: Link[] = [
  { label: 'About', href: '#' },
  { label: 'Gantry', href: '/gantry.html' },
  { label: 'Contact', href: `mailto:${CONTACT_EMAIL}` },
]

const SOCIAL: Link[] = [
  { label: 'Twitter', href: 'https://x.com/gurasees0' },
  {
    label: 'LinkedIn',
    href: 'https://www.linkedin.com/in/gurasees-singh-dhanoa-9aa7a221b/',
  },
  { label: 'GitHub', href: GITHUB_URL },
]

// External links (http…) open in a new tab; internal ones (#, mailto, /gantry.html) stay put.
const linkProps = (href: string) =>
  href.startsWith('http')
    ? { target: '_blank', rel: 'noopener noreferrer' }
    : {}

// Shared easings
const EASE_DRAWER = 'cubic-bezier(0.76, 0, 0.24, 1)'
const EASE_SOFT = 'cubic-bezier(0.22, 1, 0.36, 1)'

// Live X (Twitter) timeline for @gurasees0 via the official embed widget.
// X often restricts profile-timeline embeds (the iframe collapses to 0px);
// if that happens we detect it and show a clean call-to-action instead.
function XTimeline() {
  const ref = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const w = window as unknown as {
      twttr?: { widgets?: { load: (el?: HTMLElement | null) => void } }
    }
    const render = () => w.twttr?.widgets?.load(ref.current)

    if (w.twttr?.widgets) {
      render()
    } else {
      const existing = document.getElementById(
        'twitter-wjs',
      ) as HTMLScriptElement | null
      if (existing) {
        existing.addEventListener('load', render)
      } else {
        const s = document.createElement('script')
        s.id = 'twitter-wjs'
        s.src = 'https://platform.twitter.com/widgets.js'
        s.async = true
        s.onload = render
        document.body.appendChild(s)
      }
    }

    // If X doesn't render a real timeline within a few seconds, fall back.
    const t = setTimeout(() => {
      const f = ref.current?.querySelector('iframe') as HTMLIFrameElement | null
      if (!f || f.getBoundingClientRect().height < 60) setFailed(true)
    }, 5000)
    return () => clearTimeout(t)
  }, [])

  if (failed) {
    return (
      <a
        href="https://x.com/gurasees0"
        target="_blank"
        rel="noopener noreferrer"
        className="block border border-cream/20 px-7 py-9 font-hn text-cream transition-colors duration-300 hover:border-cream/50"
      >
        <span className="block text-xl">Read the latest from @gurasees0</span>
        <span className="mt-1 block text-sm text-cream/50">
          Rockets, builds, and the next thing. Opens X in a new tab.
        </span>
      </a>
    )
  }

  return (
    <div ref={ref} className="min-h-[100px]">
      <a
        className="twitter-timeline"
        data-theme="dark"
        data-chrome="noheader nofooter transparent"
        data-height="640"
        href="https://twitter.com/gurasees0?ref_src=twsrc%5Etfw"
      >
        Posts by @gurasees0
      </a>
    </div>
  )
}

export default function App() {
  const [open, setOpen] = useState(false)

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  return (
    <>
    <section className="relative h-[100dvh] w-full overflow-hidden bg-black">
      {/* ---------------------------------------------------------------- */}
      {/* BG image (full-bleed, behind everything)                          */}
      {/* ---------------------------------------------------------------- */}
      <img
        src={BG_IMAGE}
        alt=""
        className="anim-fade-in absolute inset-0 h-full w-full object-cover"
      />

      {/* ---------------------------------------------------------------- */}
      {/* Marquee name (z-10)                                               */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="anim-fade-up absolute inset-x-0 top-[16vh] z-10 overflow-hidden sm:top-[14vh]"
        style={{ animationDelay: '500ms' }}
      >
        <div className="marquee flex w-max whitespace-nowrap font-hn text-[12vh] leading-none text-cream sm:text-[18vh]">
          <span className="pr-[6vw]">Gurasees Dhanoa&nbsp;</span>
          <span className="pr-[6vw]">Gurasees Dhanoa&nbsp;</span>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Cream rule (z-10)                                                 */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="anim-line absolute inset-x-6 bottom-[5.5rem] z-10 h-0.5 bg-cream sm:inset-x-10 sm:bottom-28"
        style={{ animationDelay: '1200ms' }}
      />

      {/* ---------------------------------------------------------------- */}
      {/* Footer (desktop z-10 / mobile z-30)                               */}
      {/* ---------------------------------------------------------------- */}
      <footer className="absolute inset-x-0 bottom-0 z-30 flex items-end justify-between px-6 pb-5 font-hn text-xs leading-relaxed text-cream sm:z-10 sm:px-10 sm:pb-8 sm:text-sm">
        <div className="anim-fade-up" style={{ animationDelay: '1400ms' }}>
          <p>Aerospace @ IIT Madras</p>
          <p>Rocket &amp; Systems Builder</p>
          <p>Obsessed by things that fly</p>
        </div>
        <div
          className="anim-fade-up text-right"
          style={{ animationDelay: '1550ms' }}
        >
          <p>Based in</p>
          <p>Chennai, India</p>
        </div>
      </footer>

      {/* ---------------------------------------------------------------- */}
      {/* Front portrait (z-20, above the marquee, non-interactive)         */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="anim-rise-in pointer-events-none absolute inset-x-0 bottom-0 z-20 mx-auto h-[70vh] w-[89vw] sm:h-[86vh] sm:w-[56vw]"
        style={{ animationDelay: '300ms' }}
      >
        <img
          src={PORTRAIT_URL}
          alt="Portrait"
          className="h-full w-full object-cover object-top"
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Header (z-30)                                                     */}
      {/* ---------------------------------------------------------------- */}
      <header className="absolute inset-x-0 top-0 z-30 flex items-start justify-between px-6 pt-6 sm:px-10 sm:pt-8">
        <a
          href="#"
          className="anim-fade-up font-hn text-lg tracking-wide text-cream"
          style={{ animationDelay: '800ms' }}
        >
          Gurasees
        </a>

        <div className="hidden items-start gap-16 sm:flex lg:gap-24">
          <span
            className="anim-fade-up text-sm text-cream"
            style={{ animationDelay: '900ms' }}
          >
            2026
          </span>

          <nav className="flex flex-col gap-0.5 text-sm text-cream">
            {NAV.map((item, i) => (
              <span
                key={item.label}
                className="anim-fade-up block"
                style={{ animationDelay: `${1000 + i * 80}ms` }}
              >
                <a
                  href={item.href}
                  {...linkProps(item.href)}
                  className="transition-opacity duration-300 hover:opacity-60"
                >
                  {item.label}
                </a>
              </span>
            ))}
          </nav>

          <div className="flex flex-col gap-0.5 text-sm text-cream">
            {SOCIAL.map((item, i) => (
              <span
                key={item.label}
                className="anim-fade-up block"
                style={{ animationDelay: `${1150 + i * 80}ms` }}
              >
                <a
                  href={item.href}
                  {...linkProps(item.href)}
                  className="transition-opacity duration-300 hover:opacity-60"
                >
                  {item.label}
                </a>
              </span>
            ))}
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Hamburger (mobile only, z-50, morphs to X)                        */}
      {/* ---------------------------------------------------------------- */}
      <button
        type="button"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="anim-fade-up absolute right-6 top-6 z-50 flex h-10 w-10 items-center justify-center sm:hidden"
        style={{ animationDelay: '900ms' }}
      >
        <span className="relative block h-4 w-6">
          <span
            className="absolute left-0 h-0.5 w-6 bg-cream"
            style={{
              top: '50%',
              transform: open
                ? 'translateY(-50%) rotate(45deg)'
                : 'translateY(-50%) translateY(-6px)',
              transition: `transform 500ms ${EASE_DRAWER}`,
            }}
          />
          <span
            className="absolute left-0 h-0.5 w-6 bg-cream"
            style={{
              top: '50%',
              transform: 'translateY(-50%)',
              opacity: open ? 0 : 1,
              transition: 'opacity 300ms ease',
            }}
          />
          <span
            className="absolute left-0 h-0.5 w-6 bg-cream"
            style={{
              top: '50%',
              transform: open
                ? 'translateY(-50%) rotate(-45deg)'
                : 'translateY(-50%) translateY(6px)',
              transition: `transform 500ms ${EASE_DRAWER}`,
            }}
          />
        </span>
      </button>

      {/* ---------------------------------------------------------------- */}
      {/* Mobile drawer (z-40)                                              */}
      {/* ---------------------------------------------------------------- */}
      {/* Backdrop */}
      <div
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-500 sm:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      {/* Panel */}
      <aside
        className={`fixed inset-y-0 right-0 z-40 w-[80%] max-w-sm bg-[#141414] px-8 py-10 sm:hidden ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{
          transition: `transform 600ms ${EASE_DRAWER}`,
        }}
      >
        {/* Lucide close */}
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="absolute right-6 top-6 text-cream"
          style={{
            transform: open ? 'rotate(0deg)' : 'rotate(90deg)',
            opacity: open ? 1 : 0,
            transition: 'transform 400ms ease, opacity 400ms ease',
            transitionDelay: open ? '300ms' : '0ms',
          }}
        >
          <X size={26} strokeWidth={1.5} />
        </button>

        {/* Site Index */}
        <p
          className="text-xs uppercase tracking-[0.2em] text-cream/50"
          style={{
            transform: open ? 'translateY(0)' : 'translateY(8px)',
            opacity: open ? 1 : 0,
            transition: `transform 500ms ${EASE_SOFT}, opacity 500ms ${EASE_SOFT}`,
            transitionDelay: open ? '250ms' : '0ms',
          }}
        >
          Site Index
        </p>
        <nav className="mt-5 flex flex-col gap-3">
          {NAV.map((item, i) => (
            <a
              key={item.label}
              href={item.href}
              {...linkProps(item.href)}
              className="font-hn text-4xl text-cream"
              style={{
                transform: open ? 'translateY(0)' : 'translateY(24px)',
                opacity: open ? 1 : 0,
                transition: `transform 600ms ${EASE_SOFT}, opacity 600ms ${EASE_SOFT}`,
                transitionDelay: open ? `${300 + i * 80}ms` : '0ms',
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>

        {/* Find Me */}
        <p
          className="mt-12 text-xs uppercase tracking-[0.2em] text-cream/50"
          style={{
            transform: open ? 'translateY(0)' : 'translateY(8px)',
            opacity: open ? 1 : 0,
            transition: `transform 500ms ${EASE_SOFT}, opacity 500ms ${EASE_SOFT}`,
            transitionDelay: open ? '500ms' : '0ms',
          }}
        >
          Find Me
        </p>
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
          {SOCIAL.map((item, i) => (
            <a
              key={item.label}
              href={item.href}
              {...linkProps(item.href)}
              className="font-hn text-sm text-cream"
              style={{
                transform: open ? 'translateY(0)' : 'translateY(16px)',
                opacity: open ? 1 : 0,
                transition: `transform 500ms ${EASE_SOFT}, opacity 500ms ${EASE_SOFT}`,
                transitionDelay: open ? `${550 + i * 60}ms` : '0ms',
              }}
            >
              {item.label}
            </a>
          ))}
        </div>
      </aside>

      {/* ---------------------------------------------------------------- */}
      {/* Scroll cue -> posts (z-30)                                        */}
      {/* ---------------------------------------------------------------- */}
      <div
        className="anim-fade-up absolute inset-x-0 bottom-3 z-30 flex justify-center"
        style={{ animationDelay: '1700ms' }}
      >
        <button
          type="button"
          aria-label="Scroll to posts"
          onClick={() =>
            document
              .getElementById('posts')
              ?.scrollIntoView({ behavior: 'smooth' })
          }
          className="text-cream/70 transition-opacity duration-300 hover:opacity-100"
        >
          <ChevronDown className="animate-bounce" size={22} strokeWidth={1.5} />
        </button>
      </div>
    </section>

    {/* ================================================================== */}
    {/* Posts — live X timeline for @gurasees0                             */}
    {/* ================================================================== */}
    <section
      id="posts"
      className="min-h-[100dvh] w-full bg-black px-6 py-20 sm:px-10 sm:py-28"
    >
      <div className="mx-auto max-w-2xl">
        <p className="text-xs uppercase tracking-[0.2em] text-cream/50">Latest</p>
        <h2 className="mt-3 font-hn text-6xl leading-none text-cream sm:text-8xl">
          Posts
        </h2>
        <a
          href="https://x.com/gurasees0"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-block font-hn text-sm text-cream/70 transition-opacity duration-300 hover:opacity-100"
        >
          @gurasees0 on X
        </a>
        <div className="mt-10">
          <XTimeline />
        </div>
      </div>
    </section>
    </>
  )
}
