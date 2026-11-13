// The background process that keeps live tabs alive between CLI calls.
// It owns one headless Chrome, a persistent profile, and a socket the CLI talks to.
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, devices, type Browser, type BrowserContext, type CDPSession, type Dialog, type Page, type Request, type Route } from 'playwright-core'
import { isTracker } from './trackers.js'
import { findBrowser } from './browser.js'
import { ceiling, home, loadJar, saveJar, type Cookie } from './session.js'
import { COLLECTIONS, LANDMARKS, humanCheck, isTrigger, newRefs, readTree, withRefs, type Node, type Refs } from './reader.js'
import { bounded, bulkAnswer, bulkFile, diffLines, findRef, goneLines, itemsLine, paginate, renderMap, renderText, type Bulk } from './render.js'
import { call, drag, fill, heldBy, isChecked, isFileInput, pick, pointer, setFiles, submit, wheel, type Pointer, type Target } from './act.js'
import { fromTsv, group, query, records, toTsv, where, type Query, type Records } from './data.js'
import { pidPath, ping, socketPath, VERSION } from './client.js'
import { loadPolicy, type Policy } from './policy.js'
import { forgetKept, loadKept, noteSaved, savedFiles, saveKept, trimSaved, type Kept } from './kept.js'

// Decoration the agent never needs; DESIGN §1 principle 3. Never requested.
const DECORATION = new Set(['image', 'font', 'media'])

// BROWSER_LAYER_ATTACH is the debugging address of a person's own Chrome. Attached, the daemon works only in tabs it
// opened: it never closes the browser or the person's tabs, copies none of its cookies to disk, and changes no
// setting that reaches their other tabs.
const ATTACH = process.env.BROWSER_LAYER_ATTACH
// Sites the agent let load decoration (`allow images`), by the origin of the page they are on.
const pictured = new Set<string>()
const siteOf = (r: Request) => { try { return new URL(r.frame().page().url()).origin } catch { return '' } }
// The tallest picture Chrome captures (its GPU texture limit); a taller whole-page screenshot crashes the tab.
const SHOT_MAX_PX = 16384
// The most text runs remembered per canvas, and how close (px) runs must be vertically to share a line.
const CANVAS_RUNS = 5000
const CANVAS_LINE_PX = 4

// Runs in every document before the page's own scripts. It records, without changing the page: a
// signature of the text the page shows (for settle), elements given hover listeners (the reader marks
// them "reacts to hover"), and text drawn on 2D canvases with its position, forgetting text a clearRect
// paints over.
const PAGE_HOOKS = `(() => {
  // What the agent will read is the shown text, so settle waits on it, not on every DOM change: ads,
  // timers and animations change the DOM all the time without changing a word.
  // innerText leaves out shadow trees, so the ones the page creates are kept and their text counted too.
  window.__alDraws = 0
  let roots = []
  const attach = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (...args) { const r = attach.apply(this, args); roots.push(r); return r }
  window.__alText = () => {
    if (roots.length > 1000) roots = roots.filter(r => r.host.isConnected)
    const t = (document.body ? document.body.innerText : '') + roots.map(r => (r.host.isConnected ? r.textContent : '')).join('')
    let h = t.length + window.__alDraws
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0
    return h
  }
  // Text is present but hardly any of it shows (results revealed after load, a page behind a loader).
  window.__alHidden = () => {
    const shown = document.body ? document.body.innerText.length : 0
    if (shown >= 500) return false
    let all = 0
    const w = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT)
    while (w.nextNode()) if (!/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(w.currentNode.parentNode.nodeName)) all += w.currentNode.data.trim().length
    return all > 2000 && all > 4 * shown
  }
  const HOVER = new Set(['mouseenter', 'mouseover', 'pointerenter', 'pointerover'])
  const CLICK = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'])
  window.__alHover = new Set()
  window.__alClick = new Set()
  const listen = EventTarget.prototype.addEventListener
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (this instanceof Element && this !== document.documentElement && this !== document.body) {
      if (HOVER.has(type)) window.__alHover.add(this)
      if (CLICK.has(type)) window.__alClick.add(this)
    }
    return listen.call(this, type, ...rest)
  }
  const C = globalThis.CanvasRenderingContext2D
  if (!C) return
  const runs = new WeakMap(), canvases = new Set()
  const at = (ctx, x, y) => { const m = ctx.getTransform(); return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] }
  for (const fn of ['fillText', 'strokeText']) {
    const draw = C.prototype[fn]
    C.prototype[fn] = function (text, x, y, ...rest) {
      try {
        let m = runs.get(this.canvas)
        if (!m) { m = new Map(); runs.set(this.canvas, m); canvases.add(this.canvas) }
        const [px, py] = at(this, x, y)
        m.set(Math.round(px) + ',' + Math.round(py), [String(text), px, py])
        if (m.size > ${CANVAS_RUNS}) m.delete(m.keys().next().value)
        window.__alDraws++
      } catch {}
      return draw.call(this, text, x, y, ...rest)
    }
  }
  const clear = C.prototype.clearRect
  C.prototype.clearRect = function (x, y, w, h) {
    try {
      const m = runs.get(this.canvas)
      const [x0, y0] = at(this, x, y), [x1, y1] = at(this, x + w, y + h)
      if (m) for (const [k, [, px, py]] of m) if (px >= Math.min(x0, x1) && px <= Math.max(x0, x1) && py >= Math.min(y0, y1) && py <= Math.max(y0, y1)) m.delete(k)
    } catch {}
    return clear.call(this, x, y, w, h)
  }
  window.__alCanvases = () => [...canvases].filter(c => c.isConnected && runs.get(c)?.size)
  window.__alCanvasRuns = c => [...runs.get(c).values()]
  // Runs within half a line of each other read as one line, left to right.
  window.__alCanvasLines = c => {
    const all = [...runs.get(c).values()].sort((a, b) => a[2] - b[2] || a[1] - b[1])
    const lines = []
    for (const [t, x, y] of all) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(y - last.y) < ${CANVAS_LINE_PX}) last.parts.push([x, t]); else lines.push({ y, parts: [[x, t]] })
    }
    return lines.map(l => l.parts.sort((a, b) => a[0] - b[0]).map(p => p[1]).join(' · '))
  }
})()`
// Animations and transitions finish at once, so pages settle without waiting on motion.
const MOTION_RATE = 1000

// Binary bodies (protobuf, gzip) would corrupt the terminal and anything piped after it.
function printable(body: string | null | undefined, max: number): string | undefined {
  if (!body) return undefined
  const bad = body.slice(0, 300).replace(/[\x20-\x7e\t\n\r\u00a0-\uffff]/g, '').length
  return bad > 2 ? `<binary, ${body.length} bytes>` : body.length > max ? `${body.slice(0, max)}… (${body.length - max} more chars)` : body
}

// Credentials never reach the agent's context: an LLM transcript is not the place for a session token.
const SECRET_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-csrf-token|x-xsrf-token)$/i
const headerLines = (h: Record<string, string>) =>
  Object.entries(h).map(([k, v]) => `  ${k}: ${SECRET_HEADERS.test(k) ? '<redacted>' : v}`).join('\n')

// Requests that carry no data for the agent: beacons, 204 No Content, and the tracker list.
const noise = (r: Req) => r.kind === 'ping' || r.status === 204 || isTracker(r.url)

// body: an API answer (fetch, XHR), kept when it arrives: the browser drops it once the page moves on.
type Req = { id: number; method: string; url: string; status: number; type: string; kind: string; post?: string; request: Request; body?: Buffer }
// shown: the last full text the agent received per context (the page, or a modal dialog by name), so
// actions answer with what changed even when a dialog opens over the page and closes again.
// frames: cross-origin frames with their own engine session, and the iframe element that owns each.
// dialog: an alert/confirm/prompt waiting for the agent. opened: pop-ups since the last answer.
type Frame = { cdp: CDPSession; owner: { scope: string; id: number } }
type Tab = {
  id: number; session: string; page: Page; cdp: CDPSession; refs: Refs; doc: number; shown: Map<string, { doc: number; text: string }>
  // read: the whole page as the agent last read it, so reading it again answers with what changed.
  read?: { doc: number; text: string }
  // seen: each region's full text as last shown in a map (map) or in full (text), by ref, across the
  // tab's pages: a site's menus and footer are shown once, not on every page (render Seen).
  seen: { map: Map<number, string>; text: Map<number, string> }
  // used: when a command last acted on this tab; `tabs` lists by it.
  used: number
  pending: Map<Request, number>; standing: Set<string>; net: Req[]; netId: number; frames: Map<string, Frame>; dialog?: Dialog; opened: number[]
  downloads: { file: string; size: number; url: string }[]; saving: Promise<void>[]; status?: number; retryAfter?: string
  // The document the current command began on, and when a new one arrived during it: which of another
  // site's data calls count (caused).
  startDoc?: number; arrived?: number
  // view: the size and kind of viewport `viewport` set; absent while the browser's own applies.
  view?: { width: number; height: number; mobile: boolean }
}
export type Command = {
  cmd: string; session: string; urls?: boolean; out?: string; url?: string; pages?: string[]; ref?: string; text?: string; key?: string; id?: number; enter?: boolean; all?: boolean
  page?: number; files?: string[]; file?: string; dir?: string; gone?: boolean; keys?: boolean; to?: string; full?: boolean; version?: string
  // steps: the commands to run, each with the text it was given as.
  steps?: Command[]; raw?: string
  // get --all --more: the control that gives more of the list, by ref or name.
  more?: string
} & Query

// Commands that only read a page, for the shorter time limit.
const READS = new Set(['read', 'map', 'find', 'get', 'screenshot', 'net', 'tabs', 'status', 'cookies', 'storage'])

// Tab ids are unique across the daemon; each session (one agent, one task) has its own current tab.
const tabs = new Map<number, Tab>()
const current = new Map<string, number>()
let nextId = 1
let ctx: BrowserContext
let browser: Browser | undefined
let policy: Policy

// Each session's tabs are written after every command; the next daemon reopens them (a browser or daemon that died
// takes its tabs with it). A tab with no address of its own has nothing to reopen. Attached, the daemon never opens a
// tab it was not asked for, so nothing is written or restored.
let kept: Kept = { next: 1, sessions: {} }
function persist() {
  if (ATTACH) return
  for (const s of Object.values(kept.sessions)) { s.tabs = []; delete s.current }
  for (const t of tabs.values()) {
    const url = t.page.url()
    if (/^(about|chrome-error):/.test(url)) continue
    const s = (kept.sessions[t.session] ??= { tabs: [], gone: [], calls: [] })
    s.tabs.push({ id: t.id, url, used: t.used })
    s.gone = s.gone.filter(u => u !== url)
    if (current.get(t.session) === t.id) s.current = t.id
  }
  for (const [name, s] of Object.entries(kept.sessions)) if (!s.tabs.length && !s.gone.length) delete kept.sessions[name]
  kept.next = nextId
  saveKept(kept)
}

// Tabs keep their ids and their order of use, so what the agent was told about them still holds.
async function restore() {
  kept = loadKept()
  const opened: { tab: Tab; url: string }[] = []
  for (const [session, s] of Object.entries(kept.sessions)) {
    for (const t of s.tabs) {
      nextId = t.id
      const tab = await setupTab(session, await ctx.newPage())
      tab.used = t.used
      opened.push({ tab, url: t.url })
    }
    if (s.current && tabs.has(s.current)) current.set(session, s.current)
  }
  nextId = Math.max(kept.next, nextId)
  await Promise.allSettled(opened.map(({ tab, url }) => tab.page.goto(url, COMMIT())))
}

// What the agent last did, for `status`: the call, and the first line of what it was told.
function logCall(c: Command, answer: string) {
  if (c.cmd === 'status') return
  const s = (kept.sessions[c.session] ??= { tabs: [], gone: [], calls: [] })
  const call = [c.cmd, c.steps?.map(t => t.raw ?? t.cmd).join('; ') ?? c.url ?? c.ref ?? c.file ?? c.text ?? c.id].filter(x => x !== undefined).join(' ')
  s.calls = [...s.calls, `${call.slice(0, policy['status.lineChars'] / 2)} → ${answer.split('\n')[0].slice(0, policy['status.lineChars'])}`].slice(-policy['status.calls'])
  for (const file of [c.out, ...(c.steps ?? []).map(t => t.out)]) if (file && existsSync(file)) noteSaved(c.session, file)
}

