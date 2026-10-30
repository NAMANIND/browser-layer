import type { Node } from './reader.js'

// Text for the agent: blocks start lines, rows read as one line with ' · ' between their parts,
// controls inline as [ref] role "name". All shortening happens here, never in the reader.
const SEP = '\u0001'

function control(n: Node, origin: string, nameChars: number): string {
  const clip = (s: string) => (s.length > nameChars ? `${s.slice(0, nameChars - 1)}…` : s)
  const bits = [n.value === undefined ? '' : `= ${JSON.stringify(clip(n.value))}`, ...(n.states ?? [])].filter(Boolean)
  let dest = ''
  if (n.url) {
    // The ref is how the agent acts; a link target is shown only when it adds something.
    const u = new URL(n.url, origin)
    if (u.origin !== origin) dest = ` → ${u.host}`
    else if (!n.name) dest = ` → ${clip(`${u.pathname}${u.search}`)}`
  }
  return ` [${n.ref}] ${n.role}${n.name ? ` "${clip(n.name)}"` : ''}${bits.length ? `  ${bits.join(' ')}` : ''}${dest} `
}

export function renderText(root: Node, origin: string, nameChars: number): string {
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
      line += control(n, origin, nameChars)
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
