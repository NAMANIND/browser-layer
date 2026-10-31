// Agent benchmark: the same model, task and instructions, with only the browser tool changing. Each run
// is a headless coding agent (Cursor's cursor-agent by default, or Claude Code's claude -p) allowed to
// run that one tool and to read files; tokens and time come from the agent's own report, steps are its
// tool calls, and each answer is checked against ground truth.
// Usage: node bench/agents/run.mjs [--runner cursor|claude] [--tools …] [--tasks shop,…] [--model …]
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { FLIGHTS, LAPTOPS, ORDERS, REPORT_TOTAL, resetState, startSite, state } from './site.mjs'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const sh = promisify(execFile)
const norm = s => String(s ?? '').toLowerCase().replace(/[₹,\s]/g, '')

const TOOLS = {
  'browser-layer': { help: 'browser-layer help', cleanup: env => sh('browser-layer', ['stop'], { env }).catch(() => {}) },
  'agent-browser': { help: 'agent-browser --help', cleanup: () => sh('agent-browser', ['close']).catch(() => {}) },
  'playwright-cli': { help: 'playwright-cli --help', cleanup: async () => { await sh('playwright-cli', ['close']).catch(() => {}); await sh('playwright-cli', ['delete-data']).catch(() => {}) } },
}

const cheapest16 = LAPTOPS.filter(l => l.ram >= 16).sort((a, b) => a.price - b.price).slice(0, 3)
const cheapNonstop = FLIGHTS.filter(f => !f.stops).sort((a, b) => a.price - b.price)[0]
const refunded = ORDERS.filter(o => o.status === 'Refunded').length

const TASKS = {
  shop: { path: '/shop', ask: 'Which 3 laptops with at least 16 GB RAM are the cheapest? Give their names from cheapest to most expensive, separated by " | ".',
    check: a => cheapest16.every((l, i) => norm(a.split('|')[i]) === norm(l.name)) },
  flights: { path: '/flights', ask: 'Search one-way flights from Mumbai to Delhi for 20 November 2026. What is the cheapest nonstop flight? Answer as "<airline> <price as a number>".',
    check: a => norm(a).includes(norm(cheapNonstop.airline)) && norm(a).includes(String(cheapNonstop.price)) },
  reports: { path: '/reports', ask: 'Export the Q3 report as CSV and tell me its Total revenue, as a number.', check: a => norm(a).includes(String(REPORT_TOTAL)) },
  orders: { path: '/orders', ask: 'How many orders have the status Refunded, across all pages? Answer with a number.', check: a => norm(a) === String(refunded) },
  signup: { path: '/signup', ask: 'Create an account for Asha Rao with the email asha@example.com on the Pro plan, accepting the terms. Answer "done" once it is created.',
    check: () => state.signups.some(s => s.name === 'Asha Rao' && s.email === 'asha@example.com' && s.plan === 'Pro') },
  settings: { path: '/login', ask: 'Sign in with username demo and password demo123, then turn off email notifications and leave SMS alerts as they are. Answer "done".',
    check: () => state.settings.email === false && state.settings.sms === false },
  hn: { url: 'https://news.ycombinator.com', ask: 'Among the top 10 stories on the front page right now, which has the most comments? Answer with its exact title.',
    check: async a => {
      const ids = (await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')).json()).slice(0, 10)
      const items = await Promise.all(ids.map(id => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r => r.json())))
      const top = items.sort((x, y) => (y.descendants ?? 0) - (x.descendants ?? 0))[0]
      return norm(a) === norm(top.title)
    } },
  github: { url: 'https://github.com/microsoft/playwright', ask: 'What is the tag of the latest release of this repository? Answer with the tag only.',
    check: async a => norm(a) === norm((await (await fetch('https://api.github.com/repos/microsoft/playwright/releases/latest')).json()).tag_name) },
}

const tools = arg('tools', Object.keys(TOOLS).join(',')).split(',')
const tasks = arg('tasks', Object.keys(TASKS).join(',')).split(',')
const runner = arg('runner', 'cursor')
const model = arg('model', runner === 'cursor' ? 'claude-sonnet-5-thinking-high' : 'sonnet')
const out = new URL('../results/agents.jsonl', import.meta.url).pathname
const { server, base } = await startSite()

const instructions = tool => `You control a web browser only through the \`${tool}\` command-line tool, run with Bash. Learn it from its own help first (\`${TOOLS[tool].help}\`) and follow what that help says. Do not use curl, wget or any other way to reach websites. Downloaded files can be read with the Read tool.\nEnd your reply with one line: ANSWER: <answer>`

