// The cost floor (docs/LONG-TASKS.md §2): runs each par script against the floor site with the built CLI and reports
// what a perfect agent pays for the task: calls, characters answered, and the characters it reads over the whole task
// (every call re-reads the manual and all calls and answers before it). No model, no money.
// Modes: tool (only browser-layer), shell (a program may be run too), plain (the manual's one command for the job).
// Usage: npm run floor [-- <text in a task id>]     npm run floor -- --endure
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from './site.mjs'
import { TASKS } from './tasks.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const cli = join(root, 'dist', 'cli.js')
// A shell-mode script calls the tool by name, as an agent's shell does.
const bin = mkdtempSync(join(tmpdir(), 'floor-bin-'))
writeFileSync(join(bin, 'browser-layer'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`)
chmodSync(join(bin, 'browser-layer'), 0o755)

const quote = a => (/^[\w./:=?&,-]+$/.test(a) ? a : `'${a}'`)

// One run of one script: its own browser home, its calls recorded with their answers and times.
export function runner(base, shell) {
  const home = mkdtempSync(join(tmpdir(), 'floor-'))
  mkdirSync(join(home, 'out'))
  const env = { ...process.env, BROWSER_LAYER_HOME: home, PATH: `${bin}:${process.env.PATH}` }
  const calls = []
  const exec = (file, args, command, counted = true) => new Promise(done => {
    const began = Date.now()
    execFile(file, args, { env, maxBuffer: 1 << 28 }, (_, stdout, stderr) => {
      const answer = (stdout + stderr).trim()
      if (counted) calls.push({ command, answer, ms: Date.now() - began })
      done(answer)
    })
  })
  return {
    base, home, calls,
    bl: (...args) => exec(process.execPath, [cli, ...args], `browser-layer ${args.map(quote).join(' ')}`),
    sh: command => { if (!shell) throw new Error('a tool-only script has no shell'); return exec('/bin/bash', ['-c', command], command) },
    out: name => join(home, 'out', name),
    saved: () => readdirSync(join(home, 'out')).map(f => readFileSync(join(home, 'out', f), 'utf8')).join('\n'),
    killBrowserIn: ms => setTimeout(() => execFile('pkill', ['-f', join(home, 'profile')], () => {}), ms),
    end: async () => { await exec(process.execPath, [cli, 'stop'], '', false); rmSync(home, { recursive: true, force: true }) },
  }
}

// Characters read over the task: each call, and the final answer after the last, reads the manual and every call
// and answer so far.
export const carried = (calls, manual) => (calls.length + 1) * manual + calls.reduce((sum, c, i) => sum + (c.command.length + c.answer.length) * (calls.length - i), 0)

async function floor(only) {
  const site = await start()
  const manual = (await new Promise(done => execFile(process.execPath, [cli, 'help'], (_, out) => done(out)))).length
  const rows = []
  for (const task of TASKS.filter(t => !only || t.id.includes(only))) {
    for (const mode of ['tool', 'shell', 'plain']) {
      if (!task[mode]) continue
      const t = runner(site.base, mode === 'shell')
      const began = Date.now()
      let ok = false, note = ''
      try { ok = task.check(await task[mode](t), t) } catch (err) { note = err.message.split('\n')[0].slice(0, 100) }
      const row = { task: task.id, mode, ok, calls: t.calls.length, chars: t.calls.reduce((n, c) => n + c.answer.length, 0), biggest: Math.max(0, ...t.calls.map(c => c.answer.length)), carried: carried(t.calls, manual), seconds: Math.round((Date.now() - began) / 1000), note }
      rows.push(row)
      console.log(`${row.task.padEnd(44)} ${mode.padEnd(5)} ${(ok === true ? 'done' : ok || 'FAILED').padEnd(8)} ${String(row.calls).padStart(3)} calls ${String(row.chars).padStart(7)} chars  biggest ${String(row.biggest).padStart(6)}  carried ${String(Math.round(row.carried / 1000)).padStart(5)}k  ${String(row.seconds).padStart(3)} s  ${note}`)
      await t.end()
    }
  }
  site.close()
  if (!only) writeFileSync(join(root, 'bench', 'results', 'floor.json'), `${JSON.stringify({ manual, rows }, null, 1)}\n`)
}

if (process.argv.includes('--endure')) await (await import('./endure.mjs')).endure(runner)
else await floor(process.argv[2])
rmSync(bin, { recursive: true, force: true })
