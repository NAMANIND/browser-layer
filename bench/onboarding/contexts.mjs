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

// What the model is told it has read, as an agent that runs `cat SKILL.md` and `browser-layer help` sees it.
export function context(name) {
  const parts = variants[name].map(part)
  if (!parts.length) return 'You have not been given any documentation for it.'
  return parts.map(([title, text]) => `$ ${title === 'SKILL.md' ? 'cat SKILL.md' : 'browser-layer help'}\n${text}`).join('\n\n')
}
