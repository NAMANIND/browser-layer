import { parse, type DefaultTreeAdapterMap } from 'parse5'
import { COLLECTIONS, LANDMARKS, SPACE, type Node } from './reader.js'

// The fast path: HTML as the server sent it, parsed as a browser would (parse5 implements the HTML
// parsing algorithm) with scripting off, so <noscript> content is there and nothing runs. The result
// is the same Node tree the live reader builds, so the same renderer shows it.

type El = DefaultTreeAdapterMap['element']
type Child = DefaultTreeAdapterMap['childNode']

export type Page = { url: string; status: number; title: string; tree: Node; links: Record<number, string>; scripts: number }

// HTML rendering (§15.3): elements whose default display is not inline. Everything else is inline.
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'br', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'listing', 'main', 'menu', 'nav', 'ol', 'p', 'plaintext', 'pre', 'search', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul', 'xmp'])
// Not rendered by default, or never content.
const UNRENDERED = new Set(['head', 'script', 'style', 'template', 'title', 'link', 'meta', 'base', 'datalist', 'noembed', 'noframes', 'param', 'rp', 'area', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'video', 'audio', 'img', 'picture'])
const WIDGETS = new Set(['button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem'])
const ROWS = new Set(['row', 'listitem', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem'])
const CELLS = new Set(['cell', 'gridcell', 'columnheader', 'rowheader'])
// Accessible name computation: roles whose name comes from their content.
const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'cell', 'columnheader', 'rowheader', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'checkbox', 'radio', 'switch'])
const KNOWN_ROLES = new Set([...WIDGETS, ...ROWS, ...LANDMARKS, ...COLLECTIONS, ...CELLS, 'heading', 'none', 'presentation', 'generic', 'dialog'])
const SECTIONING = new Set(['article', 'aside', 'main', 'nav', 'section'])

const attr = (el: El, name: string) => el.attrs.find(a => a.name === name)?.value
const squash = (s: string) => s.replace(SPACE, ' ').trim()
const isEl = (n: Child): n is El => 'tagName' in n

function hiddenEl(el: El): boolean {
  if (UNRENDERED.has(el.tagName) || attr(el, 'hidden') !== undefined) return true
  if (el.tagName === 'input' && attr(el, 'type')?.toLowerCase() === 'hidden') return true
  if (el.tagName === 'dialog' && attr(el, 'open') === undefined) return true
  // Inline style is the only CSS the fast path can see.
  const style = (attr(el, 'style') ?? '').replace(/\s/g, '').toLowerCase()
  return style.includes('display:none') || style.includes('visibility:hidden')
}

const textOf = (n: Child): string => ('value' in n && n.nodeName === '#text' ? n.value : isEl(n) && !hiddenEl(n) ? n.childNodes.map(textOf).join('') : '')

const holdsTable = (el: El): boolean => el.childNodes.some(c => isEl(c) && (c.tagName === 'table' || holdsTable(c)))
const layout = (table: El) => attr(table, 'role') === 'presentation' || holdsTable(table)
let tableOf: (el: El) => El | undefined = () => undefined
const layoutCell = (el: El) => { const t = tableOf(el); return !!t && layout(t) }

// HTML-AAM: an element's implicit role.
function implicitRole(el: El, inSection: boolean): string {
  const t = el.tagName
  const type = attr(el, 'type')?.toLowerCase() ?? 'text'
  switch (t) {
    case 'a': return attr(el, 'href') !== undefined ? 'link' : ''
    case 'button': case 'summary': return 'button'
    case 'select': return attr(el, 'multiple') !== undefined || Number(attr(el, 'size') ?? 0) > 1 ? 'listbox' : 'combobox'
    case 'textarea': return 'textbox'
    case 'option': return 'option'
    case 'input':
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'checkbox' || type === 'radio') return type
      if (type === 'search') return 'searchbox'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      return type === 'file' ? 'button' : 'textbox'
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading'
    case 'nav': return 'navigation'
    case 'main': return 'main'
    case 'aside': return 'complementary'
    case 'search': return 'search'
    case 'header': return inSection ? '' : 'banner'
    case 'footer': return inSection ? '' : 'contentinfo'
    case 'form': return attr(el, 'aria-label') || attr(el, 'aria-labelledby') ? 'form' : ''
    case 'section': return attr(el, 'aria-label') || attr(el, 'aria-labelledby') ? 'region' : ''
    case 'ul': case 'ol': case 'menu': return 'list'
    case 'li': return 'listitem'
    // A table that holds another table lays out the page rather than holding data (browsers treat it so),
    // and so do its rows and cells.
    case 'table': return layout(el) ? '' : 'table'
    case 'tr': return layoutCell(el) ? '' : 'row'
    case 'th': return layoutCell(el) ? '' : 'columnheader'
    case 'td': return layoutCell(el) ? '' : 'cell'
    case 'dialog': return 'dialog'
    default: return ''
  }
}