// A tab let go stays in the session's record, so its address can be opened again.
async function letGo(t: Tab) {
  const url = t.page.url()
  const s = (kept.sessions[t.session] ??= { tabs: [], gone: [], calls: [] })
  s.gone = [url, ...s.gone.filter(u => u !== url)].slice(0, policy['tabs.max'])
  await t.page.close().catch(() => {})
}

// A tab costs about 110 MB (DESIGN §9): past tabs.max the least recently used closes, and never the current one.
async function limitTabs(session: string): Promise<string> {
  const mine = [...tabs.values()].filter(t => t.session === session)
  const over = mine.filter(t => t.id !== current.get(session)).sort((a, b) => a.used - b.used).slice(0, Math.max(0, mine.length - policy['tabs.max']))
  await Promise.all(over.map(letGo))
  return over.length ? `\nnote: closed tab ${over.map(t => t.id).join(', ')} (least recently used; at most ${policy['tabs.max']} tabs a session): status lists the address` : ''
}

function toBrowser(c: Cookie) {
  return { name: c.name, value: c.value, domain: c.hostOnly ? c.domain : `.${c.domain}`, path: c.path, expires: c.expires ? c.expires / 1000 : -1, secure: !!c.secure }
}

// Sessions run side by side, so a stale jar must never overwrite a cookie another session's page just
// rotated: the jar is read only when someone else (the fast path) wrote it since this daemon last did.
const jarStamp = () => statSync(join(home(), 'cookies.json'), { throwIfNoEntry: false })?.mtimeMs ?? 0
let jarSeen = 0
let jarWritten = ''

// Before each command: whatever the fast path logged into since, the browser gets too.
async function pullCookies() {
  if (ATTACH || jarStamp() === jarSeen) return
  jarSeen = jarStamp()
  jarWritten = ''
  const jar = loadJar().filter(c => !c.expires || c.expires > Date.now())
  if (jar.length) await ctx.addCookies(jar.map(toBrowser)).catch(() => {})
}

// After each command: the browser now holds the jar plus its own changes, so it is the whole truth.
async function syncCookies() {
  if (ATTACH) return
  const jar: Cookie[] = (await ctx.cookies()).map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain.replace(/^\./, ''),
    hostOnly: !c.domain.startsWith('.'),
    path: c.path,
    expires: c.expires > 0 ? c.expires * 1000 : undefined,
    secure: c.secure,
  }))
  // Most commands change no cookie, and a write moves the jar's stamp, which makes every session read it back.
  const text = JSON.stringify(jar)
  if (text === jarWritten) return
  saveJar(jar)
  jarWritten = text
  jarSeen = jarStamp()
}

