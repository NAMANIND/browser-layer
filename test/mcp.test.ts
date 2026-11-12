import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'

const server = createServer((_, res) => {
  res.setHeader('content-type', 'text/html')
  res.end('<title>Hello</title><h1>Hello MCP</h1><p>plain text here</p>')
})
let base = ''
before(() => new Promise<void>(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; r() })))
after(() => { server.closeAllConnections(); server.close() })

// One server process, spoken to the way a client does: a JSON-RPC message per line.
function connect() {
  const home = mkdtempSync(join(tmpdir(), 'browser-layer-'))
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp'], { env: { ...process.env, BROWSER_LAYER_HOME: home } })
  const waiting = new Map<number, (m: any) => void>()
  let buffer = ''
  child.stdout.on('data', d => {
    buffer += d
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const msg = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      waiting.get(msg.id)?.(msg)
    }
  })
  let id = 0
  const call = (method: string, params?: unknown) => new Promise<any>(resolve => {
    waiting.set(++id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const close = () => { child.kill(); rmSync(home, { recursive: true, force: true }) }
  return { call, notify: (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'), close }
}

test('initialize, one tool whose description is the manual, and a call that returns what the CLI prints', async () => {
  const s = connect()
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.ok(init.result.capabilities.tools)
    s.notify('notifications/initialized')

    const { tools } = (await s.call('tools/list')).result
    assert.equal(tools.length, 1)
    assert.match(tools[0].description, /websites as text and verbs for agents/)
    assert.deepEqual(tools[0].inputSchema.required, ['command'])

    const ok = (await s.call('tools/call', { name: tools[0].name, arguments: { command: `open "${base}"` } })).result
    assert.equal(ok.isError, undefined)
    assert.match(ok.content[0].text, /Hello MCP/)

    const bad = (await s.call('tools/call', { name: tools[0].name, arguments: { command: 'nonsense' } })).result
    assert.equal(bad.isError, true)
    assert.match(bad.content[0].text, /unknown command "nonsense"/)

    assert.equal((await s.call('no/such')).error.code, -32601)
  } finally { s.close() }
})
