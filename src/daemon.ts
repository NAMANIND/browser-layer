// The background process that keeps live tabs alive between CLI calls.
// It owns one headless Chrome, a persistent profile, and a socket the CLI talks to.
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { home, loadJar, saveJar, type Cookie } from './session.js'
import { snapshot } from './snapshot.js'

export const socketPath = () => join(home(), 'daemon.sock')

const IDLE_MS = 30 * 60 * 1000
// Analytics and ads calls bury the API the page actually uses; `net --all` still shows them.
const NOISE = /\/(log|logs|collect|analytics|telemetry|metrics|beacon|pixel|gen_204|ping)(\/|\?|$)|ogads-pa\.|doubleclick|googletagmanager|google-analytics/i

function printable(body: string | null | undefined): string | undefined {
  if (!body) return undefined
  // Binary bodies (protobuf, gzip) would corrupt the terminal and anything piped after it.
  const bad = body.slice(0, 300).replace(/[\x20-\x7e\t\n\r -￿]/g, '').length
  return bad > 2 ? `<binary, ${body.length} bytes>` : body.slice(0, 300).replace(/\s+/g, ' ')
}
const VIEW_CAP = 15000
const NET_CAP = 300

type Req = { method: string; url: string; status: number; type: string; kind: string; post?: string }
type Tab = { id: number; page: Page; inflight: number; net: Req[] }
export type Command = { cmd: string; url?: string; ref?: string; text?: string; key?: string; id?: number; enter?: boolean; all?: boolean }

const tabs = new Map<number, Tab>()
let current = 0
let nextId = 1
let ctx: BrowserContext

function toBrowser(c: Cookie) {
  return { name: c.name, value: c.value, domain: c.hostOnly ? c.domain : `.${c.domain}`, path: c.path, expires: c.expires ? c.expires / 1000 : -1, secure: !!c.secure }
}

async function syncCookies() {
  const jar: Cookie[] = (await ctx.cookies()).map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain.replace(/^\./, ''),
    hostOnly: !c.domain.startsWith('.'),
    path: c.path,
    expires: c.expires > 0 ? c.expires * 1000 : undefined,
    secure: c.secure,
  }))
  saveJar(jar)
}

function track(tab: Tab) {
  const { page } = tab
  page.on('request', r => { if (r.resourceType() !== 'websocket') tab.inflight++ })
  page.on('requestfailed', () => { tab.inflight = Math.max(0, tab.inflight - 1) })
  page.on('requestfinished', async r => {
    tab.inflight = Math.max(0, tab.inflight - 1)
    const kind = r.resourceType()
    if (kind !== 'document' && kind !== 'xhr' && kind !== 'fetch') return
    const res = await r.response().catch(() => null)
    tab.net.push({
      method: r.method(),
      url: r.url(),
      status: res?.status() ?? 0,
      type: (res?.headers()['content-type'] ?? '').split(';')[0],
      kind,
      post: printable(r.postData()),
    })
    if (tab.net.length > NET_CAP) tab.net.shift()
  })
  page.on('close', () => {
    tabs.delete(tab.id)
    if (current === tab.id) current = [...tabs.keys()].pop() ?? 0
  })
}

// Done when the network is idle and the DOM has stopped changing for a moment, or after 5s.
async function settle(tab: Tab) {
  await tab.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
  const end = Date.now() + 5000
  let last = -1
  let quietSince = Date.now()
  while (Date.now() < end) {
    const muts = await tab.page.evaluate(() => (window as unknown as { __alMut?: number }).__alMut ?? 0).catch(() => -2)
    if (muts !== last || tab.inflight > 0) { last = muts; quietSince = Date.now() }
    else if (Date.now() - quietSince >= 400) return
    await new Promise(r => setTimeout(r, 100))
  }
}

async function view(tab: Tab): Promise<string> {
  const snap = await tab.page.evaluate(snapshot, VIEW_CAP)
  const head = `tab ${tab.id}  ${tab.page.url()}${snap.title ? `  "${snap.title}"` : ''}`
  return `${head}\n\n${snap.body}${snap.truncated ? '\n… (page continues; cut at the view cap)' : ''}`
}

function need(): Tab {
  const tab = tabs.get(current)
  if (!tab) throw new Error('no live tab — run: agent-layer tab <url>')
  return tab
}

function target(tab: Tab, ref?: string) {
  if (!ref || !/^\d+$/.test(ref)) throw new Error(`expected a ref number like 12, got "${ref ?? ''}"`)
  return tab.page.locator(`[data-al="${ref}"]`).first()
}

async function ensureRef(tab: Tab, ref?: string) {
  const loc = target(tab, ref)
  if (!(await loc.count())) throw new Error(`[${ref}] is no longer on the page — run: agent-layer read`)
  return loc
}

function withUrl(url: string) {
  return /^[a-z]+:\/\//i.test(url) || url.startsWith('about:') ? url : `https://${url}`
}

