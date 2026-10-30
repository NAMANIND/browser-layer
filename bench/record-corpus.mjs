// Records each corpus page as a HAR so tests and measurements replay it offline.
// Decoration (images, fonts, media) is not recorded; the engine never loads it.
// Cookie and auth headers and aborted requests are removed before the file is written.
// Usage: node bench/record-corpus.mjs [name ...]
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync } from 'node:fs'
import { deterministic } from './deterministic.mjs'

const dir = new URL('../test/corpus/', import.meta.url)
const pages = JSON.parse(readFileSync(new URL('pages.json', dir), 'utf8'))
const only = new Set(process.argv.slice(2))
const SECRET = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization'])
const DECORATION = new Set(['image', 'font', 'media'])

const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const { name, url } of pages) {
  if (only.size && !only.has(name)) continue
  const file = new URL(`${name}.har`, dir)
  const ctx = await browser.newContext({ recordHar: { path: file.pathname, content: 'embed', mode: 'full' } })
  await ctx.route('**/*', r => DECORATION.has(r.request().resourceType()) ? r.abort() : r.continue())
  const page = await ctx.newPage()
  await deterministic(page)
  await page.goto(url, { waitUntil: 'load', timeout: 45000 })
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
  await ctx.close()

  const har = JSON.parse(readFileSync(file, 'utf8'))
  // Aborted requests have no response; replaying one would hang. Offline they abort, as they do live.
  har.log.entries = har.log.entries.filter(e => e.response.status > 0)
  for (const e of har.log.entries) {
    for (const part of [e.request, e.response]) {
      part.headers = part.headers.filter(h => !SECRET.has(h.name.toLowerCase()))
      part.cookies = []
    }
  }
  writeFileSync(file, JSON.stringify(har))
  console.log(`${name}: ${har.log.entries.length} entries, ${(readFileSync(file).length / 1e6).toFixed(2)} MB`)
}
await browser.close()
