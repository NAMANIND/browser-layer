// The background process that keeps live tabs alive between CLI calls.
// It owns one headless Chrome, a persistent profile, and a socket the CLI talks to.
import { createServer } from 'node:http'
import { chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core'
import { home, loadJar, saveJar, type Cookie } from './session.js'
import { newRefs, readTree, type Refs } from './reader.js'
import { paginate, renderText } from './render.js'
import { click, fill, pick } from './act.js'
import { ping, socketPath } from './client.js'
import { loadPolicy, type Policy } from './policy.js'

// Decoration the agent never needs; DESIGN §1 principle 3. Never requested.
const DECORATION = new Set(['image', 'font', 'media'])
// Animations and transitions finish at once, so pages settle without waiting on motion.
const MOTION_RATE = 1000

// Analytics and ads calls bury the API the page actually uses; `net --all` still shows them.
const NOISE = /\/(log|logs|collect|analytics|telemetry|metrics|beacon|pixel|gen_204|ping)(\/|\?|$)|ogads-pa\.|doubleclick|googletagmanager|google-analytics/i

function printable(body: string | null | undefined): string | undefined {
  if (!body) return undefined
  // Binary bodies (protobuf, gzip) would corrupt the terminal and anything piped after it.
  const bad = body.slice(0, 300).replace(/[\x20-\x7e\t\n\r -￿]/g, '').length
  return bad > 2 ? `<binary, ${body.length} bytes>` : body.slice(0, 300).replace(/\s+/g, ' ')
}

type Req = { method: string; url: string; status: number; type: string; kind: string; post?: string }
type Tab = { id: number; session: string; page: Page; cdp: CDPSession; refs: Refs; inflight: number; net: Req[] }
export type Command = { cmd: string; session: string; url?: string; ref?: string; text?: string; key?: string; id?: number; enter?: boolean; all?: boolean; page?: number }

// Tab ids are unique across the daemon; each session (one agent, one task) has its own current tab.
const tabs = new Map<number, Tab>()
const current = new Map<string, number>()
let nextId = 1
let ctx: BrowserContext
let policy: Policy

function toBrowser(c: Cookie) {
  return { name: c.name, value: c.value, domain: c.hostOnly ? c.domain : `.${c.domain}`, path: c.path, expires: c.expires ? c.expires / 1000 : -1, secure: !!c.secure }
}

// Before each command: whatever the fast path logged into since, the browser gets too.
async function pullCookies() {
  const jar = loadJar().filter(c => !c.expires || c.expires > Date.now())
  if (jar.length) await ctx.addCookies(jar.map(toBrowser)).catch(() => {})
}

// After each command: the browser now holds the jar plus its own changes, so it is the whole truth.
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
    if (tab.net.length > policy['network.keep']) tab.net.shift()
  })
  page.on('close', () => {
    tabs.delete(tab.id)
    if (current.get(tab.session) !== tab.id) return
    const next = [...tabs.values()].filter(t => t.session === tab.session).pop()
    if (next) current.set(tab.session, next.id)
    else current.delete(tab.session)
  })
}

// Done when the network is idle and the DOM has stopped changing for a moment, or after 5s.
async function settle(tab: Tab) {
  await tab.page.waitForLoadState('domcontentloaded', { timeout: policy['load.timeoutMs'] }).catch(() => {})
  const end = Date.now() + policy['settle.deadlineMs']
  let last = -1
  let quietSince = Date.now()
  while (Date.now() < end) {
    const muts = await tab.page.evaluate(() => (window as unknown as { __alMut?: number }).__alMut ?? 0).catch(() => -2)
    if (muts !== last || tab.inflight > 0) { last = muts; quietSince = Date.now() }
    else if (Date.now() - quietSince >= policy['settle.quietMs']) return
    await new Promise(r => setTimeout(r, 100))
  }
}

