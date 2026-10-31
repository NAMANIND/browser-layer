#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Field, Verb } from './html.js'
import { home, lastPage, request, saveLastPage, type Response, type Saved } from './session.js'
import { paginate, renderText } from './render.js'
import { loadPolicy } from './policy.js'
import { live } from './client.js'
import { findBrowser, PROFILE_FLAGS } from './browser.js'
import type { Command } from './daemon.js'

const HELP = `browser-layer — websites as text and verbs for agents.

Fast path (plain HTTP, no browser):
  browser-layer open <url>              read a page
  browser-layer open <ref>              follow link [ref] from the last page
  browser-layer do <verb> k=v ...       run a verb from the last page
  browser-layer verbs                   list verbs on the last page
  --json                                structured output instead of text

Live tabs (a headless browser kept alive in the background; runs the page's JS):
  browser-layer tab <url>               open a live tab (it becomes current); answers with the page map
  browser-layer go <url> | back         navigate the current tab
  browser-layer map                     the page as regions: fields, actions, lists, links, with refs
  browser-layer read [ref] [--page N]   the whole page, or one region / control by ref (paged)
  browser-layer get <ref> [--sort col] [--desc] [--limit N] [--cols a,b]
                                        a list or table from the map as records (TSV)
  browser-layer click <ref>             click control [ref]; any <ref> of an action may be its name: click "Next"
  browser-layer type <ref> <text>       fill [ref]; add --enter to press Enter after
  browser-layer pick <ref> <option>     choose an option in a select
  browser-layer press <key>             press a key or combo (Enter, Escape, Control+A, Shift+Tab…)
  browser-layer dblclick | rightclick | hover <ref>
  browser-layer scroll [ref] [down|up|top|bottom]   wheel or jump; new rows come back as changes
  browser-layer upload <ref> <file...>  a file input, or a button that opens a file chooser
  browser-layer wait [--gone] <text>    until the text appears (or is gone)
  browser-layer dialog accept [text] | dialog dismiss   answer an alert / confirm / prompt
  browser-layer forward | reload
  browser-layer eval <js>               run JavaScript in the page; prints the result as JSON
  browser-layer screenshot [ref] [file] [--full]   save a PNG of the tab, or of one region, when a person wants one (read the page as text)
  browser-layer allow <perm>[,perm] [lat,lon]   grant geolocation, notifications… to the current site
  browser-layer find <text>             the lines of the page that contain it
  browser-layer check | uncheck <ref>   set a checkbox (repeatable: only clicks if it must change)
  browser-layer submit <ref>            submit the form a field is in, as its submit button would
  browser-layer drag <ref> <onto ref>   pointer drag, and HTML drag and drop
  browser-layer type <ref> <text> --keys    one key event per character, for fields that listen to keys
  browser-layer cookies [domain] | cookies clear [domain]     names and expiry; values are never shown
  browser-layer storage local|session [clear]                the current site's web storage
  browser-layer explore [ref]           open every declared menu / pop-up, list what it holds, close it
  browser-layer menu "A > B > C"        run a menu path by names (File > Download > CSV)
  Pop-ups open as tabs in the same session and become current; downloads are saved and reported.
  browser-layer net [--all]             requests the page made (the API under the UI); trackers hidden
  browser-layer net show <#>            one request in full: headers (secrets redacted) and bodies
  browser-layer tabs | use <id> | close [id] | stop

Watch: browser-layer show makes the current browser a visible window to watch (tabs reopen); it is
headless again after hide, or once that window is closed. The agent's browser is never visible otherwise.
Sign-in: browser-layer login <url> opens a normal browser window on the agent's profile; sign in, quit it,
and the agent's browser is signed in from then on.
Browser: the first of Chrome, Edge or Chromium installed (BROWSER_LAYER_BROWSER=<path> picks one);
browser-layer install downloads Chromium when there is none. browser-layer browser says which is used.
Profiles: --profile <name> is a separate browser (own profile, cookies, daemon).
Sessions: --session <name> (or BROWSER_LAYER_SESSION) gives each agent its own
last page and live tabs. Default is "default". Cookies are shared.`

