import type { CDPSession } from 'playwright-core'

// What the page shows, as a tree. Rendering decides lines; the reader only reports facts.
export type Node = {
  ref?: number
  role?: string
  name?: string
  value?: string
  states?: string[]
  url?: string
  level?: number
  text?: string
  block?: boolean
  row?: boolean
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

export async function readTree(cdp: CDPSession, refs: Refs): Promise<Node> {
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

  // muted: inside aria-hidden (text shows, controls get no ref). unseen: visibility hidden or opacity 0.
  function walk(i: number, muted: boolean, unseen: boolean): Node[] {
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
    const children = kids[i].flatMap(c => walk(c, quiet, hidden))
    // Generated content (::before / ::after) is a pseudo element carrying its own layout text.
    if (str(nodeName[i]).startsWith('::') && l !== undefined && !hidden) children.unshift({ text: str(doc.layout.text[l]) })

    const role = !quiet && a && !a.ignored ? String(a.role?.value ?? '') : ''
    const block = l !== undefined && display !== undefined && !INLINE_DISPLAY.test(display)
    if (WIDGETS.has(role) && l !== undefined && visibility !== 'hidden') {
      const { states, url } = statesOf(a!)
      const value = a!.value?.value
      return [{
        ref: refFor(backendNodeId[i]), role, name: String(a!.name?.value ?? '').trim(), states, url, block,
        value: value === undefined || value === '' ? undefined : String(value),
        children: hasRef(children) ? children : undefined,
      }]
    }
    if (role === 'heading') return [{ role, level: statesOf(a!).level, block: true, children }]
    if (ROWS.has(role)) return [{ row: true, block: true, children }]
    return block ? [{ block: true, children }] : children
  }

  return { block: true, children: walk(0, false, false) }
}
