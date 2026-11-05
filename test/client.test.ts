import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