function track(tab: Tab) {
  const { page } = tab
  page.on('request', r => { if (r.resourceType() !== 'websocket') tab.pending.set(r, Date.now()) })
  page.on('requestfailed', r => { tab.pending.delete(r) })
  page.on('requestfinished', async r => {
    tab.pending.delete(r)
    const kind = r.resourceType()
    if (kind !== 'document' && kind !== 'xhr' && kind !== 'fetch' && kind !== 'ping') return
    const res = await r.response().catch(() => null)
    const body = kind === 'xhr' || kind === 'fetch' ? await res?.body().catch(() => undefined) : undefined
    tab.net.push({
      id: ++tab.netId,
      method: r.method(),
      url: r.url(),
      status: res?.status() ?? 0,
      type: (res?.headers()['content-type'] ?? '').split(';')[0],
      kind,
      post: printable(r.postData(), 300)?.replace(/\s+/g, ' '),
      request: r,
      body: body && body.length <= policy['network.keepBytes'] ? body : undefined,
    })
    if (tab.net.length > policy['network.keep']) tab.net.shift()
    // Held answers are memory: past the tab's budget the oldest are let go (the browser may still have them).
    let held = tab.net.reduce((sum, n) => sum + (n.body?.length ?? 0), 0)
    for (const n of tab.net) {
      if (held <= policy['network.tabBytes']) break
      if (n.body) { held -= n.body.length; n.body = undefined }
    }
  })
  page.on('close', () => {
    tabs.delete(tab.id)
    if (current.get(tab.session) !== tab.id) return
    const next = [...tabs.values()].filter(t => t.session === tab.session).pop()
    if (next) current.set(tab.session, next.id)
    else current.delete(tab.session)
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// The page's standing connections (a long-poll channel, a stream) are not the action's doing. Requests
// open when a command begins are standing, and so is a request that reopens one of their channels.
const commandStart = new Map<string, number>()
const channel = (url: string) => { const u = new URL(url); return `${u.origin}${u.pathname}` }
function beginCommand(session: string) {
  commandStart.set(session, Date.now())
  for (const t of tabs.values()) {
    if (t.session !== session) continue
    t.standing = new Set([...t.pending.keys()].map(r => channel(r.url())))
    t.startDoc = t.doc
    t.arrived = undefined
  }
}
// A site is its registrable domain: news.example.co.uk and static.example.co.uk are one site. Two-letter
// country domains under a short label (co.uk, com.au) take three labels; an IP address is its own site.
const registrable = (url: string) => {
  try {
    const host = new URL(url).hostname
    if (/^[\d.]+$|:/.test(host)) return host
    const p = host.split('.')
    return p.slice(p.length > 2 && p[p.length - 2].length <= 3 && p[p.length - 1].length === 2 ? -3 : -2).join('.')
  } catch { return '' }
}
// Requests the current command caused that are still in flight and that the page's content waits on: the
// site's own, never decoration (pictures, fonts, media cannot change the text). Another site's requests
// (ads, analytics, widgets) keep a page busy for seconds and change nothing the agent reads, so only its data calls (fetch, XHR) count, and only where content may come from
// them: on a loaded page, those an action starts right away (a search box served by a search API); on a
// page that just arrived, those its scripts make in its first settle.arrivalMs, each for that long at most,
// since ad scripts keep making more (results served by another site's API).
const caused = (tab: Tab) => {
  const site = registrable(tab.page.url())
  const began = commandStart.get(tab.session) ?? 0
  return [...tab.pending].filter(([r, at]) => {
    if (at < began || tab.standing.has(channel(r.url())) || r.resourceType() === 'eventsource' || DECORATION.has(r.resourceType()) || isTracker(r.url())) return false
    if (registrable(r.url()) === site) return true
    if (r.resourceType() !== 'xhr' && r.resourceType() !== 'fetch') return false
    if (tab.doc === tab.startDoc) return at - began < policy['settle.thirdPartyMs']
    return tab.arrived !== undefined && at - tab.arrived < policy['settle.arrivalMs'] && Date.now() - at < policy['settle.arrivalMs']
  }).length
}

// The page holds plenty of text but shows hardly any of it (PAGE_HOOKS). A dialog blocks page scripts, so the read is bounded.
const holdsBack = async (tab: Tab) => await Promise.race([tab.page.evaluate('window.__alHidden?.() ?? false').catch(() => false), sleep(500).then(() => false)]) === true

// Settled when the site's own requests are done and the shown text has not changed for settle.quietMs;
// or a dialog is waiting (the page is blocked until it is answered); or the deadline passes. A page with
// plenty of text but hardly any shown is given settle.revealMs to show it. A document that has not
// finished arriving in load.domMs is read as far as it got. Says which.
async function settle(tab: Tab, deadline = policy['settle.deadlineMs'], start = Date.now()): Promise<string> {
  const arrived = await tab.page.waitForLoadState('domcontentloaded', { timeout: policy['load.domMs'] }).then(() => true, () => false)
  if (!arrived) return `still loading after ${policy['load.domMs'] / 1000} s; this is what has arrived`
  if (tab.doc !== tab.startDoc) tab.arrived ??= Date.now()
  const end = Date.now() + deadline
  let last: unknown
  let hidden: boolean | undefined
  let quietSince = Date.now()
  // An action that navigates commits its new document during this wait. That document is settled like one
  // that was opened, from its own arrival: read before it has parsed (its head waiting on a script), it is empty.
  const doc = tab.doc
  const moved = () => tab.doc !== doc && Date.now() - start < policy['load.timeoutMs']
  while (Date.now() < end) {
    if (tab.dialog) return 'dialog'
    if (moved()) return settle(tab, deadline, start)
    // A dialog opening mid-read blocks page scripts, so the read is bounded.
    const text = await Promise.race([tab.page.evaluate('window.__alText?.() ?? 0').catch(() => -2), sleep(500).then(() => -3)])
    if (text !== last || caused(tab) > 0) { last = text; hidden = undefined; quietSince = Date.now() }
    else if (Date.now() - quietSince >= policy['settle.quietMs']) {
      hidden ??= await holdsBack(tab)
      if (!hidden || Date.now() - quietSince >= policy['settle.revealMs']) return `idle in ${Date.now() - start} ms`
    }
    await sleep(100)
  }
  // A page that arrived holding text it does not show yet (results kept back while the site checks the
  // visitor) is nothing to read: it is waited on until it shows, settle.hiddenMs at most.
  if (tab.doc === tab.startDoc || !await holdsBack(tab)) return `deadline ${deadline} ms (the page kept changing)`
  while (Date.now() - start < policy['settle.hiddenMs']) {
    if (tab.dialog) return 'dialog'
    if (moved()) return settle(tab, deadline, start)
    if (!await holdsBack(tab)) return `shown after ${Date.now() - start} ms`
    await sleep(100)
  }
  return `deadline ${policy['settle.hiddenMs']} ms (the page holds text it does not show yet: wait "<text>", or read again later)`
}

// How settling ended, for an answer that names it only when it was not the usual quiet page.
const unusual = (settled: string) => (settled.startsWith('idle') ? '' : settled)

// A 429 asks the client to come back later (RFC 6585): the page is loaded again once, after the wait the
// site names (Retry-After in seconds), at most load.retryMs. Returns a note for the answer, or ''.
async function arrive(tab: Tab): Promise<string> {
  if (tab.status !== 429) return ''
  const wait = Math.min(Number(tab.retryAfter) > 0 ? Number(tab.retryAfter) * 1000 : 2000, policy['load.retryMs'])
  await sleep(wait)
  await tab.page.reload({ waitUntil: 'commit', timeout: policy['load.timeoutMs'] }).catch(() => {})
  return `the site said too many requests (HTTP 429); loaded again after ${wait / 1000} s`
}

const caps = () => ({ nameChars: policy['render.nameChars'], labelChars: policy['render.labelChars'] })

// One read of the page: the tree and its full text.
async function snapshot(tab: Tab) {
  const tree = await readTree(tab.cdp, tab.refs, { minRepeats: policy['data.minRepeats'], minParts: policy['data.minParts'], revealItems: policy['render.mapFew'] }, (id, owner) => frameSession(tab, id, owner))
  const origin = new URL(tab.page.url()).origin
  return { tree, origin, text: renderText(tree, origin, caps()) }
}

// The full text of what the agent has been shown last, per context; later actions diff against it.
const remember = (tab: Tab, text: string) => tab.shown.set(contextOf(text), { doc: tab.doc, text })

// The tab line names the tab, its address and title. The agent already holds them when the last answer of
// the session was about this same page, so then it is just the tab's number.
const headed = new Map<string, string>()
const header = async (tab: Tab) => {
  const title = await tab.page.title()
  const what = `${tab.page.url()}${title ? `  "${title}"` : ''}`
  const same = headed.get(tab.session) === `${tab.id} ${what}`
  headed.set(tab.session, `${tab.id} ${what}`)
  const view = tab.view ? `  [viewport ${tab.view.mobile ? 'mobile ' : ''}${tab.view.width}x${tab.view.height}]` : ''
  return `${same ? `tab ${tab.id}` : `tab ${tab.id}  ${what}`}${view}`
}

// The viewport an agent gets from `viewport mobile`: a standard phone (Playwright's published descriptor, so
// size, pixel ratio, touch and user agent agree with each other as a real device's do).
const PHONE = devices['iPhone 13']
const sizeOf = (tab: Pick<Tab, 'view'>) => tab.view ?? { width: policy['viewport.width'], height: policy['viewport.height'] }

// A page that turned the agent away: the site refused this browser, or put a human check in front of it.
// The agent never solves or evades either (DESIGN §1: no anti-bot evasion), but a block often covers one
// page and not the site: the normal way in (home page, the site's own search, another page, a retry after
// a wait) is tried first, and a person can clear it in the window.
// A check provider's frame is a check only when a person can see it: reCAPTCHA's invisible helper frames
// (which ad scripts load on ordinary pages) are hidden or have no size, while a checkbox or a challenge is
// a box on the page.
const SHOWN_PX = 30
async function shownFrames(tab: Tab): Promise<string[]> {
  const shown = await Promise.all(tab.page.frames().filter(f => f !== tab.page.mainFrame()).map(async f => {
    const box = await f.frameElement().then(e => e.boundingBox()).catch(() => null)
    return box && box.width >= SHOWN_PX && box.height >= SHOWN_PX ? f.url() : undefined
  }))
  return shown.filter((u): u is string => u !== undefined)
}

async function blocked(tab: Tab, tree: Node): Promise<string> {
  const check = humanCheck(await shownFrames(tab), tree, policy['blocked.controls'])
  if (!check && tab.status !== 403 && tab.status !== 429) return ''
  const why = check ? 'a human check (CAPTCHA) is on this page' : `the site refused this browser (HTTP ${tab.status})`
  return `\nblocked: ${why}. Do not solve or evade the check. Try another normal way in first: the site's home page or its own search, a different page of the site, or this page again after a short wait. If it stays blocked, a person can clear it: browser-layer show, clear it in that window, then browser-layer hide\n`
}

// Opening a page answers with its map (DESIGN §1a); read and read <ref> go deeper. A map that answers a
// page load shows regions already shown, unchanged, in one line; one the agent asks for (map, a
// switch to an open tab) is whole, since that is when it wants every ref again.
async function mapView(tab: Tab, snap?: Awaited<ReturnType<typeof snapshot>>, settled = '', note = '', whole = false): Promise<string> {
  let { tree, origin, text } = snap ?? await snapshot(tab)
  // A page that reads empty went quiet before it drew (a timer, a fade-in still at opacity 0). Telling the agent
  // to read again costs it a call, so it is read again here until it has something, settle.revealMs at most.
  for (const end = Date.now() + policy['settle.revealMs']; !text && Date.now() < end;) {
    await sleep(policy['settle.quietMs'])
    ;({ tree, origin, text } = await snapshot(tab))
  }
  remember(tab, text)
  const now = new Map<number, string>()
  // A page that arrives comes with its main content when that is short (render.ts); a map the agent asked for is the map.
  const given = new Map<number, string>()
  const map = renderMap(tree, origin, caps(), policy['render.mapFew'], { before: whole ? new Map() : tab.seen.map, now }, whole ? undefined : { chars: policy['answer.headChars'], given })
  for (const [ref, whole] of now) tab.seen.map.set(ref, whole)
  for (const [ref, text] of given) tab.seen.text.set(ref, text)
  if (!map.trim()) note = [note, 'no content yet: the page may still be loading; read again'].filter(Boolean).join('; ')
  return `${await header(tab)}${note ? `  — ${note}` : ''}${settled ? `  — settled: ${settled}` : ''}\n${await blocked(tab, tree)}\n${map}`
}

// A dialog an action opened (a date picker, a list of suggestions) answers with what it holds when that is
// short, refs included, so the next step can act on it without reading it first; a long one, with its map.
async function openedView(tab: Tab, snap: Awaited<ReturnType<typeof snapshot>>, settled = ''): Promise<string> {
  const now = new Map<number, string>()
  const short = renderText(snap.tree, snap.origin, caps(), { before: tab.seen.text, now })
  if (short.length > policy['open.dialogChars']) return mapView(tab, snap, settled)
  remember(tab, snap.text)
  for (const [ref, whole] of now) { tab.seen.text.set(ref, whole); tab.seen.map.set(ref, whole) }
  tab.read = { doc: tab.doc, text: snap.text }
  return `${await header(tab)}  — it opened what is below${settled ? `, settled: ${settled}` : ''}\n\n${short}`
}

// The page's text, or one region's, as the agent reads it.
async function textOf(tab: Tab, ref?: number): Promise<string> {
  const snap = await snapshot(tab)
  if (ref === undefined) {
    remember(tab, snap.text)
    return snap.text
  }
  const node = findRef(snap.tree, ref)
  if (!node) throw new Error(`[${ref}] is not on the page — run: browser-layer map`)
  return renderText({ block: true, children: [node] }, snap.origin, caps())
}

// A result bigger than one answer belongs in a file the agent's own tools read (grep, jq, a script), not in
// its context: --out writes it whole, and the answer says how much and where.
// The answer also gives the start of it: the first look is what the agent would spend a turn on.
const saved = (file: string, text: string, what: string) => {
  const body = bounded(text, policy['save.lineChars'])
  writeFileSync(file, `${body}\n`)
  const max = policy['answer.previewChars']
  if (body.length <= max) return `saved ${file}: ${what}\n${body}`
  const at = body.lastIndexOf('\n', max)
  const head = body.slice(0, at > 0 ? at : max)
  return `saved ${file}: ${what}\n${head}\n… ${body.split('\n').length - head.split('\n').length} more lines in the file`
}

async function view(tab: Tab, page = 1, text?: string, ref?: number): Promise<string> {
  if (text === undefined) text = await textOf(tab, ref)
  const truncated = text.length > policy['render.maxChars']
  if (truncated) text = text.slice(0, text.lastIndexOf('\n', policy['render.maxChars']))
  const pages = paginate(text, policy['render.pageChars'])
  if (page < 1 || page > pages.length) throw new Error(`page ${page} does not exist; this view has ${pages.length}`)
  const head = `${await header(tab)}${pages.length > 1 ? `  (page ${page} of ${pages.length})` : ''}`
  // The first page of a read longer than answer.fileChars is the head and a file, in place of the whole page:
  // the tail of a long read is what agents leave unread.
  if (page === 1 && text.length > policy['answer.fileChars']) return ceiling(`${head}\n\n${text}${truncated ? '\n… (view ceiling reached; the page is larger than this)' : ''}`, policy, 0)
  const more = page < pages.length ? `\n… more below: browser-layer read${ref === undefined ? '' : ` ${ref}`} --page ${page + 1}, or --out <file> for all ${pages.length} pages` : ''
  const cut = truncated && page === pages.length ? '\n… (view ceiling reached; the page is larger than this)' : ''
  return `${head}\n\n${pages[page - 1]}${more}${cut}`
}

// Reading the same page again answers with what changed since the agent last read it: the rest is already
// in its context. Nothing changed is one line; a page that mostly changed, or a new one, reads whole. Only
// a read that fit one answer is remembered: of a longer page the agent has seen just the first part.
async function reread(tab: Tab, full: boolean): Promise<string> {
  const snap = await snapshot(tab)
  remember(tab, snap.text)
  const text = snap.text
  const again = tab.read?.doc === tab.doc
  const before = again && !full ? tab.read!.text : undefined
  tab.read = text.length <= policy['answer.fileChars'] ? { doc: tab.doc, text } : undefined
  if (before === text) return `${await header(tab)}  — no change since your last read (read --full shows it again)`
  if (before !== undefined) {
    const { removed, added } = diffLines(before.split('\n'), text.split('\n'))
    const lines = [...removed.map(l => `- ${l}`), ...added.map(l => `+ ${l}`)].join('\n')
    if (lines.length < text.length / 2) return `${await header(tab)}  — ${removed.length} line${removed.length === 1 ? '' : 's'} gone, ${added.length} new since your last read (read --full shows it all)\n\n${lines}`
  }
  // Regions already shown in full, unchanged, are one line each, when the rest fits one answer: a page
  // that needs --page N reads whole, so its pages stay the same between calls. --full asks for this page
  // again, so it shows all of it; on another page of the site it folds what the site repeats, like read.
  const now = new Map<number, string>()
  const short = renderText(snap.tree, snap.origin, caps(), { before: full && again ? new Map() : tab.seen.text, now })
  if (short.length > policy['answer.fileChars']) return view(tab, 1, text)
  for (const [ref, whole] of now) { tab.seen.text.set(ref, whole); tab.seen.map.set(ref, whole) }
  return view(tab, 1, short)
}

function need(session: string): Tab {
  const tab = tabs.get(current.get(session) ?? 0)
  if (!tab) throw new Error(`no live tab in session "${session}" — run: browser-layer tab <url>`)
  tab.used = Date.now()
  return tab
}

function own(session: string, id: number): Tab {
  const tab = tabs.get(id)
  if (!tab) throw new Error(`no tab ${id}`)
  if (tab.session !== session) throw new Error(`tab ${id} belongs to session "${tab.session}", not "${session}"`)
  tab.used = Date.now()
  return tab
}

const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 120 ? `${s} s ago` : s < 7200 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago` }
const pageOf = (url: string) => url.split('#')[0]

// After an action the agent already holds the page, so it gets the lines that changed: the complete
// answer to what the action did. A new document is answered with its map, as opening one is.
const contextOf = (text: string) => (/^\[\d+\] dialog/.test(text) ? text.slice(0, text.indexOf('\n') >>> 0) : 'page')

// The outermost collections holding any of the new lines, and the lines each one renders as.
function changedCollections(snap: Awaited<ReturnType<typeof snapshot>>, added: string[]) {
  const fresh = new Set(added)
  const lines = (n: Node) => renderText({ block: true, children: [n] }, snap.origin, caps()).split('\n')
  const moved = (n: Node): Node[] => (n.ref && COLLECTIONS.has(n.role ?? '') && lines(n).some(l => fresh.has(l)) ? [n] : (n.children ?? []).flatMap(moved))
  return { found: moved(snap.tree), lines }
}

async function changes(tab: Tab, settled = ''): Promise<string> {
  const snap = await snapshot(tab)
  const before = tab.shown.get(contextOf(snap.text))
  if (!before || before.doc !== tab.doc) return contextOf(snap.text) === 'page' ? mapView(tab, snap, settled) : openedView(tab, snap, settled)
  const { removed, added } = diffLines(before.text.split('\n'), snap.text.split('\n'))
  const size = [...removed, ...added].reduce((n, l) => n + l.length + 3, 0)
  // Changed lines longer than the page itself: the page was replaced. Like a new view, it is answered
  // with the shorter of its whole text (a small page) and its map (a large one).
  if (size > snap.text.length) {
    if (snap.text.length > renderMap(snap.tree, snap.origin, caps(), policy['render.mapFew']).length) {
      // New records (the next page of a table) leave a map as it was, so what changed is answered as those
      // records, plus any other new lines. Too many to fit one page: the map, naming where they are. A page
      // that changed around its lists too (an app re-rendering as a menu opens) is answered with its map:
      // what opened is listed there with its refs, and regions shown before, unchanged, are one line each.
      const changed = changedCollections(snap, added)
      const found = changed.found.filter(n => records(n, snap.origin, caps()).rows.length)
      const inside = new Set(found.flatMap(changed.lines))
      const outside = added.filter(l => !inside.has(l))
      if (outside.length > policy['render.mapFew']) return mapView(tab, snap, settled)
      const where = found.map(n => `[${n.ref}] ${n.role}`).join(', ')
      // The action opened something (a list of options, a menu, a dialog): that is the answer, and lists
      // that changed around it are named, not given as records.
      if (outside.some(l => / expanded\b/.test(l) || /^\[\d+\] (listbox|menu|dialog|alertdialog|grid|tree)\b/.test(l))) {
        remember(tab, snap.text)
        return `${await header(tab)}  — it opened what is below${where ? `; ${where} changed too (read <ref> shows it)` : ''}${settled ? `, settled: ${settled}` : ''}\n\n${outside.map(l => `+ ${l}`).join('\n')}`
      }
      const body = [...outside.map(l => `+ ${l}`), ...found.map(n => recordsView(`[${n.ref}] ${n.role}`, records(n, snap.origin, caps()), {}))].join('\n\n')
      if (!found.length || body.length > policy['render.pageChars']) return mapView(tab, snap, settled, where && `new records in ${where} (browser-layer get <ref> reads them)`)
      remember(tab, snap.text)
      return `${await header(tab)}  — new records in ${where}${settled ? `, settled: ${settled}` : ''}\n\n${body}`
    }
    remember(tab, snap.text)
    return `${await header(tab)}  — the whole page changed${settled ? `, settled: ${settled}` : ''}\n\n${snap.text}`
  }
  remember(tab, snap.text)
  // More new lines than one page: each long list among them is one line, and find or read <ref> goes in.
  let shown = added
  let note = ''
  if (size > policy['render.pageChars']) {
    const { found, lines } = changedCollections(snap, added)
    const summary = new Map<string, string>()
    for (const n of found) {
      const line = itemsLine(n, snap.origin, caps(), policy['render.mapFew'])
      if (line) for (const l of lines(n)) summary.set(l, line)
    }
    const seen = new Set<string>()
    shown = added.flatMap(l => {
      const line = summary.get(l)
      return !line ? [l] : seen.has(line) ? [] : (seen.add(line), [line])
    })
    if (seen.size) note = ' (a long list is one line: find <text> or read <ref> goes in)'
  }
  const head = `${await header(tab)}  — ${removed.length + added.length ? `${removed.length} lines gone, ${added.length} new` : 'no visible change'}${settled ? `, settled: ${settled}` : ''}${note}`
  return [head, '', ...goneLines(removed, policy['render.mapFew']), ...shown.map(l => `+ ${l}`)].join('\n').trimEnd()
}

// Records (a collection on the page, a list collected over its pages, a file get saved) as TSV: filtered, counted,
// grouped, sorted, limited and column-picked as asked, and never more than one page in an answer (the column line
// included); --out writes them all. what: what they are, for the answer's first line.
function recordsView(what: string, all: Records, q: Query & { out?: string }, ended = ''): string {
  const kept = q.where ? where(all, q.where) : all
  const matching = q.where ? ` match ${q.where.join(' and ')}` : ''
  if (q.count) return `${what}: ${kept.rows.length} of ${all.rows.length} records${matching}${ended}`
  const from = q.group ? group(kept, q.group) : kept
  const out = query(from, q)
  if (q.out) return saved(q.out, toTsv(out), `${out.rows.length} records, ${out.columns.length} columns (TSV)${ended}`)
  const asked = out.rows.length
  let size = toTsv({ ...out, rows: [] }).length
  const fits = out.rows.findIndex(r => (size += r.join('\t').length + 1) > policy['render.pageChars'])
  if (fits >= 0) out.rows = out.rows.slice(0, fits)
  const head = `${what}: ${all.rows.length} records, ${all.columns.length} columns${q.where ? ` (${kept.rows.length}${matching})` : ''}${ended}`
  if (!out.rows.length && asked) return `${head} — too wide for one answer: --cols picks columns, --out <file> writes all`
  const how = [q.sort ? `sorted by ${q.sort}${q.desc ? ' descending' : ''}` : '', out.rows.length < from.rows.length ? `first ${out.rows.length}` : ''].filter(Boolean).join(', ')
  const rest = out.rows.length < asked || (q.limit === undefined && out.rows.length < from.rows.length) ? `\n… ${from.rows.length - out.rows.length} more records: --limit, --cols, or --out <file> for all` : ''
  return `${head}${how ? ` (${how})` : ''}\n\n${toTsv(out)}${rest}`
}

// get --all (DESIGN §4.5): the list's own way to more, pressed until nothing new arrives. The page says which link is
// the next page in two standard ways, whatever its language: rel=next (HTML link types), and aria-current="page" on
// the current page's link in a navigation landmark (WAI-ARIA), where the link after it is the next. Failing those, a
// control named as paging controls are in English is pressed; with none, the page scrolls to its end, which is how an
// infinite list asks for more. A control only the agent can tell apart is named by it (--more). A row is new when no
// earlier row has its text.
const NEXT_PAGE = `(() => {
  const marked = document.querySelector('a[rel~=next],link[rel~=next]')
  if (marked) return marked.href
  const current = document.querySelector('nav [aria-current="page"],[role=navigation] [aria-current="page"]')
  return current && [...current.closest('nav,[role=navigation]').querySelectorAll('a[href]')]
    .find(a => current.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING && !current.contains(a))?.href
})()`
const MORE = /^(?:(?:next(?: page)?|load more|show more|see more|view more|more results)\s*[›»→>]?|[›»→>])$/i

// It says a list ended only when the page shows it: the way on that was pressed is no longer there, or scrolling, which
// had been bringing rows, brings no more. Anything else is "not shown to be complete", with what was tried.
// The file is written page by page, and beside it, while the list is unfinished, where the collection began, the
// address it has reached and its columns' fields. A call that stops (a page that fails, get.rounds, the browser gone) has lost nothing, and
// the same command, run on either of those pages, carries on: the saved rows are kept and no saved page is turned again.
async function recordsAll(tab: Tab, first: Node, origin: string, q: Query & { out?: string; more?: string }): Promise<string> {
  const rows = new Map<string, string[]>()
  let names: string[] = []
  let list = first
  // A row is its text: its refs change when the page re-renders it, and when the browser starts again.
  const add = (row: string[]) => rows.set(row.join('\t').replace(/\[\d+\] /g, ''), row)
  // A column is a field (its path in the row; a table's cell position), not a place on one page: a page whose first
  // row has an optional part would otherwise put every field after it one column over.
  const fields: string[] = []
  const take = () => {
    const r = records(list, origin, { ...caps(), urls: q.urls })
    if (r.names.length > names.length) names = r.names
    const column = (r.keys ?? r.columns).map(k => (fields.includes(k) ? fields.indexOf(k) : fields.push(k) - 1))
    for (const row of r.rows) add(Array.from(row.reduce((cells, v, i) => { cells[column[i]] = v; return cells }, Array<string>(fields.length)), v => v ?? ''))
  }
  const data = (): Records => {
    const columns = Array.from({ length: Math.max(...[...rows.values()].map(r => r.length)) }, (_, i) => `c${i + 1}`)
    return { columns, names: columns.map((_, i) => names[i] ?? ''), rows: [...rows.values()].map(r => columns.map((_, i) => r[i] ?? '')) }
  }
  // The same list after the page changed: its ref if the page kept it, else the largest list of its kind.
  const locate = async () => {
    const same = withRefs((await snapshot(tab)).tree).filter(n => n.role === list.role)
    return same.find(n => n.ref === list.ref) ?? same.sort((a, b) => records(b, origin, caps()).rows.length - records(a, origin, caps()).rows.length)[0]
  }
  const mark = q.out && `${q.out}.unfinished`
  let from = tab.page.url()
  if (mark && existsSync(mark) && existsSync(q.out!)) {
    const [began, reached, columns] = readFileSync(mark, 'utf8').split('\n')
    if ([began, reached].map(pageOf).includes(pageOf(from))) {
      const saved = fromTsv(readFileSync(q.out!, 'utf8'))
      names = saved.names
      saved.rows.forEach(add)
      fields.push(...columns.split('\t'))
      if (pageOf(reached) !== pageOf(from)) {
        await tab.page.goto(reached, COMMIT())
        await settle(tab)
        list = await locate() ?? list
      }
      from = began
    }
  }
  const keep = () => {
    if (!q.out) return
    writeFileSync(q.out, `${toTsv(data())}\n`)
    writeFileSync(mark!, `${from}\n${tab.page.url()}\n${fields.join('\t')}`)
  }
  const finished = (ending: string) => {
    if (mark) rmSync(mark, { force: true })
    return recordsView(`[${list.ref}] ${list.role}`, data(), q, ` — ${ending}`)
  }
  const stopped = (why: string) => (q.out
    ? `saved ${q.out}: ${rows.size} records so far — stopped: ${why}; the same command carries on`
    : recordsView(`[${list.ref}] ${list.role}`, data(), q, ` — stopped: ${why}`))
  // One page more: the list's way on is pressed, or the page scrolled, and the list read again. Nothing to return
  // when the way on that earlier pages had is gone.
  let pressed = ''
  const turn = async () => {
    const rel = await tab.page.evaluate(NEXT_PAGE).catch(() => undefined)
    const controls = withRefs((await snapshot(tab)).tree).filter(n => (n.role === 'link' || n.role === 'button') && !n.states?.includes('disabled'))
    // The control the agent named is the way on, and nothing else is tried: by ref, else the best match of its name.
    const want = q.more?.trim().toLowerCase() ?? ''
    const more = q.more ? controls.find(n => String(n.ref) === q.more) ?? controls.filter(n => fit(n.name, want) < 3).sort((a, b) => fit(a.name, want) - fit(b.name, want))[0]
      : controls.find(n => rel && n.url === rel) ?? controls.find(n => MORE.test((n.name ?? '').trim()))
    if (!more && pressed) return undefined
    if (!more && q.more) throw new Error(`nothing is named "${q.more}" — run: browser-layer map`)
    if (more) await pointerAt(tab, String(more.ref), {})
    else await tab.page.evaluate('document.scrollingElement.scrollTo(0, document.scrollingElement.scrollHeight)')
    await settle(tab)
    const found = await locate()
    if (found) { list = found; take() }
    return { way: !more ? 'scroll' : !q.more && rel && more.url === rel ? 'next link' : `"${more.name}"`, found: !!found }
  }
  take()
  keep()
  let scrolled = false
  for (let round = 0; ; round++) {
    if (round === policy['get.rounds']) return stopped(`${round} pages turned, the most in one call (get.rounds)`)
    const before = rows.size
    // Each page has the limit a command has: a list is as long as it is, and one stuck page must not hold the call.
    const step = await within(turn(), policy['command.timeoutMs']).catch((err: unknown) => (err instanceof Error ? err.message.split('\n')[0] : String(err)))
    if (typeof step === 'string') return stopped(step)
    if (!step) return finished(`ended: no ${pressed} on the last page`)
    if (!step.found) return finished('not shown to be complete: the list left the page')
    keep()
    if (rows.size === before) {
      return finished(step.way !== 'scroll' ? `not shown to be complete: ${step.way === 'next link' ? 'the next link' : step.way} was pressed and nothing new came`
        : scrolled ? 'ended: scrolling to the end brought nothing more' : 'not shown to be complete: no next link or control was found, and scrolling brought nothing more; if a control gives more, name it: --more <ref or name>')
    }
    if (step.way === 'scroll') scrolled = true
    else pressed = step.way
  }
}

// The engine session for a cross-origin frame. Playwright gives such a frame its own session; the frame
// id from its frame tree says which frame the reader asked for.
async function frameSession(tab: Tab, frameId: string, owner: Frame['owner']) {
  const known = tab.frames.get(frameId)
  if (known) return (known.owner = owner), { cdp: known.cdp, scope: frameId }
  for (const f of tab.page.frames()) {
    if (f === tab.page.mainFrame()) continue
    const cdp = await ctx.newCDPSession(f).catch(() => undefined)
    if (!cdp) continue
    const { frameTree } = await cdp.send('Page.getFrameTree')
    if (frameTree.frame.id !== frameId) { await cdp.detach().catch(() => {}); continue }
    await cdp.send('Accessibility.enable')
    tab.frames.set(frameId, { cdp, owner })
    return { cdp, scope: frameId }
  }
  return undefined
}

// A frame's top-left in page coordinates: its iframe's content box, plus that frame's own offset.
async function offsetOf(tab: Tab, scope: string): Promise<[number, number]> {
  const frame = tab.frames.get(scope)
  if (!frame) return [0, 0]
  const cdp = frame.owner.scope ? tab.frames.get(frame.owner.scope)!.cdp : tab.cdp
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: frame.owner.id })
  const [x, y] = await offsetOf(tab, frame.owner.scope)
  return [model.content[0] + x, model.content[1] + y]
}

function targetOf(tab: Tab, ref?: string): Target {
  if (!ref || !/^\d+$/.test(ref)) throw new Error(`expected a ref number like 12, got "${ref ?? ''}"`)
  const at = tab.refs.byRef.get(Number(ref))
  if (!at) throw new Error(`[${ref}] is not on the page — run: browser-layer read`)
  const cdp = at.scope ? tab.frames.get(at.scope)?.cdp : tab.cdp
  if (!cdp) throw new Error(`[${ref}] is in a frame that is gone — run: browser-layer read`)
  return { cdp, page: tab.cdp, id: at.id, offset: () => offsetOf(tab, at.scope) }
}

// The engine's ways of saying the element left the page: apps re-render, replacing what was read.
const GONE = /No node with given id|No node found|Could not find node|detached from document/i

// A ref the page re-rendered, or that a new page has again, is the same element by its identity (reader
// Refs): the page is read once more and the action goes to it, instead of failing for the agent to look
// again. Only a ref the page no longer has fails, with the same advice.
async function act(tab: Tab, ref: string | undefined, fn: (t: Target) => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(targetOf(tab, ref))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const gone = GONE.test(msg) || /is not on the page —/.test(msg)
      if (gone && attempt === 0 && /^\d+$/.test(ref ?? '')) { await snapshot(tab); continue }
      if (/is not on the page —|is in a frame that is gone|expected a ref number/.test(msg)) throw err
      if (GONE.test(msg)) throw new Error(`[${ref}] is not on the page any more (it changed) — run: browser-layer map`)
      // A number is a ref, so "15" meant as a day or a page number acts on ref 15; when that one cannot be
      // reached, the controls named with that number (a day "March 15th", a page "15") are listed instead.
      const number = new RegExp(`(^|[^\\d.,])${ref}(st|nd|rd|th)?($|[^\\d.,])`)
      const shown = /^\d+$/.test(ref ?? '') ? withRefs((await snapshot(tab)).tree).filter(n => String(n.ref) !== ref && number.test(n.name ?? '')) : []
      const meant = shown.length ? `; controls named with ${ref}: ${shown.slice(0, policy['render.mapFew']).map(n => `[${n.ref}] ${n.role} "${n.name}"`).join(' · ')}` : ''
      throw new Error(`cannot act on [${ref}]: ${msg}${/its controls: /.test(msg) ? ' (click one by name, then this again)' : ''}${meant}`)
    }
  }
}

function withUrl(url: string) {
  return /^[a-z]+:\/\//i.test(url) || url.startsWith('about:') ? url : `https://${url}`
}

// Every page the agent can use, whether it opened it or the site did (a pop-up), is set up here.
// One ref counter for every tab: a ref names one element in the whole browser (reader Refs).
const refCounter = { next: 1 }

// Decoration is not loaded unless a site was allowed to show it.
const skipDecoration = (r: Route) => (DECORATION.has(r.request().resourceType()) && !pictured.has(siteOf(r.request())) ? r.abort() : r.continue())

async function setupTab(session: string, page: Page): Promise<Tab> {
  // Attached, these reach this tab only; a launched browser has them for all its tabs (see main).
  if (ATTACH) {
    await page.route('**/*', skipDecoration)
    await page.addInitScript(PAGE_HOOKS)
  }
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Accessibility.enable')
  await cdp.send('Animation.enable')
  await cdp.send('Animation.setPlaybackRate', { playbackRate: MOTION_RATE })
  const tab: Tab = { id: nextId++, session, page, cdp, refs: newRefs(refCounter), used: Date.now(), doc: 0, shown: new Map(), seen: { map: new Map(), text: new Map() }, pending: new Map(), standing: new Set(), net: [], netId: 0, frames: new Map(), opened: [], downloads: [], saving: [] }
  // A new document can reuse node ids, so old refs are dropped; numbering continues, never reused.
  // Only a new document invalidates node ids. pushState and hash changes (navigatedWithinDocument)
  // keep the same nodes, so refs and the agent's view of the page stay valid.
  await cdp.send('Page.enable')
  cdp.on('Page.frameNavigated', ({ frame }) => {
    if (frame.parentId) return
    tab.doc++
    tab.refs.byNode.clear()
    tab.refs.byRef.clear()
    for (const f of tab.frames.values()) void f.cdp.detach().catch(() => {})
    tab.frames.clear()
  })
  // The status the page itself came with; a refusal (403, 429) is told apart from a page that merely says no.
  page.on('response', r => {
    if (!r.request().isNavigationRequest() || r.frame() !== page.mainFrame()) return
    tab.status = r.status()
    tab.retryAfter = r.headers()['retry-after']
  })
  // Dialogs wait for the agent: an unanswered confirm() is a decision, not something to auto-dismiss.
  page.on('dialog', d => { tab.dialog = d })
  page.on('download', d => {
    tab.saving.push((async () => {
      const dir = join(home(), 'downloads')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${tab.id}-${Date.now()}-${d.suggestedFilename()}`)
      await d.saveAs(file)
      tab.downloads.push({ file, size: statSync(file).size, url: d.url() })
    })().catch(() => {}))
  })
  tabs.set(tab.id, tab)
  track(tab)
  current.set(session, tab.id)
  return tab
}

// Navigations return once the response begins; settle then waits for the document (load.domMs at most).
const COMMIT = () => ({ waitUntil: 'commit' as const, timeout: policy['load.timeoutMs'] })

async function newTab(session: string, url: string): Promise<Tab> {
  const open = new Set([...tabs.values()].map(t => t.session))
  if (!open.has(session) && open.size >= policy['sessions.max']) {
    throw new Error(`${open.size} sessions are open, the most there can be: close the tabs of one (browser-layer --session <name> close <id>) or use a session already open`)
  }
  const tab = await setupTab(session, await ctx.newPage())
  await tab.page.goto(withUrl(url), COMMIT())
  return tab
}

// A page already open in this session is switched to, as a browser's "switch to tab" does (no second copy to
// load and keep track of); any other opens in a new tab.
async function loadTab(session: string, url: string) {
  const open = [...tabs.values()].find(t => t.session === session && pageOf(t.page.url()) === pageOf(new URL(withUrl(url)).href))
  if (open) {
    open.used = Date.now()
    return { tab: open, fresh: false, settled: '', note: 'already open here, so this is that tab (reload loads it again)' }
  }
  const tab = await newTab(session, url)
  const note = await arrive(tab)
  return { tab, fresh: true, settled: unusual(await settle(tab)), note }
}

async function openTab(session: string, url: string): Promise<{ tab: Tab; text: string }> {
  const { tab, fresh, settled, note } = await loadTab(session, url)
  return { tab, text: await mapView(tab, undefined, settled, note, !fresh) }
}

// tab <url…>: the pages load together, as a person opens several tabs and then reads them one by one; each
// answers with its map, and the first is current. One that fails says so and the others still answer.
async function openTabs(session: string, urls: string[]): Promise<string> {
  const results = await Promise.allSettled(urls.map(u => openTab(session, u)))
  const opened = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
  if (!opened.length) throw (results[0] as PromiseRejectedResult).reason
  current.set(session, opened[0].tab.id)
  return results.map((r, i) => r.status === 'fulfilled' ? r.value.text : `${urls[i]}  → error: ${r.reason instanceof Error ? r.reason.message.split('\n')[0] : r.reason}`).join('\n\n')
}

// What an action did: a dialog waiting, a pop-up that opened (it becomes current, answered with its
// map), downloads that finished, then the changed lines.
async function answer(tab: Tab): Promise<string> {
  const settled = await settle(tab)
  if (tab.dialog) {
    const d = tab.dialog
    return `tab ${tab.id}  a ${d.type()} dialog is open: "${d.message()}"${d.type() === 'prompt' ? ` (default "${d.defaultValue()}")` : ''}\nanswer: browser-layer dialog accept [text] | browser-layer dialog dismiss`
  }
  await Promise.race([Promise.all(tab.saving), sleep(policy['load.timeoutMs'])])
  tab.saving = []
  const notes = tab.downloads.splice(0).map(d => `downloaded ${d.file} (${d.size} bytes) from ${d.url}`)
  const popup = tabs.get(tab.opened.splice(0).pop() ?? 0)
  if (popup) {
    await settle(popup)
    return [...notes, `opened tab ${popup.id} (a pop-up of tab ${tab.id}); it is now current`, '', await mapView(popup)].join('\n')
  }
  const body = await changes(tab, settled)
  return notes.length ? `${notes.join('\n')}\n${body}` : body
}

// Input that opens alert/confirm/prompt does not return until the dialog is closed, so the action ends
// when a dialog opens; the agent answers it with the next command.
async function untilDialog(tab: Tab, work: Promise<unknown>) {
  let opened = () => {}
  const dialog = new Promise<void>(r => { opened = r; tab.page.once('dialog', opened) })
  work.catch(() => {})
  try { await Promise.race([work, dialog]) } finally { tab.page.off('dialog', opened) }
}

const pointerAt = (tab: Tab, ref: string | undefined, how: Pointer) => untilDialog(tab, act(tab, ref, t => pointer(t, policy['actions.timeoutMs'], how)))

// explore (DESIGN §4.6): what the page's declared menus and pop-ups hold. Only declared triggers are
// clicked, what appeared is read, and Escape closes it again; plain actions are never clicked.
type Explored = { name: string; items: { name: string; sub?: Explored }[] }
// What a menu holds is its controls, not containers (the menu itself, a list, a region, a canvas).
const isItem = (n: Node) => !COLLECTIONS.has(n.role ?? '') && !LANDMARKS.has(n.role ?? '') && n.role !== 'dialog' && n.role !== 'canvas'
const refsNow = async (tab: Tab) => new Set(withRefs((await snapshot(tab)).tree).map(n => n.ref))

async function openRead(tab: Tab, trigger: Node, depth: number, budget: { opens: number }): Promise<Explored> {
  const before = await refsNow(tab)
  const doc = tab.doc
  budget.opens--
  await pointerAt(tab, String(trigger.ref), {})
  await settle(tab, policy['explore.waitMs'])
  if (tab.doc !== doc || tab.dialog) throw new Error(`opening "${trigger.name}" ${tab.dialog ? 'opened a dialog' : 'left the page'}; explore stopped there`)
  const items = withRefs((await snapshot(tab)).tree).filter(n => !before.has(n.ref) && isItem(n))
  const out: Explored = { name: trigger.name || trigger.role!, items: [] }
  for (const item of items) {
    const sub = depth > 1 && budget.opens > 0 && isTrigger(item) && (await refsNow(tab)).has(item.ref)
      ? await openRead(tab, item, depth - 1, budget) : undefined
    out.items.push({ name: item.name || item.role!, sub })
  }
  // Escape is the standard way to close a menu or pop-up; pressed until what this opened is gone.
  for (let k = 0; k < 3; k++) {
    await tab.page.keyboard.press('Escape')
    await settle(tab, policy['explore.waitMs'])
    const now = await refsNow(tab)
    if (!items.some(i => now.has(i.ref))) break
  }
  return out
}

// A control can be named instead of numbered: the best match by accessible name (exact, then prefix, then
// contained). Several equally good matches are an error that lists them; guessing would act on the wrong one.
// A number is a ref while it is one in this tab; otherwise it may be a control's whole name (a year, a size,
// a page number), never part of one.
const fit = (name: string | undefined, want: string) => {
  const n = (name ?? '').toLowerCase()
  return n === want ? 0 : n.startsWith(want) ? 1 : n.includes(want) ? 2 : 3
}
const ACTIONS = new Set(['click', 'dblclick', 'rightclick', 'hover', 'type', 'pick', 'upload', 'check', 'uncheck', 'submit', 'drag'])

// each --from: the pages are those of records, one each (a record's first address): a list on the page, whose
// records link to their pages, or a file get --urls saved. --limit and --cols choose the records and the column.
async function addresses(c: Command): Promise<string[]> {
  let all: Records
  let what = c.file ?? ''
  if (c.file) {
    if (!existsSync(c.file)) throw new Error(`no such file: ${c.file}`)
    all = fromTsv(readFileSync(c.file, 'utf8'))
  } else {
    const { tree, origin } = await snapshot(need(c.session))
    const node = findRef(tree, Number(c.ref))
    if (!node) throw new Error(`[${c.ref}] is not on the page — run: browser-layer map`)
    all = records(node, origin, { ...caps(), urls: true })
    what = `[${node.ref}] ${node.role}`
  }
  const found = query(all, { limit: c.limit, cols: c.cols }).rows.flatMap(r => r.join('\t').match(/https?:\/\/[^\s]+/) ?? [])
  if (!found.length) throw new Error(`no addresses in ${what}: each goes to the page each record links to (a file needs get --urls)`)
  return [...new Set(found)]
}

// What a command can act on: a box is checked (WAI-ARIA: it has a checked state), a field is typed into. Among
// controls that share a name, the command means those; a click can act on any of them, so it asks which.
const checkable = (n: Node) => !!n.states?.some(s => s === 'checked' || s === 'unchecked' || s === 'mixed')
const TYPED = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'date', 'datetime', 'time', 'color'])
const TAKES: Record<string, (n: Node) => boolean> = { check: checkable, uncheck: checkable, type: n => TYPED.has(n.role ?? '') }

async function refNamed(tab: Tab, target: string | undefined, cmd: string): Promise<string | undefined> {
  if (!target || tab.refs.byRef.has(Number(target))) return target
  const want = target.trim().toLowerCase()
  const number = /^\d+$/.test(want)
  const hits = withRefs((await snapshot(tab)).tree).filter(n => isItem(n) && fit(n.name, want) < (number ? 1 : 3))
  if (number && !hits.length) return target
  const best = hits.filter(n => fit(n.name, want) === Math.min(...hits.map(h => fit(h.name, want))))
  const meant = best.length > 1 && TAKES[cmd] ? best.filter(TAKES[cmd]) : best
  if (meant.length === 1) return String(meant[0].ref)
  if (!best.length) throw new Error(`nothing is named "${target}" — run: browser-layer map`)
  throw new Error(`${best.length} controls are named "${target}"; use a ref: ${best.slice(0, policy['render.mapFew']).map(n => `[${n.ref}] ${n.role} "${n.name}"`).join(' · ')}`)
}

async function navigate(c: Command): Promise<string> {
  const tab = need(c.session)
  await untilDialog(tab, c.cmd === 'back' ? tab.page.goBack(COMMIT()) : c.cmd === 'forward' ? tab.page.goForward(COMMIT()) : tab.page.reload(COMMIT()))
  if (tab.dialog) return answer(tab)
  const note = await arrive(tab)
  return mapView(tab, undefined, unusual(await settle(tab)), note)
}

async function pointing(c: Command): Promise<string> {
  const tab = need(c.session)
  await pointerAt(tab, c.ref, { clicks: c.cmd === 'dblclick' ? 2 : 1, button: c.cmd === 'rightclick' ? 'right' : 'left', move: c.cmd === 'hover' })
  return answer(tab)
}

async function setChecked(c: Command): Promise<string> {
  const tab = need(c.session)
  const want = c.cmd === 'check'
  // Only a box in the other state is clicked, so check and uncheck can be repeated safely.
  if (await isChecked(targetOf(tab, c.ref)) !== want) await pointerAt(tab, c.ref, {})
  const out = await answer(tab)
  return (await isChecked(targetOf(tab, c.ref))) === want ? out : `${out}\nnote: [${c.ref}] is still ${want ? 'unchecked' : 'checked'}`
}

// One function per command: each takes the command and answers with the text the agent reads.
const COMMANDS: Record<string, (c: Command) => Promise<string>> = {
  async tab(c) {
    return openTabs(c.session, c.pages ?? [c.url ?? 'about:blank'])
  },
  async go(c) {
    const tab = need(c.session)
    // A page can ask before it is left (beforeunload): that dialog waits for the agent like any other.
    await untilDialog(tab, tab.page.goto(withUrl(c.url!), COMMIT()))
    if (tab.dialog) return answer(tab)
    const note = await arrive(tab)
    return mapView(tab, undefined, unusual(await settle(tab)), note)
  },
  back: navigate,
  forward: navigate,
  reload: navigate,
  async steps(c) {
    // Several commands in one call, run in order as if sent one by one. A read answers in full, an action
    // in its first line, the last step in full: what the agent planned ahead needs no answer of its own.
    // The first error, dialog or block stops the rest, and the answer ends with the page as it is then.
    const list = c.steps ?? []
    const lines: string[] = []
    for (const [k, s] of list.entries()) {
      s.session = c.session
      const at = `${k + 1}. ${s.raw ?? s.cmd}`
      let text: string
      try {
        text = await limited(s)
      } catch (err) {
        lines.push(`${at}  → error: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
        const tab = tabs.get(current.get(c.session) ?? 0)
        lines.push(`stopped at step ${k + 1} of ${list.length}${tab ? '; the page now:' : ''}`)
        if (tab) lines.push('', await changes(tab))
        return lines.join('\n')
      }
      const stop = / dialog is open: |\nblocked: /.test(text) && k < list.length - 1
      lines.push(k === list.length - 1 || stop || READS.has(s.cmd) || s.cmd === 'eval' ? `${at}\n${text}` : `${at}  → ${text.split('\n')[0]}`)
      if (stop) return [...lines, `stopped at step ${k + 1} of ${list.length}: answer it first`].join('\n')
    }
    return lines.join('\n')
  },
  // each '<read>' <url…>: the pages load together, up to each.concurrency at a time, and the one read runs on
  // each, answering per page; a tab closes as soon as its page is read, so a task over hundreds of pages never
  // holds more than that many. A page that fails is its own entry and the rest carry on. It reads: acting on
  // several pages at once is a decision per page. With --out the file and the answer are the bulk form
  // (render.ts), the same as `open <url…> --out`.
  async each(c) {
    const [read] = c.steps ?? []
    if (!read || !(c.pages?.length || c.ref || c.file)) throw new Error("usage: browser-layer each '<read command>' <url…> | --from <ref|file>")
    if (!READS.has(read.cmd) && read.cmd !== 'eval') throw new Error(`each only reads: ${[...READS, 'eval'].join(', ')}`)
    const was = current.get(c.session)
    const pages = c.pages?.length ? c.pages : await addresses(c)
    const failed = (err: unknown) => `error: ${err instanceof Error ? err.message.split('\n')[0] : err}`
    const results: { head: string; page: Bulk }[] = []
    const entry = (address: string, title: string, text: string): Bulk =>
      text.startsWith('error: ') ? { address, title, text: '', error: text.slice(7) }
        : { address, title, text, error: /^blocked: ([^.\n]+)/m.exec(text)?.[0] }
    // Reads use the session's current tab, so they take turns; loading, the slow part, does not.
    let turn = Promise.resolve()
    let next = 0
    const worker = async () => {
      for (let k = next++; k < pages.length; k = next++) {
        try {
          const l = await loadTab(c.session, pages[k])
          await (turn = turn.then(async () => {
            current.set(c.session, l.tab.id)
            const note = [l.note, l.settled].filter(Boolean).join('; ')
            const text = await limited({ ...read, session: c.session, out: undefined }).catch(failed)
            results[k] = { head: `${await header(l.tab)}${note ? `  (${note})` : ''}`, page: entry(pages[k], await l.tab.page.title().catch(() => ''), text) }
          }))
          if (l.fresh) await l.tab.page.close().catch(() => {})
        } catch (err) { results[k] = { head: pages[k], page: entry(pages[k], '', failed(err)) } }
      }
    }
    await Promise.all(Array.from({ length: Math.min(pages.length, policy['each.concurrency']) }, worker))
    if (was !== undefined && tabs.has(was)) current.set(c.session, was)
    if (!c.out) return results.map(r => `${r.head}\n${r.page.error && !r.page.text ? `error: ${r.page.error}` : r.page.text}`).join('\n\n')
    const all = results.map(r => r.page)
    writeFileSync(c.out, bulkFile(all, policy['save.lineChars']))
    return bulkAnswer('each', all, c.out, policy)
  },
  async tabs(c) {
    // The session's activity map: its tabs, most recently used first.
    const mine = [...tabs.values()].filter(t => t.session === c.session).sort((a, b) => b.used - a.used)
    if (!mine.length) return `no live tabs in session "${c.session}"`
    return (await Promise.all(mine.map(async t =>
      `${t.id === current.get(c.session) ? '*' : ' '} ${t.id}  ${t.page.url()}  "${await t.page.title().catch(() => '')}"  used ${ago(t.used)}`))).join('\n')
  },
  // Agents switch to read: the map comes with map, the text with read.
  async use(c) {
    current.set(c.session, own(c.session, c.id!).id)
    return `${await header(need(c.session))}  — current (map · read)`
  },
  async map(c) {
    return mapView(need(c.session), undefined, '', '', true)
  },
  async get(c) {
    // A file get saved is records as much as a list on a page is, and needs no page.
    if (c.file) {
      if (!existsSync(c.file)) throw new Error(`no such file: ${c.file}`)
      return recordsView(c.file, fromTsv(readFileSync(c.file, 'utf8')), c)
    }
    const tab = need(c.session)
    const { tree, origin } = await within(snapshot(tab), policy['read.timeoutMs'])
    const node = findRef(tree, Number(c.ref))
    if (!node) throw new Error(`[${c.ref}] is not on the page — run: browser-layer map`)
    if (!records(node, origin, caps()).rows.length) throw new Error(`[${c.ref}] has no rows; get works on the lists and tables the map shows`)
    return `${await header(tab)}  — ${c.all ? await recordsAll(tab, node, origin, c) : recordsView(`[${node.ref}] ${node.role}`, records(node, origin, { ...caps(), urls: c.urls }), c)}`
  },
  async read(c) {
    const ref = c.ref === undefined ? undefined : Number(c.ref)
    if (!c.out && (ref !== undefined || c.page)) return view(need(c.session), c.page ?? 1, undefined, ref)
    if (!c.out) return reread(need(c.session), !!c.full)
    const text = await textOf(need(c.session), ref)
    return saved(c.out, text, `${text.split('\n').length} lines, ${text.length} chars`)
  },
  click: pointing,
  dblclick: pointing,
  rightclick: pointing,
  hover: pointing,
  async type(c) {
    const tab = need(c.session)
    // --keys sends one key event per character, for fields that listen to keys rather than input.
    let held: string | null = null
    await act(tab, c.ref, async t => {
      await fill(t, c.keys ? '' : c.text ?? '')
      if (c.keys) await tab.page.keyboard.type(c.text ?? '')
      held = await heldBy(t).catch(() => null)
    })
    // What did not take is said in the same answer, so the agent does not look again to find out: a
    // field that changed what was typed (a mask, a limit), and an Enter that did nothing on the page.
    const words = (s: string) => s.replace(/\s+/g, ' ').trim()
    const notes = held !== null && words(held) !== words(c.text ?? '') ? [`note: [${c.ref}] holds ${JSON.stringify(words(held).slice(0, policy['render.nameChars']))}, not what was typed`] : []
    if (!c.enter) return [await answer(tab), ...notes].join('\n')
    const before = { url: tab.page.url(), doc: tab.doc, text: await tab.page.evaluate('window.__alText?.()').catch(() => -1) }
    await untilDialog(tab, tab.page.keyboard.press('Enter'))
    const out = await answer(tab)
    if (!tab.dialog && tab.doc === before.doc && tab.page.url() === before.url && await tab.page.evaluate('window.__alText?.()').catch(() => -2) === before.text)
      notes.push('note: Enter changed nothing on the page; the form may need its own button (click it by name)')
    return [out, ...notes].join('\n')
  },
  check: setChecked,
  uncheck: setChecked,
  async submit(c) {
    const tab = need(c.session)
    await untilDialog(tab, act(tab, c.ref, submit))
    return answer(tab)
  },
  async drag(c) {
    const tab = need(c.session)
    const to = targetOf(tab, c.to)
    await untilDialog(tab, act(tab, c.ref, from => drag(from, to, policy['actions.timeoutMs'])))
    return answer(tab)
  },
  async find(c) {
    const tab = need(c.session)
    const want = (c.text ?? '').toLowerCase()
    if (!want) throw new Error('usage: browser-layer find <text>')
    const { tree, origin, text } = await snapshot(tab)
    const hits = (c.urls ? renderText(tree, origin, { ...caps(), urls: true }) : text).split('\n').filter(l => l.toLowerCase().includes(want))
    if (!hits.length) return `"${c.text}" is not on the page`
    if (c.out) return saved(c.out, hits.join('\n'), `${hits.length} lines with "${c.text}"`)
    const per = policy['data.rows']
    const page = c.page ?? 1
    const from = (page - 1) * per
    if (from >= hits.length) throw new Error(`page ${page} does not exist; the matches fill ${Math.ceil(hits.length / per)}`)
    const shown = hits.slice(from, from + per)
    const more = from + per < hits.length ? `\n… more: browser-layer find ${c.text} --page ${page + 1}, or --out <file> for all ${hits.length}` : ''
    return `${hits.length} lines with "${c.text}"${hits.length > per ? ` (${from + 1}–${from + shown.length})` : ''}\n\n${shown.join('\n')}${more}`
  },
  async cookies(c) {
    // Cookie values are credentials, so they are never shown; names, sites and expiry are.
    // Attached, the browser holds a person's every site: only the current page's is the agent's to see or clear.
    const site = ATTACH ? new URL(need(c.session).page.url()).hostname : c.url
    if (c.dir === 'clear') {
      await ctx.clearCookies(site ? { domain: site } : undefined)
      return `cleared cookies${site ? ` for ${site}` : ''}`
    }
    const list = (await ctx.cookies()).filter(k => !site || k.domain.replace(/^\./, '').endsWith(site))
    if (!list.length) return 'no cookies'
    return list.map(k => `${k.domain}  ${k.name}  ${k.path}  ${k.expires > 0 ? `until ${new Date(k.expires * 1000).toISOString().slice(0, 10)}` : 'session'}${k.httpOnly ? '  httpOnly' : ''}${k.secure ? '  secure' : ''}`).join('\n')
  },
  async storage(c) {
    const tab = need(c.session)
    if (c.dir !== 'local' && c.dir !== 'session') throw new Error('usage: browser-layer storage local|session [clear]')
    const area = `${c.dir}Storage`
    if (c.text === 'clear') {
      await tab.page.evaluate(`${area}.clear()`)
      return `cleared ${area} for ${new URL(tab.page.url()).origin}`
    }
    const entries = await tab.page.evaluate(`Object.entries(${area})`) as [string, string][]
    if (!entries.length) return `${area} is empty for ${new URL(tab.page.url()).origin}`
    return entries.map(([k, v]) => `${k} = ${v.length > policy['render.nameChars'] ? `${v.slice(0, policy['render.nameChars'] - 1)}…` : v}`).join('\n')
  },
  async pick(c) {
    const tab = need(c.session)
    try {
      await act(tab, c.ref, t => pick(t, c.text ?? ''))
      return answer(tab)
    } catch (err) {
      if (!/not a <select>/.test(String(err))) throw err
    }
    // A custom dropdown (an ARIA combobox or listbox): opened and its option clicked by name, as a person
    // picks one. One already open is not clicked shut. An option that is not there closes it again (Escape)
    // and lists what it offers.
    const listed = async () => {
      const tree = (await snapshot(tab)).tree
      return { open: findRef(tree, Number(c.ref))?.states?.includes('expanded'), options: withRefs(tree).filter(n => n.role === 'option' || n.role === 'menuitemradio' || n.role === 'menuitem') }
    }
    let { open, options } = await listed()
    if (!open || !options.length) {
      await pointerAt(tab, c.ref, {})
      await settle(tab, policy['explore.waitMs'])
      options = (await listed()).options
    }
    const want = (c.text ?? '').trim().toLowerCase()
    const best = options.filter(n => fit(n.name, want) < 3).sort((a, b) => fit(a.name, want) - fit(b.name, want))[0]
    if (!best) {
      await tab.page.keyboard.press('Escape')
      throw new Error(`no option "${c.text}"; options: ${options.slice(0, policy['render.mapFew']).map(o => o.name).join(' | ') || '(none appeared when it opened)'}`)
    }
    await pointerAt(tab, String(best.ref), {})
    return answer(tab)
  },
  async press(c) {
    const tab = need(c.session)
    await untilDialog(tab, tab.page.keyboard.press(c.key!))
    return answer(tab)
  },
  async upload(c) {
    const tab = need(c.session)
    const missing = (c.files ?? []).filter(f => !existsSync(f))
    if (!c.files?.length || missing.length) throw new Error(missing.length ? `no such file: ${missing.join(', ')}` : 'usage: browser-layer upload <ref> <file...>')
    // A file input takes the files directly; any other control is clicked and its file chooser answered.
    await act(tab, c.ref, async t => {
      if (await isFileInput(t)) return setFiles(t, c.files!)
      const chooser = tab.page.waitForEvent('filechooser', { timeout: policy['actions.timeoutMs'] })
      await pointer(t, policy['actions.timeoutMs'])
      await (await chooser).setFiles(c.files!)
    })
    return answer(tab)
  },
  async scroll(c) {
    const tab = need(c.session)
    const dir = c.dir ?? 'down'
    const vp = sizeOf(tab)
    const t = c.ref ? targetOf(tab, c.ref) : undefined
    if (dir === 'down' || dir === 'up') await wheel(t, tab.cdp, (dir === 'down' ? 1 : -1) * vp.height * 0.8, [vp.width, vp.height], policy['actions.timeoutMs'])
    else if (dir === 'top' || dir === 'bottom') {
      const to = `function () { const e = this === window ? document.scrollingElement : this; e.scrollTo(0, ${dir === 'top' ? 0 : 'e.scrollHeight'}) }`
      if (t) await call(t, to)
      else await tab.page.evaluate(`(${to}).call(window)`)
    } else throw new Error(`scroll takes down, up, top or bottom, not "${dir}"`)
    return answer(tab)
  },
  // Emulation belongs to the tab, so it holds across navigations, reads and reloads.
  async viewport(c) {
    const tab = need(c.session)
    const size = /^(\d+)x(\d+)$/.exec(c.text ?? '')
    if (!size && c.text !== 'mobile' && c.text !== 'reset') throw new Error('usage: browser-layer viewport <width>x<height> | mobile | reset')
    const phone = c.text === 'mobile'
    const view = size ? { width: +size[1], height: +size[2], mobile: false } : phone ? { ...PHONE.viewport, mobile: true } : undefined
    // Reset returns to the launch size: clearing the override would fall back to the window, not the policy size.
    await tab.cdp.send('Emulation.setDeviceMetricsOverride', { ...(view ?? sizeOf({})), mobile: !!view?.mobile, deviceScaleFactor: phone ? PHONE.deviceScaleFactor : 1 })
    await tab.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: phone, maxTouchPoints: phone ? 5 : undefined })
    await tab.cdp.send('Emulation.setUserAgentOverride', { userAgent: phone ? PHONE.userAgent : '' })
    tab.view = view
    // The page's layout reacts to the new size (media queries, resize handlers).
    const settled = unusual(await settle(tab))
    return `${await header(tab)}  — ${view ? 'set' : `viewport ${sizeOf(tab).width}x${sizeOf(tab).height} (reset)`}${settled ? `, settled: ${settled}` : ''}`
  },
  async wait(c) {
    const tab = need(c.session)
    if (!c.text) throw new Error('usage: browser-layer wait [--gone] <text>')
    const end = Date.now() + policy['wait.timeoutMs']
    // Matched as find matches: letter case and runs of whitespace do not matter.
    const plain = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
    while (plain((await snapshot(tab)).text).includes(plain(c.text)) === !!c.gone) {
      if (Date.now() > end) throw new Error(`"${c.text}" ${c.gone ? 'is still on the page' : 'did not appear'} after ${policy['wait.timeoutMs']} ms`)
      await sleep(250)
    }
    return answer(tab)
  },
  async dialog(c) {
    const tab = need(c.session)
    const d = tab.dialog
    if (!d) throw new Error('no dialog is open')
    tab.dialog = undefined
    if (c.dir === 'accept') await d.accept(c.text)
    else if (c.dir === 'dismiss') await d.dismiss()
    else throw new Error('usage: browser-layer dialog accept [text] | dismiss')
    return answer(tab)
  },
  async explore(c) {
    const tab = need(c.session)
    const { tree } = await snapshot(tab)
    const scope = c.ref ? findRef(tree, Number(c.ref)) : tree
    if (!scope) throw new Error(`[${c.ref}] is not on the page — run: browser-layer map`)
    const triggers = (isTrigger(scope) ? [scope] : withRefs(scope).filter(isTrigger))
    if (!triggers.length) return 'nothing here declares a menu or pop-up (aria-haspopup / aria-expanded)'
    const budget = { opens: policy['explore.max'] }
    const lines: string[] = []
    const print = (e: Explored, path: string) => {
      lines.push(`${path} ▸ ${e.items.map(i => (i.sub ? `${i.name} ▸` : i.name)).join(' · ') || '(nothing appeared)'}`)
      for (const i of e.items) if (i.sub) print(i.sub, `${path} > ${i.name}`)
    }
    for (const t of triggers) {
      if (budget.opens <= 0) { lines.push(`… stopped after ${policy['explore.max']} opens (explore <ref> looks at one)`); break }
      const e = await openRead(tab, t, policy['explore.depth'], budget)
      print(e, `[${t.ref}] ${e.name}`)
    }
    return `${await header(tab)}  — ${triggers.length} declared menus and pop-ups, each opened, read and closed\n\n${lines.join('\n')}\n\n(menu "A > B > C" runs one by name)`
  },
  async menu(c) {
    // A path of names: each step is clicked, then looked for among what the previous step opened.
    const tab = need(c.session)
    const steps = (c.text ?? '').split('>').map(s => s.trim().toLowerCase()).filter(Boolean)
    if (!steps.length) throw new Error('usage: browser-layer menu "File > Download > CSV"')
    for (const [k, step] of steps.entries()) {
      // Best name match first; among equals, the newest control (the menu just opened) after step one.
      const hits = withRefs((await snapshot(tab)).tree)
        .filter(n => isItem(n) && !n.states?.includes('disabled') && fit(n.name, step) < 3)
        .sort((a, b) => fit(a.name, step) - fit(b.name, step) || (k ? b.ref! - a.ref! : a.ref! - b.ref!))
      if (!hits.length) throw new Error(`nothing named "${step}"${k ? ` after "${steps.slice(0, k).join(' > ')}"` : ''} — explore lists what menus hold`)
      await pointerAt(tab, String(hits[0].ref), {})
      if (k < steps.length - 1) await settle(tab, policy['explore.waitMs'])
    }
    return answer(tab)
  },
  async allow(c) {
    // Permissions are denied unless the agent grants them, per site: `allow geolocation 19.07,72.87`.
    const tab = need(c.session)
    const perms = (c.text ?? '').split(',').filter(Boolean)
    if (!perms.length) throw new Error('usage: browser-layer allow <permission>[,permission] [latitude,longitude]')
    const origin = new URL(tab.page.url()).origin
    // `images` is not a browser permission: it lets the site's pages load their decoration (DECORATION),
    // for content that is only pictures (a scanned book, a map, a video) or a page that will not work without.
    if (perms.includes('images')) pictured.add(origin)
    const granted = perms.filter(p => p !== 'images')
    if (ATTACH && (granted.length || c.dir)) throw new Error("allow cannot change a person's own browser; only allow images")
    if (granted.length) await ctx.grantPermissions(granted, { origin })
    if (c.dir) {
      const [latitude, longitude] = c.dir.split(',').map(Number)
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error(`expected latitude,longitude, got "${c.dir}"`)
      await ctx.setGeolocation({ latitude, longitude })
    }
    return `allowed ${perms.join(', ')} for ${origin}${c.dir ? ` at ${c.dir}` : ''}${perms.includes('images') ? ' (reload to load them)' : ''}`
  },
  async screenshot(c) {
    // A picture for a person (or a judge): the agent reads the page as text. Images and fonts are
    // never loaded (DECORATION), so it shows the page without them. A ref pictures just its box, in
    // page coordinates so a region taller than the window comes out whole.
    const tab = need(c.session)
    let clip: { x: number; y: number; width: number; height: number } | undefined
    if (c.ref !== undefined) await act(tab, c.ref, async t => {
      const { model } = await t.cdp.send('DOM.getBoxModel', { backendNodeId: t.id })
      const [left, top, right, , , bottom] = model.border
      if (right <= left || bottom <= top) throw new Error('it has no box on the page (hidden or not rendered)')
      const [ox, oy] = await t.offset()
      const [sx, sy] = (await tab.page.evaluate('[scrollX, scrollY]')) as [number, number]
      clip = { x: left + ox + sx, y: top + oy + sy, width: right - left, height: bottom - top }
    })
    const height = c.full && !clip ? (await tab.page.evaluate('document.documentElement.scrollHeight')) as number : 0
    if (height > SHOT_MAX_PX) clip = { x: 0, y: 0, width: sizeOf(tab).width, height: SHOT_MAX_PX }
    await tab.page.screenshot({ path: c.files![0], fullPage: !!c.full || !!clip, clip })
    return `saved ${c.files![0]}${height > SHOT_MAX_PX ? ` (the first ${SHOT_MAX_PX} px of ${height})` : ''}`
  },
  async eval(c) {
    const tab = need(c.session)
    const { result, exceptionDetails } = await tab.cdp.send('Runtime.evaluate', { expression: c.text ?? '', awaitPromise: true, returnByValue: true, replMode: true })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text)
    return result.value === undefined ? String(result.description ?? 'undefined') : JSON.stringify(result.value)
  },
  async net(c) {
    const tab = need(c.session)
    if (c.id !== undefined) {
      // One request in full: what an agent needs to call the same API itself.
      const r = tab.net.find(n => n.id === c.id)
      if (!r) throw new Error(`no request #${c.id} — run: browser-layer net`)
      const res = await r.request.response().catch(() => null)
      const body = r.body ?? await res?.body().catch(() => undefined)
      // The whole answer goes to a file, where the agent's own tools (jq, a script) read it.
      if (c.files) {
        if (!body) throw new Error(`#${r.id} has no body the browser still holds`)
        writeFileSync(c.files[0], /json/.test(r.type) ? bounded(body.toString('utf8'), policy['save.lineChars']) : body)
        return `saved ${c.files[0]} (${body.length} bytes, ${r.type || 'unknown type'})`
      }
      const text = body?.toString('utf8')
      const shown = text && printable(text, policy['network.bodyChars'])!
      return [`#${r.id} ${r.method} ${r.url}`, 'request headers:', headerLines(await r.request.allHeaders()),
        ...(r.request.postData() ? ['request body:', printable(r.request.postData(), policy['network.bodyChars'])!] : []),
        `response: ${r.status} ${r.type}`, headerLines((await res?.allHeaders()) ?? {}),
        ...(shown ? ['response body:', shown.replace(/ more chars\)$/, ` more chars: browser-layer net save ${r.id} <file> writes it all)`)]
          : r.kind === 'document' ? [] : ['response body: no longer held by the browser']),
      ].join('\n')
    }
    const list = c.all ? tab.net : tab.net.filter(r => (r.kind !== 'document' || r.method !== 'GET') && !noise(r))
    if (!list.length) return 'no requests yet'
    return list.slice(-40).map(r => {
      const u = new URL(r.url)
      const where = u.origin === new URL(tab.page.url()).origin ? `${u.pathname}${u.search}` : `${u.host}${u.pathname}${u.search}`
      return `#${String(r.id).padEnd(4)} ${r.method.padEnd(6)} ${String(r.status).padEnd(4)} ${where.slice(0, 120)}  ${r.type}${r.post ? `\n      body: ${r.post}` : ''}`
    }).join('\n') + '\n(net show <#> for headers and bodies)'
  },
  async close(c) {
    if (c.all) {
      const mine = [...tabs.values()].filter(t => t.session === c.session)
      await Promise.all(mine.map(t => t.page.close()))
      return `closed ${mine.length} tab${mine.length === 1 ? '' : 's'} of session "${c.session}"`
    }
    const tab = c.id ? own(c.session, c.id) : need(c.session)
    await tab.page.close()
    const now = current.get(c.session)
    return now ? `closed tab ${tab.id}; now on tab ${now}` : `closed tab ${tab.id}; no live tabs left in session "${c.session}"`
  },
  // Where the agent stands, for one that lost its context: the session's tabs, the addresses it let go of, the files it
  // saved (an unfinished `get --all` says so) and its last calls.
  async status(c) {
    const s = kept.sessions[c.session]
    const files = (savedFiles().get(c.session) ?? []).slice(0, policy['status.files'])
    const size = (n: number) => (n < 1000 ? `${n} B` : n < 1e6 ? `${Math.round(n / 1000)} KB` : `${(n / 1e6).toFixed(1)} MB`)
    return [
      `tabs:\n${await COMMANDS.tabs(c)}`,
      ...(s?.gone.length ? [`closed (tab <address> opens one again):\n${s.gone.map(u => `  ${u}`).join('\n')}`] : []),
      ...(files.length ? [`files:\n${files.map(f => `  ${f}  ${size(statSync(f).size)}${existsSync(`${f}.unfinished`) ? '  unfinished: run the same get --all again' : ''}`).join('\n')}`] : []),
      ...(s?.calls.length ? [`calls:\n${s.calls.map(l => `  ${l}`).join('\n')}`] : []),
    ].join('\n')
  },
  async state(c) {
    return JSON.stringify([...tabs.values()].map(t => ({ session: t.session, url: t.page.url(), current: current.get(t.session) === t.id })))
  },
  async ping(c) {
    return 'ok'
  },
}

