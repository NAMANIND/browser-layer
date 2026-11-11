// Runs a Claude agent (headless Claude Code, Bash only) on the tasks in tasks.json with one or more builds of
// browser-layer, and writes one metrics.json per run. Compare the runs with compare.mjs.
//
//   node bench/local/run.mjs --out DIR --arm A=hardening --arm B=hardening,skill=filler [--repeats 3]
//        [--tasks id,id] [--concurrency 3] [--model haiku] [--max-usd 5] [--est-usd-per-run 0.02]
//
// An arm is `label=git-ref`; `,skill=filler` appends 14,000 characters of DESIGN.md to the skill, `,skill=<ref>`
// takes the skill from another ref. A run that already has a metrics.json in DIR is not repeated.
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { carriedRow } from '../carried.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim()
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 })
const FILLER_CHARS = 14000
const MAX_TURNS = 40
// The benchmark's agent has only this tool for the web; without the instruction a cheap model just curls the page.
const WEB_RULE = 'Use the browser-layer skill for all web access. curl, wget and your own scripts that fetch URLs are not available here.'
const TIMEOUT_MS = 8 * 60 * 1000
// Commands that read or process a file again, as opposed to a browser-layer call.
const LOOKBACK = /^(?:cd [^;&]+(?:&&|;) *)?(?:rg|grep|egrep|sed|head|tail|awk|cat|jq|wc|sort|cut|uniq|python3?|node)\b/

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i < 0 ? d : args[i + 1] }
const arms = args.flatMap((a, i) => a === '--arm' ? [args[i + 1]] : []).map(s => {
  const [label, rest] = [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]
  const [ref, ...extra] = rest.split(',')
  return { label, ref, skill: extra.find(e => e.startsWith('skill='))?.slice(6) }
})
const out = opt('--out'), repeats = +opt('--repeats', 3), concurrency = +opt('--concurrency', 3)
const model = opt('--model', 'haiku'), maxUsd = +opt('--max-usd', 5), estPerRun = +opt('--est-usd-per-run', 0.02)
if (!out || !arms.length) { console.error('usage: run.mjs --out DIR --arm label=ref [--arm …]'); process.exit(2) }
const wanted = opt('--tasks')?.split(',')
const tasks = JSON.parse(readFileSync(join(here, 'tasks.json'), 'utf8')).filter(t => !wanted || wanted.includes(t.id))

// A build is a packed and installed copy of the ref, kept per commit so arms and later runs share it.
function build(ref) {
  const sha = git('rev-parse', ref).trim()
  const root = join(tmpdir(), 'bl-bench', 'builds', sha)
  if (!existsSync(join(root, 'prefix/bin/browser-layer'))) {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    execFileSync('sh', ['-c', `git -C '${repo}' archive ${sha} | tar -x -C '${join(root, 'src')}'`])
    symlinkSync(join(repo, 'node_modules'), join(root, 'src/node_modules'))
    const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', root], { cwd: join(root, 'src'), encoding: 'utf8' }).trim().split('\n').pop()
    execFileSync('npm', ['install', '-g', '--silent', '--prefix', join(root, 'prefix'), join(root, tgz)])
  }
  return { sha, root }
}

function skillText(arm) {
  const text = git('show', `${arm.skill && arm.skill !== 'filler' ? arm.skill : arm.ref}:skills/browser-layer/SKILL.md`)
  return arm.skill === 'filler' ? text + '\n' + git('show', `${arm.ref}:docs/DESIGN.md`).slice(0, FILLER_CHARS) : text
}

