import type { Node } from './reader.js'

// Text for the agent: blocks start lines, rows read as one line with ' · ' between their parts,
// controls inline as [ref] role "name". All shortening happens here, never in the reader.
const SEP = '\u0001'

export type Caps = { nameChars: number; labelChars: number }

function control(n: Node, origin: string, caps: Caps): string {
  const clip = (s: string, max = caps.nameChars) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
  const bits = [n.value === undefined ? '' : `= ${JSON.stringify(clip(n.value))}`, ...(n.states ?? [])].filter(Boolean)
  let dest = ''
  if (n.url) {
    // The ref is how the agent acts; a link target is shown only when it adds something.
    const u = new URL(n.url, origin)
    if (u.origin !== origin) dest = ` → ${u.host}`
    else if (!n.name) dest = ` → ${clip(`${u.pathname}${u.search}`)}`
  }
  // A label only assistive tech hears usually repeats what the row shows; it gets less room.
  const name = n.name && clip(n.name, n.nameShown ? caps.nameChars : caps.labelChars)
  return ` [${n.ref}] ${n.role}${name ? ` "${name}"` : ''}${bits.length ? `  ${bits.join(' ')}` : ''}${dest} `
}

export function renderText(root: Node, origin: string, caps: Caps): string {
  const lines: string[] = []
  let line = ''
  // Parts of a row are joined by ' · ', except next to a part that is only punctuation or symbols
  // (a dash, a bullet), which reads as a space: "• 7:00 AM – 9:10 AM".
  const mark = /^[\p{P}\p{S}]+$/u
  const flush = () => {
    const parts = line.split(SEP).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
    const t = parts.reduce((acc, p, i) => (i === 0 ? p : `${acc}${mark.test(p) || mark.test(parts[i - 1]) ? ' ' : ' · '}${p}`), '')
    if (t) lines.push(t)
    line = ''
  }
  const visit = (n: Node, inRow: boolean) => {
    if (n.text !== undefined) { line += n.text; return }
    if (n.ref) {
      if (n.block && !inRow) flush()
      line += control(n, origin, caps)
      for (const c of n.children ?? []) visit(c, inRow)
      if (n.block && !inRow) flush()
      return
    }
    if (inRow) {
      if (n.block) line += SEP
      for (const c of n.children ?? []) visit(c, true)
      if (n.block) line += SEP
      return
    }
    if (n.block) flush()
    if (n.role === 'heading') line += `${'#'.repeat(n.level ?? 1)} `
    if (n.role === 'dialog') { line += `dialog${n.name ? ` "${n.name}"` : ''} — the page behind it is not available`; flush() }
    for (const c of n.children ?? []) visit(c, !!n.row)
    if (n.block) flush()
  }
  visit(root, false)
  flush()
  return lines.join('\n')
}

// Pages split on line boundaries so no control's line is cut in half.
export function paginate(text: string, pageChars: number): string[] {
  const pages: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > pageChars) { pages.push(cur); cur = '' }
    cur = cur ? `${cur}\n${line}` : line
  }
  pages.push(cur)
  return pages
}

// Lines removed and added between two views of the same page. Refs keep unchanged lines identical,
// so the common head and tail are skipped and the middle is compared as multisets.
export function diffLines(before: string[], after: string[]): { removed: string[]; added: string[] } {
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  const was = before.slice(head, before.length - tail)
  const now = after.slice(head, after.length - tail)
  const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>())
  const take = (lines: string[], other: Map<string, number>) => lines.filter(l => {
    const n = other.get(l) ?? 0
    if (n) other.set(l, n - 1)
    return !n
  })
  return { removed: take(was, count(now)), added: take(now, count(was)) }
}