const LIVE = new Set(['tab', 'go', 'back', 'forward', 'reload', 'tabs', 'use', 'map', 'read', 'get', 'dblclick', 'rightclick', 'hover', 'upload', 'scroll', 'wait', 'dialog', 'eval', 'allow', 'explore', 'menu', 'check', 'uncheck', 'submit', 'drag', 'find', 'cookies', 'storage', 'click', 'type', 'pick', 'press', 'net', 'close', 'stop', 'screenshot'])

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

let session = process.env.BROWSER_LAYER_SESSION || 'default'

const short = (href: string, from: string) => {
  const u = new URL(href)
  return u.host === new URL(from).host ? `${u.pathname}${u.search}` : `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`
}

function fieldLine(f: Field): string {
  const name = `${f.name}${f.required ? '*' : ''}`
  const kind = f.multi ? `any of ${f.options!.join(', ')}` : f.options ? f.options.join(' | ') : f.type
  const extra = [
    f.label && f.label !== f.name ? `"${f.label}"` : '',
    f.multi ? (f.value ? `= ${f.value}` : '') : f.type === 'checkbox' ? (f.checked ? 'checked' : 'unchecked') : f.value && !f.options ? `= ${JSON.stringify(f.value)}` : '',
  ].filter(Boolean).join(' ')
  return `    ${name.padEnd(16)} ${kind}${extra ? `  ${extra}` : ''}`
}

// Hidden fields and the submitter are sent as the page set them; the agent sees what it can fill.
const verbView = (v: Verb, from: string) => [`  ${v.name} → ${v.method} ${short(v.action, from)}`, ...v.fields.filter(f => f.type !== 'hidden' && f.type !== 'submit').map(fieldLine)].join('\n')

// A fetched page reads like a live one: the same tree and renderer, plus its forms as verbs.
async function show(res: Response, json: boolean) {
  if (!/html|xml/.test(res.type) && res.body.trimStart()[0] !== '<') {
    let body = res.body
    try { body = JSON.stringify(JSON.parse(body), null, 2) } catch {}
    console.log(json ? JSON.stringify({ url: res.url, status: res.status, type: res.type, body: res.body }) : `${res.url}  [${res.status}]  ${res.type}\n\n${body.slice(0, 8000)}`)
    return
  }
  // The HTML parser is loaded here, not at startup: live-tab commands never need it.
  const { readHtml } = await import('./html.js')
  const page = readHtml(res.body, res.url, res.status)
  saveLastPage(session, { url: page.url, links: page.links, verbs: page.verbs })
  if (json) return console.log(JSON.stringify(page, null, 2))
  const policy = loadPolicy()
  const text = renderText(page.tree, new URL(page.url).origin, { nameChars: policy['render.nameChars'], labelChars: policy['render.labelChars'] })
  const [first, ...more] = paginate(text, policy['render.pageChars'])
  const out = [`${page.url}  [${page.status}]${page.title ? `  "${page.title}"` : ''}`, '', first]
  if (more.length) out.push(`… ${more.join('\n').length} more chars: browser-layer tab ${page.url} reads it all`)
  if (page.verbs.length) out.push('', 'verbs:', ...page.verbs.map(v => verbView(v, page.url)))
  // Little to read but scripts to run: the page is built in the browser, which the fast path never runs.
  if (text.length < policy['http.shellChars'] && page.scripts) out.push('', `this page builds itself with JavaScript; browser-layer tab ${page.url} runs it`)
  console.log(out.join('\n').trimEnd())
}

function needPage(): Saved {
  return lastPage(session) ?? fail('no page open yet — run: browser-layer open <url>')
}

