// Agent benchmark: the same model, task and instructions, with only the browser tool changing. Each run
// is a headless coding agent (Cursor's cursor-agent by default, or Claude Code's claude -p) allowed to
// run that one tool and to read files; tokens and time come from the agent's own report, steps are its
// tool calls, and each answer is checked against ground truth.
// Usage: node bench/agents/run.mjs [--runner cursor|claude] [--tools …] [--tasks shop,…] [--model …]
//   [--reps 1] [--concurrency 1] [--max-usd N]
// With WAB=<web-agent-bench checkout> and tsx (node --import <tsx>), that benchmark's suites are tasks too, named
// <suite>/<scenario>, and the claude runner holds every tool to a command guard (guard.mjs) as a PreToolUse hook.
// The browser-layer arm is a packed build of --ref (HEAD by default), as bench/local/run.mjs installs it.
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from '../local/build.mjs'
import { CATALOG, FLIGHTS, LAPTOPS, ORDERS, REPORT_TOTAL, resetState, startSite, state } from './site.mjs'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const sh = promisify(execFile)
const norm = s => String(s ?? '').toLowerCase().replace(/[₹,\s]/g, '')

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const blBuild = build(arg('ref', 'HEAD'))
const TOOLS = {
  'browser-layer': { help: 'browser-layer help', rules: " The tool's eval, net, cookies, storage and plain-HTTP (open, do) commands are not available here.",
    env: cwd => ({ ...process.env, PATH: `${blBuild.root}/prefix/bin:${process.env.PATH}`, BROWSER_LAYER_HOME: join(cwd, 'al') }),
    cleanup: env => sh('browser-layer', ['stop'], { env }).catch(() => {}) },
  // Browser Use 1.0 (its CLI is Python piped on stdin). Each run gets its own headless Chrome and daemon name, so it
  // never attaches to the machine's own Chrome.
  'browser-harness': { help: 'browser-harness skill', rules: " Scripts may use the tool's helpers and js() to read the page's DOM, with no imports, files, processes, network calls or cdp().",
    env: cwd => {
      const port = 9300 + Math.floor(Math.random() * 600)
      const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(cwd, 'chrome')}`, '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true })
      return { ...process.env, BU_CDP_URL: `http://127.0.0.1:${port}`, BU_NAME: `h2h${port}`, H2H_CHROME_PID: String(chrome.pid) }
    },
    cleanup: async env => { try { process.kill(Number(env.H2H_CHROME_PID)) } catch {} await sh('browser-harness', ['--reload'], { env }).catch(() => {}) } },
  'agent-browser': { help: 'agent-browser --help', cleanup: () => sh('agent-browser', ['close']).catch(() => {}) },
  'playwright-cli': { help: 'playwright-cli --help', cleanup: async () => { await sh('playwright-cli', ['close']).catch(() => {}); await sh('playwright-cli', ['delete-data']).catch(() => {}) } },
  // ego lite's agent CLI: the ego lite app must be running; the agent writes JavaScript it runs in a Space.
  'ego-browser': { help: 'ego-browser skill', cleanup: async () => {} },
}

const cheapest16 = LAPTOPS.filter(l => l.ram >= 16).sort((a, b) => a.price - b.price).slice(0, 3)
const cheapNonstop = FLIGHTS.filter(f => !f.stops).sort((a, b) => a.price - b.price)[0]
const refunded = ORDERS.filter(o => o.status === 'Refunded').length
const pendingSum = ORDERS.filter(o => o.status === 'Pending').reduce((n, o) => n + o.amount, 0)
const topOrder = ORDERS.reduce((a, o) => (o.amount > a.amount ? o : a))
const backorder = CATALOG.filter(c => c.stock === 'Backorder').length
const priciest = CATALOG.reduce((a, c) => (c.price > a.price ? c : a))