function claude(cwd, env, tool, prompt) {
  const system = instructions(tool)
  const args = ['-p', prompt, '--output-format', 'json', '--model', model, '--append-system-prompt', system,
    '--allowedTools', `Bash(${tool}:*)`, 'Read', '--disallowedTools', 'WebFetch', 'WebSearch', 'Task', '--max-turns', '60',
    '--add-dir', cwd, join(homedir(), 'Downloads')]
  return new Promise(resolve => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', d => (stdout += d))
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60 * 1000)
    child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(stdout)) } catch { resolve({ is_error: true, result: stdout.slice(-500) }) } })
  })
}

// cursor-agent: the folder's .cursor/cli.json allows only this tool's commands and reading files; the
// stream gives each tool call (a step) and, at the end, token usage. It reports no cost.
function cursor(cwd, env, tool, prompt) {
  mkdirSync(join(cwd, '.cursor'), { recursive: true })
  writeFileSync(join(cwd, '.cursor', 'cli.json'), JSON.stringify({ permissions: { allow: [`Shell(${tool})`, 'Read(**)'], deny: ['Shell(curl)', 'Shell(wget)'] } }))
  const args = ['-p', `${instructions(tool)}\n\n${prompt}`, '--output-format', 'stream-json', '--model', model, '--trust', '--workspace', cwd, '--add-dir', join(homedir(), 'Downloads')]
  return new Promise(resolve => {
    const child = spawn('cursor-agent', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    let steps = 0
    const log = []
    let result = { is_error: true, result: 'no result' }
    const started = Date.now()
    child.stdout.on('data', d => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let e
        try { e = JSON.parse(line) } catch { continue }
        log.push(line)
        // A run that is stuck is stopped at 60 steps rather than burning tokens to the time limit.
        if (e.type === 'tool_call' && e.subtype === 'started' && ++steps > 60) child.kill('SIGTERM')
        if (e.type === 'result') result = e
      }
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60 * 1000)
    child.on('close', () => {
      clearTimeout(timer)
      writeFileSync(join(cwd, 'transcript.jsonl'), log.join('\n'))
      const u = result.usage ?? {}
      resolve({ result: result.result, is_error: result.is_error, num_turns: steps, duration_ms: result.duration_ms ?? Date.now() - started,
        usage: { input_tokens: u.inputTokens, cache_read_input_tokens: u.cacheReadTokens, cache_creation_input_tokens: u.cacheWriteTokens, output_tokens: u.outputTokens } })
    })
  })
}

for (const task of tasks) {
  for (const tool of tools) {
    resetState()
    const cwd = mkdtempSync(join(tmpdir(), `bench-${tool}-`))
    const env = { ...process.env, BROWSER_LAYER_HOME: join(cwd, 'al') }
    mkdirSync(env.BROWSER_LAYER_HOME, { recursive: true })
    await TOOLS[tool].cleanup(env)
    const t = TASKS[task]
    const r = await (runner === 'cursor' ? cursor : claude)(cwd, env, tool, `Open ${t.url ?? base + t.path} and do this: ${t.ask}`)
    await TOOLS[tool].cleanup(env)
    const answer = String(r.result ?? '').match(/ANSWER:\s*(.+)\s*$/im)?.[1]?.trim() ?? ''
    const ok = await Promise.resolve(t.check(answer)).catch(() => false)
    const u = r.usage ?? {}
    const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
    const row = { at: new Date().toISOString(), runner, model, dir: cwd, task, tool, ok, answer, turns: r.num_turns, ms: r.duration_ms, tokens, input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens, cost: r.total_cost_usd, error: r.is_error ? String(r.result ?? '').slice(0, 300) : undefined }
    appendFileSync(out, `${JSON.stringify(row)}\n`)
    console.log(`${task.padEnd(9)} ${tool.padEnd(15)} ${ok ? 'PASS' : 'FAIL'}  steps ${String(r.num_turns ?? '-').padStart(3)}  tokens ${String(tokens).padStart(8)}${r.total_cost_usd ? `  $${r.total_cost_usd.toFixed(3)}` : ''}  ${Math.round((r.duration_ms ?? 0) / 1000)}s  answer: ${answer.slice(0, 60)}${r.is_error ? `  error: ${String(r.result).slice(0, 80)}` : ''}`)
  }
}
server.close()
