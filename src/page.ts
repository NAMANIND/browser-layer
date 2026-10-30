import { parse, type HTMLElement } from 'node-html-parser'

export type Field = {
  name: string
  type: string
  label: string
  required: boolean
  value: string
  options?: string[]
  checked?: boolean
  multi?: boolean
}

export type Verb = {
  name: string
  method: 'GET' | 'POST'
  action: string
  enctype: string
  fields: Field[]
  hidden: Record<string, string>
  submit?: [string, string]
}

export type Link = { label: string; href: string }

export type Page = {
  url: string
  status: number
  title: string
  text: string
  links: Link[]
  verbs: Verb[]
}

const DROP = 'script, style, noscript, template, svg, canvas, iframe, head, title'
const SKIP_INPUT = new Set(['submit', 'button', 'image', 'reset'])

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

function hidden(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true
  const style = (el.getAttribute('style') ?? '').replace(/\s/g, '').toLowerCase()
  return style.includes('display:none') || style.includes('visibility:hidden')
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
}

function labelFor(root: HTMLElement, el: HTMLElement): string {
  const id = el.getAttribute('id')
  if (id) {
    const lab = root.querySelector(`label[for="${id}"]`)
    if (lab) return clean(lab.text)
  }
  let p = el.parentNode as HTMLElement | null
  while (p && p.tagName) {
    if (p.tagName === 'LABEL') return clean(p.text)
    p = p.parentNode as HTMLElement | null
  }
  return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title'))
}

function groupLabel(el: HTMLElement): string {
  let p = el.parentNode as HTMLElement | null
  while (p && p.tagName) {
    if (p.tagName === 'FIELDSET') return clean(p.querySelector('legend')?.text)
    if (p.tagName === 'FORM') break
    p = p.parentNode as HTMLElement | null
  }
  return ''
}

function readForm(root: HTMLElement, form: HTMLElement, base: string, index: number): Verb {
  const method = (form.getAttribute('method') ?? 'get').toUpperCase() === 'POST' ? 'POST' : 'GET'
  const action = new URL(form.getAttribute('action') || base, base).href
  const fields: Field[] = []
  const hiddenValues: Record<string, string> = {}
  let submit: [string, string] | undefined

  for (const el of form.querySelectorAll('input, select, textarea, button')) {
    const name = el.getAttribute('name')
    const tag = el.tagName
    const type = (el.getAttribute('type') ?? (tag === 'BUTTON' ? 'submit' : 'text')).toLowerCase()
    if (tag === 'BUTTON' || (tag === 'INPUT' && SKIP_INPUT.has(type))) {
      if (name && !submit && type === 'submit') submit = [name, el.getAttribute('value') ?? '']
      continue
    }
    if (!name || el.hasAttribute('disabled')) continue
    if (type === 'hidden') {
      hiddenValues[name] = el.getAttribute('value') ?? ''
      continue
    }
    const field: Field = {
      name,
      type: tag === 'INPUT' ? type : tag.toLowerCase(),
      label: labelFor(root, el),
      required: el.hasAttribute('required'),
      value: tag === 'TEXTAREA' ? el.text : (el.getAttribute('value') ?? ''),
    }
    if (tag === 'SELECT') {
      const opts = el.querySelectorAll('option')
      field.options = opts.map(o => o.getAttribute('value') ?? clean(o.text))
      const sel = opts.find(o => o.hasAttribute('selected')) ?? opts[0]
      field.value = sel ? (sel.getAttribute('value') ?? clean(sel.text)) : ''
    }
    if (type === 'radio') {
      const same = fields.find(f => f.name === name && f.type === 'radio')
      const v = el.getAttribute('value') ?? 'on'
      if (same) {
        same.options!.push(v)
        if (el.hasAttribute('checked')) same.value = v
        continue
      }
      field.label = groupLabel(el)
      field.options = [v]
      field.value = el.hasAttribute('checked') ? v : ''
    }
    if (type === 'checkbox') {
      const v = el.getAttribute('value') ?? 'on'
      const on = el.hasAttribute('checked')
      const same = fields.find(f => f.name === name && f.type === 'checkbox')
      // Checkboxes sharing a name are one "pick any of" field, sent once per picked value.
      if (same) {
        if (!same.multi) {
          same.multi = true
          same.options = [same.value]
          same.value = same.checked ? same.value : ''
          same.label = groupLabel(el)
          delete same.checked
        }
        same.options!.push(v)
        if (on) same.value = same.value ? `${same.value},${v}` : v
        continue
      }
      field.value = v
      field.checked = on
    }
    fields.push(field)
  }

  const label = form.getAttribute('id') || form.getAttribute('name') || form.getAttribute('aria-label')
    || new URL(action).pathname.split('/').filter(Boolean).pop() || `form${index + 1}`
  return {
    name: `${slug(label) || `form${index + 1}`}.submit`,
    method,
    action,
    enctype: (form.getAttribute('enctype') ?? 'application/x-www-form-urlencoded').toLowerCase(),
    fields,
    hidden: hiddenValues,
    submit,
  }
}

export function readPage(html: string, url: string, status: number): Page {
  const root = parse(html, { comment: false })
  const title = clean(root.querySelector('title')?.text)
  const base = new URL(root.querySelector('base')?.getAttribute('href') || url, url).href

  const forms = root.querySelectorAll('form').filter(f => !hidden(f))
  const verbs = forms.map((f, i) => readForm(root, f, base, i))
  const seen = new Map<string, number>()
  for (const v of verbs) {
    const n = (seen.get(v.name) ?? 0) + 1
    seen.set(v.name, n)
    if (n > 1) v.name = v.name.replace(/\.submit$/, `-${n}.submit`)
  }

  const body = root.querySelector('body') ?? root
  // Forms are already verbs; keeping their labels in the text would say everything twice.
  for (const el of body.querySelectorAll(`${DROP}, form`)) el.remove()
  for (const el of body.querySelectorAll('*')) if (hidden(el)) el.remove()

  const links: Link[] = []
  const linkSeen = new Set<string>()
  for (const a of body.querySelectorAll('a[href]')) {
    const raw = a.getAttribute('href')!
    if (/^(javascript:|mailto:|tel:|#)/i.test(raw)) continue
    let href: string
    try { href = new URL(raw, base).href } catch { continue }
    const label = clean(a.text) || clean(a.getAttribute('aria-label') || a.getAttribute('title')) || href
    const key = `${label}\n${href}`
    if (linkSeen.has(key)) continue
    linkSeen.add(key)
    links.push({ label, href })
  }

  const text = body.structuredText.replace(/<!doctype[^>]*>/gi, '').split('\n').map(clean).filter(Boolean).join('\n')
  return { url, status, title, text, links, verbs }
}
