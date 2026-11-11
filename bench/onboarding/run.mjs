// The command-writing exam. No browser: the model gets one variant's onboarding and one scenario, one turn,
// no tools, and answers with the shell commands it would run. Answers are kept under --out and graded by report.mjs.
//
//   node bench/onboarding/run.mjs --out DIR [--models haiku,sonnet] [--variants baseline,skill] [--repeats 3]
//        [--scenarios id,id] [--concurrency 6] [--max-usd 2] [--est-usd-per-call 0.002]
//
// --models is passed to `claude --model` as it is, so any model name `claude` accepts works here; a model
// that `claude` cannot reach cannot be examined. A call that already has an answer in DIR is not repeated.
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { context, variants } from './contexts.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1] }
const out = opt('--out')
if (!out) { console.error('usage: run.mjs --out DIR [--models haiku,sonnet] [--variants a,b] [--repeats 3]'); process.exit(2) }
const models = opt('--models', 'haiku,sonnet').split(',')
const names = opt('--variants', Object.keys(variants).join(',')).split(',')
const repeats = +opt('--repeats', 3), concurrency = +opt('--concurrency', 6)
const maxUsd = +opt('--max-usd', 2), estPerCall = +opt('--est-usd-per-call', 0.002)
const wanted = opt('--scenarios')?.split(',')
const scenarios = JSON.parse(readFileSync(join(here, 'scenarios.json'), 'utf8')).filter(s => !wanted || wanted.includes(s.id))

const SYSTEM = 'You are an AI agent with a Linux shell and no other tool. You are about to use a command-line tool called browser-layer. ' +
  'Everything you have been given to learn it is below; you know nothing else about it.\n\n'
const ASK = 'You get one turn only: write the shell commands for the whole task, in order, in one ```sh block, as if every call works and the refs and numbers in the state stay valid. ' +
  'Use no command you were not given. Besides the block, at most three sentences, only where you decide not to do something or say what you could not reach.'

const jobs = []
for (const model of models) for (const variant of names) for (const s of scenarios) for (let rep = 1; rep <= repeats; rep++)
  jobs.push({ model, variant, s, rep, file: join(out, model, variant, `${s.id}-${rep}.json`) })
const todo = jobs.filter(j => !existsSync(j.file))
const estimate = todo.length * estPerCall
console.log(`${todo.length} calls to do of ${jobs.length}, models ${models.join(',')}, estimate $${estimate.toFixed(2)} (at $${estPerCall}/call), cap $${maxUsd}`)
if (estimate > maxUsd) { console.error('estimate is over the cap; raise --max-usd or run fewer'); process.exit(1) }

const ask = job => new Promise(done => {
  const child = spawn('claude', ['-p', '--model', job.model, '--tools', '', '--system-prompt', SYSTEM + context(job.variant),
    '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands', '--strict-mcp-config', '--output-format', 'json'],
  { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] })
  let raw = ''
  child.stdout.on('data', d => { raw += d })
  child.on('close', () => { try { done(JSON.parse(raw)) } catch { done(null) } })
  child.stdin.end(`${job.s.prompt}\n\n${ASK}`)
})

let spent = 0, next = 0, failed = 0
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < todo.length && spent < maxUsd) {
    const job = todo[next++]
    const r = await ask(job)
    if (!r || r.is_error) { failed++; continue }
    mkdirSync(dirname(job.file), { recursive: true })
    writeFileSync(job.file, JSON.stringify({ scenario: job.s.id, answer: r.result, usd: r.total_cost_usd, usage: r.usage }))
    spent += r.total_cost_usd
  }
}))
console.log(`done: $${spent.toFixed(3)} spent, ${failed} calls failed${next < todo.length ? `, stopped at the cap with ${todo.length - next} not done` : ''}`)
