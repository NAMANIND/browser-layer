import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Policy } from './policy.js'
import { cellsOf, COLLECTIONS, isHeaderRow, isTrigger, LANDMARKS, rowsOf, SPACE, withRefs, type Node } from './reader.js'

// Text for the agent: blocks start lines, rows read as one line with ' · ' between their parts,
// controls inline as [ref] role "name". All shortening happens here, never in the reader.
const SEP = '\u0001'

// urls (get --urls): links give their full address and pictures theirs; otherwise both are left out.
// brief: a collection of records is its one line, as in the map (its size and first record); get reads the records.
export type Caps = { nameChars: number; labelChars: number; urls?: boolean; brief?: boolean }
// The full text of each region the agent has already been shown (before), by ref; a region shown again
// exactly as it was answers in one line. now collects this answer's regions, for the caller to keep.
export type Seen = { before: Map<number, string>; now: Map<number, string> }
const unchanged = (n: Node, whole: string, seen: Seen) => {
  seen.now.set(n.ref!, whole)
  return seen.before.get(n.ref!) === whole
}

const isRegion = (n: Node) => n.ref !== undefined && (n.role === 'dialog' || LANDMARKS.has(n.role ?? ''))
const clipTo = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const regionLine = (n: Node, caps: Caps) =>
  `[${n.ref}] ${n.role}${n.name ? ` "${clipTo(n.name, caps.nameChars)}"` : ''}${n.role === 'dialog' ? ' — the page behind it is not available' : ''}`

export function control(n: Node, origin: string, caps: Caps): string {
  const clip = (s: string, max = caps.nameChars) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
  const bits = [n.value === undefined ? '' : `= ${JSON.stringify(clip(n.value))}`, ...(n.states ?? [])].filter(Boolean)
  let dest = ''
  // An address that does not parse goes nowhere, as in a browser; the link still shows.
  if (n.url && URL.canParse(n.url, origin)) {
    // The ref is how the agent acts; a link target is shown only when it adds something.
    const u = new URL(n.url, origin)
    if (caps.urls) dest = ` → ${u.href}`
    else if (u.origin !== origin) dest = ` → ${u.host}`
    else if (!n.name) dest = ` → ${clip(`${u.pathname}${u.search}`)}`
  }
  // A label only assistive tech hears usually repeats what the row shows; it gets less room.
  const name = n.name && clip(n.name, n.nameShown ? caps.nameChars : caps.labelChars)
  const reveals = n.reveals?.length ? `  reveals: ${n.reveals.map(r => clip(r, caps.labelChars)).join(' · ')}` : ''
  return ` [${n.ref}] ${n.role}${name ? ` "${name}"` : ''}${bits.length ? `  ${bits.join(' ')}` : ''}${reveals}${dest} `
}

// A collection of controls rather than records (a menu of every language), when it has more than `few`:
// one line with its size and first items, or undefined when it is short enough to show in full.
export function itemsLine(n: Node, origin: string, caps: Caps, few: number): string | undefined {
  const items: Node[] = []
  const walk = (c: Node) => (c.ref && !COLLECTIONS.has(c.role ?? '') ? items.push(c) : (c.children ?? []).forEach(walk))
  ;(n.children ?? []).forEach(walk)
  if (items.length <= few) return undefined
  return `[${n.ref}] ${n.role} of ${items.length}: ${items.slice(0, few).map(c => control(c, origin, caps).trim()).join(' · ')} …`
}

