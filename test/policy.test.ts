import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, loadPolicy } from '../src/policy.js'

const dir = mkdtempSync(join(tmpdir(), 'al-policy-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const file = (name: string, text: string) => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}

test('no policy file gives the defaults', () => {
  assert.deepEqual(loadPolicy(join(dir, 'missing.json')), DEFAULTS)
})

test('overrides replace only the keys they name', () => {
  const p = loadPolicy(file('ok.json', '{"settle.quietMs": 250}'))
  assert.equal(p['settle.quietMs'], 250)
  assert.equal(p['render.pageChars'], DEFAULTS['render.pageChars'])
})

test('unknown keys, bad values and bad JSON are errors', () => {
  assert.throws(() => loadPolicy(file('key.json', '{"settle.quiet": 1}')), /unknown key "settle.quiet"/)
  assert.throws(() => loadPolicy(file('type.json', '{"settle.quietMs": "300"}')), /must be a positive number/)
  assert.throws(() => loadPolicy(file('neg.json', '{"settle.quietMs": 0}')), /must be a positive number/)
  assert.throws(() => loadPolicy(file('json.json', '{settle')), /policy .*json\.json/)
  assert.throws(() => loadPolicy(file('arr.json', '[]')), /expected an object/)
})
