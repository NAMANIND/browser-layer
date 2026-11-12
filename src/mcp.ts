// `browser-layer mcp`: one MCP tool over stdio that takes the command line the CLI takes and answers with what the
// CLI prints. Each call runs the CLI itself, so verbs, sessions and the daemon are the ones the shell has.
import { execFile } from 'node:child_process'
import { extname } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { script } from './script.js'
import { VERSION } from './client.js'

const cli = fileURLToPath(new URL(`cli${extname(fileURLToPath(import.meta.url))}`, import.meta.url))

// The manual is the CLI's own `help`, so the tool description cannot drift from it. execArgv carries tsx's loader in dev.
// Its stdin is closed so a nested `mcp` ends at once instead of waiting for a client.
const run = (words: string[]) => new Promise<{ text: string; failed: boolean }>(resolve => {
  const child = execFile(process.execPath, [...process.execArgv, cli, ...words], { maxBuffer: 1 << 28 }, (err, stdout, stderr) =>
    resolve({ text: (stdout + stderr).trim(), failed: !!err }))
  child.stdin!.end()
})

let manual: Promise<string> | undefined

async function handle(method: string, params: any) {
  if (method === 'initialize') return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'browser-layer', version: VERSION } }
  if (method === 'ping') return {}
  if (method === 'tools/list') {
    manual ??= run(['help']).then(r => r.text)
    return { tools: [{ name: 'browser', description: await manual, inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'A browser-layer command line, as you would type it after `browser-layer`' } }, required: ['command'] } }] }
  }
  if (method === 'tools/call') {
    if (params?.name !== 'browser' || typeof params.arguments?.command !== 'string') throw { code: -32602, message: 'tools/call: name "browser" with a string argument "command"' }
    // Words are split as steps splits them (quotes, no shell), so the command line cannot run anything else.
    const [step] = script(params.arguments.command)
    if (!step) throw { code: -32602, message: 'command is empty' }
    const { text, failed } = await run(step.words)
    return { content: [{ type: 'text', text }], ...(failed && { isError: true }) }
  }
  throw { code: -32601, message: `method not found: ${method}` }
}

export function serve() {
  createInterface({ input: process.stdin }).on('line', async line => {
    let msg: any
    try { msg = JSON.parse(line) } catch { return }
    // A message without an id is a notification: nothing answers it.
    if (msg.id === undefined) return
    try {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: await handle(msg.method, msg.params) }) + '\n')
    } catch (e: any) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message ?? String(e) } }) + '\n')
    }
  })
}
