import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

// A page that only exists after JS runs: autocomplete, then a fetch() send with no <form>.
const APP = `<!doctype html><title>Trip</title><body><div id="app"></div><script>
  const app = document.getElementById('app')
  app.innerHTML = '<h1>Plan a trip</h1><label for="city">City</label><input id="city"><ul id="sug"></ul>' +
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

const env = { ...process.env, AGENT_LAYER_HOME: mkdtempSync(join(tmpdir(), 'al-')) }

function run(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile('npx', ['tsx', 'src/cli.ts', ...args], { env, timeout: 120000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr }))
  })
}

const ref = (out: string, what: RegExp) => {
  const m = out.match(new RegExp(`\\[(\\d+)\\] ${what.source}`))
  assert.ok(m, `no ref for ${what} in:\n${out}`)
  return m[1]
}

before(() => new Promise<void>(r => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  r()
})))
after(async () => { await run('stop'); server.close() })

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

test('stale refs and missing tabs fail with a clear message', async () => {
  const r = await run('click', '9999')
  assert.equal(r.code, 1)
  assert.match(r.out, /\[9999\] is no longer on the page/)
})
