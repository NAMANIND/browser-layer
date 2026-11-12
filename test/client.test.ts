import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('a daemon that dies while running a command is not asked to run it again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-'))
  process.env.BROWSER_LAYER_HOME = dir
  const { live, socketPath } = await import('../src/client.js')
  let received = 0
  const dying = createServer(req => { received++; req.socket.destroy() })
  await new Promise<void>(r => dying.listen(socketPath(), r))
  try {
    const reply = await live({ cmd: 'click', session: 'default', ref: '1' })
    assert.equal(reply.ok, false)
    assert.match(reply.error!, /stopped while this command ran.*map/)
    assert.equal(received, 1)
  } finally {
    dying.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// A daemon still connecting to Chrome (its pid file names a live process) for 2.5 s, then answering.
async function waitingForChrome(address: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'al-'))
  process.env.BROWSER_LAYER_HOME = dir
  process.env.BROWSER_LAYER_ATTACH = address
  const { live, socketPath, pidPath } = await import('../src/client.js')
  writeFileSync(pidPath(), String(process.pid))
  let said = ''
  const log = console.error
  console.error = (m: string) => { said += m }
  const late = createServer((_, res) => res.end('{"ok":true}'))
  const listening = new Promise(r => setTimeout(r, 2500)).then(() => new Promise<void>(r => late.listen(socketPath(), r)))
  try {
    await Promise.all([live({ cmd: 'tabs', session: 'default' }), listening])
    return said
  } finally {
    console.error = log
    late.close()
    delete process.env.BROWSER_LAYER_ATTACH
    rmSync(dir, { recursive: true, force: true })
  }
}

test('attached by port, the client does not tell the person to click Allow: only `attach auto` has that popup', async () => {
  assert.equal(await waitingForChrome('http://127.0.0.1:9222'), '')
})

test('attached to the Chrome that has remote debugging on, a slow start says to click Allow', async () => {
  assert.match(await waitingForChrome('ws://127.0.0.1:9222/devtools/browser/x'), /click Allow in Chrome/)
})

test('a daemon still exiting when the next command comes is replaced, not waited on until the command fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-'))
  process.env.BROWSER_LAYER_HOME = dir
  const { live, pidPath } = await import('../src/client.js')
  const leaving = spawn('sleep', ['1'])
  writeFileSync(pidPath(), String(leaving.pid))
  try {
    const r = await live({ cmd: 'tabs', session: 'default' })
    assert.equal(r.ok, true, r.error)
  } finally {
    await live({ cmd: 'stop' })
    rmSync(dir, { recursive: true, force: true })
  }
})
