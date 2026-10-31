// A true phone viewport through DevTools device emulation, with touch:
//   npx vite preview --host 127.0.0.1 --port 4175 --strictPort
//   node tools/phone_shot.mjs http://127.0.0.1:4175/?t=7 <output dir> <name>
// Headless --window-size cannot go below about 489 px wide, so this is the
// only honest way to see the narrow layout.

import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = process.argv[2]; const OUT = process.argv[3]; const NAME = process.argv[4] || 'phone'; const PORT = 9336
const chrome = spawn(CHROME, ['--headless=new','--use-gl=angle','--use-angle=swiftshader','--disable-gpu-sandbox','--hide-scrollbars','--window-size=800,900',`--remote-debugging-port=${PORT}`,'--user-data-dir='+OUT+'/chrome-profile4','about:blank'],{stdio:'ignore'})
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
let wsUrl
for (let i=0;i<40;i++){ try { const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p=l.find(t=>t.type==='page'); if(p){wsUrl=p.webSocketDebuggerUrl;break} } catch{} await sleep(250) }
const ws=new WebSocket(wsUrl); await new Promise(r=>ws.onopen=r)
let id=0; const pending=new Map()
ws.onmessage=(ev)=>{ const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)} }
const send=(method,params={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method,params}))})
await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true})
await send('Emulation.setTouchEmulationEnabled',{enabled:true})
await send('Page.navigate',{url:URL}); await sleep(10000)
const r = await send('Runtime.evaluate',{expression:'JSON.stringify({inner:[innerWidth,innerHeight],coarse:matchMedia("(pointer: coarse)").matches,hud:document.querySelector(".hud")&&document.querySelector(".hud").getBoundingClientRect().right,narrow:document.querySelector(".hint.narrow")&&document.querySelector(".hint.narrow").getBoundingClientRect().right})',returnByValue:true})
console.log(r.result.result.value)
const s=await send('Page.captureScreenshot',{format:'png'}); writeFileSync(`${OUT}/${NAME}.png`,Buffer.from(s.result.data,'base64')); console.log('saved',NAME)
ws.close(); chrome.kill(); await sleep(400); process.exit(0)
