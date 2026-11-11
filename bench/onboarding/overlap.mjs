// Which facts the skill and the help each carry, and which commands and flags neither mentions, with sizes.
//   node bench/onboarding/overlap.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { help } from './contexts.mjs'
import { FLAGS, VERBS } from './grade.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const skill = readFileSync(join(here, '../../skills/browser-layer/SKILL.md'), 'utf8')
const docs = { skill, help: help() }
const words = text => new Set(text.match(/[a-z][a-z-]+/g))

console.log(`skill ${skill.length} chars (~${Math.round(skill.length / 4)} tokens), help ${docs.help.length} chars (~${Math.round(docs.help.length / 4)} tokens)`)

// Concepts an agent needs, each with the words that show a document says it.
const facts = {
  'tab opens a page, answers with its map': /\btab <url|`tab <url>`/,
  'refs or control names address things': /control's name|control's name|name of a control|by name/i,
  'actions answer with what changed': /what changed/,
  'steps chains commands': /\bsteps\b/,
  'open <url…> --out: many static pages': /open --out|open <url>[^\n]*--out/,
  'each --out: many JavaScript pages': /each[^\n]*--out/,
  'get: list or table as records': /\bget <ref>/,
  'get --sort/--desc/--limit/--cols': /--sort|--cols/,
  'get --urls': /--urls/,
  'read one region / read --page / --full': /read \[?<?ref|--full/,
  'find': /\bfind <text>|`find/,
  '--out saves the whole result': /--out/,
  'net / net show / net save': /net save/,
  'eval fetch for more API pages': /eval[^\n]*fetch/,
  'wait for late content': /\bwait\b/,
  'URL filters': /\?q=/,
  'popup covered-by answer': /covered by/,
  'suggestions: press Enter / click the option': /suggestions/,
  'note: something did not take': /^- `note:/m,
  'allow images + reload': /allow images|images loads/,
  'blocked / CAPTCHA: never solve': /CAPTCHA/,
  'show / hide: a person clears a block': /\bshow\b[^\n]*\bhide\b|show \/ hide/,
  'login: person signs in, never type passwords': /login/,
  'irreversible steps: confirm first': /[Ii]rreversible/,
  'sessions: --session': /--session/,
  'screenshot is for a person': /screenshot/,
  'list complete only when shown ended': /complete only when/,
  'deliver as you go': /Deliver as you go/,
  'know when to stop': /Know when to stop/,
  'stop closes the browser': /\bstop\b/,
  'attach: the person’s own Chrome': /--attach/,
  'plain HTTP: open, verbs, do': /\bdo <verb>/,
}
const rows = Object.entries(facts).map(([name, re]) => ({ name, skill: re.test(skill), help: re.test(docs.help) }))
for (const [label, pick] of [['both', r => r.skill && r.help], ['only the skill', r => r.skill && !r.help], ['only help', r => !r.skill && r.help], ['neither', r => !r.skill && !r.help]])
  console.log(`\n${label}:\n${rows.filter(pick).map(r => `  ${r.name}`).join('\n') || '  -'}`)

const missing = (set, where) => [...set].filter(w => !where.has(w))
const sw = words(skill), hw = words(docs.help)
const neither = [...VERBS, ...FLAGS].map(w => w.replace(/^--/, '')).filter(w => !sw.has(w) && !hw.has(w))
console.log(`\ncommands and flags in neither document: ${neither.join(' ') || '-'}`)
console.log(`commands and flags only in help: ${missing(new Set([...VERBS].filter(v => hw.has(v))), sw).join(' ')}`)
console.log(`commands and flags only in the skill: ${missing(new Set([...VERBS].filter(v => sw.has(v))), hw).join(' ') || '-'}`)