// HTML form submission: the entry list in tree order (fields, dirname, the submitter), newlines as CRLF,
// then one of the three encodings. GET always sends it urlencoded in the action's query.
function encode(verb: Verb, args: Record<string, string>): { method: string; body: URLSearchParams | FormData | string; type?: string } {
  const known = new Set(verb.fields.map(f => f.name))
  const unknown = Object.keys(args).filter(k => !known.has(k))
  if (unknown.length) fail(`unknown field ${unknown.join(', ')}\n\n${verbView(verb, verb.action)}`)
  const entries: [string, string][] = []
  const missing: string[] = []
  for (const f of verb.fields) {
    const given = args[f.name]
    if (f.type === 'submit') { entries.push([f.name, f.value]); continue }
    if (f.multi) {
      const picked = (given ?? f.value).split(',').map(s => s.trim()).filter(Boolean)
      const bad = picked.filter(p => !f.options!.includes(p))
      if (bad.length) fail(`${f.name} takes any of: ${f.options!.join(', ')} (comma-separated), not ${bad.join(', ')}`)
      for (const p of picked) entries.push([f.name, p])
      continue
    }
    if (f.type === 'checkbox') {
      const on = given === undefined ? f.checked : !/^(false|off|no|0)$/i.test(given)
      if (on) entries.push([f.name, given && !/^(true|on|yes|1)$/i.test(given) ? given : f.value])
      continue
    }
    const value = given ?? f.value
    if (f.options && given !== undefined && !f.options.includes(given)) fail(`${f.name} must be one of: ${f.options.join(' | ')}`)
    if (f.required && !value) missing.push(f.name)
    if (f.type === 'radio' && !value) continue
    entries.push([f.name, value])
    if (f.dirname) entries.push([f.dirname, 'ltr'])
  }
  if (missing.length) fail(`missing required ${missing.join(', ')}\n\n${verbView(verb, verb.action)}`)
  const crlf = (t: string) => t.replace(/\r\n|\r|\n/g, '\r\n')
  const list = entries.map(([k, v]) => [crlf(k), crlf(v)] as [string, string])
  if (verb.method === 'GET' || verb.enctype === 'application/x-www-form-urlencoded') return { method: verb.method, body: new URLSearchParams(list), type: 'application/x-www-form-urlencoded' }
  if (verb.enctype === 'text/plain') return { method: 'POST', body: list.map(([k, v]) => `${k}=${v}\r\n`).join(''), type: 'text/plain' }
  const form = new FormData()
  for (const [k, v] of list) form.append(k, v)
  return { method: 'POST', body: form }
}

