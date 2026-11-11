// Grades the answers under DIR and prints, per model and variant: the exam score (share of checks met),
// scenarios passed in full, invented verbs and flags, the checks most often missed, and the characters of
// onboarding read at step 1.
//   node bench/onboarding/report.mjs DIR [--detail]
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { context } from './contexts.mjs'
import { grade } from './grade.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = process.argv[2]
const detail = process.argv.includes('--detail')
const scenarios = Object.fromEntries(JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8')).map(s => [s.id, s]))
const top = (counts, n) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}×${v}`).join(' ')
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)

console.log('model\tvariant\tchars@1\ttokens@1\tx72 steps\tscore\tpass\tinvented\tcost\tmissed')
for (const model of readdirSync(dir)) for (const variant of readdirSync(join(dir, model))) {
  const rows = readdirSync(join(dir, model, variant)).map(f => {
    const r = JSON.parse(readFileSync(join(dir, model, variant, f), 'utf8'))
    return { ...grade(scenarios[r.scenario], r.answer), id: r.scenario, usd: r.usd, answer: r.answer }
  })
  const miss = new Map(), bad = new Map()
  rows.forEach(r => { r.missed.concat(r.forbidden.map(f => `!${f}`)).forEach(t => bump(miss, `${r.id}:${t}`)); r.invented.forEach(i => bump(bad, i)) })
  const n = rows.length
  const mean = f => rows.reduce((a, r) => a + f(r), 0) / n
  console.log([model, variant, context(variant).length, Math.round(context(variant).length / 4), `${Math.round(context(variant).length / 4 * 72 / 1000)}k`, mean(r => r.score).toFixed(3), `${rows.filter(r => r.pass).length}/${n}`,
    `${[...bad.values()].reduce((a, b) => a + b, 0)}${bad.size ? ` (${top(bad, 6)})` : ''}`, `$${rows.reduce((a, r) => a + r.usd, 0).toFixed(2)}`, top(miss, detail ? 40 : 8)].join('\t'))
}
