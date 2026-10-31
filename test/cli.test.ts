import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
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
  if (url.pathname === '/spec') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<!doctype html><meta charset="utf-8"><title>spec</title>
      <form id="spec" method="post" action="/echo">
        <input type="hidden" name="t" value="1"><input name="q" value="hi" dirname="q.dir"><input type="hidden" name="t" value="2">
        <textarea name="note">line1
line2</textarea>
        <fieldset disabled><legend><input name="kept" value="y"></legend><input name="gone" value="x"></fieldset>
        <select name="tags" multiple><option selected>a</option><option>b</option><option selected>c</option></select>
        <input name="off" disabled value="z"><button name="go" value="yes" formaction="/echo2">Go</button>
      </form><input name="outside" value="o" form="spec">
      <form id="plain" method="post" action="/echo" enctype="text/plain"><input name="a" value="1"><input name="b" value="2"><button>Send</button></form>
      <noscript><p>Enable JavaScript please</p></noscript>`)
  }
  if (url.pathname === '/echo' || url.pathname === '/echo2') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: url.pathname, type: req.headers['content-type'], body })) })
    return
  }
  if (url.pathname === '/app') {
    res.setHeader('content-type', 'text/html')
    return res.end('<!doctype html><title>app</title><div id="root"></div><script src="/app.js"></script>')
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
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env }, (err, stdout, stderr) =>
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr }))
  })
}

before(() => new Promise<void>(r => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  r()
})))
after(() => {
  server.close()
  rmSync(env.AGENT_LAYER_HOME, { recursive: true, force: true })
})

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
  assert.match(out, /\[1\] link "About"/)
  assert.doesNotMatch(out, /csrf/)
})

test('forms submit as the HTML spec builds the entry list: owners, disabled, submitter, dirname, CRLF', async () => {
  const page = await run('open', `${base}/spec`)
  assert.match(page.out, /Enable JavaScript please/)
  const sent = JSON.parse((await run('do', 'spec', '--json')).out).body
  const echoed = JSON.parse(sent)
  assert.equal(echoed.path, '/echo2')
  assert.equal(echoed.type, 'application/x-www-form-urlencoded')
  assert.equal(echoed.body, 't=1&q=hi&q.dir=ltr&t=2&note=line1%0D%0Aline2&kept=y&tags=a&tags=c&go=yes&outside=o')
  await run('open', `${base}/spec`)
  const plain = JSON.parse(JSON.parse((await run('do', 'plain', '--json')).out).body)
  assert.equal(plain.type, 'text/plain')
  assert.equal(plain.body, 'a=1\r\nb=2\r\n')
})

test('a page built by JavaScript says so instead of looking empty', async () => {
  assert.match((await run('open', `${base}/app`)).out, /this page builds itself with JavaScript; agent-layer tab .*\/app runs it/)
})

test('do refuses a verb with a missing required field', async () => {
  await run('open', `${base}/contact`)
  const { code, out } = await run('do', 'contact.submit', 'name=Naman')
  assert.equal(code, 1)
  assert.match(out, /missing required email/)
})

test('do submits the form with cookie, csrf and defaults, follows the redirect', async () => {
  await run('open', `${base}/contact`)
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