async function main() {
  const argv = process.argv.slice(2)
  // Flags that carry a value: removed from argv, value returned.
  const take = (flag: string) => {
    const at = argv.indexOf(flag)
    if (at < 0) return undefined
    const value = argv[at + 1] ?? fail(`usage: ${flag} <value>`)
    argv.splice(at, 2)
    return value
  }
  const count = (flag: string) => {
    const v = take(flag)
    if (v !== undefined && !/^[1-9]\d*$/.test(v)) fail(`usage: ${flag} <number from 1>`)
    return v === undefined ? undefined : Number(v)
  }
  const page = count('--page')
  const limit = count('--limit')
  const sort = take('--sort')
  const cols = take('--cols')?.split(',').map(c => c.trim())
  session = take('--session') ?? session
  // A profile is a separate browser: its own Chrome profile, cookies and daemon, under <home>/profiles.
  const profile = take('--profile')
  if (profile !== undefined) {
    if (!/^[\w.-]+$/.test(profile)) fail('a profile name uses letters, digits, dot, dash or underscore')
    process.env.BROWSER_LAYER_HOME = join(home(), 'profiles', profile)
  }
  const json = argv.includes('--json')
  const flags = new Set(['--json', '--enter', '--all', '--desc', '--gone', '--keys', '--full'])
  const [cmd, target, ...rest] = argv.filter(a => !flags.has(a))

  if (cmd === 'browser') {
    const browser = await findBrowser()
    return 'error' in browser ? fail(browser.error) : console.log(browser.path)
  }

  if (cmd === 'install') {
    // Playwright's own installer, for the Chromium build this playwright-core drives. --with-deps (Linux)
    // also installs the system libraries it needs, through the package manager, so it asks for sudo.
    // The installer is the package's bin, which its exports do not expose; package.json names it.
    const pkg = createRequire(import.meta.url).resolve('playwright-core/package.json')
    const cli = join(dirname(pkg), (JSON.parse(readFileSync(pkg, 'utf8')) as { bin: Record<string, string> }).bin['playwright-core'])
    const code = await new Promise<number | null>(done => spawn(process.execPath, [cli, 'install', 'chromium', ...(argv.includes('--with-deps') ? ['--with-deps'] : [])], { stdio: 'inherit' }).on('exit', done))
    if (code) process.exit(code)
    return console.log(`Installed. The agent's browser: ${((await findBrowser()) as { path: string }).path}`)
  }

  if (cmd === 'show' || cmd === 'hide') {
    // Chrome cannot switch between headless and visible while running, so the browser restarts and every
    // open tab is reopened in its session (the current one last, so it stays current). Sign-ins live in
    // the profile and carry over; page state such as half-filled forms does not.
    const state = await live({ cmd: 'state', session })
    // Never restart blind: if the open tabs cannot be listed (say a daemon from an older build), stop here.
    if (!state.ok) fail(`could not list the open tabs (${state.error}); run browser-layer stop, then try again`)
    const open = JSON.parse(state.text!) as { session: string; url: string; current: boolean }[]
    await live({ cmd: 'stop', session })
    // Only the browser started now is visible; the daemon reads this from its environment at launch.
    process.env.BROWSER_LAYER_VISIBLE = cmd === 'show' ? '1' : ''
    const reopened: string[] = []
    for (const t of [...open.filter(t => !t.current), ...open.filter(t => t.current)]) {
      const r = await live({ cmd: 'tab', session: t.session, url: t.url })
      reopened.push(`  ${t.session}: ${(r.ok ? r.text! : `could not reopen ${t.url}: ${r.error}`).split('\n')[0]}`)
    }
    // Chrome shows a window only when it has a tab, so showing an empty browser opens a blank one.
    if (cmd === 'show' && !open.length) {
      await live({ cmd: 'tab', session, url: 'about:blank' })
      return console.log("The agent's browser is a visible window now, with a blank tab (no tabs were open). Next: browser-layer go <url>")
    }
    return console.log([`The agent's browser is ${cmd === 'show' ? 'a visible window' : 'headless'} now.${open.length ? ' Reopened:' : ''}`, ...reopened].join('\n'))
  }

  if (cmd === 'login') {
    // A plain Chrome window on the agent's own profile, with no automation attached: the person signs
    // in themselves (passwords, 2FA, passkeys stay with them) and the agent's browser keeps the session.
    const url = target ?? fail('usage: browser-layer login <url>')
    const browser = await findBrowser()
    if ('error' in browser) fail(browser.error)
    await live({ cmd: 'stop', session }) // one browser per profile directory at a time
    console.log('Sign in in the browser window that opens, then quit it (close every window of it).')
    await new Promise(done => spawn(browser.path, [`--user-data-dir=${join(home(), 'profile')}`, ...PROFILE_FLAGS, '--no-first-run', '--no-default-browser-check', /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`], { stdio: 'ignore' }).on('exit', done))
    // The jar mirrors the browser after every command; dropping it lets the new session win over stale cookies.
    rmSync(join(home(), 'cookies.json'), { force: true })
    return console.log("Saved. The agent's browser uses this session from the next command.")
  }

  if (LIVE.has(cmd)) {
    const c: Command = { cmd, session, page, limit, sort, cols, desc: argv.includes('--desc'), gone: argv.includes('--gone'), keys: argv.includes('--keys'), enter: argv.includes('--enter'), all: argv.includes('--all') }
    if (cmd === 'tab' || cmd === 'go') c.url = target ?? fail(`usage: browser-layer ${cmd} <url>`)
    if (cmd === 'use' || (cmd === 'close' && target)) c.id = Number(target)
    if (cmd === 'net' && target) c.id = target === 'show' && /^#?\d+$/.test(rest[0] ?? '') ? Number(rest[0].replace('#', '')) : fail('usage: browser-layer net [--all] | net show <#>')
    if (['click', 'dblclick', 'rightclick', 'hover', 'type', 'pick', 'upload', 'check', 'uncheck', 'submit', 'drag'].includes(cmd)) c.ref = target ?? fail(`usage: browser-layer ${cmd} <ref>`)
    if (cmd === 'drag') c.to = rest[0] ?? fail('usage: browser-layer drag <ref> <onto ref>')
    if (cmd === 'find') c.text = [target, ...rest].filter(Boolean).join(' ')
    if (cmd === 'cookies') [c.dir, c.url] = target === 'clear' ? ['clear', rest[0]] : [undefined, target]
    if (cmd === 'storage') [c.dir, c.text] = [target, rest[0]]
    // The daemon runs elsewhere, so files are resolved against the agent's working directory here.
    if (cmd === 'upload') c.files = rest.map(f => resolve(f))
    if (cmd === 'screenshot') {
      const [ref, file] = target && /^\d+$/.test(target) ? [target, rest[0]] : [undefined, target]
      ;[c.ref, c.files, c.full] = [ref, [resolve(file ?? `screenshot-${Date.now()}.png`)], argv.includes('--full')]
    }
    if (cmd === 'scroll') [c.ref, c.dir] = target && /^\d+$/.test(target) ? [target, rest[0]] : [undefined, target]
    if (cmd === 'dialog') [c.dir, c.text] = [target, rest.length ? rest.join(' ') : undefined]
    if (cmd === 'wait' || cmd === 'eval') c.text = [target, ...rest].filter(Boolean).join(' ')
    if (cmd === 'allow') [c.text, c.dir] = [target, rest[0]]
    if (cmd === 'explore' && target) c.ref = /^\d+$/.test(target) ? target : fail('usage: browser-layer explore [ref]')
    if (cmd === 'menu') c.text = [target, ...rest].filter(Boolean).join(' ')
    if (cmd === 'read' && target) c.ref = /^\d+$/.test(target) ? target : fail('usage: browser-layer read [ref] [--page N]')
    if (cmd === 'get') c.ref = target && /^\d+$/.test(target) ? target : fail('usage: browser-layer get <ref> [--sort col] [--desc] [--limit N] [--cols a,b]')
    if (cmd === 'type' || cmd === 'pick') c.text = rest.join(' ')
    if (cmd === 'press') c.key = target ?? fail('usage: browser-layer press <key>')
    const reply = await live(c)
    if (!reply.ok) fail(`error: ${reply.error}`)
    return console.log(reply.text)
  }

  if (cmd === 'open' && target) {
    let url = target
    if (/^\d+$/.test(target)) {
      url = needPage().links[Number(target)] ?? fail(`[${target}] is not a link on the last page`)
    } else if (!/^https?:\/\//i.test(target)) url = `https://${target}`
    return show(await request(url), json)
  }

  if (cmd === 'verbs') {
    const page = needPage()
    return console.log(json ? JSON.stringify(page.verbs, null, 2) : page.verbs.map(v => verbView(v, page.url)).join('\n') || 'no verbs on this page')
  }

  if (cmd === 'do' && target) {
    const page = needPage()
    const verb = page.verbs.find(v => v.name === target || v.name === `${target}.submit`)
      ?? fail(`no verb "${target}" on ${page.url}\n\nverbs:\n${page.verbs.map(v => verbView(v, page.url)).join('\n') || '  (none)'}`)
    const args: Record<string, string> = {}
    for (const pair of rest) {
      const eq = pair.indexOf('=')
      if (eq < 1) fail(`expected key=value, got "${pair}"`)
      args[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    const { method, body, type } = encode(verb, args)
    if (method === 'GET') {
      const url = new URL(verb.action)
      url.search = body.toString()
      return show(await request(url.href), json)
    }
    const headers: Record<string, string> = type ? { 'content-type': type } : {}
    return show(await request(verb.action, { method, body: body instanceof FormData ? body : body.toString(), headers: { ...headers, referer: page.url, origin: new URL(page.url).origin } }), json)
  }

  console.log(HELP)
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exit(1)
}

main().catch(err => fail(`error: ${err instanceof Error ? err.message : err}`))