// A session nobody has used for a while still holds its tabs and its slot of sessions.max. Another session's
// command is the moment to let them go; with no command there is no one to care, and the daemon's own idle exit comes.
async function dropIdle(running: string) {
  const lastUse = new Map<string, number>()
  for (const t of tabs.values()) lastUse.set(t.session, Math.max(lastUse.get(t.session) ?? 0, t.used))
  const stale = [...lastUse].filter(([s, used]) => s !== running && Date.now() - used > policy['sessions.idleMs']).map(([s]) => s)
  await Promise.all([...tabs.values()].filter(t => stale.includes(t.session)).map(letGo))
}

async function run(c: Command): Promise<string> {
  await dropIdle(c.session)
  beginCommand(c.session)
  if (ACTIONS.has(c.cmd)) {
    const tab = need(c.session)
    c.ref = await refNamed(tab, c.ref, c.cmd)
    c.to = await refNamed(tab, c.to, c.cmd)
  }
  if (!Object.hasOwn(COMMANDS, c.cmd)) throw new Error(`unknown command ${c.cmd}`)
  return COMMANDS[c.cmd](c)
}

// An action that failed still leaves a page to act on. What changed on it since the agent's last view comes with the
// error, as a failed step of `steps` gives it, so the agent does not spend a call looking; nothing when nothing changed.
async function pageNow(session: string): Promise<string> {
  const tab = tabs.get(current.get(session) ?? 0)
  const now = tab ? await within(changes(tab), policy['read.timeoutMs']).catch(() => '') : ''
  return now && !/ — no visible change/.test(now.split('\n')[0]) ? `\nthe page now:\n${now}` : ''
}

