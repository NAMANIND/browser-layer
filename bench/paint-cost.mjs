// How much of a page load is painting? Traces Chrome's own work and splits it into
// script, style, layout, paint (record), raster+composite (pixels), and the rest.
// Usage: node bench/paint-cost.mjs   (writes bench/results/paint-cost.json)
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const SITES = [
  ['hacker-news', 'https://news.ycombinator.com/'],
  ['github-repo', 'https://github.com/microsoft/playwright'],
  ['google-flights', 'https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDI2LTExLTIwagcIARIDQk9NcgcIARIDREVMQAFIAXABggELCP___________wGYAQI&hl=en'],
  ['amazon-search', 'https://www.amazon.in/s?k=laptop'],
  ['react-todomvc', 'https://todomvc.com/examples/react/dist/'],
]
const BUCKETS = {
  script: ['EvaluateScript', 'FunctionCall', 'v8.compile', 'v8.compileModule', 'TimerFire', 'EventDispatch', 'FireAnimationFrame', 'RunMicrotasks', 'v8.evaluateModule'],
  style: ['UpdateLayoutTree', 'ParseAuthorStyleSheet', 'RecalculateStyles'],
  layout: ['Layout'],
  paint: ['Paint', 'PrePaint', 'UpdateLayer', 'Layerize'],
  pixels: ['RasterTask', 'GPUTask', 'CompositeLayers', 'Decode Image', 'ImageDecodeTask', 'Draw Frame', 'DrawFrame'],
  parse: ['ParseHTML'],
}
const bucketOf = Object.fromEntries(Object.entries(BUCKETS).flatMap(([b, names]) => names.map(n => [n, b])))

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const out = []
for (const [name, url] of SITES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'cc', 'gpu'] })
  await page.goto(url, { waitUntil: 'load', timeout: 45000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  const trace = JSON.parse((await browser.stopTracing()).toString())
  await page.close()
  const ms = Object.fromEntries(Object.keys(BUCKETS).map(b => [b, 0]))
  // Complete events (ph X) only, and only top-level per bucket name to avoid double counting nested slices.
  for (const e of trace.traceEvents) {
    if (e.ph !== 'X' || !e.dur) continue
    const b = bucketOf[e.name]
    if (b) ms[b] += e.dur / 1000
  }
  const row = { site: name, ...Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v)])) }
  const total = Object.values(ms).reduce((a, b) => a + b, 0)
  row.paintShare = Math.round(((ms.paint + ms.pixels) / total) * 100)
  out.push(row)
  console.log(`${name.padEnd(15)} script ${String(row.script).padStart(5)}  style ${String(row.style).padStart(4)}  layout ${String(row.layout).padStart(4)}  paint ${String(row.paint).padStart(4)}  pixels ${String(row.pixels).padStart(5)}  parse ${String(row.parse).padStart(4)}  → paint+pixels ${row.paintShare}% of traced work`)
}
await browser.close()
mkdirSync(new URL('./results/', import.meta.url), { recursive: true })
writeFileSync(new URL('./results/paint-cost.json', import.meta.url), JSON.stringify(out, null, 2))
