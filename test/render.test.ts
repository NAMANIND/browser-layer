import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLines } from '../src/render.js'

test('only the lines that changed are reported', () => {
  const before = ['title', '[1] button "More"', 'a', 'b', 'footer']
  const after = ['title', '[1] button "More"  focused', 'a', 'b', 'c', 'footer']
  assert.deepEqual(diffLines(before, after), { removed: ['[1] button "More"'], added: ['[1] button "More"  focused', 'c'] })
})

test('repeated lines count as many times as they appear', () => {
  assert.deepEqual(diffLines(['x', '|', '|', 'y'], ['x', '|', 'y']), { removed: ['|'], added: [] })
})

test('no change gives nothing', () => {
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), { removed: [], added: [] })
})
