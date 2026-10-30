import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/policy.js'

// A page that only exists after JS runs: autocomplete, then a fetch() send with no <form>.
const APP = `<!doctype html><title>Trip</title><body><div id="app"></div><script>
  const app = document.getElementById('app')
  app.innerHTML = '<h1>Plan a trip</h1><label for="city">City</label><input id="city"><ul id="sug" role="listbox"></ul>' +
    '<button id="send" disabled>Book</button><p id="out"></p><div style="display:none">hidden promo</div>'
  const city = document.getElementById('city'), sug = document.getElementById('sug'), send = document.getElementById('send')
  city.addEventListener('input', () => {
    sug.innerHTML = ''
    if (city.value.length < 2) return
    setTimeout(() => {
      for (const c of ['Delhi', 'Dehradun', 'Denver'].filter(c => c.toLowerCase().startsWith(city.value.toLowerCase()))) {
        const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = c
        li.onclick = () => { city.value = c; sug.innerHTML = ''; send.disabled = false }
        sug.appendChild(li)
      }
    }, 150)
  })
  send.onclick = async () => {
    const r = await fetch('/api/book', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ city: city.value }) })
    document.getElementById('out').textContent = (await r.json()).message
  }
</script></body>`

let base = ''
let booked = ''
const server = createServer((req, res) => {
  if (req.url === '/login') {
    res.setHeader('set-cookie', 'fast=1; Path=/')
    res.setHeader('content-type', 'text/html')
    return res.end('<p>logged in</p>')
  }
  if (req.url === '/whoami') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>who</title><p>fast cookie: ${/fast=1/.test(req.headers.cookie ?? '') ? 'yes' : 'no'}</p>`)
  }
  if (req.url === '/view') {
    res.setHeader('content-type', 'text/html')
    // A result list: each item is one row on screen whatever blocks it is built from.
    return res.end(`<meta charset="utf-8"><title>view</title>
      <ul><li><div><span>7:00 AM</span><div>–</div><span>9:10 AM</span></div><div>IndiGo</div><div>₹6,895</div></li>
      <li><div><span>4:15 AM</span><div>–</div><span>6:25 AM</span></div><div>SpiceJet</div><div>₹7,118</div></li></ul>
      <h2>Stacked</h2><p>first line</p><p>second line</p>
      <div aria-hidden="true"><p>BOM – DEL</p><button>ghost</button></div>
      <div inert><p>behind the dialog</p></div>
      <a href="/vote?id=1"></a> <a href="/about">About us</a> <a href="https://example.org/x">Elsewhere</a>
      <a href="/airport" aria-label="Chhatrapati Shivaji Maharaj International Airport Mumbai (BOM)"><span>Chhatrapati Shivaji Maharaj International Airport Mumbai</span><span>BOM</span> 15 km away</a>
      <button aria-label="From 6895 Indian rupees. Nonstop flight with IndiGo. Leaves Chhatrapati Shivaji Maharaj International Airport Mumbai at 7:00 AM and arrives at 9:10 AM">Select</button>`)
  }
  if (req.url === '/watch') {
    // Counts every DOM change that is not its own counter update.
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>watch</title><p>mutations: <span id="n">0</span></p><a href="/x">a link</a><input aria-label="field">
      <script>let n = 0; const out = document.getElementById('n')
      new MutationObserver(ms => { const mine = ms.filter(m => !out.contains(m.target)); if (mine.length) out.textContent = n += mine.length })
        .observe(document, { subtree: true, childList: true, attributes: true, characterData: true })</script>`)
  }
  if (req.url === '/delta') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>delta</title>${Array.from({ length: 30 }, (_, i) => `<p>story ${i}</p>`).join('')}
      <button onclick="const p = document.createElement('p'); p.textContent = 'loaded more'; document.body.append(p)">More</button>
      <a href="/page/next">next page</a>`)
  }
  if (req.url === '/spa') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>spa</title>${Array.from({ length: 20 }, (_, i) => `<p>item ${i}</p>`).join('')}
      <button onclick="history.pushState({}, '', '/spa?step=2'); this.textContent = 'Step 2'">Next</button>`)
  }
  if (req.url === '/modal') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>modal</title><p>background text</p><button>behind</button>
      <dialog aria-label="Pick a city"><button>Delhi</button></dialog>
      <button onclick="document.querySelector('dialog').showModal()">Open</button>`)
  }
  if (req.url === '/long') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>long</title>${Array.from({ length: 600 }, (_, i) => `<p>line ${i} ${'x'.repeat(250)}</p>`).join('')}`)
  }
  if (req.url?.startsWith('/page/')) {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>${req.url.slice(6)}</title><p>page ${req.url.slice(6)}</p>`)
  }
  if (req.url === '/api/book') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      booked = JSON.parse(body).city
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ message: `Booked ${booked}, confirmation AL-7` }))
    })
    return
  }
  res.setHeader('content-type', 'text/html')
  res.end(APP)
})

const home = mkdtempSync(join(tmpdir(), 'al-'))
// Deep enough that home/daemon.sock passes the ~104-byte Unix socket path limit.
const deepHome = join(home, 'deep', 'd'.repeat(110))

function runIn(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile('npx', ['tsx', 'src/cli.ts', ...args], { env: { ...process.env, AGENT_LAYER_HOME: dir }, timeout: 120000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr }))
  })
}

const run = (...args: string[]) => runIn(home, ...args)

const ref = (out: string, what: RegExp) => {
  const m = out.match(new RegExp(`\\[(\\d+)\\] ${what.source}`))
  assert.ok(m, `no ref for ${what} in:\n${out}`)
  return m[1]
}

before(() => new Promise<void>(r => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  r()
})))
after(async () => {
  await run('stop')
  await runIn(deepHome, 'stop')
  server.close()
  rmSync(home, { recursive: true, force: true })
})

test('plain fetch sees an empty shell', async () => {
  const { out } = await run('open', base)
  assert.doesNotMatch(out, /Plan a trip/)
})

test('a live tab runs the JS: type, pick a suggestion, click, read the result and the API under it', async () => {
  let r = await run('tab', base)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Plan a trip/)
  assert.doesNotMatch(r.out, /hidden promo/)
  assert.match(r.out, /button "Book"\s+disabled/)

  r = await run('type', ref(r.out, /textbox "City"/), 'de')
  assert.match(r.out, /textbox "City"\s+= "de"\s+focused/)
  r = await run('click', ref(r.out, /option "Delhi"/))
  assert.match(r.out, /= "Delhi"/)
  r = await run('click', ref(r.out, /button "Book"/))
  assert.match(r.out, /Booked Delhi, confirmation AL-7/)
  assert.equal(booked, 'Delhi')

  r = await run('net')
  assert.match(r.out, /POST\s+200\s+\/api\/book\s+application\/json\s+body: \{"city":"Delhi"\}/)
})

test('a fast-path login survives live commands, and live tabs see it', async () => {
  await run('tab', `${base}/page/x`)
  await run('open', `${base}/login`)
  await run('read')
  let r = await run('open', `${base}/whoami`)
  assert.match(r.out, /fast cookie: yes/)
  r = await run('tab', `${base}/whoami`)
  assert.match(r.out, /fast cookie: yes/)
})

test('sessions keep their own tabs and cannot touch each other', async () => {
  const a = await run('--session', 'a', 'tab', `${base}/page/alpha`)
  await run('--session', 'b', 'tab', `${base}/page/beta`)
  const aId = a.out.match(/^tab (\d+)/)![1]
  assert.match((await run('--session', 'a', 'read')).out, /page alpha/)
  assert.match((await run('--session', 'b', 'read')).out, /page beta/)
  assert.doesNotMatch((await run('--session', 'b', 'tabs')).out, /alpha/)
  const r = await run('--session', 'b', 'use', aId)
  assert.equal(r.code, 1)
  assert.match(r.out, /belongs to session "a"/)
})

test('two commands from cold start one daemon, and both tabs live in it', async () => {
  await run('stop')
  const [one, two] = await Promise.all([run('--session', 'c', 'tab', `${base}/page/one`), run('--session', 'c', 'tab', `${base}/page/two`)])
  assert.equal(one.code, 0, one.out)
  assert.equal(two.code, 0, two.out)
  const tabs = (await run('--session', 'c', 'tabs')).out
  assert.match(tabs, /page\/one/)
  assert.match(tabs, /page\/two/)
})

test('the live view: one line per row, aria-hidden text without refs, hidden labels clipped, links only when useful', async () => {
  const { code, out } = await run('tab', `${base}/view`)
  assert.equal(code, 0, out)
  assert.match(out, /^• 7:00 AM – 9:10 AM · IndiGo · ₹6,895$/m)
  assert.match(out, /^• 4:15 AM – 6:25 AM · SpiceJet · ₹7,118$/m)
  assert.match(out, /^## Stacked$\n^first line$\n^second line$/m)
  assert.match(out, /^BOM – DEL$\n^ghost$/m)
  assert.doesNotMatch(out, /button "ghost"|behind the dialog/)
  assert.match(out, /link → \/vote\?id=1/)
  assert.match(out, /link "About us"(?! →)/)
  assert.match(out, /link "Elsewhere" → example\.org/)
  // Its name is on screen inside longer text, only formatted differently: a visible name, never cut.
  assert.match(out, /link "Chhatrapati Shivaji Maharaj International Airport Mumbai \(BOM\)"/)
  const label = out.match(/button "(From 6895[^"]*)"/)
  // Its visible text is "Select"; the long name is a hidden label, so it gets the shorter cap.
  assert.ok(label && label[1].length === DEFAULTS['render.labelChars'] && label[1].endsWith('…'), out)
})

test('reading never changes the page', async () => {
  await run('tab', `${base}/watch`)
  await run('read')
  const r = await run('read')
  assert.match(r.out, /mutations: 0/)
  assert.match(r.out, /\[\d+\] link "a link"/)
})

test('actions answer with what changed; read and navigation give the whole page', async () => {
  const full = await run('tab', `${base}/delta`)
  assert.match(full.out, /story 5/)
  const more = await run('click', ref(full.out, /button "More"/))
  assert.match(more.out, /lines gone, \d+ new \(full page: agent-layer read\)/)
  assert.match(more.out, /^\+ loaded more$/m)
  assert.doesNotMatch(more.out, /story 5/)
  assert.match((await run('read')).out, /story 5[\s\S]*loaded more/)
  const next = await run('click', ref(full.out, /link "next page"/))
  assert.match(next.out, /^tab \d+ .*\/page\/next/)
  assert.match(next.out, /page next/)
})

test('a pushState URL change keeps refs and answers with changes', async () => {
  const page = await run('tab', `${base}/spa`)
  const next = ref(page.out, /button "Next"/)
  const step = await run('click', next)
  assert.match(step.out, /\/spa\?step=2 .*lines gone/)
  assert.match(step.out, new RegExp(`^\\+ \\[${next}\\] button "Step 2"`, 'm'))
})

test('an open modal dialog is the whole view', async () => {
  const page = await run('tab', `${base}/modal`)
  assert.match(page.out, /background text/)
  const open = await run('click', ref(page.out, /button "Open"/))
  assert.match(open.out, /dialog "Pick a city" — the page behind it is not available/)
  assert.match(open.out, /button "Delhi"/)
  assert.doesNotMatch(open.out, /background text|button "behind"/)
})

test('long views come in pages and every page is reachable', async () => {
  const first = await run('tab', `${base}/long`)
  assert.match(first.out, /\(page 1 of (\d+)\)/)
  const total = Number(first.out.match(/\(page 1 of (\d+)\)/)![1])
  assert.ok(total >= 2)
  assert.match(first.out, /more below: agent-layer read --page 2/)
  const last = await run('read', '--page', String(total))
  assert.match(last.out, /line 599 /)
  assert.doesNotMatch(last.out, /more below/)
  const past = await run('read', '--page', String(total + 1))
  assert.equal(past.code, 1)
  assert.match(past.out, /does not exist/)
})

test('a home dir deeper than the socket path limit still starts the daemon', async () => {
  mkdirSync(deepHome, { recursive: true })
  const r = await runIn(deepHome, 'tab', `${base}/page/deep`)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /page deep/)
})

test('stale refs and missing tabs fail with a clear message', async () => {
  const none = await run('--session', 'empty', 'read')
  assert.equal(none.code, 1)
  assert.match(none.out, /no live tab in session "empty"/)
  await run('tab', `${base}/page/x`)
  const r = await run('click', '9999')
  assert.equal(r.code, 1)
  assert.match(r.out, /\[9999\] is not on the page/)
})
