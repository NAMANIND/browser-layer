import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/policy.js'

const CSRF = 'tok-123'
let base = ''
let posted: URLSearchParams | null = null
let inFlight = 0
let mostInFlight = 0
// How many times each /late/ page was asked for: what a run that carries on must not repeat.
const late: Record<string, number> = {}

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
  if (url.pathname.startsWith('/lag/')) {
    mostInFlight = Math.max(mostInFlight, ++inFlight)
    return void setTimeout(() => { inFlight--; res.setHeader('content-type', 'text/html'); res.end(`<title>lag</title><p>lagged ${url.pathname}</p>`) }, 300)
  }
  if (url.pathname.startsWith('/late/')) {
    late[url.pathname] = (late[url.pathname] ?? 0) + 1
    return void setTimeout(() => { res.setHeader('content-type', 'text/html'); res.end(`<title>Late ${url.pathname.slice(6)}</title><p>late ${url.pathname.slice(6)}</p>`) }, 300)
  }
  if (url.pathname.startsWith('/big/')) {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>Big</title>${Array.from({ length: 80 }, (_, k) => `<p>big ${url.pathname.slice(5)} line ${k} ${'x'.repeat(90)}</p>`).join('')}`)
  }
  if (url.pathname.startsWith('/doc/')) {
    const n = url.pathname.slice(5)
    const lines = Array.from({ length: 30 }, (_, k) => `<p>paragraph ${k + 1} of doc ${n}</p>`)
    if (n === '2') lines[11] = '<p>needle here</p>'
    if (n === '3') lines[4] = '<p>== not a header</p>'
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>Doc ${n}</title><h1>Doc ${n} heading</h1>${lines.join('')}`)
  }
  if (url.pathname === '/sitemap.xml') {
    res.setHeader('content-type', 'application/xml')
    return res.end('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a?x=1&amp;y=2</loc><lastmod>2024-07-19</lastmod></url><url><loc>https://example.com/b</loc></url></urlset>')
  }
  if (url.pathname === '/wide.json') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, name: `row ${i} ${'x'.repeat(30)}` }))))
  }
  if (url.pathname === '/wide') {
    res.setHeader('content-type', 'text/html')
    return res.end(`<title>Wide</title><p>${Array.from({ length: 800 }, (_, i) => `word${i}`).join(' ')}</p>`)
  }
  if (url.pathname === '/search') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ q: url.searchParams.get('q') }))
  }
  // A server that takes the request and never answers.
  if (url.pathname === '/never') return
  res.statusCode = 404
  res.end()
})

const env = { ...process.env, BROWSER_LAYER_HOME: mkdtempSync(join(tmpdir(), 'browser-layer-')) }

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
  server.closeAllConnections()
  server.close()
  rmSync(env.BROWSER_LAYER_HOME, { recursive: true, force: true })
})

test('--version prints the package version; an unknown command fails and says so', async () => {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  for (const flag of ['--version', '-v', 'version']) assert.deepEqual(await run(flag), { code: 0, out: `${version}\n` })
  const bad = await run('nope')
  assert.equal(bad.code, 1)
  assert.match(bad.out, /^unknown command "nope"\n\nbrowser-layer — /)
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
  assert.match((await run('open', `${base}/app`)).out, /this page builds itself with JavaScript; browser-layer tab .*\/app runs it/)
})

test('open with several addresses fetches them together, at most open.perHost per host', async () => {
  writeFileSync(join(env.BROWSER_LAYER_HOME, 'policy.json'), JSON.stringify({ 'open.perHost': 2 }))
  const urls = ['a', 'b', 'c', 'd', 'e', 'f'].map(s => `${base}/lag/${s}`)
  const t0 = Date.now()
  const out = await run('open', ...urls)
  const took = Date.now() - t0
  assert.equal(out.code, 0, out.out)
  for (const u of urls) assert.match(out.out, new RegExp(`lagged ${u.slice(base.length)}`))
  assert.equal(mostInFlight, 2, 'two at a time on one host: together, but not all')
  assert.ok(took < 6 * 300, `six pages at two at a time take three waits, not six (${took} ms)`)
  const one = await run('open', `${base}/lag/a`)
  assert.match(one.out, /^http:\/\/127\.0\.0\.1:\d+\/lag\/a {2}\[200\] {2}"lag"\n\nlagged \/lag\/a/)
})

