// A6 (docs/LONG-TASKS.md §2): one session, the same 20 calls over and over. Call 600 should cost what call 6 costs:
// the time of a call, the browser's and the daemon's memory, and the size of an answer are reported for the first and
// the last rounds. Run twice: closing its tabs each round (30 rounds), and never closing them (10 rounds, 40 tabs),
// which is what agents do.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ITEMS, start } from './site.mjs'

const round = (base, k, closing) => [
  ['tab', `${base}/list/rel?page=1&round=${k}`], ['map'], ['find', 'SKU-1000'], ['click', 'Next'], ['read'], ['back'],
  ['tab', `${base}/item/${ITEMS[k].sku}`], ['read'], ['find', 'Warranty'],
  ['tab', `${base}/wizard?round=${k}`], ['type', 'Full name', 'Asha Rao'], ['click', 'Continue'], ['type', 'Email', 'asha@example.test'], ['click', 'Continue'], ['read'],
  ['tab', `${base}/org/${(k % 6) + 1}?round=${k}`], ['find', 'Founded'], ['tabs'], ['map'], closing ? ['close', '--all'] : ['tabs'],
]

// Megabytes held by the browser started for this home (every process with the home in its command line) and by the
// daemon, its parent.
function memory(home) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
  const browser = rows.filter(r => r[4].includes(home))
  const daemon = rows.find(r => r[1] === browser.find(b => !b[4].includes('--type='))?.[2])
  return { browserMb: Math.round(browser.reduce((n, r) => n + Number(r[3]), 0) / 1024), daemonMb: Math.round(Number(daemon?.[3] ?? 0) / 1024), processes: browser.length }
}

const centile = (list, p) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))]

// runner: run.mjs's, handed in (this file is loaded by it).
export async function endure(runner) {
  const site = await start()
  const results = []
  for (const [name, rounds, closing] of [['closing tabs', 30, true], ['keeping tabs', 10, false]]) {
    const t = runner(site.base, false)
    let early
    for (let k = 0; k < rounds; k++) {
      for (const args of round(site.base, k, closing)) await t.bl(...args)
      if (k === 2) early = memory(t.home)
    }
    const late = memory(t.home)
    const ms = t.calls.map(c => c.ms), size = t.calls.map(c => c.answer.length)
    const first = n => n.slice(0, 60), last = n => n.slice(-60)
    const row = {
      run: name, calls: t.calls.length, errors: t.calls.filter(c => /^error:/m.test(c.answer)).length,
      msP50: [centile(first(ms), 0.5), centile(last(ms), 0.5)], msP95: [centile(first(ms), 0.95), centile(last(ms), 0.95)],
      answerChars: [first(size).reduce((a, b) => a + b), last(size).reduce((a, b) => a + b)],
      browserMb: [early.browserMb, late.browserMb], daemonMb: [early.daemonMb, late.daemonMb], processes: [early.processes, late.processes],
    }
    results.push(row)
    console.log(`${name}: ${row.calls} calls, ${row.errors} errors · first 60 calls → last 60: p50 ${row.msP50.join(' → ')} ms, p95 ${row.msP95.join(' → ')} ms, answers ${row.answerChars.join(' → ')} chars · after round 3 → at the end: browser ${row.browserMb.join(' → ')} MB in ${row.processes.join(' → ')} processes, daemon ${row.daemonMb.join(' → ')} MB`)
    await t.end()
  }
  site.close()
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'results', 'endure.json'), `${JSON.stringify(results, null, 1)}\n`)
}