async function view(tab: Tab, page = 1): Promise<string> {
  let text = renderText(await readTree(tab.cdp, tab.refs), new URL(tab.page.url()).origin, policy['render.nameChars'])
  const truncated = text.length > policy['render.maxChars']
  if (truncated) text = text.slice(0, text.lastIndexOf('\n', policy['render.maxChars']))
  const pages = paginate(text, policy['render.pageChars'])
  if (page < 1 || page > pages.length) throw new Error(`page ${page} does not exist; this view has ${pages.length}`)
  const title = await tab.page.title()
  const head = `tab ${tab.id}  ${tab.page.url()}${title ? `  "${title}"` : ''}${pages.length > 1 ? `  (page ${page} of ${pages.length})` : ''}`
  const more = page < pages.length ? `\n… more below: agent-layer read --page ${page + 1}` : ''
  const cut = truncated && page === pages.length ? '\n… (view ceiling reached; the page is larger than this)' : ''
  return `${head}\n\n${pages[page - 1]}${more}${cut}`
}

function need(session: string): Tab {
  const tab = tabs.get(current.get(session) ?? 0)
  if (!tab) throw new Error(`no live tab in session "${session}" — run: agent-layer tab <url>`)
  return tab
}

function own(session: string, id: number): Tab {
  const tab = tabs.get(id)
  if (!tab) throw new Error(`no tab ${id}`)
  if (tab.session !== session) throw new Error(`tab ${id} belongs to session "${tab.session}", not "${session}"`)
  return tab
}

function nodeOf(tab: Tab, ref?: string): number {
  if (!ref || !/^\d+$/.test(ref)) throw new Error(`expected a ref number like 12, got "${ref ?? ''}"`)
  const id = tab.refs.byRef.get(Number(ref))
  if (!id) throw new Error(`[${ref}] is not on the page — run: agent-layer read`)
  return id
}

// A ref whose node is gone (re-rendered, navigated away) fails here with the same advice.
async function act(tab: Tab, ref: string | undefined, fn: (id: number) => Promise<void>) {
  const id = nodeOf(tab, ref)
  try {
    await fn(id)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(/No node with given id|Could not find node/i.test(msg) ? `[${ref}] is not on the page — run: agent-layer read` : `cannot act on [${ref}]: ${msg}`)
  }
}

function withUrl(url: string) {
  return /^[a-z]+:\/\//i.test(url) || url.startsWith('about:') ? url : `https://${url}`
}

async function newTab(session: string, url: string): Promise<Tab> {
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Accessibility.enable')
  await cdp.send('Animation.enable')
  await cdp.send('Animation.setPlaybackRate', { playbackRate: MOTION_RATE })
  const tab: Tab = { id: nextId++, session, page, cdp, refs: newRefs(), inflight: 0, net: [] }
  // A new document can reuse node ids, so old refs are dropped; numbering continues, never reused.
  page.on('framenavigated', f => {
    if (f !== page.mainFrame()) return
    tab.refs.byNode.clear()
    tab.refs.byRef.clear()
  })
  tabs.set(tab.id, tab)
  track(tab)
  current.set(session, tab.id)
  await page.goto(withUrl(url), { waitUntil: 'domcontentloaded', timeout: policy['load.timeoutMs'] })
  return tab
}

