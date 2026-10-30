import type { CDPSession } from 'playwright-core'

// What the page shows, as a tree. Rendering decides lines; the reader only reports facts.
export type Node = {
  ref?: number
  role?: string
  name?: string
  // Everything the name says is on screen; otherwise it is a label only assistive tech hears.
  nameShown?: boolean
  value?: string
  states?: string[]
  url?: string
  level?: number
  text?: string
  block?: boolean
  row?: boolean
  // A field inside a row (a block, a control, a cell, generated content): its element path from the row
  // (tags and classes). Rows built from one template share a path for the same field, which is how
  // records line up into columns.
  key?: string
  // A table cell (HTML table model); header marks a column header cell.
  cell?: boolean
  header?: boolean
  // One of several siblings with the same element signature and parts: a record in a collection the page
  // did not mark up as a list (§4.5). Records are addressable; they do not change how the page reads.
  record?: boolean
  children?: Node[]
}

// Refs are small numbers the agent types. Each maps to the browser's own node id; numbers are never
// reused within a tab, so a ref from an old page can only miss, never hit the wrong element.
export type Refs = { byNode: Map<number, number>; byRef: Map<number, number>; next: number }
export const newRefs = (): Refs => ({ byNode: new Map(), byRef: new Map(), next: 1 })

// ARIA widget roles: the things a user operates. Everything else is content.
const WIDGETS = new Set(['button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem'])
// Roles that are one item on screen (a result, a table row): their content reads as one line.
const ROWS = new Set(['row', 'listitem', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem'])
// ARIA landmarks: the regions a page is made of, as screen-reader users jump between them.
export const LANDMARKS = new Set(['banner', 'navigation', 'main', 'search', 'complementary', 'contentinfo', 'region', 'form'])
// Containers whose items are a collection: a list of results, a table of rows, a set of tabs.
export const COLLECTIONS = new Set(['list', 'table', 'grid', 'treegrid', 'tree', 'menu', 'menubar', 'tablist', 'radiogroup'])
const CELLS = new Set(['cell', 'gridcell', 'columnheader', 'rowheader'])
export const TABLES = new Set(['table', 'grid', 'treegrid'])
// Separates the segments of a field path (Node.key).
export const SEGMENT = '\u001e'

// The rows of a collection and the cells of a row, not descending into nested collections.
export const rowsOf = (n: Node): Node[] => (n.row || n.record ? [n] : (n.children ?? []).flatMap(c => (COLLECTIONS.has(c.role ?? '') ? [] : rowsOf(c))))
export const cellsOf = (n: Node): Node[] => (n.cell ? [n] : (n.children ?? []).flatMap(c => (COLLECTIONS.has(c.role ?? '') ? [] : cellsOf(c))))
// HTML table model: a row whose cells are all column headers names the columns.
export const isHeaderRow = (row: Node) => { const cells = cellsOf(row); return cells.length > 0 && cells.every(c => c.header) }
// CSS outer display types that stay in the line; every other display value starts a new block.
const INLINE_DISPLAY = /^(inline|contents|ruby)/
const BOOLEAN_STATES = ['focused', 'disabled', 'selected', 'required', 'readonly', 'busy', 'modal']

type AXNode = { ignored: boolean; role?: { value?: unknown }; name?: { value?: unknown }; value?: { value?: unknown }; properties?: { name: string; value: { value?: unknown } }[]; backendDOMNodeId?: number }

function statesOf(ax: AXNode): { states: string[]; url?: string; level?: number } {
  const states: string[] = []
  let url: string | undefined
  let level: number | undefined
  for (const { name, value: { value } } of ax.properties ?? []) {
    if (name === 'checked') states.push(value === 'mixed' ? 'mixed' : value === 'true' ? 'checked' : 'unchecked')
    else if (name === 'expanded') states.push(value ? 'expanded' : 'collapsed')
    else if (name === 'pressed' && value === 'true') states.push('pressed')
    else if (name === 'invalid' && value !== 'false') states.push('invalid')
    else if (BOOLEAN_STATES.includes(name) && value === true) states.push(name)
    else if (name === 'url') url = String(value)
    else if (name === 'level') level = Number(value)
  }
  return { states, url, level }
}

export type Limits = { minRepeats: number; minParts: number }

export async function readTree(cdp: CDPSession, refs: Refs, limits: Limits): Promise<Node> {
  const [{ nodes: ax }, snap] = await Promise.all([
    cdp.send('Accessibility.getFullAXTree') as Promise<{ nodes: AXNode[] }>,
    cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: ['display', 'visibility', 'opacity'] }),
  ])
  const axOf = new Map(ax.filter(n => n.backendDOMNodeId).map(n => [n.backendDOMNodeId!, n]))
  const str = (i: number | undefined) => (i === undefined || i < 0 ? '' : snap.strings[i])
  const doc = snap.documents[0]
  const { parentIndex = [], nodeType = [], nodeName = [], nodeValue = [], backendNodeId = [], attributes = [] } = doc.nodes
  const attr = (i: number, name: string) => {
    const a = attributes[i] ?? []
    for (let k = 0; k < a.length; k += 2) if (str(a[k]) === name) return str(a[k + 1])
    return undefined
  }
  const kids: number[][] = nodeType.map(() => [])
  parentIndex.forEach((p, i) => { if (p >= 0) kids[p].push(i) })
  const layoutOf = new Map(doc.layout.nodeIndex.map((n, l) => [n, l]))

  const refFor = (id: number) => {
    let ref = refs.byNode.get(id)
    if (!ref) { ref = refs.next++; refs.byNode.set(id, ref); refs.byRef.set(ref, id) }
    return ref
  }
  const hasRef = (nodes: Node[]): boolean => nodes.some(n => n.ref || (n.children && hasRef(n.children)))
  const textOf = (nodes: Node[]): string => nodes.map(n => n.text ?? textOf(n.children ?? [])).join('')
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
  // Content, not formatting: "Airport Mumbai (BOM)" is on screen as "Airport MumbaiBOM 15 km away".
  const content = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()

  // muted: inside aria-hidden (text shows, controls get no ref). unseen: visibility hidden or opacity 0.
  // path: this node's place inside the nearest row, for lining records up. marked: inside a collection
  // the page marked up itself, where its own rows win over detected ones.
  function walk(i: number, muted: boolean, unseen: boolean, path = '', marked = false): Node[] {
    const l = layoutOf.get(i)
    if (nodeType[i] === 3) {
      if (l === undefined || unseen) return []
      const text = str(doc.layout.text[l]) || str(nodeValue[i])
      return text ? [{ text }] : []
    }
    // HTML inert: the subtree cannot be used at all. WAI-ARIA aria-hidden: still on screen, so its
    // text stays, but it is not exposed as controls.
    if (attr(i, 'inert') !== undefined) return []
    const quiet = muted || attr(i, 'aria-hidden') === 'true'
    const a = axOf.get(backendNodeId[i])
    const [display, visibility, opacity] = l === undefined ? [] : doc.layout.styles[l].map(str)
    const hidden = l === undefined ? unseen : visibility === 'hidden' || visibility === 'collapse' || unseen || opacity === '0'
    const role = !quiet && a && !a.ignored ? String(a.role?.value ?? '') : ''
    const cls = attr(i, 'class')?.trim()
    // Segments are split by a control character and classes by spaces: neither can occur in a class name.
    const key = ROWS.has(role) ? '' : `${path}${SEGMENT}${str(nodeName[i]).toLowerCase()}${cls ? ` ${cls.split(/\s+/).join(' ')}` : ''}`
    const perKid = kids[i].map(c => walk(c, quiet, hidden, key, marked || COLLECTIONS.has(role)))
    const children = perKid.flat()
    // Generated content (::before, ::after, ::marker) is a pseudo element carrying its own layout text,
    // and a field of its own: a bullet or a rank is not part of the text beside it.
    if (str(nodeName[i]).startsWith('::')) return l === undefined || hidden ? [] : [{ key, children: [{ text: str(doc.layout.text[l]) }] }]

    const block = l !== undefined && display !== undefined && !INLINE_DISPLAY.test(display)
    if (WIDGETS.has(role) && l !== undefined && visibility !== 'hidden') {
      const { states, url } = statesOf(a!)
      const value = a!.value?.value
      const name = squash(String(a!.name?.value ?? ''))
      return [{
        ref: refFor(backendNodeId[i]), role, name, nameShown: content(textOf(children)).includes(content(name)), states, url, block, key,
        value: value === undefined || value === '' ? undefined : String(value),
        children: hasRef(children) ? children : undefined,
      }]
    }
    if (role === 'heading') return [{ role, level: statesOf(a!).level, block: true, children }]
    // Landmarks get refs so the agent can zoom into a region.
    if (LANDMARKS.has(role)) return [{ ref: refFor(backendNodeId[i]), role, name: squash(String(a!.name?.value ?? '')), block: true, children }]
    // Collections get refs so the agent can ask for their records.
    if (COLLECTIONS.has(role)) return [{ ref: refFor(backendNodeId[i]), role, block: true, children }]
    if (ROWS.has(role)) return [{ row: true, block: true, children }]
    if (CELLS.has(role)) return [{ cell: true, header: role === 'columnheader', block: true, key, children }]
    if (!marked && (!role || role === 'generic' || role === 'none') && block && markRecords(i, perKid)) return [{ ref: refFor(backendNodeId[i]), role: 'list', block: true, key, children }]
    return block ? [{ block: true, key, children }] : children
  }

  // Data-region detection: at least minRepeats element children share a signature (tag and the classes
  // more than one of them has) and
  // each has at least minParts block-level parts. A card has a title, a price, a rating; a run of
  // paragraphs repeats but has no parts, so it is not records. The largest such group is marked.
  function markRecords(i: number, perKid: Node[][]): boolean {
    // Block-level parts of a node, looking through wrappers: a box whose only content is one box is that box.
    const parts = (n: Node, need: number): number => {
      const boxes: Node[] = []
      const collect = (m: Node) => { for (const c of m.children ?? []) if (c.block || c.ref) boxes.push(c); else collect(c) }
      collect(n)
      return boxes.length === 1 && !boxes[0].ref ? parts(boxes[0], need) : Math.min(boxes.length, need)
    }
    // A class only one sibling has (item-3) is that sibling's identity, not its template.
    const classes = (c: number) => (attr(c, 'class') ?? '').split(/\s+/).filter(Boolean)
    const siblingsWith = new Map<string, number>()
    for (const c of kids[i]) for (const t of new Set(classes(c))) siblingsWith.set(t, (siblingsWith.get(t) ?? 0) + 1)
    const groups = new Map<string, Node[]>()
    kids[i].forEach((c, k) => {
      const [only, ...rest] = perKid[k]
      if (nodeType[c] !== 1 || rest.length || !only?.block || parts(only, limits.minParts) < limits.minParts) return
      const sig = [str(nodeName[c]), ...classes(c).filter(t => (siblingsWith.get(t) ?? 0) > 1)].join(' ')
      groups.set(sig, [...(groups.get(sig) ?? []), only])
    })
    const best = [...groups.values()].sort((a, b) => b.length - a.length)[0]
    if (!best || best.length < limits.minRepeats) return false
    for (const n of best) n.record = true
    return true
  }

  // WAI-ARIA: while a modal dialog is open, content outside it is not available. The view is the dialog.
  const modal = ax.find(n => !n.ignored && n.backendDOMNodeId && n.properties?.some(p => p.name === 'modal' && p.value.value === true))
  const at = modal ? backendNodeId.indexOf(modal.backendDOMNodeId!) : -1
  if (at >= 0) return { block: true, children: [{ ref: refFor(modal!.backendDOMNodeId!), role: 'dialog', name: squash(String(modal!.name?.value ?? '')), block: true, children: walk(at, false, false) }] }
  return { block: true, children: walk(0, false, false) }
}