export function renderText(root: Node, origin: string, caps: Caps, seen?: Seen): string {
  const lines: string[] = []
  let line = ''
  // Parts of a row are joined by ' · ', except next to a part that is only punctuation or symbols
  // (a dash, a bullet), which reads as a space: "• 7:00 AM – 9:10 AM".
  const mark = /^[\p{P}\p{S}]+$/u
  const flush = () => {
    const parts = line.split(SEP).map(p => p.replace(SPACE, ' ').trim()).filter(Boolean)
    const t = parts.reduce((acc, p, i) => (i === 0 ? p : `${acc}${mark.test(p) || mark.test(parts[i - 1]) ? ' ' : ' · '}${p}`), '')
    if (t) lines.push(t)
    line = ''
  }
  const visit = (n: Node, inRow: boolean) => {
    if (n.text !== undefined) { line += n.text; return }
    if (n.role === 'image') { if (caps.urls) line += `${SEP}${n.url}${SEP}`; return }
    if (isRegion(n)) {
      flush()
      if (seen && unchanged(n, renderText({ block: true, children: [n] }, origin, caps), seen)) {
        lines.push(`${regionLine(n, caps)} — shown before, unchanged`)
        return
      }
      line = regionLine(n, caps)
      flush()
      for (const c of n.children ?? []) visit(c, false)
      flush()
      return
    }
    const brief = caps.brief && n.ref && !inRow ? recordsLine(n, origin, { ...caps, brief: false }) : undefined
    if (brief) {
      flush()
      lines.push(brief)
      // Whatever else the container holds (a heading, pagination) is still read.
      for (const c of n.children ?? []) if (!rowsOf(c).length) visit(c, false)
      return
    }
    // A collection of records starts with its own line, so `get <ref>` is in reach from the text as from
    // the map; then it reads as its contents, as a canvas does.
    if (n.ref && COLLECTIONS.has(n.role ?? '') && !inRow) {
      const rows = rowsOf(n).filter(r => !isHeaderRow(r)).length
      if (rows >= 2) { flush(); lines.push(`[${n.ref}] ${n.role} of ${rows}`) }
    }
    if (n.ref && !COLLECTIONS.has(n.role ?? '') && n.role !== 'canvas') {
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
    for (const c of n.children ?? []) visit(c, !!n.row)
    if (n.block) flush()
  }
  visit(root, false)
  flush()
  return lines.join('\n')
}

// The subtree for a ref (a region, a control), for zooming in.
export function findRef(n: Node, ref: number): Node | undefined {
  if (n.ref === ref) return n
  for (const c of n.children ?? []) {
    const hit = findRef(c, ref)
    if (hit) return hit
  }
  return undefined
}

const FIELDS = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'listbox'])

// A collection of records in one line: how many, and its first record that shows something, or a table's column
// names (its header row is its schema, counted out of the records). Nothing for a collection without records.
function recordsLine(n: Node, origin: string, caps: Caps): string | undefined {
  if (!COLLECTIONS.has(n.role ?? '')) return undefined
  const all = rowsOf(n)
  const header = all.find(isHeaderRow)
  const rows = all.filter(r => r !== header)
  if (!rows.length) return undefined
  const line = (r: Node) => clipTo(renderText({ block: true, children: [r] }, origin, caps).replace(/\n/g, ' · '), caps.nameChars)
  const sample = header ? `columns ${cellsOf(header).map(c => renderText({ block: true, children: c.children }, origin, caps)).join(' · ')}` : `${line(rows.find(r => line(r)) ?? rows[0])}${rows.length > 1 ? ' …' : ''}`
  return `[${n.ref}] ${n.role} of ${rows.length}: ${sample}`
}

