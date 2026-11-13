import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { findBrowser } from '../src/browser.js'

const server = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>p</title><p>plain page</p>') })
const home = mkdtempSync(join(tmpdir(), 'al-'))
const slow = join(home, 'slow-start')
let base = ''
let browser = ''

function run(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env: { ...process.env, BROWSER_LAYER_HOME: home, BROWSER_LAYER_BROWSER: browser }, timeout: 150000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, out: stdout + stderr }))
  })
}

before(async () => {
  // A Chrome that takes 30 s to start the next time it is launched, as one does on a machine starved of CPU.
  const real = ((await findBrowser()) as { path: string }).path
  browser = join(home, 'chrome.sh')
  writeFileSync(browser, `#!/bin/sh\nif [ -f '${slow}' ]; then sleep 30; rm -f '${slow}'; fi\nexec '${real}' "$@"\n`)
  chmodSync(browser, 0o755)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    r()
  }))
})
after(async () => {
  await run('stop')
  server.close()
  rmSync(home, { recursive: true, force: true })
})

test('Chrome killed and slow to come back: every session waits for the one daemon starting it, none is told it did not start', async () => {
  const sessions = ['a', 'b', 'c']
  for (const s of sessions) assert.equal((await run('--session', s, 'tab', `${base}/`)).code, 0)
  writeFileSync(slow, '')
  execFileSync('pkill', ['-9', '-f', `user-data-dir=${join(home, 'profile')}`])
  const results = await Promise.all(sessions.map(s => run('--session', s, 'tab', `${base}/`)))
  for (const r of results) assert.doesNotMatch(r.out, /daemon did not start/)
  assert.ok(results.every(r => r.code === 0 || /browser stopped/.test(r.out)), results.map(r => r.out).join('\n'))
  assert.equal(readFileSync(join(home, 'daemon.log'), 'utf8').split('\n').filter(l => l.startsWith('browser-layer daemon on')).length, 2)
})

const tabsNow = async (session: string) => (await run('--session', session, 'tabs')).out.trim().split('\n').map(l => l.replace(/ used .*/, ''))
const killBrowser = async () => {
  execFileSync('pkill', ['-9', '-f', `user-data-dir=${join(home, 'profile')}`])
  await new Promise(r => setTimeout(r, 1500))
}

test('a browser killed with tabs open comes back with the same tabs, the current one still current', async () => {
  await run('stop')
  await run('--session', 'keep', 'tab', `${base}/a`)
  await run('--session', 'keep', 'tab', `${base}/b`)
  const first = (await tabsNow('keep')).find(l => l.includes('/a'))!.trim().split(/\s+/)[0]
  await run('--session', 'keep', 'use', first)
  const before = await tabsNow('keep')
  assert.match(before[0], /^\* \d+ .*\/a /)
  await killBrowser()
  assert.deepEqual(await tabsNow('keep'), before)
})

test('stop ends the session: a browser that died and was then stopped restores nothing', async () => {
  await run('--session', 'keep', 'tab', `${base}/c`)
  await killBrowser()
  await run('stop')
  assert.match((await run('--session', 'keep', 'tabs')).out, /no live tabs/)
})

test('status puts an agent with no context back in its task: the tabs, the files it saved, its last calls; and it survives the browser dying', async () => {
  await run('stop')
  const dir = mkdtempSync(join(tmpdir(), 'al-out-'))
  const [text, rows, plain] = ['page.txt', 'rows.tsv', 'plain.html'].map(f => join(dir, f))
  await run('--session', 'st', 'tab', `${base}/a`)
  await run('--session', 'st', 'tab', `${base}/b`)
  await run('--session', 'st', 'read', '--out', text)
  await run('--session', 'st', 'find', 'plain', '--out', rows)
  await run('--session', 'st', 'open', `${base}/c`, '--out', plain)
  writeFileSync(`${rows}.unfinished`, `${base}/a\n${base}/b\nc1`)
  const status = async () => (await run('--session', 'st', 'status')).out
  const check = async () => {
    const out = await status()
    assert.match(out, /^tabs:\n\* \d+  \S+\/b  "p"  used .*\n  \d+  \S+\/a  "p"/m, out)
    assert.match(out, new RegExp(`files:\\n  ${plain}  \\d+ B\\n  ${rows}  \\d+ B  unfinished: run the same get --all again\\n  ${text}  \\d+ B`), out)
    assert.match(out, /calls:\n(.*\n)*  find plain → saved /, out)
    assert.ok(out.length < 1500, `${out.length} chars`)
  }
  await check()
  await killBrowser()
  await check()
  assert.doesNotMatch(await status(), /status/, 'the status call is not one of the calls it lists')
  await run('stop')
  assert.doesNotMatch(await status(), /files:|calls:/, 'stop ends the session')
  rmSync(dir, { recursive: true, force: true })
})