test('an XML list is saved one record per line, not as one run of text', async () => {
  const file = join(env.BROWSER_LAYER_HOME, 'sitemap.txt')
  const out = await run('open', '--out', file, `${base}/sitemap.xml`)
  assert.equal(out.code, 0, out.out)
  assert.equal(readFileSync(file, 'utf8'), 'https://example.com/a?x=1&y=2 2024-07-19\nhttps://example.com/b\n')
  const shown = await run('open', `${base}/sitemap.xml`)
  assert.match(shown.out, /^https:\/\/example.com\/b$/m)
})

test('open --out writes a header line and the page lines per address, and answers with failures and a headline per page', async () => {
  writeFileSync(join(env.BROWSER_LAYER_HOME, 'policy.json'), JSON.stringify({ 'bulk.pages': 2 }))
  const urls = [`${base}/doc/1`, `${base}/doc/2`, `${base}/doc/3`, `${base}/gone`, 'http://127.0.0.1:1/none', `${base}/app`]
  const file = join(env.BROWSER_LAYER_HOME, 'open.out')
  const out = await run('open', '--out', file, ...urls)
  assert.equal(out.code, 0, out.out)
  assert.match(out.out, new RegExp(`^open: 6 pages, 2 failed, saved ${file}\\n`))
  assert.match(out.out, new RegExp(`failed:\\n  ${urls[3]} — HTTP 404\\n  ${urls[4]} — fetch failed \\(`))
  assert.match(out.out, new RegExp(`${urls[0]}  "Doc 1" · 31 lines, \\d+ chars · line 1\\n`))
  assert.match(out.out, new RegExp(`${urls[1]}  "Doc 2" · 31 lines, \\d+ chars · line 33\\n… 2 more\\n`))
  assert.match(out.out, /rg -n '\^== '/)
  assert.ok(out.out.length < 900, `the answer stays small (${out.out.length})`)
  const lines = readFileSync(file, 'utf8').split('\n')
  const headers = lines.map((l, i) => [i + 1, l] as const).filter(([, l]) => l.startsWith('== '))
  assert.deepEqual(headers.map(([, l]) => l.split('  ')[0]), urls.map(u => `== ${u}`), 'a page line that looks like a header is not one')
  assert.equal(headers[1][0], 33)
  assert.match(headers[0][1], /  \[200\]$/)
  assert.match(headers[3][1], /  HTTP 404$/)
  assert.match(headers[4][1], /  error: /)
  const hits = lines.map((l, i) => `${i + 1}:${l}`).filter(l => l.includes('needle'))
  assert.deepEqual(hits, ['46:needle here'], 'a search returns the line, not the page')
  assert.ok(lines.slice(0, 3).join('\n').length < 200, 'head -3 is three lines')
  assert.ok(lines.includes(' == not a header'))
})

test('open --out is written as pages arrive; killed part way, the same command fetches only the rest and ends with the whole file', async () => {
  writeFileSync(join(env.BROWSER_LAYER_HOME, 'policy.json'), JSON.stringify({ 'open.concurrency': 2 }))
  const urls = Array.from({ length: 10 }, (_, k) => `${base}/late/${k}`)
  const whole = join(env.BROWSER_LAYER_HOME, 'open-whole.out')
  await run('open', '--out', whole, ...urls)
  const file = join(env.BROWSER_LAYER_HOME, 'open-cut.out')
  const heads = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l.startsWith('== ')) : [])
  for (const k of Object.keys(late)) delete late[k]
  const call = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'open', '--out', file, ...urls], { env })
  for (let i = 0; i < 100 && heads().length < 3; i++) await new Promise(r => setTimeout(r, 100))
  call.kill('SIGKILL')
  await new Promise(r => call.on('exit', r))
  const kept = heads().length
  assert.ok(kept >= 3 && kept < urls.length, `the pages arrived so far are in the file (${kept})`)
  assert.ok(existsSync(`${file}.unfinished`))
  for (const k of Object.keys(late)) delete late[k]
  const again = await run('open', '--out', file, ...urls)
  assert.match(again.out, new RegExp(`^open: 10 pages, 0 failed, ${kept} kept from the file, saved `))
  assert.deepEqual(Object.keys(late).sort(), urls.slice(kept).map(u => u.slice(base.length)).sort(), 'only the pages the file lacked were fetched')
  assert.equal(readFileSync(file, 'utf8'), readFileSync(whole, 'utf8'))
  assert.ok(!existsSync(`${file}.unfinished`))
  const other = await run('open', '--out', file, ...urls.slice(0, 2))
  assert.match(other.out, /^open: 2 pages, 0 failed, saved /)
})

