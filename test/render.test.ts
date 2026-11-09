import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffLines, renderMap, renderText } from '../src/render.js'
import type { Node } from '../src/reader.js'

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

test('padding of spaces and invisible characters reads as one space; one inside a word stays', () => {
  const text = (t: string) => renderText({ block: true, children: [{ text: t }] }, 'https://x.test', { nameChars: 120, labelChars: 40 })
  assert.equal(text('Done in 30 seconds ‌ ‌ ‌ ‌ end'), 'Done in 30 seconds end')
  assert.equal(text('family 👨‍👩‍👧'), 'family 👨‍👩‍👧')
})

test('a heading that wraps a region is not a heading: the map shows the region', () => {
  const tree: Node = { block: true, children: [{ role: 'heading', level: 1, block: true, children: [
    { ref: 16, role: 'banner', name: '', block: true, children: [{ ref: 3, role: 'button', name: 'Main menu', nameShown: true, block: true }] }] }] }
  const map = renderMap(tree, 'https://x.test', { nameChars: 120, labelChars: 40 }, 8)
  assert.doesNotMatch(map, /headings:/)
  assert.match(map, /\[16\] banner/)
  assert.match(map, /\[3\] button "Main menu"/)
})

test('the footer (contentinfo) is counted, not named: its links are rarely what a task needs, and read <ref> lists them', () => {
  const link = (ref: number, name: string): Node => ({ ref, role: 'link', name, nameShown: true, url: `/${name}`, block: true })
  const tree: Node = { block: true, children: [
    { ref: 1, role: 'main', block: true, children: [link(2, 'Pricing'), link(3, 'Docs')] },
    { ref: 4, role: 'contentinfo', block: true, children: [link(5, 'Privacy'), link(6, 'Terms'), link(7, 'Careers')] }] }
  const map = renderMap(tree, 'https://x.test', { nameChars: 120, labelChars: 40 }, 8)
  assert.match(map, /\[1\] main\n  links: \[2\] link "Pricing" · \[3\] link "Docs"/)
  assert.match(map, /\[4\] contentinfo\n  links: 3$/)
})
