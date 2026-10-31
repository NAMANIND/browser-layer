// Comparison charts from the benchmark results, as SVG and PNG for posts and the README.
// One color per tool in every chart; values at the bar tips; the ratio to agent-layer on the right.
// Usage: node bench/charts.mjs   (writes bench/charts/*.svg and *.png)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'

const dir = new URL('./charts/', import.meta.url).pathname
mkdirSync(dir, { recursive: true })
const rows = file => readFileSync(new URL(`./results/${file}`, import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l))
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

const COLOR = { 'agent-layer': '#2a78d6', 'agent-browser': '#eb6834', 'playwright-cli': '#1baf7a' }
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#8a8984', grid: '#e7e6e2', surface: '#fcfcfb' }
const FONT = `font-family="Inter, -apple-system, 'Segoe UI', system-ui, sans-serif"`
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')

// Grouped horizontal bars: one row per task, one bar per tool, value at each tip, and one ratio
// column per other tool (how many times agent-layer's value it is).
function bars({ title, subtitle, source, tools, tasks, value, format }) {
  const W = 1200, left = 210, col = 130, top = 170, bar = 18, gap = 2
  const rowH = tools.length * (bar + gap) + 22
  const H = top + tasks.length * rowH + 64
  const max = Math.max(...tasks.flatMap(t => tools.map(tool => value(t, tool))))
  const colX = k => W - 48 - (tools.length - 1 - k) * col
  // Bars end where the longest value label still clears the first ratio column (~60px wide).
  const x = v => ((colX(0) - 60 - 80 - left) * v) / max
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT}>`,
    `<rect width="${W}" height="${H}" fill="${INK.surface}"/>`,
    `<text x="48" y="64" font-size="30" font-weight="700" fill="${INK.primary}">${esc(title)}</text>`,
    `<text x="48" y="98" font-size="18" fill="${INK.secondary}">${esc(subtitle)}</text>`]
  // Legend: a swatch and the tool's name in text ink.
  let lx = 48
  for (const tool of tools) {
    out.push(`<rect x="${lx}" y="116" width="14" height="14" rx="3" fill="${COLOR[tool]}"/><text x="${lx + 22}" y="128" font-size="16" fill="${INK.secondary}">${tool}</text>`)
    lx += 44 + tool.length * 9
  }
  tools.slice(1).forEach((tool, k) => out.push(`<text x="${colX(k)}" y="${top - 30}" font-size="14" text-anchor="end" fill="${INK.muted}">${tool}</text><text x="${colX(k)}" y="${top - 12}" font-size="14" text-anchor="end" fill="${INK.muted}">vs agent-layer</text>`))
  tasks.forEach((t, i) => {
    const y0 = top + i * rowH
    const mid = y0 + (tools.length * (bar + gap)) / 2
    out.push(`<text x="${left - 16}" y="${mid + 6}" font-size="17" text-anchor="end" font-weight="500" fill="${INK.primary}">${esc(t.label)}</text>`)
    tools.forEach((tool, k) => {
      const v = value(t, tool), w = Math.max(x(v), 4), y = y0 + k * (bar + gap)
      // Square at the baseline, 4px round at the data end.
      out.push(`<path d="M${left},${y} h${w - 4} a4,4 0 0 1 4,4 v${bar - 8} a4,4 0 0 1 -4,4 h${-(w - 4)} z" fill="${COLOR[tool]}"><title>${tool}: ${format(v)}</title></path>`)
      out.push(`<text x="${left + w + 8}" y="${y + bar - 4}" font-size="14" fill="${INK.secondary}">${format(v)}</text>`)
    })
    tools.slice(1).forEach((tool, k) => out.push(`<text x="${colX(k)}" y="${mid + 6}" font-size="18" text-anchor="end" font-weight="700" fill="${INK.primary}">${(value(t, tool) / value(t, tools[0])).toFixed(1)}×</text>`))
  })
  out.push(`<text x="48" y="${H - 28}" font-size="14" fill="${INK.muted}">${esc(source)}</text>`, '</svg>')
  return out.join('\n')
}

// Headline tiles: the three ratios, big, with what they compare.
function headline({ title, subtitle, source, tiles }) {
  const W = 1200, H = 630, tw = (W - 96 - 2 * 32) / 3
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT}>`,
    `<rect width="${W}" height="${H}" fill="${INK.surface}"/>`,
    `<text x="48" y="92" font-size="40" font-weight="700" fill="${INK.primary}">${esc(title)}</text>`,
    `<text x="48" y="134" font-size="20" fill="${INK.secondary}">${esc(subtitle)}</text>`]
  tiles.forEach((t, i) => {
    const x0 = 48 + i * (tw + 32)
    out.push(`<rect x="${x0}" y="190" width="${tw}" height="300" rx="16" fill="#ffffff" stroke="${INK.grid}"/>`,
      `<text x="${x0 + 32}" y="330" font-size="112" font-weight="800" fill="${INK.primary}">${esc(t.big)}</text>`,
      `<text x="${x0 + 32}" y="384" font-size="24" font-weight="600" fill="${INK.primary}">${esc(t.what)}</text>`,
      `<text x="${x0 + 32}" y="426" font-size="17" fill="${INK.secondary}">${esc(t.detail)}</text>`,
      `<rect x="${x0 + 32}" y="448" width="10" height="10" rx="2" fill="${COLOR['agent-layer']}"/><text x="${x0 + 50}" y="458" font-size="15" fill="${INK.muted}">agent-layer vs agent-browser</text>`)
  })
  out.push(`<text x="48" y="${H - 48}" font-size="15" fill="${INK.muted}">${esc(source)}</text>`, '</svg>')
  return out.join('\n')
}

