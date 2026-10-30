// The background process that keeps live tabs alive between CLI calls.
// It owns one headless Chrome, a persistent profile, and a socket the CLI talks to.
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type CDPSession, type Dialog, type Page, type Request } from 'playwright-core'
import { isTracker } from './trackers.js'
import { home, loadJar, saveJar, type Cookie } from './session.js'
import { newRefs, readTree, type Refs } from './reader.js'
import { diffLines, findRef, paginate, renderMap, renderText } from './render.js'
import { call, fill, isFileInput, pick, pointer, setFiles, wheel, type Pointer, type Target } from './act.js'
import { query, records, toTsv, type Query } from './data.js'
import { ping, socketPath } from './client.js'
import { loadPolicy, type Policy } from './policy.js'

// Decoration the agent never needs; DESIGN §1 principle 3. Never requested.
const DECORATION = new Set(['image', 'font', 'media'])
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

type Req = { id: number; method: string; url: string; status: number; type: string; kind: string; post?: string; request: Request }
// shown: the last full text the agent received per context (the page, or a modal dialog by name), so
// actions answer with what changed even when a dialog opens over the page and closes again.
// frames: cross-origin frames with their own engine session, and the iframe element that owns each.
// dialog: an alert/confirm/prompt waiting for the agent. opened: pop-ups since the last answer.
type Frame = { cdp: CDPSession; owner: { scope: string; id: number } }
type Tab = {
  id: number; session: string; page: Page; cdp: CDPSession; refs: Refs; doc: number; shown: Map<string, { doc: number; text: string }>
  inflight: number; net: Req[]; netId: number; frames: Map<string, Frame>; dialog?: Dialog; opened: number[]
  downloads: { file: string; size: number; url: string }[]; saving: Promise<void>[]
}
export type Command = {
  cmd: string; session: string; url?: string; ref?: string; text?: string; key?: string; id?: number; enter?: boolean; all?: boolean
  page?: number; files?: string[]; dir?: string; gone?: boolean
} & Query

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
    if (kind !== 'document' && kind !== 'xhr' && kind !== 'fetch' && kind !== 'ping') return
    const res = await r.response().catch(() => null)
    tab.net.push({
      id: ++tab.netId,
      method: r.method(),
      url: r.url(),
      status: res?.status() ?? 0,
      type: (res?.headers()['content-type'] ?? '').split(';')[0],
      kind,
      post: printable(r.postData(), 300)?.replace(/\s+/g, ' '),
      request: r,
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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Settled when no request is in flight and the DOM has been quiet for settle.quietMs; or a dialog is
// waiting (the page is blocked until it is answered); or the deadline passes. Says which.
async function settle(tab: Tab): Promise<string> {
  const start = Date.now()
  await tab.page.waitForLoadState('domcontentloaded', { timeout: policy['load.timeoutMs'] }).catch(() => {})
  let last = -1
  let quietSince = Date.now()
  while (Date.now() - start < policy['settle.deadlineMs']) {
    if (tab.dialog) return 'dialog'
    // A dialog opening mid-read blocks page scripts, so the read is bounded.
    const muts = await Promise.race([tab.page.evaluate(() => (window as unknown as { __alMut?: number }).__alMut ?? 0).catch(() => -2), sleep(500).then(() => -3)])
    if (muts !== last || tab.inflight > 0) { last = muts; quietSince = Date.now() }
    else if (Date.now() - quietSince >= policy['settle.quietMs']) return `idle in ${Date.now() - start} ms`
    await sleep(100)
  }
  return `deadline ${policy['settle.deadlineMs']} ms (the page kept changing)`
}

const caps = () => ({ nameChars: policy['render.nameChars'], labelChars: policy['render.labelChars'] })

// One read of the page: the tree and its full text.
async function snapshot(tab: Tab) {
  const tree = await readTree(tab.cdp, tab.refs, { minRepeats: policy['data.minRepeats'], minParts: policy['data.minParts'] }, (id, owner) => frameSession(tab, id, owner))
  const origin = new URL(tab.page.url()).origin
  return { tree, origin, text: renderText(tree, origin, caps()) }
}

// The full text of what the agent has been shown last, per context; later actions diff against it.
const remember = (tab: Tab, text: string) => tab.shown.set(contextOf(text), { doc: tab.doc, text })

const header = async (tab: Tab) => {
  const title = await tab.page.title()
  return `tab ${tab.id}  ${tab.page.url()}${title ? `  "${title}"` : ''}`
}

// Opening a page answers with its map (DESIGN §1a); read and read <ref> go deeper.
async function mapView(tab: Tab, snap?: Awaited<ReturnType<typeof snapshot>>, settled = ''): Promise<string> {
  const { tree, origin, text } = snap ?? await snapshot(tab)
  remember(tab, text)
  const map = renderMap(tree, origin, caps(), policy['render.mapFew'])
  return `${await header(tab)}${settled ? `  — settled: ${settled}` : ''}\n\n${map}\n\n(read <ref> opens a region · read gives the whole page)`
}

async function view(tab: Tab, page = 1, text?: string, ref?: number): Promise<string> {
  if (text === undefined) {
    const snap = await snapshot(tab)
    text = snap.text
    if (ref === undefined) remember(tab, text)
    else {
      const node = findRef(snap.tree, ref)
      if (!node) throw new Error(`[${ref}] is not on the page — run: agent-layer map`)
      text = renderText({ block: true, children: [node] }, snap.origin, caps())
    }
  }
  const truncated = text.length > policy['render.maxChars']
  if (truncated) text = text.slice(0, text.lastIndexOf('\n', policy['render.maxChars']))
  const pages = paginate(text, policy['render.pageChars'])
  if (page < 1 || page > pages.length) throw new Error(`page ${page} does not exist; this view has ${pages.length}`)
  const head = `${await header(tab)}${pages.length > 1 ? `  (page ${page} of ${pages.length})` : ''}`
  const more = page < pages.length ? `\n… more below: agent-layer read${ref === undefined ? '' : ` ${ref}`} --page ${page + 1}` : ''
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

// After an action the agent already holds the page, so it gets the lines that changed: the complete
// answer to what the action did. A new document is answered with its map, as opening one is.
const contextOf = (text: string) => (/^\[\d+\] dialog/.test(text) ? text.slice(0, text.indexOf('\n') >>> 0) : 'page')

async function changes(tab: Tab, settled = ''): Promise<string> {
  const snap = await snapshot(tab)
  const before = tab.shown.get(contextOf(snap.text))
  if (!before || before.doc !== tab.doc) return mapView(tab, snap, settled)
  const { removed, added } = diffLines(before.text.split('\n'), snap.text.split('\n'))
  const size = [...removed, ...added].reduce((n, l) => n + l.length + 3, 0)
  // Changed lines longer than the page itself: the page was replaced. Like a new view, it is answered
  // with the shorter of its whole text (a small page) and its map (a large one).
  if (size > snap.text.length) {
    if (snap.text.length > renderMap(snap.tree, snap.origin, caps(), policy['render.mapFew']).length) return mapView(tab, snap, settled)
    remember(tab, snap.text)
    return `${await header(tab)}  — the whole page changed${settled ? `, settled: ${settled}` : ''}\n\n${snap.text}`
  }
  remember(tab, snap.text)
  const head = `tab ${tab.id}  ${tab.page.url()}  — ${removed.length + added.length ? `${removed.length} lines gone, ${added.length} new` : 'no visible change'}${settled ? `, settled: ${settled}` : ''} (full page: agent-layer read)`
  return [head, '', ...removed.map(l => `- ${l}`), ...added.map(l => `+ ${l}`)].join('\n').trimEnd()
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
  if (!at) throw new Error(`[${ref}] is not on the page — run: agent-layer read`)
  const cdp = at.scope ? tab.frames.get(at.scope)?.cdp : tab.cdp
  if (!cdp) throw new Error(`[${ref}] is in a frame that is gone — run: agent-layer read`)
  return { cdp, page: tab.cdp, id: at.id, offset: () => offsetOf(tab, at.scope) }
}

// A ref whose node is gone (re-rendered, navigated away) fails here with the same advice.
async function act(tab: Tab, ref: string | undefined, fn: (t: Target) => Promise<void>) {
  const t = targetOf(tab, ref)
  try {
    await fn(t)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(/No node with given id|Could not find node/i.test(msg) ? `[${ref}] is not on the page — run: agent-layer read` : `cannot act on [${ref}]: ${msg}`)
  }
}

function withUrl(url: string) {
  return /^[a-z]+:\/\//i.test(url) || url.startsWith('about:') ? url : `https://${url}`
}

// Every page the agent can use, whether it opened it or the site did (a pop-up), is set up here.
async function setupTab(session: string, page: Page): Promise<Tab> {
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Accessibility.enable')
  await cdp.send('Animation.enable')
  await cdp.send('Animation.setPlaybackRate', { playbackRate: MOTION_RATE })
  const tab: Tab = { id: nextId++, session, page, cdp, refs: newRefs(), doc: 0, shown: new Map(), inflight: 0, net: [], netId: 0, frames: new Map(), opened: [], downloads: [], saving: [] }
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

async function newTab(session: string, url: string): Promise<Tab> {
  const tab = await setupTab(session, await ctx.newPage())
  await tab.page.goto(withUrl(url), { waitUntil: 'domcontentloaded', timeout: policy['load.timeoutMs'] })
  return tab
}

// What an action did: a dialog waiting, a pop-up that opened (it becomes current, answered with its
// map), downloads that finished, then the changed lines.
async function answer(tab: Tab): Promise<string> {
  const settled = await settle(tab)
  if (tab.dialog) {
    const d = tab.dialog
    return `tab ${tab.id}  a ${d.type()} dialog is open: "${d.message()}"${d.type() === 'prompt' ? ` (default "${d.defaultValue()}")` : ''}\nanswer: agent-layer dialog accept [text] | agent-layer dialog dismiss`
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

const pointerAt = (tab: Tab, c: Command, how: Pointer) => untilDialog(tab, act(tab, c.ref, t => pointer(t, policy['actions.timeoutMs'], how)))

async function run(c: Command): Promise<string> {
  switch (c.cmd) {
    case 'tab': {
      const tab = await newTab(c.session, c.url ?? 'about:blank')
      await settle(tab)
      return mapView(tab)
    }
    case 'go': {
      const tab = need(c.session)
      await tab.page.goto(withUrl(c.url!), { waitUntil: 'domcontentloaded', timeout: policy['load.timeoutMs'] })
      await settle(tab)
      return mapView(tab)
    }
    case 'back':
    case 'forward':
    case 'reload': {
      const tab = need(c.session)
      const opts = { waitUntil: 'domcontentloaded' as const, timeout: policy['load.timeoutMs'] }
      await (c.cmd === 'back' ? tab.page.goBack(opts) : c.cmd === 'forward' ? tab.page.goForward(opts) : tab.page.reload(opts))
      await settle(tab)
      return mapView(tab)
    }
    case 'tabs': {
      const mine = [...tabs.values()].filter(t => t.session === c.session)
      if (!mine.length) return `no live tabs in session "${c.session}"`
      return (await Promise.all(mine.map(async t =>
        `${t.id === current.get(c.session) ? '*' : ' '} ${t.id}  ${t.page.url()}  "${await t.page.title().catch(() => '')}"`))).join('\n')
    }
    case 'use': {
      current.set(c.session, own(c.session, c.id!).id)
      return mapView(need(c.session))
    }
    case 'map':
      return mapView(need(c.session))
    case 'get': {
      const tab = need(c.session)
      const { tree, origin } = await snapshot(tab)
      const node = findRef(tree, Number(c.ref))
      if (!node) throw new Error(`[${c.ref}] is not on the page — run: agent-layer map`)
      const all = records(node, origin, caps())
      if (!all.rows.length) throw new Error(`[${c.ref}] has no rows; get works on the lists and tables the map shows`)
      const limit = c.limit ?? policy['data.rows']
      const out = query(all, { ...c, limit })
      const what = [c.sort ? `sorted by ${c.sort}${c.desc ? ' descending' : ''}` : '', out.rows.length < all.rows.length ? `first ${out.rows.length}` : ''].filter(Boolean).join(', ')
      const head = `${await header(tab)}  — [${c.ref}] ${node.role}: ${all.rows.length} records, ${all.columns.length} columns${what ? ` (${what})` : ''}`
      return `${head}\n\n${toTsv(out)}`
    }
    case 'read':
      return view(need(c.session), c.page ?? 1, undefined, c.ref === undefined ? undefined : Number(c.ref))
    case 'click':
    case 'dblclick':
    case 'rightclick':
    case 'hover': {
      const tab = need(c.session)
      await pointerAt(tab, c, { clicks: c.cmd === 'dblclick' ? 2 : 1, button: c.cmd === 'rightclick' ? 'right' : 'left', move: c.cmd === 'hover' })
      return answer(tab)
    }
    case 'type': {
      const tab = need(c.session)
      await act(tab, c.ref, t => fill(t, c.text ?? ''))
      if (c.enter) await untilDialog(tab, tab.page.keyboard.press('Enter'))
      return answer(tab)
    }
    case 'pick': {
      const tab = need(c.session)
      await act(tab, c.ref, t => pick(t, c.text ?? ''))
      return answer(tab)
    }
    case 'press': {
      const tab = need(c.session)
      await untilDialog(tab, tab.page.keyboard.press(c.key!))
      return answer(tab)
    }
    case 'upload': {
      const tab = need(c.session)
      const missing = (c.files ?? []).filter(f => !existsSync(f))
      if (!c.files?.length || missing.length) throw new Error(missing.length ? `no such file: ${missing.join(', ')}` : 'usage: agent-layer upload <ref> <file...>')
      // A file input takes the files directly; any other control is clicked and its file chooser answered.
      await act(tab, c.ref, async t => {
        if (await isFileInput(t)) return setFiles(t, c.files!)
        const chooser = tab.page.waitForEvent('filechooser', { timeout: policy['actions.timeoutMs'] })
        await pointer(t, policy['actions.timeoutMs'])
        await (await chooser).setFiles(c.files!)
      })
      return answer(tab)
    }
    case 'scroll': {
      const tab = need(c.session)
      const dir = c.dir ?? 'down'
      const vp = tab.page.viewportSize() ?? { width: policy['viewport.width'], height: policy['viewport.height'] }
      const t = c.ref ? targetOf(tab, c.ref) : undefined
      if (dir === 'down' || dir === 'up') await wheel(t, tab.cdp, (dir === 'down' ? 1 : -1) * vp.height * 0.8, [vp.width, vp.height], policy['actions.timeoutMs'])
      else if (dir === 'top' || dir === 'bottom') {
        const to = `function () { const e = this === window ? document.scrollingElement : this; e.scrollTo(0, ${dir === 'top' ? 0 : 'e.scrollHeight'}) }`
        if (t) await call(t, to)
        else await tab.page.evaluate(`(${to}).call(window)`)
      } else throw new Error(`scroll takes down, up, top or bottom, not "${dir}"`)
      return answer(tab)
    }
    case 'wait': {
      const tab = need(c.session)
      if (!c.text) throw new Error('usage: agent-layer wait [--gone] <text>')
      const end = Date.now() + policy['wait.timeoutMs']
      while (((await snapshot(tab)).text.includes(c.text)) === !!c.gone) {
        if (Date.now() > end) throw new Error(`"${c.text}" ${c.gone ? 'is still on the page' : 'did not appear'} after ${policy['wait.timeoutMs']} ms`)
        await sleep(250)
      }
      return answer(tab)
    }
    case 'dialog': {
      const tab = need(c.session)
      const d = tab.dialog
      if (!d) throw new Error('no dialog is open')
      tab.dialog = undefined
      if (c.dir === 'accept') await d.accept(c.text)
      else if (c.dir === 'dismiss') await d.dismiss()
      else throw new Error('usage: agent-layer dialog accept [text] | dismiss')
      return answer(tab)
    }
    case 'allow': {
      // Permissions are denied unless the agent grants them, per site: `allow geolocation 19.07,72.87`.
      const tab = need(c.session)
      const perms = (c.text ?? '').split(',').filter(Boolean)
      if (!perms.length) throw new Error('usage: agent-layer allow <permission>[,permission] [latitude,longitude]')
      const origin = new URL(tab.page.url()).origin
      await ctx.grantPermissions(perms, { origin })
      if (c.dir) {
        const [latitude, longitude] = c.dir.split(',').map(Number)
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error(`expected latitude,longitude, got "${c.dir}"`)
        await ctx.setGeolocation({ latitude, longitude })
      }
      return `allowed ${perms.join(', ')} for ${origin}${c.dir ? ` at ${c.dir}` : ''}`
    }
    case 'eval': {
      const tab = need(c.session)
      const { result, exceptionDetails } = await tab.cdp.send('Runtime.evaluate', { expression: c.text ?? '', awaitPromise: true, returnByValue: true, replMode: true })
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text)
      return result.value === undefined ? String(result.description ?? 'undefined') : JSON.stringify(result.value, null, 2)
    }
    case 'net': {
      const tab = need(c.session)
      if (c.id !== undefined) {
        // One request in full: what an agent needs to call the same API itself.
        const r = tab.net.find(n => n.id === c.id)
        if (!r) throw new Error(`no request #${c.id} — run: agent-layer net`)
        const res = await r.request.response().catch(() => null)
        const body = await res?.text().catch(() => undefined)
        return [`#${r.id} ${r.method} ${r.url}`, 'request headers:', headerLines(await r.request.allHeaders()),
          ...(r.request.postData() ? ['request body:', printable(r.request.postData(), policy['network.bodyChars'])!] : []),
          `response: ${r.status} ${r.type}`, headerLines((await res?.allHeaders()) ?? {}),
          ...(body ? ['response body:', printable(body, policy['network.bodyChars'])!] : [])].join('\n')
      }
      const list = c.all ? tab.net : tab.net.filter(r => (r.kind !== 'document' || r.method !== 'GET') && !noise(r))
      if (!list.length) return 'no requests yet'
      return list.slice(-40).map(r => {
        const u = new URL(r.url)
        const where = u.origin === new URL(tab.page.url()).origin ? `${u.pathname}${u.search}` : `${u.host}${u.pathname}${u.search}`
        return `#${String(r.id).padEnd(4)} ${r.method.padEnd(6)} ${String(r.status).padEnd(4)} ${where.slice(0, 120)}  ${r.type}${r.post ? `\n      body: ${r.post}` : ''}`
      }).join('\n') + '\n(net show <#> for headers and bodies)'
    }
    case 'close': {
      const tab = c.id ? own(c.session, c.id) : need(c.session)
      await tab.page.close()
      const now = current.get(c.session)
      return now ? `closed tab ${tab.id}; now on tab ${now}` : `closed tab ${tab.id}; no live tabs left in session "${c.session}"`
    }
    case 'state':
      return JSON.stringify([...tabs.values()].map(t => ({ session: t.session, url: t.page.url(), current: current.get(t.session) === t.id })))
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
    // `agent-layer show` leaves this marker so a person can watch the agent's browser.
    headless: !existsSync(join(home(), 'visible')),
    viewport: { width: policy['viewport.width'], height: policy['viewport.height'] },
    reducedMotion: 'reduce',
  })
  await ctx.route('**/*', r => (DECORATION.has(r.request().resourceType()) ? r.abort() : r.continue()))
  await ctx.addInitScript(`
    window.__alMut = 0;
    new MutationObserver(() => { window.__alMut++ }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  `)
  for (const p of ctx.pages()) await p.close()
  // A page a site opens (window.open, target=_blank, an OAuth pop-up) joins its opener's session.
  ctx.on('page', async page => {
    const opener = await page.opener()
    const parent = [...tabs.values()].find(t => t.page === opener)
    if (!parent) return
    const tab = await setupTab(parent.session, page)
    parent.opened.push(tab.id)
  })

  let queue = Promise.resolve()
  let idle: NodeJS.Timeout
  // `stop` answers only after Chrome has exited, so a caller can safely delete the profile next.
  let stopping = false
  const shutdown = async (reply?: (text: string) => void) => {
    stopping = true
    server.close()
    await ctx.close().catch(() => {})
    rmSync(socketPath(), { force: true })
    if (reply) reply('stopped')
    else process.exit(0)
  }
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => void shutdown(), policy['daemon.idleMs']) }
  // The browser went away on its own (a person closed the visible window, Chrome crashed): a daemon
  // without a browser can only fail, so it exits and the next command starts a fresh one.
  ctx.on('close', () => {
    if (stopping) return
    rmSync(socketPath(), { force: true })
    process.exit(0)
  })

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
