import type { Field, Page, Verb } from './page.js'

const TEXT_CAP = 4000
const LINK_CAP = 60

function short(href: string, from: string): string {
  const u = new URL(href)
  return u.host === new URL(from).host ? `${u.pathname}${u.search}` : `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`
}

function fieldLine(f: Field): string {
  const name = `${f.name}${f.required ? '*' : ''}`
  const kind = f.multi ? `any of ${f.options!.join(', ')}` : f.options ? f.options.join(' | ') : f.type
  const extra = [
    f.label && f.label !== f.name ? `"${f.label}"` : '',
    f.multi ? (f.value ? `= ${f.value}` : '')
      : f.type === 'checkbox' ? (f.checked ? 'checked' : 'unchecked')
      : f.value && !f.options ? `= ${JSON.stringify(f.value)}` : '',
  ].filter(Boolean).join(' ')
  return `    ${name.padEnd(16)} ${kind}${extra ? `  ${extra}` : ''}`
}

export function verbView(v: Verb, from: string): string {
  return [`  ${v.name} → ${v.method} ${short(v.action, from)}`, ...v.fields.map(fieldLine)].join('\n')
}

export function pageView(p: Page): string {
  const out = [`${p.url}  [${p.status}]${p.title ? `  "${p.title}"` : ''}`, '']
  const text = p.text.length > TEXT_CAP ? `${p.text.slice(0, TEXT_CAP)}\n… (${p.text.length - TEXT_CAP} more chars)` : p.text
  if (text) out.push(text, '')
  if (p.verbs.length) out.push('verbs:', ...p.verbs.map(v => verbView(v, p.url)), '')
  if (p.links.length) {
    out.push('links:')
    p.links.slice(0, LINK_CAP).forEach((l, i) => out.push(`  [${i + 1}] ${l.label} → ${short(l.href, p.url)}`))
    if (p.links.length > LINK_CAP) out.push(`  … ${p.links.length - LINK_CAP} more (open N works for any of them)`)
  }
  return out.join('\n').trimEnd()
}