// web-agent-bench: medians of 3 runs per task.
const wab = rows('web-agent-bench.jsonl')
const wabTasks = [...new Set(wab.map(r => `${r.suite}/${r.scenario}`))].map(key => ({ key, label: key.split('/')[1] }))
const wabRuns = (t, tool) => wab.filter(r => `${r.suite}/${r.scenario}` === t.key && r.tool === tool)
const wabSum = (tool, f) => wab.filter(r => r.tool === tool).reduce((a, r) => a + f(r), 0)
const two = ['agent-layer', 'agent-browser']
const wabSource = 'web-agent-bench suites (controlled, scroll, dynamic, hard) · cursor-agent, claude-sonnet-5-thinking-high · 3 runs per task, both tools 30/30 passed'
const k = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

const charts = {
  'headline': headline({
    title: 'Same tasks, same model, same rules',
    subtitle: '10 tasks from web-agent-bench, 3 runs each. Both tools passed all 30.',
    source: wabSource,
    tiles: [
      { big: `${(wabSum('agent-browser', r => r.total) / wabSum('agent-layer', r => r.total)).toFixed(1)}×`, what: 'fewer tokens', detail: `${k(wabSum('agent-layer', r => r.total))} vs ${k(wabSum('agent-browser', r => r.total))}` },
      { big: `${(wabSum('agent-browser', r => r.steps) / wabSum('agent-layer', r => r.steps)).toFixed(1)}×`, what: 'fewer steps', detail: `${wabSum('agent-layer', r => r.steps)} vs ${wabSum('agent-browser', r => r.steps)} tool calls` },
      { big: `${(wabSum('agent-browser', r => r.ms) / wabSum('agent-layer', r => r.ms)).toFixed(1)}×`, what: 'faster', detail: `${Math.round(wabSum('agent-layer', r => r.ms) / 60000)} vs ${Math.round(wabSum('agent-browser', r => r.ms) / 60000)} minutes in all` },
    ],
  }),
  'tokens-per-task': bars({
    title: 'Tokens per task', subtitle: `Median of 3 runs. Lower is better. All 30 runs: ${k(wabSum('agent-layer', r => r.total))} vs ${k(wabSum('agent-browser', r => r.total))}.`, source: wabSource, tools: two,
    tasks: wabTasks, format: k,
    value: (t, tool) => median(wabRuns(t, tool).map(r => r.total)),
  }),
  'steps-per-task': bars({
    title: 'Steps per task', subtitle: `Tool calls the agent made, median of 3 runs. Lower is better. All 30 runs: ${wabSum('agent-layer', r => r.steps)} vs ${wabSum('agent-browser', r => r.steps)}.`, source: wabSource, tools: two,
    tasks: wabTasks, format: n => String(n),
    value: (t, tool) => median(wabRuns(t, tool).map(r => r.steps)),
  }),
  'time-per-task': bars({
    title: 'Time per task', subtitle: `Wall-clock seconds, median of 3 runs. Lower is better. All 30 runs: ${Math.round(wabSum('agent-layer', r => r.ms) / 60000)} vs ${Math.round(wabSum('agent-browser', r => r.ms) / 60000)} min.`, source: wabSource, tools: two,
    tasks: wabTasks, format: ms => `${Math.round(ms / 1000)} s`,
    value: (t, tool) => median(wabRuns(t, tool).map(r => r.ms)),
  }),
}

