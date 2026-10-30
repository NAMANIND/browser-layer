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
  const flush = () => { const t = clean(line); if (t) push(t); line = '' }

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
    const name = clean(el.getAttribute('aria-label')) || clean(labelled)
      || clean(input.labels?.[0]?.innerText)
      || (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable ? '' : clean(el.innerText))
      || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title'))
      || clean(el.querySelector('img')?.getAttribute('alt'))
      || (input.type === 'submit' || input.type === 'button' ? clean(input.value) : '')
    return name.length > 80 ? `${name.slice(0, 77)}…` : name
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

  function walk(node: Node) {
    if (truncated) return
    if (node.nodeType === Node.TEXT_NODE) { line += ` ${node.textContent}`; return }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    if (SKIP.has(el.tagName.toUpperCase())) return
    const style = getComputedStyle(el)
    const contents = style.display === 'contents'
    if (!contents && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return

    const role = roleOf(el)
    if (role) {
      // Controls stay inline with the text around them; blocks still break lines.
      if (!el.dataset.al) el.dataset.al = String(w.__alNext!++)
      const name = nameOf(el)
      const href = role === 'link' ? (el as HTMLAnchorElement).getAttribute('href') ?? '' : ''
      const dest = href && !href.startsWith('javascript:') && href !== '#' ? ` → ${href.length > 60 ? `${href.slice(0, 57)}…` : href}` : ''
      line += ` [${el.dataset.al}] ${role}${name ? ` "${name}"` : ''}${stateOf(el, role)}${dest} `
      return
    }
    const block = !contents && (BLOCK.test(el.tagName) || style.display === 'block' || style.display === 'flex' || style.display === 'grid' || style.display === 'list-item')
    if (block) flush()
    for (const child of el.shadowRoot ? el.shadowRoot.childNodes : []) walk(child)
    for (const child of el.childNodes) walk(child)
    if (block) flush()
  }

  walk(document.body ?? document.documentElement)
  flush()
  return { title: document.title, body: out.join('\n'), truncated }
}