// What each session last did and was told. An agent that repeats a call and gets the same answer is not
// getting anywhere, and it cannot see that from one answer; the tool can. Reads and batches repeat legitimately.
const history = new Map<string, string[]>()
function repeated(c: Command, text: string): string {
  if (READS.has(c.cmd) || c.cmd === 'steps' || c.cmd === 'wait') return text
  const log = history.get(c.session) ?? []
  // How long settling took differs on every call, so it is not part of "the same answer".
  const seen = `${JSON.stringify({ ...c, version: undefined })}\n${text.replace(/\d+ ms/g, '')}`
  const k = log.lastIndexOf(seen)
  const ago = log.length - k
  history.set(c.session, [...log, seen].slice(-10))
  if (k < 0) return text
  return `${text}\nnote: the same call gave this same answer ${ago} call${ago === 1 ? '' : 's'} ago; repeating it again changes nothing`
}

// A page whose renderer stopped answering (a script that never returns) would hold every later command
// behind it; the command fails instead, and other tabs carry on. Reading the page takes seconds at most, so
// a read gives up sooner than a command that loads a page. Each of a call's steps has its own limit.
const within = <T>(work: Promise<T>, limit: number) => Promise.race([work, new Promise<never>((_, fail) => setTimeout(() => fail(new Error(
  `the page did not answer in ${limit / 1000} s; it may be stuck: browser-layer close it and open it again`)), limit))])