async function newTab(url: string): Promise<Tab> {
  const page = await ctx.newPage()
  const tab: Tab = { id: nextId++, page, inflight: 0, net: [] }
  tabs.set(tab.id, tab)
  track(tab)
  current = tab.id
  await page.goto(withUrl(url), { waitUntil: 'domcontentloaded', timeout: 30000 })
  return tab
}

async function run(c: Command): Promise<string> {
  switch (c.cmd) {
    case 'tab': {
      const tab = await newTab(c.url ?? 'about:blank')
      await settle(tab)
      return view(tab)
    }
    case 'go': {
      const tab = need()
      await tab.page.goto(withUrl(c.url!), { waitUntil: 'domcontentloaded', timeout: 30000 })
      await settle(tab)
      return view(tab)
    }
    case 'back': {
      const tab = need()
      await tab.page.goBack({ waitUntil: 'domcontentloaded' })
      await settle(tab)
      return view(tab)
    }
    case 'tabs':
      if (!tabs.size) return 'no live tabs'
      return (await Promise.all([...tabs.values()].map(async t =>
        `${t.id === current ? '*' : ' '} ${t.id}  ${t.page.url()}  "${await t.page.title().catch(() => '')}"`))).join('\n')
    case 'use': {
      if (!tabs.has(c.id!)) throw new Error(`no tab ${c.id}`)
      current = c.id!
      return view(need())
    }
    case 'read':
      return view(need())
    case 'click': {
      const tab = need()
      await (await ensureRef(tab, c.ref)).click({ timeout: 10000 })
      await settle(tab)
      return view(tab)
    }
    case 'type': {
      const tab = need()
      const loc = await ensureRef(tab, c.ref)
      await loc.fill(c.text ?? '', { timeout: 10000 })
      if (c.enter) await loc.press('Enter')
      await settle(tab)
      return view(tab)
    }
    case 'pick': {
      const tab = need()
      const loc = await ensureRef(tab, c.ref)
      await loc.selectOption({ label: c.text! }, { timeout: 5000 }).catch(() => loc.selectOption(c.text!, { timeout: 5000 }))
      await settle(tab)
      return view(tab)
    }
    case 'press': {
      const tab = need()
      await tab.page.keyboard.press(c.key!)
      await settle(tab)
      return view(tab)
    }
    case 'net': {
      const tab = need()
      const list = c.all ? tab.net : tab.net.filter(r => (r.kind !== 'document' || r.method !== 'GET') && !NOISE.test(r.url))
      if (!list.length) return 'no requests yet'
      return list.slice(-40).map(r => {
        const u = new URL(r.url)
        const where = u.origin === new URL(tab.page.url()).origin ? `${u.pathname}${u.search}` : `${u.host}${u.pathname}${u.search}`
        return `${r.method.padEnd(6)} ${String(r.status).padEnd(4)} ${where.slice(0, 120)}  ${r.type}${r.post ? `\n         body: ${r.post}` : ''}`
      }).join('\n')
    }
    case 'close': {
      const id = c.id ?? current
      const tab = tabs.get(id)
      if (!tab) throw new Error(`no tab ${id}`)
      await tab.page.close()
      return tabs.size ? `closed tab ${id}; now on tab ${current}` : `closed tab ${id}; no live tabs left`
    }
    case 'ping':
      return 'ok'
    default:
      throw new Error(`unknown command ${c.cmd}`)
  }
}

async function main() {
  ctx = await chromium.launchPersistentContext(join(home(), 'profile'), {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--blink-settings=imagesEnabled=false'],
  })
  // tsx/esbuild wraps nested functions in __name(); give injected functions a no-op one.
  await ctx.addInitScript(`
    window.__name = window.__name || (f => f);
    window.__alMut = 0;
    new MutationObserver(() => { window.__alMut++ }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  `)
  const jar = loadJar()
  if (jar.length) await ctx.addCookies(jar.map(toBrowser)).catch(() => {})
  for (const p of ctx.pages()) await p.close()

  let queue = Promise.resolve()
  let idle: NodeJS.Timeout
  const shutdown = async () => {
    server.close()
    await ctx.close().catch(() => {})
    rmSync(socketPath(), { force: true })
    process.exit(0)
  }
  const touch = () => { clearTimeout(idle); idle = setTimeout(shutdown, IDLE_MS) }

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      touch()
      const c = JSON.parse(body || '{}') as Command
      if (c.cmd === 'stop') { res.end(JSON.stringify({ ok: true, text: 'stopped' }), () => void shutdown()); return }
      // One command at a time: two agents clicking into the same tab at once would race.
      queue = queue.then(async () => {
        try {
          const text = await run(c)
          await syncCookies().catch(() => {})
          res.end(JSON.stringify({ ok: true, text }))
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }))
        }
      })
    })
  })
  rmSync(socketPath(), { force: true })
  server.listen(socketPath(), () => { touch(); console.log(`agent-layer daemon on ${socketPath()}`) })
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