// Our own benchmark: three tools, eight tasks, the latest run of each.
const own = new Map(rows('agents.jsonl').map(r => [`${r.task}|${r.tool}`, r]))
const ownTasks = [...new Set([...own.values()].map(r => r.task))].map(key => ({ key, label: key }))
const three = ['agent-layer', 'agent-browser', 'playwright-cli']
charts['three-tools-tokens'] = bars({
  title: 'Three browser CLIs, eight tasks', subtitle: `Tokens per task, one run each. Lower is better. All passed 8/8. Totals: ${three.map(tool => `${tool} ${k(ownTasks.reduce((a, o) => a + own.get(`${o.key}|${tool}`).tokens, 0))}`).join(', ')}.`,
  source: 'agent-layer benchmark: 6 local apps + Hacker News + GitHub · cursor-agent, claude-sonnet-5-thinking-high · agent-browser 0.41.0, playwright-cli 0.1.22',
  tools: three, tasks: ownTasks, format: k,
  value: (t, tool) => own.get(`${t.key}|${tool}`).tokens,
})

// The results page: page.html with the same data filled in (medians per task, totals over all runs).
const pageData = {
  wab: wabTasks.map(t => ({ suite: t.key.split('/')[0], task: t.label, ...Object.fromEntries(two.map(tool => { const r = wabRuns(t, tool); return [tool, { tokens: median(r.map(x => x.total)), steps: median(r.map(x => x.steps)), s: Math.round(median(r.map(x => x.ms)) / 1000) }] })) })),
  own: ownTasks.map(t => ({ task: t.key, ...Object.fromEntries(three.map(tool => { const r = own.get(`${t.key}|${tool}`); return [tool, { tokens: r.tokens, steps: r.turns, s: Math.round(r.ms / 1000) }] })) })),
  totals: Object.fromEntries(two.map(tool => [tool, { tokens: wabSum(tool, r => r.total), steps: wabSum(tool, r => r.steps), s: Math.round(wabSum(tool, r => r.ms) / 1000) }])),
}
writeFileSync(`${dir}results.html`, readFileSync(`${dir}page.html`, 'utf8').replace('__DATA__', JSON.stringify(pageData)))

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ deviceScaleFactor: 2 })
for (const [name, svg] of Object.entries(charts)) {
  writeFileSync(`${dir}${name}.svg`, svg)
  await page.setContent(`<body style="margin:0">${svg}</body>`)
  await page.locator('svg').screenshot({ path: `${dir}${name}.png` })
}
await browser.close()
console.log(Object.keys(charts).map(n => `bench/charts/${n}.{svg,png}`).join('\n'))