// The page as regions, the way screen-reader users survey it: per landmark its headings, collections
// (item count and the first item), fields, actions and links. Named when few, counted when many.
// main: the main landmark is the page's primary content (WAI-ARIA). When its text, with each list of records as its
// one line, is no longer than main.chars, it is given as that text, refs and all, in place of its summary: a summary
// of a short article or form tells an agent nothing it can act on, and it reads the region in its next call. Records
// stay one line, since get is how they are read. given collects what was given so.
export function renderMap(root: Node, origin: string, caps: Caps, few: number, seen?: Seen, main?: { chars: number; given: Map<number, string> }): string {
  const out: string[] = []
  const summarize = (title: string, nodes: Node[], region?: Node) => {
    if (region?.role === 'main' && main) {
      if (seen && unchanged(region, renderText({ block: true, children: [region] }, origin, caps), seen)) return void out.push(`${title} — shown before, unchanged`)
      const text = renderText({ block: true, children: [region] }, origin, { ...caps, brief: true })
      if (text.length <= main.chars) { main.given.set(region.ref!, text); return void out.push(text) }
    }
    const headings: string[] = []
    const lists: string[] = []
    const fields: Node[] = []
    const actions: Node[] = []
    const options: Node[] = []
    const links: Node[] = []
    const nested: Node[] = []
    let text = 0
    const walk = (n: Node) => {
      if (n.text !== undefined) { text += n.text.trim().length; return }
      if (isRegion(n)) { nested.push(n); return }
      // A heading names a part of the page; one wrapped around a whole region (an app's banner) is markup
      // misuse, and the region is what the map shows.
      if (n.role === 'heading' && !withRefs(n).some(isRegion)) { headings.push(renderText({ block: true, children: n.children }, origin, caps)); return }
      if (COLLECTIONS.has(n.role ?? '')) {
        const records = recordsLine(n, origin, caps)
        if (records) {
          lists.push(records)
          // Whatever else the container holds (a heading, pagination) still belongs in the map, and so
          // does a collection nested inside one of its rows.
          const nestedLists = (r: Node): void => (r.children ?? []).forEach(c => (COLLECTIONS.has(c.role ?? '') ? walk(c) : nestedLists(c)))
          for (const c of n.children ?? []) if (rowsOf(c).length) nestedLists(c); else walk(c)
          return
        }
        const line = itemsLine(n, origin, caps, few)
        if (line) { lists.push(line); return }
      }
      if (n.role === 'canvas') {
        const lines = n.children ?? []
        lists.push(`[${n.ref}] canvas: ${lines.length} lines — ${clipTo(renderText({ block: true, children: lines.slice(0, 1) }, origin, caps), caps.nameChars)}${lines.length > 1 ? ' …' : ''}`)
        return
      }
      if (n.ref && !COLLECTIONS.has(n.role ?? '')) (FIELDS.has(n.role ?? '') ? fields : n.role === 'option' ? options : n.role === 'link' ? links : actions).push(n)
      for (const c of n.children ?? []) walk(c)
    }
    nodes.forEach(walk)
    // A footer (contentinfo) holds links about the site, not the task: counted, and read <ref> names them.
    const shown = region?.role === 'contentinfo' ? 0 : few
    const named = (label: string, list: Node[]) => {
      if (!list.length) return
      out.push(list.length <= shown
        ? `  ${label}: ${list.map(n => control(n, origin, caps).trim()).join(' · ')}`
        : `  ${label}: ${list.length}`)
    }
    const body = out.length
    named('fields', fields)
    named('options', options)
    named('actions', actions)
    if (headings.length) out.push(`  headings: ${headings.slice(0, few).join(' · ')}${headings.length > few ? ` … ${headings.length - few} more` : ''}`)
    lists.slice(0, shown).forEach(l => out.push(`  ${l}`))
    if (lists.length > shown) out.push(`  … ${lists.length - shown} more collections`)
    named('links', links)
    if (text) out.push(`  text: ${text} chars`)
    if (out.length > body) out.splice(body, 0, title)
    if (region && seen && unchanged(region, renderText({ block: true, children: [region] }, origin, caps), seen) && out.length > body + 1) out.splice(body, Infinity, `${title} — shown before, unchanged`)
    nested.forEach(r => summarize(regionLine(r, caps), r.children ?? [], r))
  }
  summarize('page (outside any region)', root.children ?? [])
  const closed = withRefs(root).filter(isTrigger).length
  if (closed) out.push(`closed menus and pop-ups: ${closed} (explore lists them)`)
  return out.join('\n')
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

// What an action removed is the old state, so only a few of those lines are named; the count says the rest.
export const goneLines = (removed: string[], few: number) =>
  [...removed.slice(0, few).map(l => `- ${l}`), ...(removed.length > few ? [`… ${removed.length - few} more gone`] : [])]

// A file the agent reads with sed, rg and head holds no line longer than `max`: a long line printed whole is
// the largest thing an agent ever carries. JSON (an API body, an eval's result) breaks between its elements
// and stays valid JSON; text breaks at a space. A single string or word longer than `max` stays whole.
export function bounded(text: string, max: number): string {
  return text.split('\n').map(l => (l.length <= max ? l : /^\s*[[{]/.test(l) && jsonLines(l, max) || wrap(l, max))).join('\n')
}

function jsonLines(line: string, max: number): string | undefined {
  let value: unknown
  try { value = JSON.parse(line) } catch { return undefined }
  const lines = (v: unknown): string[] => {
    const whole = JSON.stringify(v)
    if (whole.length <= max || typeof v !== 'object' || v === null) return [whole]
    const [open, close, parts] = Array.isArray(v)
      ? ['[', ']', v.map(lines)]
      : ['{', '}', Object.entries(v).map(([k, x]) => { const l = lines(x); l[0] = `${JSON.stringify(k)}:${l[0]}`; return l })]
    parts.forEach((l, i) => { if (i < parts.length - 1) l[l.length - 1] += ',' })
    return [open as string, ...(parts as string[][]).flat(), close as string]
  }
  return lines(value).join('\n')
}

function wrap(line: string, max: number): string {
  const out: string[] = []
  let rest = line
  while (rest.length > max) {
    let at = rest.lastIndexOf(' ', max)
    if (at <= 0) at = rest.indexOf(' ', max)
    if (at < 0) break
    out.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  return [...out, rest].join('\n')
}

// What a bulk call (each, open) leaves in its --out file and says in its answer. The file is plain lines for
// grep, sed and head: a header line `== <address>  <status>` per page, then the page's own lines. A page line
// that begins with `== ` gets a leading space so `rg -n '^== '` finds pages and only pages.
export type Bulk = { address: string; status?: number; error?: string; title: string; text: string }

const failure = (b: Bulk) => b.error ?? (b.status !== undefined && b.status >= 400 ? `HTTP ${b.status}` : undefined)
const linesOf = (b: Bulk, max: number) => (b.text ? bounded(b.text, max).split('\n') : [])

const bulkPage = (b: Bulk, max: number) => {
  const mark = b.error ? `error: ${b.error}` : failure(b) ?? (b.status === undefined ? '' : `[${b.status}]`)
  return [`== ${b.address}${mark ? `  ${mark}` : ''}`, ...linesOf(b, max).map(l => (l.startsWith('== ') ? ` ${l}` : l))].join('\n')
}

export const bulkFile = (pages: Bulk[], max: number) => `${pages.map(b => bulkPage(b, max)).join('\n')}\n`

// The pages a bulk file holds, as they were written.
function readBulk(file: string): Bulk[] {
  const pages: Bulk[] = []
  const lines: string[][] = []
  for (const line of readFileSync(file, 'utf8').replace(/\n$/, '').split('\n')) {
    if (!line.startsWith('== ')) { lines.at(-1)?.push(line.replace(/^ (== )/, '$1')); continue }
    const [address, mark = ''] = line.slice(3).split(/ {2}(.*)/s)
    const status = /^\[(\d+)\]$|^HTTP (\d+)$/.exec(mark)
    pages.push({ address, title: '', text: '', status: status ? Number(status[1] ?? status[2]) : undefined, error: mark.startsWith('error: ') ? mark.slice(7) : undefined })
    lines.push([])
  }
  return pages.map((p, i) => ({ ...p, text: lines[i].join('\n') }))
}

// A bulk call (each, open) writes its file page by page, so a call cut short leaves the pages it had read, and beside
// it, while any page is missing or failed, `<file>.unfinished`: the command and the addresses, in order. The same
// command run again keeps the pages the file holds as read and fetches the rest; any other command replaces the file.
// The file ends in the order of the addresses, whatever order the pages came in.
export function bulkRun(file: string, command: string[], max: number) {
  const mark = `${file}.unfinished`
  const kept = new Map<string, Bulk>()
  if (existsSync(file) && existsSync(mark) && readFileSync(mark, 'utf8') === command.join('\n')) {
    for (const b of readBulk(file)) if (!failure(b)) kept.set(b.address, b)
  }
  writeFileSync(file, kept.size ? bulkFile([...kept.values()], max) : '')
  writeFileSync(mark, command.join('\n'))
  return {
    kept,
    add: (b: Bulk) => appendFileSync(file, `${bulkPage(b, max)}\n`),
    finish(pages: Bulk[]) {
      writeFileSync(file, bulkFile(pages, max))
      if (!pages.some(failure)) rmSync(mark)
    },
  }
}

// Counts, each failure with its reason, one headline per page that read (title or first line, size, the line
// where it starts in the file), each list cut at its bound with the number left out.
export function bulkAnswer(name: string, pages: Bulk[], file: string, p: Pick<Policy, 'bulk.pages' | 'bulk.failures' | 'bulk.headlineChars' | 'save.lineChars'>, kept = 0): string {
  const failed = pages.filter(failure)
  const cut = (s: string) => (s.length > p['bulk.headlineChars'] ? `${s.slice(0, p['bulk.headlineChars'] - 1)}…` : s)
  const lines = [`${name}: ${pages.length} pages, ${failed.length} failed, ${kept ? `${kept} kept from the file, ` : ''}saved ${file}`]
  if (failed.length) lines.push('failed:', ...failed.slice(0, p['bulk.failures']).map(b => `  ${b.address} — ${cut(failure(b)!)}`))
  if (failed.length > p['bulk.failures']) lines.push(`… ${failed.length - p['bulk.failures']} more`)
  if (failed.length) lines.push('the same command run again fetches only the failed')
  let at = 1
  const heads: string[] = []
  for (const b of pages) {
    const n = linesOf(b, p['save.lineChars']).length
    if (!failure(b)) heads.push(`${b.address}  ${cut(b.title ? `"${b.title}"` : b.text.split('\n').find(l => l.trim()) ?? '')} · ${n} lines, ${b.text.length} chars · line ${at}`)
    at += 1 + n
  }
  lines.push(...heads.slice(0, p['bulk.pages']))
  if (heads.length > p['bulk.pages']) lines.push(`… ${heads.length - p['bulk.pages']} more`)
  lines.push(`find a page: rg -n '^== ' ${file}; read part: sed -n 20,60p ${file}`)
  return lines.join('\n')
}

// XML is data, not a page: the HTML reader would run a sitemap's entries together into one line. Each element
// made only of text elements (a sitemap's <url>, a feed's <item>) is a record: one line of those texts.
export function xmlLines(xml: string): string {
  const unescape = (s: string) => s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]!)
  type Open = { text: string; leaves: string[]; nested: boolean; mixed: boolean }
  const stack: Open[] = [{ text: '', leaves: [], nested: false, mixed: false }]
  const lines: string[] = []
  const top = () => stack[stack.length - 1]
  for (const [, cdata, close, tag, selfClose, text] of xml.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\w[^>]*>|<(\/?)([^\s>\/]+)[^>]*?(\/?)>|([^<]+)/g)) {
    if (cdata !== undefined) top().text += cdata
    else if (text !== undefined) top().text += unescape(text)
    else if (tag && !close) {
      top().nested = true
      if (!selfClose) stack.push({ text: '', leaves: [], nested: false, mixed: false })
    } else if (close && stack.length > 1) {
      const done = stack.pop()!
      const value = done.text.trim().replace(/\s+/g, ' ')
      if (!done.nested) { if (value) top().leaves.push(value) } else if (!done.mixed && done.leaves.length) lines.push(done.leaves.join(' '))
      if (done.nested) top().mixed = true
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : ''
}
