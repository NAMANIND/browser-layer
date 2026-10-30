#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readPage, type Page, type Verb } from './page.js'
import { home, lastPage, request, saveLastPage, type Response } from './session.js'
import { pageView, verbView } from './view.js'
import { live } from './client.js'
import type { Command } from './daemon.js'

const HELP = `agent-layer — websites as text and verbs for agents.

Fast path (plain HTTP, no browser):
  agent-layer open <url>              read a page
  agent-layer open <N>                follow link [N] from the last page
  agent-layer do <verb> k=v ...       run a verb from the last page
  agent-layer verbs                   list verbs on the last page
  --json                              structured output instead of text

Live tabs (headless Chrome kept alive in the background; runs the page's JS):
  agent-layer tab <url>               open a live tab (it becomes current); answers with the page map
  agent-layer go <url> | back         navigate the current tab
  agent-layer map                     the page as regions: fields, actions, lists, links, with refs
  agent-layer read [ref] [--page N]   the whole page, or one region / control by ref (paged)
  agent-layer get <ref> [--sort col] [--desc] [--limit N] [--cols a,b]
                                      a list or table from the map as records (TSV)
  agent-layer click <ref>             click control [ref]
  agent-layer type <ref> <text>       fill [ref]; add --enter to press Enter after
  agent-layer pick <ref> <option>     choose an option in a select
  agent-layer press <key>             press a key or combo (Enter, Escape, Control+A, Shift+Tab…)
  agent-layer dblclick | rightclick | hover <ref>
  agent-layer scroll [ref] [down|up|top|bottom]   wheel or jump; new rows come back as changes
  agent-layer upload <ref> <file...>  a file input, or a button that opens a file chooser
  agent-layer wait [--gone] <text>    until the text appears (or is gone)
  agent-layer dialog accept [text] | dialog dismiss   answer an alert / confirm / prompt
  agent-layer forward | reload
  agent-layer eval <js>               run JavaScript in the page; prints the result as JSON
  agent-layer allow <perm>[,perm] [lat,lon]   grant geolocation, notifications… to the current site
  Pop-ups open as tabs in the same session and become current; downloads are saved and reported.
  agent-layer net [--all]             requests the page made (the API under the UI); trackers hidden
  agent-layer net show <#>            one request in full: headers (secrets redacted) and bodies
  agent-layer tabs | use <id> | close [id] | stop

Watch: agent-layer show makes the current browser a visible window to watch (tabs reopen); it is
headless again after hide, or once that window is closed. The agent's browser is never visible otherwise.
Sign-in: agent-layer login <url> opens a normal Chrome window on the agent's profile; sign in, quit it,
and the agent's browser is signed in from then on.
Profiles: --profile <name> is a separate browser (own Chrome profile, cookies, daemon).
Sessions: --session <name> (or AGENT_LAYER_SESSION) gives each agent its own
last page and live tabs. Default is "default". Cookies are shared.`

const CHROME: Record<string, string> = {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}

const LIVE = new Set(['tab', 'go', 'back', 'forward', 'reload', 'tabs', 'use', 'map', 'read', 'get', 'dblclick', 'rightclick', 'hover', 'upload', 'scroll', 'wait', 'dialog', 'eval', 'allow', 'click', 'type', 'pick', 'press', 'net', 'close', 'stop'])

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

let session = process.env.AGENT_LAYER_SESSION || 'default'

function show(res: Response, json: boolean) {
  if (!/html|xml/.test(res.type) && res.body.trimStart()[0] !== '<') {
    let body = res.body
    try { body = JSON.stringify(JSON.parse(body), null, 2) } catch {}
    console.log(json ? JSON.stringify({ url: res.url, status: res.status, type: res.type, body: res.body }) : `${res.url}  [${res.status}]  ${res.type}\n\n${body.slice(0, 8000)}`)
    return
  }
  const page = readPage(res.body, res.url, res.status)
  saveLastPage(session, page)
  console.log(json ? JSON.stringify(page, null, 2) : pageView(page))
}

