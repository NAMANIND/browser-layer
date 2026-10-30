// CLI side of the daemon: send one command over the socket, starting the daemon if it is not up.
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { home } from './session.js'
import type { Command } from './daemon.js'

const socketPath = () => join(home(), 'daemon.sock')

type Reply = { ok: boolean; text?: string; error?: string }

function send(c: Command, timeout = 90000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socketPath(), method: 'POST', path: '/', timeout }, res => {
      let body = ''
      res.on('data', d => (body += d))
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch { reject(new Error(`bad reply from daemon: ${body.slice(0, 200)}`)) } })
    })
    req.on('timeout', () => req.destroy(new Error('daemon did not answer in time')))
    req.on('error', reject)
    req.end(JSON.stringify(c))
  })
}

function startDaemon() {
  mkdirSync(home(), { recursive: true })
  const self = fileURLToPath(import.meta.url)
  const entry = join(self, '..', `daemon${extname(self)}`)
  const log = openSync(join(home(), 'daemon.log'), 'a')
  // execArgv carries tsx's loader in dev and tests, and is empty for the built CLI.
  spawn(process.execPath, [...process.execArgv, entry], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref()
}

export async function live(c: Command): Promise<Reply> {
  try {
    return await send(c)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw err
  }
  if (c.cmd === 'stop') return { ok: true, text: 'daemon was not running' }
  startDaemon()
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 150))
    const up = await send({ cmd: 'ping' }, 2000).then(() => true, () => false)
    if (up) return send(c)
  }
  throw new Error(`daemon did not start — see ${join(home(), 'daemon.log')}`)
}
