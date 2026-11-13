import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

let base = ''
const server = createServer((_, res) => {
  res.setHeader('content-type', 'text/html')
  res.end('<title>p</title><p>a page</p>')
})

const home = mkdtempSync(join(tmpdir(), 'al-'))
writeFileSync(join(home, 'policy.json'), JSON.stringify({ 'sessions.idleMs': 1500, 'tabs.max': 3 }))

function run(...args: string[]): Promise<string> {
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { env: { ...process.env, BROWSER_LAYER_HOME: home }, timeout: 120000 }, (err, stdout, stderr) =>
      resolve(stdout + stderr))
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

test('a session idle past sessions.idleMs loses its tabs when another session works; the active one keeps its own', async () => {
  await run('--session', 'idle', 'tab', `${base}/`)
  await new Promise(r => setTimeout(r, 2000))
  await run('--session', 'busy', 'tab', `${base}/`)
  assert.match(await run('--session', 'idle', 'tabs'), /no live tabs/)
  assert.match(await run('--session', 'busy', 'tabs'), /http/)
  assert.match(await run('--session', 'idle', 'status'), new RegExp(`closed \\(tab <address> opens one again\\):\\n  ${base}/\\n`))
})

test('a session holds at most tabs.max tabs: the least recently used closes, never the current one, and the answer says so', async () => {
  for (const p of ['one', 'two', 'three']) await run('--session', 'many', 'tab', `${base}/${p}`)
  const listed = (await run('--session', 'many', 'tabs')).trim().split('\n')
  const id = (page: string) => listed.find(l => l.includes(`/${page} `))!.trim().replace(/^\* /, '').split(/\s+/)[0]
  await run('--session', 'many', 'use', id('one'))
  const answer = await run('--session', 'many', 'tab', `${base}/four`)
  assert.match(answer, new RegExp(`note: closed tab ${id('two')} \\(least recently used; at most 3 tabs a session\\)`))
  const tabs = (await run('--session', 'many', 'tabs')).trim().split('\n')
  assert.equal(tabs.length, 3)
  assert.doesNotMatch(tabs.join('\n'), /\/two /)
  assert.match(tabs.join('\n'), /\* \d+ +\S+\/four /)
  assert.match(await run('--session', 'many', 'status'), new RegExp(`closed \\(tab <address> opens one again\\):\\n  ${base}/two\\n`))
})