function needPage(): Page {
  return lastPage(session) ?? fail('no page open yet — run: agent-layer open <url>')
}

function encode(verb: Verb, args: Record<string, string>): [string, URLSearchParams | FormData] {
  const known = new Set(verb.fields.map(f => f.name))
  const unknown = Object.keys(args).filter(k => !known.has(k) && !(k in verb.hidden))
  if (unknown.length) fail(`unknown field ${unknown.join(', ')}\n\n${verbView(verb, verb.action)}`)

  const data = verb.enctype === 'multipart/form-data' ? new FormData() : new URLSearchParams()
  for (const [k, v] of Object.entries(verb.hidden)) data.append(k, args[k] ?? v)
  const missing: string[] = []
  for (const f of verb.fields) {
    const given = args[f.name]
    if (f.multi) {
      const picked = (given ?? f.value).split(',').map(s => s.trim()).filter(Boolean)
      const bad = picked.filter(p => !f.options!.includes(p))
      if (bad.length) fail(`${f.name} takes any of: ${f.options!.join(', ')} (comma-separated), not ${bad.join(', ')}`)
      for (const p of picked) data.append(f.name, p)
      continue
    }
    if (f.type === 'checkbox') {
      const on = given === undefined ? f.checked : !/^(false|off|no|0)$/i.test(given)
      if (on) data.append(f.name, given && !/^(true|on|yes|1)$/i.test(given) ? given : f.value)
      continue
    }
    const value = given ?? f.value
    if (f.options && given !== undefined && !f.options.includes(given)) fail(`${f.name} must be one of: ${f.options.join(' | ')}`)
    if (f.required && !value) missing.push(f.name)
    if (value || given !== undefined || f.type !== 'radio') data.append(f.name, value)
  }
  if (missing.length) fail(`missing required ${missing.join(', ')}\n\n${verbView(verb, verb.action)}`)
  if (verb.submit) data.append(...verb.submit)
  return [verb.method, data]
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
    process.env.AGENT_LAYER_HOME = join(home(), 'profiles', profile)
  }
  const json = argv.includes('--json')
  const flags = new Set(['--json', '--enter', '--all', '--desc', '--gone'])
  const [cmd, target, ...rest] = argv.filter(a => !flags.has(a))

  if (cmd === 'show' || cmd === 'hide') {
    // Chrome cannot switch between headless and visible while running, so the browser restarts and every
    // open tab is reopened in its session (the current one last, so it stays current). Sign-ins live in
    // the profile and carry over; page state such as half-filled forms does not.
    const state = await live({ cmd: 'state', session })
    // Never restart blind: if the open tabs cannot be listed (say a daemon from an older build), stop here.
    if (!state.ok) fail(`could not list the open tabs (${state.error}); run agent-layer stop, then try again`)
    const open = JSON.parse(state.text!) as { session: string; url: string; current: boolean }[]
    await live({ cmd: 'stop', session })
    // Only the browser started now is visible; the daemon reads this from its environment at launch.
    process.env.AGENT_LAYER_VISIBLE = cmd === 'show' ? '1' : ''
    const reopened: string[] = []
    for (const t of [...open.filter(t => !t.current), ...open.filter(t => t.current)]) {
      const r = await live({ cmd: 'tab', session: t.session, url: t.url })
      reopened.push(`  ${t.session}: ${(r.ok ? r.text! : `could not reopen ${t.url}: ${r.error}`).split('\n')[0]}`)
    }
    // Chrome shows a window only when it has a tab, so showing an empty browser opens a blank one.
    if (cmd === 'show' && !open.length) {
      await live({ cmd: 'tab', session, url: 'about:blank' })
      return console.log("The agent's browser is a visible window now, with a blank tab (no tabs were open). Next: agent-layer go <url>")
    }
    return console.log([`The agent's browser is ${cmd === 'show' ? 'a visible window' : 'headless'} now.${open.length ? ' Reopened:' : ''}`, ...reopened].join('\n'))
  }

  if (cmd === 'login') {
    // A plain Chrome window on the agent's own profile, with no automation attached: the person signs
    // in themselves (passwords, 2FA, passkeys stay with them) and the agent's browser keeps the session.
    const url = target ?? fail('usage: agent-layer login <url>')
    const chrome = CHROME[process.platform] ?? fail(`login needs Google Chrome; no known path on ${process.platform}`)
    await live({ cmd: 'stop', session }) // one Chrome per profile directory at a time
    console.log('Sign in in the Chrome window that opens, then quit it (Cmd+Q, or close every window).')
    // --use-mock-keychain: the agent's browser (Playwright) encrypts cookies with Chromium's mock keychain,
    // so the window must too, or the session it saves cannot be decrypted and is dropped.
    await new Promise(done => spawn(chrome, [`--user-data-dir=${join(home(), 'profile')}`, '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`], { stdio: 'ignore' }).on('exit', done))
    // The jar mirrors the browser after every command; dropping it lets the new session win over stale cookies.
    rmSync(join(home(), 'cookies.json'), { force: true })
    return console.log("Saved. The agent's browser uses this session from the next command.")
  }

  if (LIVE.has(cmd)) {
    const c: Command = { cmd, session, page, limit, sort, cols, desc: argv.includes('--desc'), gone: argv.includes('--gone'), enter: argv.includes('--enter'), all: argv.includes('--all') }
    if (cmd === 'tab' || cmd === 'go') c.url = target ?? fail(`usage: agent-layer ${cmd} <url>`)
    if (cmd === 'use' || (cmd === 'close' && target)) c.id = Number(target)
    if (cmd === 'net' && target) c.id = target === 'show' && /^#?\d+$/.test(rest[0] ?? '') ? Number(rest[0].replace('#', '')) : fail('usage: agent-layer net [--all] | net show <#>')
    if (['click', 'dblclick', 'rightclick', 'hover', 'type', 'pick', 'upload'].includes(cmd)) c.ref = target ?? fail(`usage: agent-layer ${cmd} <ref>`)
    // The daemon runs elsewhere, so files are resolved against the agent's working directory here.
    if (cmd === 'upload') c.files = rest.map(f => resolve(f))
    if (cmd === 'scroll') [c.ref, c.dir] = target && /^\d+$/.test(target) ? [target, rest[0]] : [undefined, target]
    if (cmd === 'dialog') [c.dir, c.text] = [target, rest.length ? rest.join(' ') : undefined]
    if (cmd === 'wait' || cmd === 'eval') c.text = [target, ...rest].filter(Boolean).join(' ')
    if (cmd === 'allow') [c.text, c.dir] = [target, rest[0]]
    if (cmd === 'read' && target) c.ref = /^\d+$/.test(target) ? target : fail('usage: agent-layer read [ref] [--page N]')
    if (cmd === 'get') c.ref = target && /^\d+$/.test(target) ? target : fail('usage: agent-layer get <ref> [--sort col] [--desc] [--limit N] [--cols a,b]')
    if (cmd === 'type' || cmd === 'pick') c.text = rest.join(' ')
    if (cmd === 'press') c.key = target ?? fail('usage: agent-layer press <key>')
    const reply = await live(c)
    if (!reply.ok) fail(`error: ${reply.error}`)
    return console.log(reply.text)
  }

  if (cmd === 'open' && target) {
    let url = target
    if (/^\d+$/.test(target)) {
      const link = needPage().links[Number(target) - 1] ?? fail(`no link [${target}] on the last page`)
      url = link.href
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
    const [method, data] = encode(verb, args)
    if (method === 'GET') {
      const url = new URL(verb.action)
      url.search = (data as URLSearchParams).toString()
      return show(await request(url.href), json)
    }
    const body = data instanceof FormData ? data : data.toString()
    const headers: Record<string, string> = data instanceof FormData ? {} : { 'content-type': 'application/x-www-form-urlencoded' }
    return show(await request(verb.action, { method, body, headers: { ...headers, referer: page.url, origin: new URL(page.url).origin } }), json)
  }

  console.log(HELP)
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exit(1)
}

main().catch(err => fail(`error: ${err instanceof Error ? err.message : err}`))
