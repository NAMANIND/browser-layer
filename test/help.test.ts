import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const help = (...a: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'help', ...a], { encoding: 'utf8' })
const VERBS = 'tab go back forward reload tabs use close stop status each map read find get click dblclick rightclick hover check uncheck submit type pick press drag scroll upload wait viewport dialog explore menu eval net cookies storage allow screenshot steps open'.split(' ')

// The manual is re-read on every call; the first page carries what every task needs and names where the rest is.
test('help is a short page that names every verb and says where the rest is', () => {
  const page = help()
  assert.ok(page.length < 3600, `${page.length} characters`)
  assert.match(page, /help <verb>/)
  for (const v of VERBS) assert.match(page, new RegExp(`\\b${v}\\b`), v)
})

test('help <verb> gives that verb its flags, and nothing else a task needs is lost', () => {
  assert.match(help('get'), /--where[^\n]*--group|--group[^\n]*--where/)
  assert.match(help('each'), /--from/)
  assert.match(help('steps'), /find "matrix" --urls/)
  assert.match(help('eval'), /fetch\(\)/)
  assert.match(help('dialog'), /dialog accept/)
  assert.match(help('rules'), /never solve or evade/)
  for (const v of VERBS) assert.ok(help(v).length > 20, v)
})

test('help <unknown> says so and lists the verbs', () => {
  assert.match(help('nonsense'), /no help for "nonsense"/)
})
