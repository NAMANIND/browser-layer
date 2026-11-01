import { control, renderText, type Caps } from './render.js'
import { cellsOf, COLLECTIONS, isHeaderRow, picturesIn, rowsOf, SEGMENT, SPACE, TABLES, type Node } from './reader.js'

// A collection as records: columns and rows of cell text. Column ids are always c1…cN; a table's
// header row also gives them names.
export type Records = { columns: string[]; names: string[]; rows: string[][] }

// A part made only of punctuation or symbols (a dash between two times) carries no data.
const mark = /^[\p{P}\p{S}]+$/u

export function records(collection: Node, origin: string, caps: Caps): Records {
  if (collection.role === 'canvas') return canvasRecords(collection.drawn ?? [])
  return TABLES.has(collection.role ?? '') ? tableRecords(collection, origin, caps) : listRecords(collection, origin, caps)
}

// A canvas has no cells, only text drawn at positions. Text drawn on one line is a row; the places where
// text starts, gathered over the whole canvas, are its columns. A wrapped cell is several rows.
const SAME_LINE_PX = 4 // the same tolerance the page hook uses to put text on one line
const SAME_COLUMN_PX = 8 // starts closer than this are one column (glyph and padding differences)
function canvasRecords(drawn: [string, number, number][]): Records {
  const starts = [...new Set(drawn.map(([, x]) => Math.round(x)))].sort((a, b) => a - b)
  const columns: number[] = []
  for (const x of starts) if (!columns.length || x - columns[columns.length - 1] >= SAME_COLUMN_PX) columns.push(x)
  const column = (x: number) => columns.reduce((best, c, k) => (c <= x + SAME_COLUMN_PX / 2 ? k : best), 0)
  const rows: string[][] = []
  let lineY = Number.NEGATIVE_INFINITY
  for (const [t, x, y] of [...drawn].sort((a, b) => a[2] - b[2] || a[1] - b[1])) {
    if (y - lineY >= SAME_LINE_PX) { rows.push(columns.map(() => '')); lineY = y }
    const row = rows[rows.length - 1]
    const k = column(x)
    row[k] = row[k] ? `${row[k]} ${t}` : t
  }
  const ids = columns.map((_, k) => `c${k + 1}`)
  return { columns: ids, names: ids.map(() => ''), rows }
}

// HTML table model: a column is a cell position; the first all-header row names the columns.
function tableRecords(table: Node, origin: string, caps: Caps): Records {
  const text = (cell: Node) => renderText({ block: true, children: cell.children }, origin, caps).replace(/\n/g, ' · ')
  let names: string[] = []
  const rows: string[][] = []
  for (const row of rowsOf(table)) {
    if (!names.length && !rows.length && isHeaderRow(row)) names = cellsOf(row).map(text)
    else rows.push(cellsOf(row).map(text))
  }
  const width = Math.max(names.length, ...rows.map(r => r.length), 0)
  const columns = Array.from({ length: width }, (_, i) => `c${i + 1}`)
  return { columns, names: columns.map((_, i) => names[i] ?? ''), rows: rows.map(r => columns.map((_, i) => r[i] ?? '')) }
}

