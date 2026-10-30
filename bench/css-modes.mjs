// Loads real sites three ways and measures cost and what the agent would see.
//   full        everything, as a browser does today
//   meaning     no images, fonts, media; animations and transitions off; stylesheets kept
//   nocss       meaning + no CSS at all: stylesheets blocked, <style> removed, style attributes stripped
// Usage: node bench/css-modes.mjs [runs]   (writes bench/results/css-modes.json)
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const SITES = [
  { name: 'hacker-news', url: 'https://news.ycombinator.com/' },
  { name: 'github-repo', url: 'https://github.com/microsoft/playwright' },
  { name: 'google-flights', url: 'https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDI2LTExLTIwagcIARIDQk9NcgcIARIDREVMQAFIAXABggELCP___________wGYAQI&hl=en' },
  { name: 'amazon-search', url: 'https://www.amazon.in/s?k=laptop' },
  { name: 'react-todomvc', url: 'https://todomvc.com/examples/react/dist/', interact: true },
]
const MODES = ['full', 'meaning', 'nocss']
const RUNS = Number(process.argv[2] ?? 2)
const CONTROL_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'tab', 'menuitem', 'option', 'switch', 'slider', 'listbox'])

const NO_MOTION = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}'
const STRIP_CSS = `(() => {
  const strip = n => {
    if (n.nodeType !== 1) return
    if (n.tagName === 'STYLE' || (n.tagName === 'LINK' && /stylesheet/i.test(n.rel))) { n.remove(); return }
    n.removeAttribute('style')
    for (const c of n.querySelectorAll('style, link[rel~="stylesheet"]')) c.remove()
    for (const c of n.querySelectorAll('[style]')) c.removeAttribute('style')
  }
  new MutationObserver(ms => { for (const m of ms) {
    if (m.type === 'attributes') m.target.removeAttribute('style')
    else for (const n of m.addedNodes) strip(n)
  } }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] })
  try { Object.defineProperty(Document.prototype, 'adoptedStyleSheets', { get: () => [], set: () => {} }) } catch {}
  try { Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', { get: () => [], set: () => {} }) } catch {}
})()`

async function load(browser, site, mode) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: mode === 'full' ? 'no-preference' : 'reduce' })
  if (mode !== 'full') {
    const blocked = mode === 'nocss' ? new Set(['image', 'font', 'media', 'stylesheet']) : new Set(['image', 'font', 'media'])
    await ctx.route('**/*', r => blocked.has(r.request().resourceType()) ? r.abort() : r.continue())
  }
  if (mode === 'meaning') await ctx.addInitScript(`document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(NO_MOTION)}; document.head.append(s) })`)
  if (mode === 'nocss') await ctx.addInitScript(STRIP_CSS)

  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Performance.enable')
  let bytes = 0
  let requests = 0
  cdp.on('Network.loadingFinished', e => { bytes += e.encodedDataLength; requests++ })

  const t0 = Date.now()
  let error = ''
  try {
    await page.goto(site.url, { waitUntil: 'load', timeout: 45000 })
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  } catch (e) { error = String(e.message).split('\n')[0] }
  const loadMs = Date.now() - t0

  let interaction = null
  if (site.interact && !error) {
    try {
      const box = page.getByRole('textbox').first()
      for (const t of ['buy milk', 'write report']) { await box.fill(t); await box.press('Enter') }
      await page.getByRole('checkbox').nth(1).check({ timeout: 5000 })
      interaction = { left: await page.getByText(/item(s)? left/).first().textContent({ timeout: 3000 }).catch(() => null) }
    } catch (e) { interaction = { error: String(e.message).split('\n')[0] } }
  }

  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  await cdp.send('Accessibility.enable')
  const { nodes } = await cdp.send('Accessibility.getFullAXTree')
  const live = nodes.filter(n => !n.ignored)
  const controls = live.filter(n => CONTROL_ROLES.has(n.role?.value)).map(n => `${n.role.value}|${(n.name?.value ?? '').trim().slice(0, 80)}`)
  const text = live.filter(n => n.role?.value === 'StaticText').reduce((s, n) => s + (n.name?.value?.length ?? 0), 0)
  // What a user would see as on screen: controls with a layout box inside the page.
  const onScreen = await page.evaluate(() => [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link]')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }).length).catch(() => -1)

  await ctx.close()
  return {
    loadMs, bytes, requests, error, interaction, controls, text, onScreen,
    scriptMs: Math.round((metrics.ScriptDuration ?? 0) * 1000),
    styleMs: Math.round((metrics.RecalcStyleDuration ?? 0) * 1000),
    layoutMs: Math.round((metrics.LayoutDuration ?? 0) * 1000),
    taskMs: Math.round((metrics.TaskDuration ?? 0) * 1000),
  }
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
for (const site of SITES) {
  for (const mode of MODES) {
    const runs = []
    for (let i = 0; i < RUNS; i++) runs.push(await load(browser, site, mode))
    const last = runs.at(-1)
    const row = {
      site: site.name, mode,
      loadMs: median(runs.map(r => r.loadMs)), bytes: median(runs.map(r => r.bytes)), requests: median(runs.map(r => r.requests)),
      scriptMs: median(runs.map(r => r.scriptMs)), styleMs: median(runs.map(r => r.styleMs)), layoutMs: median(runs.map(r => r.layoutMs)), taskMs: median(runs.map(r => r.taskMs)),
      controls: last.controls.length, text: last.text, onScreen: last.onScreen, interaction: last.interaction, error: last.error,
      controlSet: last.controls,
    }
    results.push(row)
    console.log(`${site.name.padEnd(15)} ${mode.padEnd(8)} load ${String(row.loadMs).padStart(5)}ms  ${(row.bytes / 1e6).toFixed(2).padStart(6)}MB  req ${String(row.requests).padStart(4)}  script ${row.scriptMs}ms style ${row.styleMs}ms layout ${row.layoutMs}ms task ${row.taskMs}ms  controls ${row.controls} onscreen ${row.onScreen}${row.error ? `  ERROR ${row.error}` : ''}${row.interaction ? `  todo ${JSON.stringify(row.interaction)}` : ''}`)
  }
}
await browser.close()

// Control-set difference against full: what each mode loses and what it wrongly adds.
for (const site of SITES) {
  const full = new Set(results.find(r => r.site === site.name && r.mode === 'full').controlSet)
  for (const mode of ['meaning', 'nocss']) {
    const r = results.find(x => x.site === site.name && x.mode === mode)
    const set = new Set(r.controlSet)
    r.missing = [...full].filter(c => !set.has(c))
    r.extra = [...set].filter(c => !full.has(c))
    console.log(`${site.name.padEnd(15)} ${mode.padEnd(8)} vs full: missing ${r.missing.length}, extra ${r.extra.length}  e.g. extra ${JSON.stringify(r.extra.slice(0, 4))} missing ${JSON.stringify(r.missing.slice(0, 3))}`)
  }
}
mkdirSync(new URL('./results/', import.meta.url), { recursive: true })
writeFileSync(new URL('./results/css-modes.json', import.meta.url), JSON.stringify(results.map(({ controlSet, ...r }) => r), null, 2))
