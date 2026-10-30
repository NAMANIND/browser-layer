import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Verb } from './html.js'

// What the fast path keeps of the last page: where its links go and its forms.
export type Saved = { url: string; links: Record<number, string>; verbs: Verb[] }

export type Cookie = { name: string; value: string; domain: string; hostOnly: boolean; path: string; expires?: number; secure?: boolean }

export const home = () => process.env.AGENT_LAYER_HOME || join(homedir(), '.agent-layer')

function load<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(join(home(), file), 'utf8')) } catch { return fallback }
}

function save(file: string, data: unknown) {
  mkdirSync(home(), { recursive: true })
  writeFileSync(join(home(), file), JSON.stringify(data, null, 2))
}

// Each session (one agent, one task) keeps its own last page so two agents never read each other's.
const lastFile = (session: string) => session === 'default' ? 'last.json' : `last-${session.replace(/[^\w.-]/g, '_')}.json`
export const lastPage = (session: string) => load<Saved | null>(lastFile(session), null)
export const saveLastPage = (session: string, page: Saved) => save(lastFile(session), page)

// One cookie jar for both paths: what a live tab logs into, plain fetch can use, and back.
export const loadJar = () => load<Cookie[]>('cookies.json', [])
export const saveJar = (jar: Cookie[]) => save('cookies.json', jar)

function storeCookies(jar: Cookie[], url: URL, headers: Headers) {
  for (const line of headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';')
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    const c: Cookie = {
      name: pair.slice(0, eq).trim(),
      value: pair.slice(eq + 1).trim(),
      domain: url.hostname,
      hostOnly: true,
      path: '/',
    }
    for (const attr of attrs) {
      const [k, v = ''] = attr.split('=').map(s => s.trim())
      const key = k.toLowerCase()
      if (key === 'domain' && v) { c.domain = v.replace(/^\./, '').toLowerCase(); c.hostOnly = false }
      else if (key === 'path' && v.startsWith('/')) c.path = v
      else if (key === 'secure') c.secure = true
      else if (key === 'max-age') c.expires = Date.now() + Number(v) * 1000
      else if (key === 'expires' && c.expires === undefined) c.expires = Date.parse(v)
    }
    const i = jar.findIndex(o => o.name === c.name && o.domain === c.domain && o.path === c.path)
    if (i >= 0) jar.splice(i, 1)
    if (c.expires === undefined || c.expires > Date.now()) jar.push(c)
  }
}

function cookieHeader(jar: Cookie[], url: URL): string {
  const host = url.hostname
  return jar
    .filter(c => (c.expires === undefined || c.expires > Date.now())
      && (!c.secure || url.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1')
      && (c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`))
      && url.pathname.startsWith(c.path))
    .map(c => `${c.name}=${c.value}`)
    .join('; ')
}

export type Response = { url: string; status: number; type: string; body: string }

// Plain HTTP with a persistent cookie jar. Redirects are followed by hand so every hop's cookies are kept.
export async function request(url: string, init: { method?: string; body?: string | FormData; headers?: Record<string, string> } = {}): Promise<Response> {
  const jar = loadJar()
  let target = new URL(url)
  let method = init.method ?? 'GET'
  let body = init.body
  let headers = { ...init.headers }
  for (let hop = 0; hop < 10; hop++) {
    const cookie = cookieHeader(jar, target)
    const res = await fetch(target, {
      method,
      body,
      redirect: 'manual',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        ...headers,
        ...(cookie ? { cookie } : {}),
      },
    })
    storeCookies(jar, target, res.headers)
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      target = new URL(location, target)
      if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; headers = {} }
      continue
    }
    saveJar(jar)
    return { url: target.href, status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }
  }
  throw new Error(`too many redirects from ${url}`)
}
