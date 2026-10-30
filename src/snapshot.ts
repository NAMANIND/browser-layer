// Runs inside the live page. Turns what is actually rendered into text lines and
// numbered controls. Every control gets a data-al ref that stays the same across reads.
// Self-contained on purpose: Playwright ships this function's source into the page.
export function snapshot(cap: number): { title: string; body: string; truncated: boolean } {
  const w = window as unknown as { __alNext?: number }
  w.__alNext ??= 1
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'treeitem'])
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG', 'IFRAME', 'CANVAS'])
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TD|TH|TR|UL)$/
  const out: string[] = []
  let line = ''
  let size = 0
  let truncated = false
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
  const push = (s: string) => {
    if (truncated) return
    if (size + s.length > cap) { truncated = true; return }
    out.push(s)
    size += s.length + 1
  }
  // SEP marks a boundary between side-by-side blocks inside one collapsed line.
  const SEP = '\u0001'
  const flush = () => {
    const t = clean(line
      .replace(/(\s*\u0001\s*)+/g, SEP)
      .replace(/^\u0001|\u0001$/g, '')
      // "7:00 AM · – · 9:10 AM" reads better as "7:00 AM – 9:10 AM".
      .replace(/\u0001(?=[–—\-|/:,.)])/g, ' ')
      .replace(/([–—\-|/(])\u0001/g, '$1 ')
      .replaceAll(SEP, ' · '))
    if (t) push(t)
    line = ''
  }
  // A row is a short block whose children sit side by side on screen: a result row, a table
  // row, a nav bar. It reads as one line. Short blocks stacked vertically keep their lines.
  const ROW_CHARS = 240
  const isRow = (el: HTMLElement) => {
    const text = el.textContent ?? ''
    if (text.length > ROW_CHARS * 4 || clean(text).length > ROW_CHARS) return false
    // Inline children always flow side by side, so only boxes that lay themselves out count,
    // and every one of them has to share the same band of the screen.
    const boxes = [...el.children]
      .filter(c => !['inline', 'contents', 'none'].includes(getComputedStyle(c).display))
      .map(c => c.getBoundingClientRect())
      .filter(r => r.width > 0 && r.height > 0)
    if (boxes.length < 2) return false
    for (let i = 1; i < boxes.length; i++) {
      const [a, b] = [boxes[i - 1], boxes[i]]
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (overlap <= Math.min(a.height, b.height) / 2) return false
    }
    return true
  }

  function roleOf(el: HTMLElement): string {
    const r = el.getAttribute('role')
    if (r && ROLES.has(r)) return r
    const tag = el.tagName
    if (tag === 'A' && el.hasAttribute('href')) return 'link'
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button'
    if (tag === 'SELECT') return 'select'
    if (tag === 'TEXTAREA') return 'textbox'
    if (tag === 'INPUT') {
      const t = (el as HTMLInputElement).type
      if (t === 'hidden') return ''
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button'
      if (t === 'checkbox' || t === 'radio') return t
      if (t === 'search') return 'searchbox'
      return t === 'text' ? 'textbox' : `textbox(${t})`
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox'
    return ''
  }

  function nameOf(el: HTMLElement): string {
    const by = el.getAttribute('aria-labelledby')
    const labelled = by ? by.split(/\s+/).map(id => document.getElementById(id)?.innerText).join(' ') : ''
    const input = el as HTMLInputElement
    const field = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable
    const visible = field ? '' : clean(el.innerText)
    // A hidden label (aria-label, tooltip) on a control with visible text usually repeats what
    // the row already shows, so it gets less room than text the user actually sees.
    const hidden = clean(el.getAttribute('aria-label')) || clean(labelled)
      || clean(input.labels?.[0]?.innerText)
      || (visible ? '' : clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title'))
        || clean(el.getAttribute('data-tooltip')) || clean(el.querySelector('[aria-label]')?.getAttribute('aria-label'))
        || clean(el.querySelector('img')?.getAttribute('alt')) || clean(el.querySelector('svg title')?.textContent)
        || (input.type === 'submit' || input.type === 'button' ? clean(input.value) : ''))
    const name = hidden || visible
    const cap = hidden && hidden !== visible && hidden.length > 48 ? 45 : 80
    return name.length > cap ? `${name.slice(0, cap - 1)}…` : name
  }

  // Refs are how the agent acts, so a link target is shown only when it tells the agent
  // something the name does not: an unnamed link, or one that leaves this site.
  function destOf(el: HTMLAnchorElement, name: string): string {
    const raw = el.getAttribute('href') ?? ''
    if (!raw || raw.startsWith('javascript:') || raw === '#') return ''
    let url: URL
    try { url = new URL(raw, location.href) } catch { return '' }
    if (url.host !== location.host) return ` → ${url.host}`
    if (name) return ''
    const path = `${url.pathname}${url.search}`
    return ` → ${path.length > 40 ? `${path.slice(0, 39)}…` : path}`
  }

  function stateOf(el: HTMLElement, role: string): string {
    const bits: string[] = []
    if (el.tagName === 'SELECT') {
      const s = el as HTMLSelectElement
      const opts = [...s.options].map(o => clean(o.text) || o.value)
      bits.push(`= ${JSON.stringify(clean(s.selectedOptions[0]?.text))}`, `of ${opts.slice(0, 12).join(' | ')}${opts.length > 12 ? ` … +${opts.length - 12}` : ''}`)
    } else if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const on = (el as HTMLInputElement).checked ?? el.getAttribute('aria-checked') === 'true'
      bits.push(on || el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked')
    } else if (role.startsWith('textbox') || role === 'searchbox' || role === 'combobox') {
      const v = el.isContentEditable ? el.innerText : (el as HTMLInputElement).value
      if (v) bits.push(`= ${JSON.stringify(clean(v).slice(0, 120))}`)
    }
    if (el.getAttribute('aria-expanded')) bits.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed')
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled')
    if (el === document.activeElement) bits.push('focused')
    return bits.length ? `  ${bits.join(' ')}` : ''
  }

  function walk(node: Node, row = false, muted = false) {
    if (truncated) return
    if (node.nodeType === Node.TEXT_NODE) { line += ` ${node.textContent}`; return }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (SKIP.has(el.tagName.toUpperCase())) return
    // inert content cannot be used at all. aria-hidden content is still on screen (sites put
    // visible text there and read it out elsewhere), so its text stays but its controls get no ref.
    if (el.hasAttribute('inert')) return
    const quiet = muted || el.getAttribute('aria-hidden') === 'true'
    const style = getComputedStyle(el)
    const contents = style.display === 'contents'
    if (!contents && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return

    const role = quiet ? '' : roleOf(el)
    if (role) {
      // Controls stay inline with the text around them; blocks still break lines.
      if (!el.dataset.al) el.dataset.al = String(w.__alNext!++)
      const name = nameOf(el)
      const dest = role === 'link' && el.tagName === 'A' ? destOf(el as HTMLAnchorElement, name) : ''
      line += ` [${el.dataset.al}] ${role}${name ? ` "${name}"` : ''}${stateOf(el, role)}${dest} `
      return
    }
    const block = !contents && (BLOCK.test(el.tagName) || style.display === 'block' || style.display === 'flex' || style.display === 'grid' || style.display === 'list-item' || style.display === 'table-row')
    if (!block) {
      for (const child of el.shadowRoot ? el.shadowRoot.childNodes : []) walk(child, row, quiet)
      for (const child of el.childNodes) walk(child, row, quiet)
      return
    }
    if (row) {
      // Inside a collapsed row, blocks become separators instead of line breaks.
      line += SEP
      for (const child of el.shadowRoot ? el.shadowRoot.childNodes : []) walk(child, true, quiet)
      for (const child of el.childNodes) walk(child, true, quiet)
      line += SEP
      return
    }
    const collapse = el.tagName !== 'BR' && isRow(el)
    flush()
    for (const child of el.shadowRoot ? el.shadowRoot.childNodes : []) walk(child, collapse, quiet)
    for (const child of el.childNodes) walk(child, collapse, quiet)
    flush()
  }

  walk(document.body ?? document.documentElement)
  flush()
  return { title: document.title, body: out.join('\n'), truncated }
}
