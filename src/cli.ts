#!/usr/bin/env node
import { readPage, type Page, type Verb } from './page.js'
import { lastPage, request, saveLastPage, type Response } from './session.js'
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
  agent-layer press <key>             press a key (Enter, Escape, Tab, ArrowDown…)
  agent-layer net [--all]             requests the page made (the API under the UI)
  agent-layer tabs | use <id> | close [id] | stop

Sessions: --session <name> (or AGENT_LAYER_SESSION) gives each agent its own
last page and live tabs. Default is "default". Cookies are shared.`

const LIVE = new Set(['tab', 'go', 'back', 'tabs', 'use', 'map', 'read', 'get', 'click', 'type', 'pick', 'press', 'net', 'close', 'stop'])

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
  const json = argv.includes('--json')
  const flags = new Set(['--json', '--enter', '--all', '--desc'])
  const [cmd, target, ...rest] = argv.filter(a => !flags.has(a))

  if (LIVE.has(cmd)) {
    const c: Command = { cmd, session, page, limit, sort, cols, desc: argv.includes('--desc'), enter: argv.includes('--enter'), all: argv.includes('--all') }
    if (cmd === 'tab' || cmd === 'go') c.url = target ?? fail(`usage: agent-layer ${cmd} <url>`)
    if (cmd === 'use' || (cmd === 'close' && target)) c.id = Number(target)
    if (cmd === 'click' || cmd === 'type' || cmd === 'pick') c.ref = target ?? fail(`usage: agent-layer ${cmd} <ref>`)
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
