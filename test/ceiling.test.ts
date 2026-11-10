import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/policy.js'

process.env.BROWSER_LAYER_HOME = mkdtempSync(join(tmpdir(), 'bl-ceiling-'))
const { ceiling } = await import('../src/session.js')

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${'x'.repeat(100)}`).join('\n')

test('a long text with ordinary lines points at rg and sed, with no warning about wide lines', () => {
  const out = ceiling(lines(400), DEFAULTS)
  assert.match(out, /sed -n \d+,\d+p /)
  assert.doesNotMatch(out, /cut -c/)
})

test('a text whose later lines are far wider than the head says to cut them, or sed prints them whole again', () => {
  const out = ceiling(`${lines(3)}\n${'y'.repeat(60000)}\n${lines(3)}`, DEFAULTS)
  assert.match(out, /sed -n \d+,\d+p .* \| cut -c1-\d+/)
})
