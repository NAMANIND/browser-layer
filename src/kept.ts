// What a session keeps when its browser or daemon dies (DESIGN §10): its tabs, the addresses of tabs it let go of and its last calls in <home>/kept.json; the files it saved with --out,
// one line each, in <home>/saved.log (the CLI appends to that one too, for plain `open --out`).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './session.js'

export type Kept = {
  next: number
  sessions: Record<string, { tabs: { id: number; url: string; used: number }[]; current?: number; gone: string[]; calls: string[] }>
}

const keptFile = () => join(home(), 'kept.json')
const savedFile = () => join(home(), 'saved.log')

export function loadKept(): Kept {
  try { return JSON.parse(readFileSync(keptFile(), 'utf8')) } catch { return { next: 1, sessions: {} } }
}

// Written whole and renamed into place: a daemon killed mid-write leaves the last good file.
export function saveKept(kept: Kept) {
  mkdirSync(home(), { recursive: true })
  writeFileSync(`${keptFile()}.tmp`, JSON.stringify(kept))
  renameSync(`${keptFile()}.tmp`, keptFile())
}

// `stop` ends every session: nothing is restored after it, and the next task does not meet this one's files.
export const forgetKept = () => { rmSync(keptFile(), { force: true }); rmSync(savedFile(), { force: true }) }

export function noteSaved(session: string, file: string) {
  mkdirSync(home(), { recursive: true })
  appendFileSync(savedFile(), `${session}\t${file}\n`)
}

// Each session's files that still exist, newest first, each once.
export function savedFiles(): Map<string, string[]> {
  const by = new Map<string, string[]>()
  try {
    for (const line of readFileSync(savedFile(), 'utf8').split('\n').reverse()) {
      const [session, ...rest] = line.split('\t')
      const file = rest.join('\t')
      const files = by.get(session) ?? by.set(session, []).get(session)!
      if (file && existsSync(file) && !files.includes(file)) files.push(file)
    }
  } catch {}
  return by
}

// Once at start-up, so the log never holds more than `max` files a session.
export function trimSaved(max: number) {
  writeFileSync(savedFile(), [...savedFiles()].flatMap(([session, files]) => files.slice(0, max).reverse().map(f => `${session}\t${f}\n`)).join(''))
}