const limited = (c: Command) => within(run(c), policy[READS.has(c.cmd) ? 'read.timeoutMs' : 'command.timeoutMs'])

// A Unix socket is a file left behind on exit; a Windows named pipe goes away with its server.
const dropSocket = () => { if (process.platform !== 'win32') rmSync(socketPath(), { force: true }) }

// Attached, only the tabs the daemon opened close, and the person's Chrome keeps running.
async function release() {
  if (!browser) return ctx.close().catch(() => {})
  await Promise.all([...tabs.values()].map(t => t.page.close().catch(() => {})))
  await browser.close().catch(() => {})
}

async function main() {
  // A second daemon would steal the socket and orphan the first one's tabs.
  if (await ping()) {
    console.log('another daemon already answers on the socket; exiting')
    process.exit(0)
  }
  policy = loadPolicy()
  if (ATTACH) {
    // Chrome asks the person to click Allow on every new connection, and a connection that gives up while the popup is
    // open would only raise another: there is no deadline, and a daemon that is turned down exits.
    console.log('connecting; Chrome may be asking the person to allow remote debugging')
    browser = await chromium.connectOverCDP(ATTACH, { timeout: 0 }).catch(err => {
      console.error(`cannot attach to ${ATTACH}: ${err.message.split('\n')[0]}`)
      return process.exit(1)
    })
    ctx = browser.contexts()[0]
  } else {
    const found = await findBrowser()
    if ('error' in found) {
      console.error(found.error)
      process.exit(1)
    }
    const visible = process.env.BROWSER_LAYER_VISIBLE === '1'
    ctx = await chromium.launchPersistentContext(join(home(), 'profile'), {
      executablePath: found.path,
      // Headless always, except a browser `browser-layer show` started for a person to watch. Nothing is
      // remembered: the next browser after this one is headless again.
      headless: !visible,
      viewport: { width: policy['viewport.width'], height: policy['viewport.height'] },
      reducedMotion: 'reduce',
    })
    await ctx.route('**/*', skipDecoration)
    await ctx.addInitScript(PAGE_HOOKS)
    // A visible Chrome quits when its last window closes, so it keeps the blank tab it started with.
    if (!visible) for (const p of ctx.pages()) await p.close()
  }
  // A page a site opens (window.open, target=_blank, an OAuth pop-up) joins its opener's session.
  ctx.on('page', async page => {
    const opener = await page.opener()
    const parent = [...tabs.values()].find(t => t.page === opener)
    if (!parent) return
    const tab = await setupTab(parent.session, page)
    parent.opened.push(tab.id)
  })

  trimSaved(policy['status.files'])
  if (!ATTACH) await restore()

  const queues = new Map<string, Promise<void>>()
  let idle: NodeJS.Timeout
  // `stop` answers only after Chrome has exited, so a caller can safely delete the profile next.
  let stopping = false
  const shutdown = async (reply?: (text: string) => void) => {
    stopping = true
    server.close()
    await release()
    dropSocket()
    if (reply) reply('stopped')
    else process.exit(0)
  }
  // Attached, the one connection (and the one popup it cost the person) stays until Chrome goes or `stop`.
  const touch = () => { clearTimeout(idle); if (!ATTACH) idle = setTimeout(() => void shutdown(), policy['daemon.idleMs']) }
  // The browser went away on its own (a person closed the visible window, Chrome crashed): a daemon
  // without a browser can only fail, so it exits and the next command starts a fresh one.
  ctx.on('close', () => {
    if (stopping) return
    dropSocket()
    process.exit(0)
  })

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      touch()
      let c: Command
      try {
        c = JSON.parse(body || '{}') as Command
      } catch {
        res.end(JSON.stringify({ ok: false, error: 'the daemon could not read that request' }))
        return
      }
      if (c.cmd === 'stop') {
        void shutdown(text => { forgetKept(); res.end(JSON.stringify({ ok: true, text }), () => process.exit(0)) })
        return
      }
      // The CLI was updated under a running daemon: this one's code is old, so it exits and the CLI starts
      // its own. (A ping carries no version.)
      if (c.version && c.version !== VERSION) {
        void shutdown(() => res.end(JSON.stringify({ ok: false, stale: true }), () => process.exit(0)))
        return
      }
      // One command at a time per session, as in a browser one person clicks one thing at a time: two commands
      // into the same tabs would race. Sessions own their tabs, so they run side by side.
      c.session ||= 'default'
      queues.set(c.session, (queues.get(c.session) ?? Promise.resolve()).then(async () => {
        try {
          await pullCookies()
          const answer = await (c.cmd === 'steps' || c.cmd === 'each' || (c.cmd === 'get' && c.all) ? run(c) : limited(c)) + await limitTabs(c.session)
          logCall(c, answer)
          const text = ceiling(repeated(c, answer), policy)
          await syncCookies().catch(() => {})
          res.end(JSON.stringify({ ok: true, text }))
        } catch (err) {
          const error = err instanceof Error ? err.message.split('\n')[0] : String(err)
          logCall(c, `error: ${error}`)
          res.end(JSON.stringify({ ok: false, error: ACTIONS.has(c.cmd) && !/did not answer in/.test(error) ? error + await pageNow(c.session) : error }))
        }
        if (!stopping) persist()
      }))
    })
  })
  dropSocket()
  server.on('error', async err => {
    console.error(`cannot listen on ${socketPath()}: ${err.message}`)
    await release()
    process.exit(1)
  })
  server.listen(socketPath(), () => {
    // A named pipe (Windows) has no file mode; its default ACL lets only this user, SYSTEM and
    // administrators write to it, so no other account can send it commands.
    if (process.platform !== 'win32') chmodSync(socketPath(), 0o600)
    rmSync(pidPath(), { force: true }) // listening: the pid file's job, telling the CLI a daemon is still starting, is over
    touch()
    console.log(`browser-layer daemon on ${socketPath()}`)
  })
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