const TASKS = {
  shop: { path: '/shop', ask: 'Which 3 laptops with at least 16 GB RAM are the cheapest? Give their names from cheapest to most expensive, separated by " | ".',
    check: a => cheapest16.every((l, i) => norm(a.split('|')[i]) === norm(l.name)) },
  flights: { path: '/flights', ask: 'Search one-way flights from Mumbai to Delhi for 20 November 2026. What is the cheapest nonstop flight? Answer as "<airline> <price as a number>".',
    check: a => norm(a).includes(norm(cheapNonstop.airline)) && norm(a).includes(String(cheapNonstop.price)) },
  reports: { path: '/reports', ask: 'Export the Q3 report as CSV and tell me its Total revenue, as a number.', check: a => norm(a).includes(String(REPORT_TOTAL)) },
  orders: { path: '/orders', ask: 'How many orders have the status Refunded, across all pages? Answer with a number.', check: a => norm(a) === String(refunded) },
  // Lists to be read to their end over several pages: a Next button (orders) and rel=next links (catalog).
  'orders-pending': { path: '/orders', ask: 'Across all pages of orders, what is the total amount of the orders with the status Pending? Answer with a number.', check: a => norm(a) === String(pendingSum) },
  'orders-top': { path: '/orders', ask: 'Across all pages of orders, which order has the highest amount? Answer with its order number.', check: a => norm(a).includes(norm(topOrder.id)) },
  'catalog-backorder': { path: '/catalog', ask: 'The catalog has several pages. How many items have the availability Backorder, across all pages? Answer with a number.', check: a => norm(a) === String(backorder) },
  'catalog-priciest': { path: '/catalog', ask: 'The catalog has several pages. Which item has the highest price? Answer with its SKU.', check: a => norm(a).includes(norm(priciest.sku)) },
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
  // Three of ego lite's Real-World Bench tasks (github.com/citrolabs/ego-browser-benchmark-framework, MIT),
  // worded as they are. The answer is a whole report, checked against the live page when the run ends.
  'rwb-hn': { report: true, ask: "I want a quick overview of today's most prominent topics on the Hacker News homepage and which posts are generating the most discussion. Visit https://news.ycombinator.com and collect the current top 10 posts, skipping any job post with no score and continuing farther down the list until you have 10 scored posts. For each one, record its rank, title, score in points, and number of comments. Then calculate the average score and average comment count across the 10 posts, rounded to one decimal place, and identify the post with the highest comments-to-points ratio, giving its title and the ratio rounded to two decimal places.",
    check: async a => {
      const titles = (await (await fetch('https://news.ycombinator.com')).text()).split('class="athing').slice(1)
        .filter(row => /id="score_/.test(row.split('class="spacer"')[0])).slice(0, 10)
        .map(row => decode(row.match(/class="titleline"><a [^>]*>([^<]+)/)[1]))
      // Ranks move while a run reads the page, so 8 of the 10 is a pass.
      return titles.filter(t => norm(a).includes(norm(t))).length >= 8
    } },
  'rwb-github': { report: true, ask: 'I want to see which Python projects are hottest on GitHub this week. Open the GitHub Trending page at https://github.com/trending, set the language to Python, and set the time range to This week. Take the first 8 repositories from this week\'s trending list and record each repository\'s rank, full name (owner/repo), stars gained this week as shown by "X stars this week", total Stars, total Forks, and one-line description; write "Not listed" if there is no description. Organize the results in a table. Then calculate the total and average number of stars gained this week across the 8 repositories, rounding the average to one decimal place. Finally, identify the repository with the highest ratio of stars gained this week to total Stars—the one with the strongest recent surge—and provide its full name and the ratio rounded to three decimal places.',
    check: async a => {
      const repos = [...(await (await fetch('https://github.com/trending/python?since=weekly')).text()).matchAll(/<h2 class="h3 lh-condensed">\s*<a [^>]*href="\/([^"]+)"/g)].slice(0, 8).map(m => m[1].toLowerCase())
      const at = repos.map(r => a.toLowerCase().replace(/\s+\/\s+/g, '/').indexOf(r))
      return repos.length === 8 && at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1]))
    } },
  'rwb-mortgage': { report: true, ask: "I'm evaluating the financing cost of a $550,000 home and want to know the monthly payment and total interest over the life of the loan. Visit https://www.calculator.net/mortgage-calculator.html and set the mortgage calculator to a Home Price of $550,000, a Down Payment of 20%, a Loan Term of 30 years, and an Interest Rate of 6.5%, then click Calculate. Provide four results: the Monthly Payment for principal and interest only, excluding taxes and fees; the Loan Amount; the Total Interest; and the total principal and interest across 360 payments, shown as Total of 360 Payments or Total Payments.",
    // 440,000 at 6.5% over 360 months: 2,781.10 a month, 1,001,195.75 in all, 561,195.75 of it interest.
    check: a => {
      const nums = (a.replace(/,/g, '').match(/\d+(\.\d+)?/g) ?? []).map(Number)
      const has = (want, within) => nums.some(n => Math.abs(n - want) <= within)
      return has(2781.10, 0.01) && has(440000, 0) && has(561195.75, 2) && has(1001195.75, 2)
    } },
}

// web-agent-bench's scenarios, with their own checks (which read the whole reply), as <suite>/<scenario>.
const wabSites = []
if (process.env.WAB) {
  const { getSuite } = await import(`${process.env.WAB}/src/suites/registry.ts`)
  for (const id of ['controlled', 'scroll', 'dynamic', 'hard']) {
    const suite = getSuite(id)
    const { server, baseUrl } = await suite.startSite()
    wabSites.push(server)
    for (const sc of suite.scenarios) TASKS[`${id}/${sc.id}`] = { wab: true, prompt: sc.prompt({ baseUrl }), check: sc.check }
  }
}