export function readHtml(html: string, url: string, status: number): Page {
  const doc = parse(html, { scriptingEnabled: false })
  const all: El[] = []
  const collect = (n: Child | typeof doc) => { if ('tagName' in n) all.push(n as El); for (const c of ('childNodes' in n ? n.childNodes : []) as Child[]) collect(c) }
  collect(doc)
  const byId = new Map(all.flatMap(el => (attr(el, 'id') ? [[attr(el, 'id')!, el] as const] : [])))
  const baseEl = all.find(el => el.tagName === 'base' && attr(el, 'href'))
  const base = new URL(baseEl ? attr(baseEl, 'href')! : url, url).href
  const titleEl = all.find(el => el.tagName === 'title')
  const title = titleEl ? squash(titleEl.childNodes.map(c => ('value' in c ? c.value : '')).join('')) : ''
  const parent = new Map<El, El>()
  for (const el of all) for (const c of el.childNodes) if (isEl(c)) parent.set(c, el)
  const ancestors = function* (el: El) { for (let p = parent.get(el); p; p = parent.get(p)) yield p }
  tableOf = el => [...ancestors(el)].find(a => a.tagName === 'table')
  const labels = (el: El) => {
    const id = attr(el, 'id')
    const own = id ? all.filter(l => l.tagName === 'label' && attr(l, 'for') === id) : []
    const wrap = [...ancestors(el)].find(a => a.tagName === 'label')
    return [...own, ...(wrap ? [wrap] : [])]
  }

  // Accessible name, the parts of the computation the HTML alone can answer.
  function nameOf(el: El, role: string): string {
    const by = attr(el, 'aria-labelledby')
    if (by) { const t = squash(by.split(/\s+/).map(id => (byId.get(id) ? textOf(byId.get(id)!) : '')).join(' ')); if (t) return t }
    const label = squash(attr(el, 'aria-label') ?? '')
    if (label) return label
    if (['input', 'select', 'textarea', 'button'].includes(el.tagName)) {
      const t = squash(labels(el).map(l => textOf(l)).join(' '))
      if (t) return t
    }
    const type = attr(el, 'type')?.toLowerCase()
    if (el.tagName === 'input' && type === 'image') return squash(attr(el, 'alt') ?? '')
    if (el.tagName === 'input' && (type === 'submit' || type === 'reset' || type === 'button')) return squash(attr(el, 'value') ?? (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : ''))
    if (NAME_FROM_CONTENT.has(role)) {
      const t = squash(el.childNodes.map(c => (isEl(c) && c.tagName === 'img' ? ` ${attr(c, 'alt') ?? ''} ` : textOf(c))).join(''))
      if (t) return t
    }
    return squash(attr(el, 'title') ?? attr(el, 'placeholder') ?? '')
  }

  let next = 1
  const links: Record<number, string> = {}
  const hasRef = (nodes: Node[]): boolean => nodes.some(n => n.ref || (n.children && hasRef(n.children)))
  const content = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
  const plainText = (nodes: Node[]): string => nodes.map(n => n.text ?? plainText(n.children ?? [])).join('')

  function walk(n: Child, muted: boolean, inSection: boolean): Node[] {
    if (n.nodeName === '#text' && 'value' in n) return [{ text: n.value }]
    if (!isEl(n) || hiddenEl(n)) return []
    const el = n
    const quiet = muted || attr(el, 'aria-hidden') === 'true'
    const explicit = attr(el, 'role')?.split(/\s+/).find(r => KNOWN_ROLES.has(r))
    const role = quiet ? '' : explicit === 'presentation' || explicit === 'none' || explicit === 'generic' ? '' : explicit ?? implicitRole(el, inSection)
    // A closed dropdown shows its value, not its options; a list box (multiple, or size > 1) shows them.
    const children = role === 'combobox' && el.tagName === 'select' ? [] : el.childNodes.flatMap(c => walk(c, quiet, inSection || SECTIONING.has(el.tagName)))
    if (el.tagName === 'br') return [{ block: true }]
    const block = BLOCK.has(el.tagName)
    if (WIDGETS.has(role)) {
      const name = nameOf(el, role)
      const states: string[] = []
      if (role === 'checkbox' || role === 'radio') states.push(attr(el, 'checked') !== undefined || attr(el, 'aria-checked') === 'true' ? 'checked' : 'unchecked')
      if (el.tagName === 'summary') states.push(parent.get(el) && attr(parent.get(el)!, 'open') !== undefined ? 'expanded' : 'collapsed')
      if (attr(el, 'disabled') !== undefined || attr(el, 'aria-disabled') === 'true') states.push('disabled')
      if (attr(el, 'required') !== undefined) states.push('required')
      const value = el.tagName === 'textarea' ? textOf(el) : el.tagName === 'select' ? squash(textOf(el.childNodes.filter(isEl).find(o => attr(o, 'selected') !== undefined) ?? el.childNodes.filter(isEl)[0] ?? el)) : role === 'textbox' || role === 'searchbox' ? attr(el, 'value') : undefined
      const ref = next++
      // An address that does not parse goes nowhere, as in a browser (HTML: the link has no URL).
      const href = role === 'link' && URL.canParse(attr(el, 'href') ?? '', base) ? new URL(attr(el, 'href')!, base).href : undefined
      if (href) links[ref] = href
      return [{ ref, role, name, nameShown: content(plainText(children)).includes(content(name)), states, url: href, block, value: value || undefined, children: hasRef(children) ? children : undefined }]
    }
    if (role === 'heading') return [{ role, level: Number(attr(el, 'aria-level') ?? el.tagName.slice(1)) || 2, block: true, children }]
    if (LANDMARKS.has(role) || role === 'dialog') return [{ ref: next++, role, name: nameOf(el, role), block: true, children }]
    if (COLLECTIONS.has(role)) return [{ ref: next++, role, block: true, children }]
    if (ROWS.has(role)) return [{ row: true, block: true, children }]
    if (CELLS.has(role)) return [{ cell: true, header: role === 'columnheader', block: true, children }]
    return block ? [{ block: true, children }] : children
  }

  const body = all.find(el => el.tagName === 'body')
  const tree: Node = { block: true, children: body ? walk(body, false, false) : [] }
  return { url, status, title, tree, links, scripts: all.filter(el => el.tagName === 'script').length }
}