test('open --out keeps a failed page marked unfinished, and the same command fetches only that one again', async () => {
  const file = join(env.BROWSER_LAYER_HOME, 'open-failed.out')
  const urls = [`${base}/doc/1`, `${base}/gone`, `${base}/doc/2`]
  const first = await run('open', '--out', file, ...urls)
  assert.match(first.out, /^open: 3 pages, 1 failed, saved /)
  assert.match(first.out, /the same command run again fetches only the failed/)
  assert.ok(existsSync(`${file}.unfinished`))
  assert.match((await run('open', '--out', file, ...urls)).out, /^open: 3 pages, 1 failed, 2 kept from the file, saved /)
})

test('open with several addresses and no --out over answer.maxChars is a head and a file with every page', async () => {
  const urls = [1, 2, 3, 4].map(n => `${base}/big/${n}`)
  const out = await run('open', ...urls)
  assert.equal(out.code, 0, out.out)
  assert.ok(out.out.length < DEFAULTS['answer.headChars'] + 1000, `${out.out.length} chars`)
  assert.match(out.out, new RegExp(`^${urls[0]}\\n`))
  assert.doesNotMatch(out.out, /big 4 line/)
  const file = out.out.match(/saved (\S+\.txt)/)![1]
  assert.equal(dirname(file), join(env.BROWSER_LAYER_HOME, 'results'))
  const whole = readFileSync(file, 'utf8')
  for (const u of urls) assert.ok(whole.includes(`${u}\n`))
  assert.match(whole, /big 4 line 79 /)
  assert.ok(whole.length > DEFAULTS['answer.maxChars'])
  const next = Number(out.out.match(/sed -n (\d+),/)![1])
  assert.match(whole.split('\n')[next - 1], /^big \d line \d+ /)
})

test('saved answers stay within answer.keepFiles and answer.keepBytes', async () => {
  rmSync(join(env.BROWSER_LAYER_HOME, 'results'), { recursive: true, force: true })
  const urls = [1, 2, 3, 4].map(n => `${base}/big/${n}`)
  writeFileSync(join(env.BROWSER_LAYER_HOME, 'policy.json'), JSON.stringify({ 'answer.keepFiles': 3 }))
  for (let i = 0; i < 5; i++) await run('open', ...urls)
  assert.deepEqual(readdirSync(join(env.BROWSER_LAYER_HOME, 'results')).sort(), ['3.txt', '4.txt', '5.txt'])
  writeFileSync(join(env.BROWSER_LAYER_HOME, 'policy.json'), JSON.stringify({ 'answer.keepBytes': 80000 }))
  await run('open', ...urls)
  assert.deepEqual(readdirSync(join(env.BROWSER_LAYER_HOME, 'results')).sort(), ['5.txt', '6.txt'], 'two files of about 34k fit under 80k, a third does not')
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
  assert.match(out, /"q":"shoes"/)
})

test('no file saved with open --out has a line longer than save.lineChars, JSON or text, one page or several', async () => {
  const file = join(env.BROWSER_LAYER_HOME, 'wide.txt')
  for (const args of [[`${base}/wide.json`], [`${base}/wide`], [`${base}/wide.json`, `${base}/wide`]]) {
    assert.equal((await run('open', '--out', file, ...args)).code, 0)
    const lines = readFileSync(file, 'utf8').split('\n')
    assert.ok(lines.length > 3 && lines.every(l => l.length <= DEFAULTS['save.lineChars']), args.join(' '))
  }
  await run('open', '--out', file, `${base}/wide.json`)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 300)
})

test('a page that never answers fails after load.timeoutMs, and the other pages of the call still answer', async () => {
  writeFileSync(join(env.BROWSER_LAYER_HOME, 'policy.json'), JSON.stringify({ 'load.timeoutMs': 1000 }))
  const out = await run('open', `${base}/never`, `${base}/wide`)
  assert.match(out.out, /\/never\nerror: no answer in 1 s/)
  assert.match(out.out, /word1 /)
})