function decode(s) { return s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&') }

const tools = arg('tools', Object.keys(TOOLS).join(',')).split(',')
const tasks = arg('tasks', Object.keys(TASKS).filter(t => !TASKS[t].wab).join(',')).split(',')
const runner = arg('runner', 'cursor')
const model = arg('model', runner === 'cursor' ? 'claude-sonnet-5-thinking-high' : 'sonnet')
const reps = Number(arg('reps', '1'))
const concurrency = Number(arg('concurrency', '1'))
const maxUsd = Number(arg('max-usd', 'Infinity'))
const out = arg('out', new URL('../results/agents.jsonl', import.meta.url).pathname)
const { server, base } = await startSite()

const guardPath = new URL('./guard.mjs', import.meta.url).pathname
const instructions = tool => `You control a web browser only through the \`${tool}\` command-line tool, run with Bash. Learn it from its own help first (\`${TOOLS[tool].help}\`) and follow what that help says. Do not use curl, wget or any other way to reach websites.${TOOLS[tool].rules ?? ''} Downloaded files can be read with the Read tool.\nEnd your reply with one line: ANSWER: <answer>`

// Claude Code with Bash and Read only. The guard hook refuses a command that does not drive the page; steps are the
// agent's tool calls, and a refused call is counted in `blocked`.
function claude(cwd, env, tool, prompt) {
  const settings = join(cwd, 'settings.json')
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${process.execArgv.join(' ')} ${guardPath}` }] }] } }))
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', model, '--append-system-prompt', instructions(tool),
    '--tools', 'Bash,Read', '--allowedTools', 'Bash', 'Read', '--max-turns', '60', '--setting-sources', 'project', '--settings', settings,
    '--strict-mcp-config', '--no-session-persistence', '--add-dir', cwd, join(homedir(), 'Downloads')]
  return new Promise(resolve => {
    const child = spawn('claude', args, { cwd, env: { ...env, WAB_TOOL: tool }, stdio: ['ignore', 'pipe', 'pipe'] })
    let raw = ''
    child.stdout.on('data', d => (raw += d))
    const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000)
    child.on('close', () => {
      clearTimeout(timer)
      writeFileSync(join(cwd, 'transcript.jsonl'), raw)
      const events = raw.split('\n').flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
      const content = type => events.filter(e => e.type === type).flatMap(e => e.message?.content ?? [])
      const result = events.findLast(e => e.type === 'result') ?? { is_error: true, result: raw.slice(-500) }
      resolve({ ...result, steps: content('assistant').filter(b => b.type === 'tool_use').length,
        blocked: content('user').filter(b => JSON.stringify(b.content).includes('Blocked:')).length })
    })
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

async function once({ task, tool, rep }) {
  resetState()
  const cwd = mkdtempSync(join(tmpdir(), `bench-${tool}-`))
  const env = TOOLS[tool].env?.(cwd) ?? { ...process.env, BROWSER_LAYER_HOME: join(cwd, 'al') }
  mkdirSync(join(cwd, 'al'), { recursive: true })
  const t = TASKS[task]
  const r = await (runner === 'cursor' ? cursor : claude)(cwd, env, tool, t.wab ? t.prompt : t.report ? t.ask : `Open ${t.url ?? base + t.path} and do this: ${t.ask}`)
  await TOOLS[tool].cleanup(env)
  const answer = t.report || t.wab ? String(r.result ?? '') : String(r.result ?? '').match(/ANSWER:\s*(.+)\s*$/im)?.[1]?.trim() ?? ''
  const ok = await Promise.resolve(t.check(answer)).catch(() => false)
  const u = r.usage ?? {}
  const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
  const row = { at: new Date().toISOString(), runner, model, dir: cwd, task, tool, rep, ok, answer: answer.slice(-300), turns: r.steps ?? r.num_turns, blocked: r.blocked, ms: r.duration_ms, tokens, input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens, output: u.output_tokens, cost: r.total_cost_usd, error: r.is_error ? String(r.result ?? '').slice(0, 300) : undefined }
  appendFileSync(out, `${JSON.stringify(row)}\n`)
  console.log(`${task.padEnd(22)} ${tool.padEnd(15)} #${rep} ${ok ? 'PASS' : 'FAIL'}  steps ${String(row.turns ?? '-').padStart(3)}  tokens ${String(tokens).padStart(8)}${r.total_cost_usd ? `  $${r.total_cost_usd.toFixed(3)}` : ''}  ${Math.round((r.duration_ms ?? 0) / 1000)}s  answer: ${answer.slice(0, 60).replace(/\s+/g, ' ')}${r.is_error ? `  error: ${String(r.result).slice(0, 80)}` : ''}`)
  return r.total_cost_usd ?? 0
}

// Tools alternate order between reps, so neither always runs on a warmer machine. Runs stop being started at the cap.
const jobs = []
for (let rep = 1; rep <= reps; rep++) for (const task of tasks) for (const tool of rep % 2 ? tools : [...tools].reverse()) jobs.push({ task, tool, rep })
let spent = 0
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (let job; (job = jobs.shift()) && spent < maxUsd;) spent += await once(job)
}))
if (jobs.length) console.log(`stopped at the cap ($${spent.toFixed(2)}): ${jobs.length} runs not done`)
console.log(`spent $${spent.toFixed(2)}`)
server.close()
wabSites.forEach(w => w.close())