async function run(c: Command): Promise<string> {
  switch (c.cmd) {
    case 'tab': {
      const tab = await newTab(c.session, c.url ?? 'about:blank')
      await settle(tab)
      return view(tab)
    }
    case 'go': {
      const tab = need(c.session)
      await tab.page.goto(withUrl(c.url!), { waitUntil: 'domcontentloaded', timeout: policy['load.timeoutMs'] })
      await settle(tab)
      return view(tab)
    }
    case 'back': {
      const tab = need(c.session)
      await tab.page.goBack({ waitUntil: 'domcontentloaded' })
      await settle(tab)
      return view(tab)
    }
    case 'tabs': {
      const mine = [...tabs.values()].filter(t => t.session === c.session)
      if (!mine.length) return `no live tabs in session "${c.session}"`
      return (await Promise.all(mine.map(async t =>
        `${t.id === current.get(c.session) ? '*' : ' '} ${t.id}  ${t.page.url()}  "${await t.page.title().catch(() => '')}"`))).join('\n')
    }
    case 'use': {
      current.set(c.session, own(c.session, c.id!).id)
      return view(need(c.session))
    }
    case 'read':
      return view(need(c.session), c.page ?? 1)
    case 'click': {
      const tab = need(c.session)
      await act(tab, c.ref, id => click(tab.cdp, id))
      await settle(tab)
      return view(tab)
    }
    case 'type': {
      const tab = need(c.session)
      await act(tab, c.ref, id => fill(tab.cdp, id, c.text ?? ''))
      if (c.enter) await tab.page.keyboard.press('Enter')
      await settle(tab)
      return view(tab)
    }
    case 'pick': {
      const tab = need(c.session)
      await act(tab, c.ref, id => pick(tab.cdp, id, c.text ?? ''))
      await settle(tab)
      return view(tab)
    }
    case 'press': {
      const tab = need(c.session)
      await tab.page.keyboard.press(c.key!)
      await settle(tab)
      return view(tab)
    }
    case 'net': {
      const tab = need(c.session)
      const list = c.all ? tab.net : tab.net.filter(r => (r.kind !== 'document' || r.method !== 'GET') && !NOISE.test(r.url))
      if (!list.length) return 'no requests yet'
      return list.slice(-40).map(r => {
        const u = new URL(r.url)
        const where = u.origin === new URL(tab.page.url()).origin ? `${u.pathname}${u.search}` : `${u.host}${u.pathname}${u.search}`
        return `${r.method.padEnd(6)} ${String(r.status).padEnd(4)} ${where.slice(0, 120)}  ${r.type}${r.post ? `\n         body: ${r.post}` : ''}`
      }).join('\n')
    }
    case 'close': {
      const tab = c.id ? own(c.session, c.id) : need(c.session)
      await tab.page.close()
      const now = current.get(c.session)
      return now ? `closed tab ${tab.id}; now on tab ${now}` : `closed tab ${tab.id}; no live tabs left in session "${c.session}"`
    }
    case 'ping':
      return 'ok'
    default:
      throw new Error(`unknown command ${c.cmd}`)
  }
}

async function main() {
  // A second daemon would steal the socket and orphan the first one's tabs.
  if (await ping()) {
    console.log('another daemon already answers on the socket; exiting')
    process.exit(0)
  }
  policy = loadPolicy()
  ctx = await chromium.launchPersistentContext(join(home(), 'profile'), {
    channel: 'chrome',
    headless: true,
    viewport: { width: policy['viewport.width'], height: policy['viewport.height'] },
    reducedMotion: 'reduce',
  })
  await ctx.route('**/*', r => (DECORATION.has(r.request().resourceType()) ? r.abort() : r.continue()))
  await ctx.addInitScript(`
    window.__alMut = 0;
    new MutationObserver(() => { window.__alMut++ }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  `)
  for (const p of ctx.pages()) await p.close()

  let queue = Promise.resolve()
  let idle: NodeJS.Timeout
  // `stop` answers only after Chrome has exited, so a caller can safely delete the profile next.
  const shutdown = async (reply?: (text: string) => void) => {
    server.close()
    await ctx.close().catch(() => {})
    rmSync(socketPath(), { force: true })
    if (reply) reply('stopped')
    else process.exit(0)
  }
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => void shutdown(), policy['daemon.idleMs']) }

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      touch()
      const c = JSON.parse(body || '{}') as Command
      if (c.cmd === 'stop') {
        void shutdown(text => res.end(JSON.stringify({ ok: true, text }), () => process.exit(0)))
        return
      }
      // One command at a time: two agents clicking into the same tab at once would race.
      queue = queue.then(async () => {
        try {
          c.session ||= 'default'
          await pullCookies()
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
  server.on('error', async err => {
    console.error(`cannot listen on ${socketPath()}: ${err.message}`)
    await ctx.close().catch(() => {})
    process.exit(1)
  })
  server.listen(socketPath(), () => {
    chmodSync(socketPath(), 0o600)
    touch()
    console.log(`agent-layer daemon on ${socketPath()}`)
  })
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
