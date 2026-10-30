import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const CSRF = 'tok-123'
let base = ''
let posted: URLSearchParams | null = null

const server = createServer((req, res) => {
  const url = new URL(req.url!, base)
  const session = /sid=abc/.test(req.headers.cookie ?? '')
  if (req.method === 'GET' && url.pathname === '/contact') {
    res.setHeader('set-cookie', 'sid=abc; Path=/; HttpOnly')
    res.setHeader('content-type', 'text/html')
    return res.end(`<!doctype html><title>Contact us</title>
      <h1>Contact</h1><p>Write to us.</p><a href="/about">About</a>
      <div style="display:none">secret promo</div>
      <form id="contact" method="post" action="/contact">
        <input type="hidden" name="csrf" value="${CSRF}">
        <label for="n">Your name</label><input id="n" name="name" required>
        <input name="email" type="email" required placeholder="Email">
        <select name="topic"><option value="sales">Sales</option><option value="help" selected>Help</option></select>
        <label><input type="radio" name="size" value="s">S</label><label><input type="radio" name="size" value="m" checked>M</label>
        <label><input type="checkbox" name="news"> Newsletter</label>
        <fieldset><legend>Toppings</legend>
          <label><input type="checkbox" name="top" value="bacon"> Bacon</label>
          <label><input type="checkbox" name="top" value="onion" checked> Onion</label>
          <label><input type="checkbox" name="top" value="cheese"> Cheese</label>
        </fieldset>
        <textarea name="message"></textarea>
        <button type="submit">Send</button>
      </form>
      <form action="/search"><input name="q"></form>`)
  }
  if (req.method === 'POST' && url.pathname === '/contact') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      posted = new URLSearchParams(body)
      if (!session || posted.get('csrf') !== CSRF) { res.statusCode = 403; return res.end('forbidden') }
      res.statusCode = 303
      res.setHeader('location', '/thanks')
      res.end()
    })
    return
  }
  if (url.pathname === '/thanks') {
    res.setHeader('content-type', 'text/html')
    return res.end(session ? '<title>Thanks</title><p>Thanks, we will be in touch.</p>' : '<p>no session</p>')
  }
  if (url.pathname === '/search') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ q: url.searchParams.get('q') }))
  }
  res.statusCode = 404
  res.end()
})

const env = { ...process.env, AGENT_LAYER_HOME: mkdtempSync(join(tmpdir(), 'agent-layer-')) }

function run(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile('npx', ['tsx', 'src/cli.ts', ...args], { env }, (err, stdout, stderr) =>
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr }))
  })
}

before(() => new Promise<void>(r => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  r()
})))
after(() => server.close())

test('open shows text, links and forms as verbs, without hidden content', async () => {
  const { code, out } = await run('open', `${base}/contact`)
  assert.equal(code, 0)
  assert.match(out, /"Contact us"/)
  assert.match(out, /Write to us\./)
  assert.doesNotMatch(out, /secret promo/)
  assert.match(out, /contact\.submit → POST \/contact/)
  assert.match(out, /name\*\s+text\s+"Your name"/)
  assert.match(out, /topic\s+sales \| help/)
  assert.match(out, /size\s+s \| m\n/)
  assert.match(out, /top\s+any of bacon, onion, cheese\s+"Toppings" = onion/)
  assert.doesNotMatch(out, /doctype|^Contact us$/im)
  assert.match(out, /search\.submit → GET \/search/)
  assert.match(out, /\[1\] About → \/about/)
  assert.doesNotMatch(out, /csrf/)
})

test('do refuses a verb with a missing required field', async () => {
  const { code, out } = await run('do', 'contact.submit', 'name=Naman')
  assert.equal(code, 1)
  assert.match(out, /missing required email/)
})

test('do submits the form with cookie, csrf and defaults, follows the redirect', async () => {
  const { code, out } = await run('do', 'contact', 'name=Naman', 'email=n@x.com', 'news=on', 'top=bacon,cheese', 'message=hello there')
  assert.equal(code, 0, out)
  assert.match(out, /Thanks, we will be in touch\./)
  assert.equal(posted!.get('csrf'), CSRF)
  assert.equal(posted!.get('topic'), 'help')
  assert.equal(posted!.get('size'), 'm')
  assert.equal(posted!.get('news'), 'on')
  assert.deepEqual(posted!.getAll('top'), ['bacon', 'cheese'])
  assert.equal(posted!.get('message'), 'hello there')
})

test('GET verbs become a query, JSON comes back as JSON', async () => {
  await run('open', `${base}/contact`)
  const { code, out } = await run('do', 'search', 'q=shoes')
  assert.equal(code, 0, out)
  assert.match(out, /"q": "shoes"/)
})
