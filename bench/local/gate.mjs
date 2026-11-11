// Pre-release gate: runs the short and the long task sets for a candidate and a baseline ref and prints a paired table and
// a go / no-go line.   node bench/local/gate.mjs <candidate-ref> <baseline-ref> [--repeats 3] [--max-usd 2]
// A metric is AHEAD only when the whole 95% bootstrap interval (10,000 resamples of tasks, as bu-run/finalcompare.py) is on
// the candidate's side, BEHIND when it is wholly on the other side, else tie. NO-GO if cost or wall time is BEHIND, or the
// score is BEHIND or lower; steps and input tokens are shown but too noisy on these tasks to veto (bench/README.md).
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const METRICS = [['score', true, true], ['usd', false, true], ['wallS', false, true], ['steps', false, false], ['inputTokens', false, false]]
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length

function rng(seed) { // mulberry32
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32 }
}

export function interval(diffs, seed = 1) {
  const r = rng(seed), means = []
  for (let i = 0; i < 10000; i++) means.push(mean(diffs.map(() => diffs[Math.floor(r() * diffs.length)])))
  means.sort((a, b) => a - b)
  return [means[250], means[9749]]
}

// rows: [{ task, cand: {metric: mean}, base: {metric: mean} }], one per task both arms finished.
export function judge(rows) {
  const lines = [], reasons = []
  for (const [m, higherBetter, vetoes] of METRICS) {
    const d = rows.map(r => r.cand[m] - r.base[m]), [lo, hi] = interval(d)
    const verdict = higherBetter ? (lo > 0 ? 'AHEAD' : hi < 0 ? 'BEHIND' : 'tie') : (hi < 0 ? 'AHEAD' : lo > 0 ? 'BEHIND' : 'tie')
    lines.push({ metric: m, cand: mean(rows.map(r => r.cand[m])), base: mean(rows.map(r => r.base[m])), diff: mean(d), lo, hi, verdict })
    if (vetoes && verdict === 'BEHIND') reasons.push(`${m} is BEHIND`)
    if (m === 'score' && mean(d) < 0 && verdict !== 'BEHIND') reasons.push('score is lower')
  }
  return { lines, go: !reasons.length, reasons }
}

// Runs that overlapped a system sleep are hung or distorted: drop them.
function sleepGaps() {
  const log = execFileSync('pmset', ['-g', 'log'], { encoding: 'utf8', maxBuffer: 1 << 28 })
  return [...log.matchAll(/^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4})\s+(Sleep|Wake|DarkWake)\b/gm)].map(m => [Date.parse(m[1].replace(' ', 'T').replace(' ', '')), m[2]])
}

function load(dir, gaps) {
  const kept = [], dropped = []
  for (const r of readdirSync(join(dir, 'runs'))) {
    const f = join(dir, 'runs', r, 'metrics.json')
    if (!existsSync(f)) continue
    const m = JSON.parse(readFileSync(f, 'utf8'))
    const slept = gaps.some(([t, kind]) => kind === 'Sleep' && t >= m.startedAt - 60000 && t <= m.startedAt + m.wallS * 1000 + 60000)
    ;(slept ? dropped : kept).push(m)
  }
  return { kept, dropped }
}

function rowsOf(runs) {
  const tasks = [...new Set(runs.map(r => r.task))], arm = (a, t) => runs.filter(r => r.arm === a && r.task === t)
  return tasks.filter(t => arm('cand', t).length && arm('base', t).length).map(t => ({
    task: t, cand: Object.fromEntries(METRICS.map(([m]) => [m, mean(arm('cand', t).map(r => r[m]))])),
    base: Object.fromEntries(METRICS.map(([m]) => [m, mean(arm('base', t).map(r => r[m]))])),
  }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1] }
  const [cand, base] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
  if (!cand || !base) { console.error('usage: gate.mjs <candidate-ref> <baseline-ref> [--repeats 3] [--max-usd 2]'); process.exit(2) }
  const here = dirname(fileURLToPath(import.meta.url)), repeats = opt('--repeats', '3'), maxUsd = opt('--max-usd', '2')
  const sha = r => execFileSync('git', ['rev-parse', '--short', r], { cwd: here, encoding: 'utf8' }).trim()
  const out = join(here, 'out', `gate-${sha(cand)}-${sha(base)}`)
  // Measured costs per run on haiku: short about $0.004, long about $0.011; a rerun resumes, never repeats a finished run.
  for (const [set, perRun] of [['short', 0.006], ['long', 0.015]])
    execFileSync('caffeinate', ['-dims', 'node', join(here, 'run.mjs'), '--out', out, '--arm', `cand=${cand}`, '--arm', `base=${base}`,
      '--set', set, '--repeats', repeats, '--model', 'haiku', '--est-usd-per-run', String(perRun), '--max-usd', maxUsd], { stdio: 'inherit' })
  const { kept, dropped } = load(out, sleepGaps())
  const rows = rowsOf(kept), { lines, go, reasons } = judge(rows)
  console.log(`\n${cand} (cand) against ${base} (base): ${rows.length} tasks, ${kept.length} runs kept, ${dropped.length} dropped for a sleep gap`)
  const f = x => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(4))
  console.log('metric'.padEnd(13) + ['cand', 'base', 'diff'].map(s => s.padStart(10)).join('') + '95% interval'.padStart(26) + 'verdict'.padStart(9))
  for (const l of lines) console.log(l.metric.padEnd(13) + [l.cand, l.base, l.diff].map(x => f(x).padStart(10)).join('') + `${f(l.lo)}..${f(l.hi)}`.padStart(26) + l.verdict.padStart(9))
  console.log(go ? 'GO' : `NO-GO: ${reasons.join('; ')}`)
  if (dropped.length) console.log(`rerun to refill the ${dropped.length} dropped runs after deleting them from ${out}/runs`)
  process.exit(go ? 0 : 1)
}
