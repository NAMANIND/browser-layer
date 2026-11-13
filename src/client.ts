// CLI side of the daemon: send one command over the socket, starting the daemon if it is not up.
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { home } from './session.js'
import { findBrowser } from './browser.js'
import { forgetKept } from './kept.js'
import type { Command } from './daemon.js'

// Windows has no Unix sockets; a named pipe, named after the home dir, plays the same part.
// Unix socket paths are capped near 104 bytes on macOS and silently truncated past that,
// so a deep home dir gets a short, stable path in the temp dir instead.
const homeId = () => createHash('sha256').update(home()).digest('hex').slice(0, 12)
export const socketPath = () => {
  if (process.platform === 'win32') return `\\\\.\\pipe\\browser-layer-${homeId()}`
  const p = join(home(), 'daemon.sock')
  if (Buffer.byteLength(p) < 100) return p
  return join(tmpdir(), `browser-layer-${homeId()}.sock`)
}
const lockPath = () => join(home(), 'daemon.lock')
const LOCK_STALE_MS = 30000
// A daemon has no socket until its Chrome is up: attached, that can be a long wait on Chrome's "Allow remote
// debugging?" popup; launched, a slow start on a loaded machine. Its pid file, kept until it listens, tells the
// next command to wait for it, not to start a second daemon (and a second popup, or a second Chrome on one profile).
export const pidPath = () => join(home(), 'daemon.pid')
const ALLOW_WAIT_MS = 60000
const LAUNCH_WAIT_MS = 180000
const pending = (): number | undefined => {
  try {
    const pid = Number(readFileSync(pidPath(), 'utf8'))
    process.kill(pid, 0)
    return pid
  } catch {
    return undefined
  }
}

// The installed version: the CLI prints it, and a daemon started by another version (before an update)
// will not run this one's commands.
export const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version

type Reply = { ok: boolean; text?: string; error?: string; stale?: boolean }

function send(c: Partial<Command>, timeout = 90000): Promise<Reply> {
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

export const ping = () => send({ cmd: 'ping' }, 2000).then(() => true, () => false)

// Only one CLI call gets to spawn; concurrent calls just wait for that daemon to answer.
function takeLock(): boolean {
  try {
    closeSync(openSync(lockPath(), 'wx'))
    return true
  } catch {
    try {
      if (Date.now() - statSync(lockPath()).mtimeMs < LOCK_STALE_MS) return false
      rmSync(lockPath(), { force: true })
      closeSync(openSync(lockPath(), 'wx'))
      return true
    } catch {
      return false
    }
  }
}

function startDaemon(): number | undefined {
  const self = fileURLToPath(import.meta.url)
  const entry = join(self, '..', `daemon${extname(self)}`)
  const log = openSync(join(home(), 'daemon.log'), 'a')
  // execArgv carries tsx's loader in dev and tests, and is empty for the built CLI.
  // windowsHide: a detached process on Windows would otherwise open a console window of its own.
  const child = spawn(process.execPath, [...process.execArgv, entry], { detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env })
  child.unref()
  return child.pid
}

export async function live(c: Command): Promise<Reply> {
  // A browser that died leaves its tabs to be restored; `stop` is what says they are not wanted, whether or not a daemon is there to hear it.
  if (c.cmd === 'stop') forgetKept()
  // Each of a call's steps (each page of an `each`) has the daemon's own time limit, so the call waits for all of them.
  // A list being collected has that limit per page and the daemon's bound on pages, so the call has no limit of its own;
  // nor has an `each` whose pages the daemon finds (--from).
  const wait = (c.cmd === 'get' && c.all) || (c.cmd === 'each' && !c.pages?.length) ? 0 : 90000 * Math.max(1, c.cmd === 'each' ? c.pages!.length : c.steps?.length ?? 1)
  try {
    const reply = await send({ ...c, version: VERSION }, wait)
    // A daemon from another version stopped instead of answering; this version's starts below.
    if (!reply.stale) return reply
    if (c.cmd === 'stop') return { ok: true, text: 'stopped' }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ECONNRESET: the daemon went away while it held the command, so the command may have run, and running
    // it again could click or submit twice. Only `stop` (the daemon exiting) is safe to carry on from.
    if (code === 'ECONNRESET' && c.cmd !== 'stop') {
      return { ok: false, error: 'the browser stopped while this command ran, so what it did is not known: run browser-layer map to see the page' }
    }
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'ECONNRESET') throw err
  }
  // Asking about or stopping a browser that is not running must not start one.
  if (c.cmd === 'stop' && process.env.BROWSER_LAYER_ATTACH && pending()) {
    process.kill(pending()!)
    rmSync(pidPath(), { force: true })
    return { ok: true, text: 'stopped' }
  }
  if (c.cmd === 'stop' || c.cmd === 'state') return { ok: true, text: c.cmd === 'stop' ? 'daemon was not running' : '[]' }
  // Without a browser the daemon could only exit; say why now instead of waiting for it.
  if (!process.env.BROWSER_LAYER_ATTACH) {
    const browser = await findBrowser()
    if ('error' in browser) return { ok: false, error: browser.error }
  }
  mkdirSync(home(), { recursive: true })
  const attached = !!process.env.BROWSER_LAYER_ATTACH
  const launch = () => {
    const pid = startDaemon()
    if (pid) writeFileSync(pidPath(), String(pid))
  }
  let mine = pending() === undefined && takeLock()
  if (mine) launch()
  const started = Date.now()
  try {
    for (let i = 0; ; i++) {
      await new Promise(r => setTimeout(r, 150))
      if (await ping()) return send(c, wait)
      // A daemon that exited (Don't allow, Chrome would not start) is no longer worth waiting for.
      if (!pending()) {
        // The daemon waited on was one that was exiting (an old version): its exit leaves nothing to wait for.
        if (mine || !(mine = takeLock())) break
        launch()
      }
      if (!attached) {
        if (Date.now() - started > LAUNCH_WAIT_MS) throw new Error('the browser is still starting; run the command again')
        continue
      }
      // `attach auto` (a ws:// address; a port is http://) makes Chrome ask the person to click Allow: say so once,
      // give up waiting after a minute, and keep the daemon for the next command.
      if (i === 13 && process.env.BROWSER_LAYER_ATTACH!.startsWith('ws:')) console.error('Chrome is asking "Allow remote debugging?": click Allow in Chrome.')
      if (Date.now() - started > ALLOW_WAIT_MS) throw new Error('Chrome is still waiting for you to click Allow on "Allow remote debugging?"; click it, then run the command again')
    }
  } finally {
    if (mine) rmSync(lockPath(), { force: true })
  }
  throw new Error(`daemon did not start — see ${join(home(), 'daemon.log')}`)
}
