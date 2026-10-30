// Replays each corpus page offline and measures the reader on it: time, size, refs, and the facts the
// page must show (test/corpus/pages.json). Exits 1 if a fact is missing.
// Usage: npm run measure [-- --save] [-- --dump DIR]
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { snapshot } from '../dist/snapshot.js'
import { DEFAULTS } from '../dist/policy.js'
import { deterministic } from './deterministic.mjs'

const RUNS = 5
const corpus = new URL('../test/corpus/', import.meta.url)
const pages = JSON.parse(readFileSync(new URL('pages.json', corpus), 'utf8'))
const save = process.argv.includes('--save')
const dumpAt = process.argv.indexOf('--dump')
const dump = dumpAt >= 0 ? process.argv[dumpAt + 1] : ''

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
let failed = false
for (const { name, url, facts = [] } of pages) {
  const ctx = await browser.newContext({ viewport: { width: DEFAULTS['viewport.width'], height: DEFAULTS['viewport.height'] } })
  const har = new URL(`${name}.har`, corpus).pathname
  await ctx.routeFromHAR(har, { notFound: 'abort' })
  const page = await ctx.newPage()
  await deterministic(page)
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

  const times = []
  let snap
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now()
    snap = await page.evaluate(snapshot, DEFAULTS['render.maxChars'])
    times.push(performance.now() - t)
  }
  await ctx.close()
  times.sort((a, b) => a - b)
  const body = snap.body
  if (dump) { mkdirSync(dump, { recursive: true }); writeFileSync(`${dump}/${name}.txt`, body) }

  const row = {
    page: name,
    readMsP50: Math.round(times[Math.floor(RUNS / 2)]),
    readMsMax: Math.round(times[RUNS - 1]),
    lines: body.split('\n').length,
    chars: body.length,
    refs: (body.match(/\[\d+\]/g) ?? []).length,
    facts: {},
  }
  for (const { label, pattern, min } of facts) {
    const count = body.split('\n').filter(l => new RegExp(pattern).test(l)).length
    row.facts[label] = count
    if (count < min) { failed = true; console.error(`  MISSING ${name}: "${label}" ${count} < ${min}`) }
  }
  results.push(row)
  console.log(`${name.padEnd(15)} read p50 ${String(row.readMsP50).padStart(4)}ms max ${String(row.readMsMax).padStart(4)}ms  ${String(row.lines).padStart(4)} lines ${String(row.chars).padStart(6)} chars ${String(row.refs).padStart(4)} refs  ${JSON.stringify(row.facts)}`)
}
await browser.close()
if (save) writeFileSync(new URL('./results/baseline.json', import.meta.url), JSON.stringify(results, null, 2))
process.exit(failed ? 1 : 0)
