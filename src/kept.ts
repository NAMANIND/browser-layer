// What a session keeps when its browser or daemon dies (DESIGN §10): its tabs, in <home>/kept.json.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { home } from './session.js'

export type Kept = {
  next: number
  sessions: Record<string, { tabs: { id: number; url: string; used: number }[]; current?: number }>
}

const keptFile = () => join(home(), 'kept.json')

export function loadKept(): Kept {
  try { return JSON.parse(readFileSync(keptFile(), 'utf8')) } catch { return { next: 1, sessions: {} } }
}

// Written whole and renamed into place: a daemon killed mid-write leaves the last good file.
export function saveKept(kept: Kept) {
  mkdirSync(home(), { recursive: true })
  writeFileSync(`${keptFile()}.tmp`, JSON.stringify(kept))
  renameSync(`${keptFile()}.tmp`, keptFile())
}

// `stop` ends every session: nothing is restored after it.
export const forgetKept = () => rmSync(keptFile(), { force: true })
