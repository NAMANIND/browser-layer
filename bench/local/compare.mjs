// Compares two arms of runs written by run.mjs, paired by task.
//   node bench/local/compare.mjs --a LABEL --b LABEL DIR [DIR…]
// Per metric: each arm's mean, the mean of the per-task differences (B − A), that mean's standard error across
// tasks, how many tasks went each way, and the smallest effect those runs could show (2 standard errors, as a
// share of A's mean). A difference under that share is within noise.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = k => args[args.indexOf(k) + 1]
const [a, b] = [opt('--a'), opt('--b')]
const dirs = args.filter((x, i) => !x.startsWith('--') && !args[i - 1]?.startsWith('--'))
const runs = dirs.flatMap(d => readdirSync(join(d, 'runs')).map(r => join(d, 'runs', r, 'metrics.json')).filter(existsSync).map(f => JSON.parse(readFileSync(f, 'utf8'))))
const METRICS = ['score', 'steps', 'lookbacks', 'chars', 'carried', 'inputTokens', 'outputTokens', 'usd', 'wallS']
const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length
const sd = xs => xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1))
const cell = (arm, task, m) => runs.filter(r => r.arm === arm && r.task === task).map(r => r[m])
const tasks = [...new Set(runs.map(r => r.task))].filter(t => cell(a, t, 'steps').length && cell(b, t, 'steps').length)
const n = arm => runs.filter(r => r.arm === arm && tasks.includes(r.task))
const hit = arm => n(arm).filter(r => r.limit).length

console.log(`${a} (${n(a).length} runs) vs ${b} (${n(b).length} runs), ${tasks.length} tasks; limit hits ${hit(a)} vs ${hit(b)}`)
console.log('metric       ' + [a, b, 'diff', 'se', 'b>a/b<a', 'within-task sd %', 'detectable %'].map(s => s.padStart(15)).join(''))
for (const m of METRICS) {
  const A = tasks.map(t => mean(cell(a, t, m))), B = tasks.map(t => mean(cell(b, t, m)))
  const d = B.map((x, i) => x - A[i])
  const se = sd(d) / Math.sqrt(d.length)
  const within = mean(tasks.flatMap(t => [a, b].map(x => sd(cell(x, t, m)) / (mean(cell(x, t, m)) || 1)))) * 100
  const f = x => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(4)).padStart(15)
  console.log(m.padEnd(13) + f(mean(A)) + f(mean(B)) + f(mean(d)) + f(se) + `${d.filter(x => x > 0).length}/${d.filter(x => x < 0).length}`.padStart(15) + within.toFixed(0).padStart(15) + (mean(A) ? (200 * se / mean(A)).toFixed(0) : '-').padStart(15))
}
