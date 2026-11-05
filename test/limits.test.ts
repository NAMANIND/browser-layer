import { execFile } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const MB = 1_000_000
let base = ''
const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ pad: 'x'.repeat(MB) }))
  }
  res.setHeader('content-type', 'text/html')
  res.end(req.url === '/fetches'
    ? '<title>f</title><p>loading</p><script>for (const n of [1, 2, 3]) fetch("/api/" + n)</script>'
    : '<title>plain</title><p>plain page</p>')
})

const home = mkdtempSync(join(tmpdir(), 'al-'))
writeFileSync(join(home, 'policy.json'), JSON.stringify({ 'sessions.max': 2, 'network.tabBytes': 1.5 * MB }))

function run(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env: { ...process.env, BROWSER_LAYER_HOME: home }, timeout: 120000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr }))
  })
}

before(() => new Promise<void>(r => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  r()
})))
after(async () => {
  await run('stop')
  server.close()
  rmSync(home, { recursive: true, force: true })
})

test('a request the daemon cannot parse is an error for that caller, and the daemon carries on', async () => {
  await run('tab', `${base}/plain`)
  process.env.BROWSER_LAYER_HOME = home
  const { socketPath } = await import('../src/client.js')
  const reply = await new Promise<string>((done, fail) => request({ socketPath: socketPath(), method: 'POST', path: '/' }, res => {
    let body = ''
    res.on('data', d => (body += d)).on('end', () => done(body))
  }).on('error', fail).end('{not json'))
  assert.equal(JSON.parse(reply).ok, false)
  assert.match((await run('read')).out, /plain page/)
})

test('sessions.max: a session beyond the limit is refused, and one already open still works', async () => {
  assert.equal((await run('--session', 'b', 'tab', `${base}/plain`)).code, 0)
  const third = await run('--session', 'c', 'tab', `${base}/plain`)
  assert.equal(third.code, 1)
  assert.match(third.out, /2 sessions are open/)
  assert.equal((await run('--session', 'b', 'read')).code, 0)
})

test('network.tabBytes: the oldest answers are let go first, the newest is kept', async () => {
  await run('tab', `${base}/fetches`)
  await run('wait', 'loading')
  const list = (await run('net')).out.match(/#(\d+)\s+GET\s+\d+\s+\/api\/\d/g)!
  assert.equal(list.length, 3, 'three API calls listed')
  const ids = list.map(l => l.match(/#(\d+)/)![1])
  await run('go', `${base}/plain`)
  assert.match((await run('net', 'save', ids[0], join(home, 'first.json'))).out, /no body the browser still holds/)
  assert.match((await run('net', 'save', ids[2], join(home, 'last.json'))).out, /saved/)
})
