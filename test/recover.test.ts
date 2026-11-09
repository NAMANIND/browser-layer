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
