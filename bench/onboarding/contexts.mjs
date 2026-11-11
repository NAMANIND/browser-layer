// The onboarding a variant gives the model: the current skill file, the current `browser-layer help`
// (read from src/cli.ts, so the exam follows the repo) or a text under variants/.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../..')
const read = p => readFileSync(join(root, p), 'utf8')

export const help = () => read('src/cli.ts').match(/const HELP = `([\s\S]*?)`\n/)[1]
// A part is `skill`, `help`, or a file under variants/; `a+b` joins files into one document.
const part = name => name === 'skill' ? ['SKILL.md', read('skills/browser-layer/SKILL.md')]
  : name === 'help' ? ['browser-layer help', help()]
  : [name.endsWith('.md') ? 'SKILL.md' : 'browser-layer help', name.split('+').map(f => readFileSync(join(here, f), 'utf8')).join('')]

export const variants = JSON.parse(readFileSync(join(here, 'variants.json'), 'utf8'))

// The manual before the trims the ablation led to; the ablation's units are lines of this text.
export const manualV1 = () => readFileSync(join(here, 'variants/manual-v1.txt'), 'utf8')

// `cut:4-4,16-17` is manual v1 without those lines (1-based): the leave-one-out ablation's variants.
// `head:40` and `v1head:40` are the first lines of the current help and of v1: what `--help | head -40` shows.
const cut = name => manualV1().split('\n').filter((_, i) => !name.slice(4).split(',').some(r => { const [a, b] = r.split('-').map(Number); return i + 1 >= a && i + 1 <= b })).join('\n')

// What the model is told it has read, as an agent that runs `cat SKILL.md` and `browser-layer help` sees it.
export function context(name) {
  const parts = name.startsWith('cut:') ? [['browser-layer help', cut(name)]]
    : name.startsWith('head:') ? [['browser-layer help', help().split('\n').slice(0, +name.slice(5)).join('\n')]]
    : name.startsWith('v1head:') ? [['browser-layer help', manualV1().split('\n').slice(0, +name.slice(7)).join('\n')]]
    : variants[name].map(part)
  if (!parts.length) return 'You have not been given any documentation for it.'
  return parts.map(([title, text]) => `$ ${title === 'SKILL.md' ? 'cat SKILL.md' : 'browser-layer help'}\n${text}`).join('\n\n')
}
