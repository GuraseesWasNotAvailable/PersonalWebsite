// Run from the repo root with the preview server up:
//   npx vite preview --host 127.0.0.1 --port 4174 --strictPort
//   node tools/cdp_test.mjs http://127.0.0.1:4174/ <output dir>

// Drive the page in headless Chrome over the DevTools protocol: click Earth,
// close in, click a sail from there (from the star view a sail is under the
// three pixel floor and is not a target), press Escape back out, and
// screenshot each state. Uses Node's built-in WebSocket; no packages.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = process.argv[2] || 'http://127.0.0.1:4174/'
const OUT = process.argv[3] || '.'
const PORT = 9333

const chrome = spawn(CHROME, [
  '--headless=new',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-gpu-sandbox',
  '--hide-scrollbars',
  '--window-size=1600,1000',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + OUT + '/chrome-profile',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('chrome did not come up')
}

const ws = new WebSocket(await pageWs())
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result.result.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.log(`saved ${name}.png`)
}
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
const key = async (k, code) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: 27 })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: URL })
// Let the warm-up and a few frames run.
for (let i = 0; i < 60; i++) {
  await sleep(500)
  const ready = await evaluate('typeof window.__dyson === "object"')
  if (ready) break
}
await sleep(3000)
console.log('device as the page sees it:', await evaluate('JSON.stringify({ coarse: matchMedia("(pointer: coarse)").matches, screen: [screen.width, screen.height], cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory })'))
const fps = await evaluate(`new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 > 2000) r((n / (performance.now() - t0) * 1000).toFixed(1)); else requestAnimationFrame(f) }; requestAnimationFrame(f) })`)
console.log(`frames per second under swiftshader: ${fps}`)
console.log('focus at start:', await evaluate('window.__dyson.focus()'))

const planet = await evaluate('JSON.stringify(window.__dyson.screen("planet"))')
console.log('planet on screen at', planet)
await shot('start')
const pp = JSON.parse(planet)
await click(pp.x, pp.y)
await sleep(4000)
console.log('focus after clicking the planet:', await evaluate('window.__dyson.focus()'))
await shot('click_planet')

// From the landed view a transit sail leaving Earth is tens of pixels
// across and in front of the planet, so it is a target.
const sail = await evaluate('JSON.stringify(window.__dyson.screen("sail"))')
console.log('a sail on screen at', sail)
if (sail !== 'null') {
  const sp = JSON.parse(sail)
  await click(sp.x, sp.y)
  await sleep(4000)
  console.log('focus after clicking a sail:', await evaluate('window.__dyson.focus()'), '|', await evaluate('window.__dyson.text()'))
  await shot('click_sail')
  await sleep(6000)
  console.log('six seconds later:', await evaluate('window.__dyson.text()'))
  await shot('follow_sail')
  await key('Escape', 'Escape')
  await sleep(4000)
  console.log('focus after escape from the sail:', await evaluate('window.__dyson.focus()'))
}

// Back on Earth: click the planet again to come in closer.
if ((await evaluate('window.__dyson.focus()')) !== 'ground') {
  const pb = JSON.parse(await evaluate('JSON.stringify(window.__dyson.screen("planet"))'))
  await click(pb.x, pb.y)
  await sleep(4000)
}
const p2 = JSON.parse(await evaluate('JSON.stringify(window.__dyson.screen("planet"))'))
await click(p2.x + 40, p2.y - 30)
await sleep(3000)
console.log('focus after closing in:', await evaluate('window.__dyson.focus()'))
await shot('click_closer')

await key('Escape', 'Escape')
await sleep(3500)
console.log('focus after escape:', await evaluate('window.__dyson.focus()'))

ws.close()
chrome.kill()
await sleep(500)
process.exit(0)