const words = s => s.match(/\S+/g) ?? []
const score = (task, answer) => {
  const clean = answer.replace(/[*`]/g, '')
  const hit = e => new RegExp(`(?<![\\d.,])${e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)(?![.,]\\d)`, 'i').test(clean)
  return task.expect.filter(hit).length / task.expect.length
}

function metrics(dir, task, wall, timedOut, events) {
  const calls = new Map(), done = []
  let result
  for (const e of events) {
    if (e.type === 'assistant') for (const b of e.message.content) if (b.type === 'tool_use' && b.name === 'Bash') calls.set(b.id, b.input.command)
    if (e.type === 'user' && Array.isArray(e.message.content)) for (const b of e.message.content) {
      if (b.type !== 'tool_result' || !calls.has(b.tool_use_id)) continue
      const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map(c => c.text ?? '').join('')
      done.push({ type: 'command_execution', command: calls.get(b.tool_use_id), aggregated_output: text })
    }
    if (e.type === 'result') result = e
  }
  // The same shape the Codex transcripts have, so bench/carried.mjs reads it.
  writeFileSync(join(dir, 'events.jsonl'), done.map(item => JSON.stringify({ type: 'item.completed', item })).join('\n'))
  const row = carriedRow(done)
  const answer = (result?.result ?? '').split(/answer:/i).pop()
  const u = result?.usage ?? {}
  return {
    task: task.id, score: score(task, answer), steps: row.commands, shell: row.shell,
    lookbacks: done.filter(i => LOOKBACK.test(i.command.trim())).length,
    chars: row.chars, carried: row.carried,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0, usd: result?.total_cost_usd ?? 0, wallS: Math.round(wall / 1000),
    limit: timedOut ? 'time' : result?.subtype === 'error_max_turns' ? 'turns' : result ? null : 'no-result',
    answer: words(answer).slice(0, 60).join(' '),
  }
}

async function run(job) {
  const dir = join(out, 'runs', `${job.arm.label}-${job.task.id}-${job.rep}`)
  if (existsSync(join(dir, 'metrics.json'))) return JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8'))
  rmSync(dir, { recursive: true, force: true })
  const work = join(dir, 'work')
  mkdirSync(join(work, '.claude/skills/browser-layer'), { recursive: true })
  writeFileSync(join(work, '.claude/skills/browser-layer/SKILL.md'), job.skill)
  const env = {
    ...process.env, PATH: `${join(job.build.root, 'prefix/bin')}:${process.env.PATH}`,
    BROWSER_LAYER_HOME: join(dir, 'home'), BROWSER_LAYER_SESSION: 'bench',
  }
  const prompt = `${job.task.prompt}\n\nFinish with one line: "Answer: <your answer>".`
  const child = spawn('claude', [
    '-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model, '--tools', 'Bash,Skill',
    '--allowedTools', 'Bash,Skill', '--max-turns', String(MAX_TURNS), '--setting-sources', 'project',
    '--strict-mcp-config', '--no-session-persistence', '--append-system-prompt', WEB_RULE,
  ], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let raw = ''
  child.stdout.on('data', d => { raw += d })
  const start = Date.now()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, TIMEOUT_MS)
  await new Promise(r => child.on('close', r))
  clearTimeout(timer)
  writeFileSync(join(dir, 'stream.jsonl'), raw)
  try { execFileSync('browser-layer', ['stop', '--session', 'default'], { env, timeout: 30000, stdio: 'ignore' }) } catch {}
  const events = raw.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
  const m = { arm: job.arm.label, rep: job.rep, ...metrics(dir, job.task, Date.now() - start, timedOut, events) }
  writeFileSync(join(dir, 'metrics.json'), JSON.stringify(m, null, 1))
  rmSync(work, { recursive: true, force: true })
  return m
}

const builds = Object.fromEntries(arms.map(a => [a.ref, build(a.ref)]))
const jobs = []
for (let rep = 1; rep <= repeats; rep++) for (const arm of arms) for (const task of tasks)
  jobs.push({ arm, task, rep, build: builds[arm.ref], skill: skillText(arm) })
const todo = jobs.filter(j => !existsSync(join(out, 'runs', `${j.arm.label}-${j.task.id}-${j.rep}`, 'metrics.json')))
const estimate = todo.length * estPerRun
console.log(`${todo.length} runs to do of ${jobs.length}, ${model}, estimate $${estimate.toFixed(2)} (at $${estPerRun}/run), cap $${maxUsd}`)
if (estimate > maxUsd) { console.error('estimate is over the cap; raise --max-usd or run fewer'); process.exit(1) }

let spent = 0, next = 0
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < todo.length && spent < maxUsd) {
    const job = todo[next++]
    const m = await run(job)
    spent += m.usd
    console.log(`${job.arm.label} ${job.task.id} #${job.rep}: score ${m.score} steps ${m.steps} $${m.usd.toFixed(3)} ${m.limit ?? ''} (spent $${spent.toFixed(2)})`)
  }
}))
if (next < todo.length) console.log(`stopped at the cap: ${todo.length - next} runs not done`)