// Lists have no column model. Each row's text is split by the innermost field it sits in (DESIGN §4.5);
// the field's path inside the row is its column, so rows from one template line up even when some rows
// have optional parts. The template is what repeats: a class only one row has (an item id) is that
// row's identity, not structure, and is left out of its paths.
function listRecords(list: Node, origin: string, caps: Caps): Records {
  const rows = rowsOf(list)
  const tokensOf = (key: string) => key.split(SEGMENT).flatMap(seg => seg.split(' ').slice(1))
  const rowsWith = new Map<string, number>()
  for (const row of rows) {
    const mine = new Set<string>()
    const collect = (n: Node) => { if (n.key) tokensOf(n.key).forEach(t => mine.add(t)); (n.children ?? []).forEach(collect) }
    collect(row)
    for (const t of mine) rowsWith.set(t, (rowsWith.get(t) ?? 0) + 1)
  }
  const template = (key: string) => key.split(SEGMENT).map(seg => seg.split(' ').filter((t, i) => i === 0 || (rowsWith.get(t) ?? 0) > 1).join(' ')).join(SEGMENT)
  const keys: string[] = []
  const cells = rows.map(row => {
    const cell = new Map<string, string>()
    const seen = new Map<string, number>()
    // The same path twice in one row is two fields: the second becomes path#2.
    const field = (raw: string) => {
      const key = template(raw)
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      return n === 1 ? key : `${key}#${n}`
    }
    const put = (key: string, s: string) => cell.set(key, (cell.get(key) ?? '') + s)
    const visit = (n: Node, key: string) => {
      if (n.text !== undefined) return put(key, n.text)
      if (n.role === 'image') return caps.urls && put(n.key ? field(n.key) : key, n.url!)
      if (n.ref && !COLLECTIONS.has(n.role ?? '')) {
        put(n.key ? field(n.key) : key, control(n, origin, caps))
        return picturesIn(n.children ?? []).forEach(p => visit(p, key))
      }
      const here = n.key ? field(n.key) : key
      for (const c of n.children ?? []) visit(c, here)
    }
    for (const c of row.children ?? []) visit(c, '')
    // A record names each page once: a store links the picture, the title and the price to one page, and an
    // address that differs only by its #fragment is a place in that same page (URL standard).
    const named = new Set<string>()
    const page = (u: string) => u.split('#')[0]
    if (caps.urls) for (const [k, v] of cell) cell.set(k, v.replace(/(?:→ )?(https?:\/\/\S+)/g, (m, u) => (named.has(page(u)) ? '' : (named.add(page(u)), m))))
    for (const [k, v] of cell) {
      const t = v.replace(SPACE, ' ').trim()
      if (t && !mark.test(t)) cell.set(k, t)
      else cell.delete(k)
      if (cell.has(k) && !keys.includes(k)) keys.push(k)
    }
    return cell
  })
  const columns = keys.map((_, i) => `c${i + 1}`)
  return { columns, names: columns.map(() => ''), rows: cells.map(cell => keys.map(k => cell.get(k) ?? '')) }
}

// Numbers compare as numbers: digit-group separators go ("₹1,18,899"), 12-hour times become
// 24-hour ("1:05 PM" → "13:05"), then the standard collator compares numeric runs by value.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const sortKey = (v: string) =>
  v.replace(/(\d)[,  ](?=\d)/g, '$1')
    .replace(/\b(\d{1,2}):(\d\d)\s?([AP])M\b/gi, (_, h, m, p) => `${String((Number(h) % 12) + (p.toUpperCase() === 'P' ? 12 : 0)).padStart(2, '0')}:${m}`)

export type Query = { sort?: string; desc?: boolean; limit?: number; cols?: string[]; urls?: boolean }

export function query(data: Records, q: Query): Records {
  // A column is named by its id (c3) or, in a table, by its header text.
  const index = (c: string) => {
    const i = data.columns.indexOf(c) >= 0 ? data.columns.indexOf(c) : data.names.findIndex(n => n && n.toLowerCase() === c.toLowerCase())
    if (i < 0) throw new Error(`no column "${c}"; columns are ${data.columns.map((id, k) => (data.names[k] ? `${id} (${data.names[k]})` : id)).join(', ')}`)
    return i
  }
  let rows = data.rows
  if (q.sort) {
    const i = index(q.sort)
    // Rows with no value in the sort column go last either way.
    rows = [...rows].sort((a, b) => (!a[i] ? 1 : !b[i] ? -1 : collator.compare(sortKey(a[i]), sortKey(b[i])) * (q.desc ? -1 : 1)))
  }
  if (q.limit !== undefined) rows = rows.slice(0, q.limit)
  const pick = q.cols?.map(index) ?? data.columns.map((_, i) => i)
  return { columns: pick.map(i => data.columns[i]), names: pick.map(i => data.names[i]), rows: rows.map(r => pick.map(i => r[i])) }
}

// Tab-separated: a header of column ids (with names where the table has them), then one record per line.
export const toTsv = (data: Records) =>
  [data.columns.map((c, i) => (data.names[i] ? `${c} ${data.names[i]}` : c)).join('\t'), ...data.rows.map(r => r.join('\t'))].join('\n')
