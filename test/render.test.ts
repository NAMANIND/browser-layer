import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/policy.js'
import { bounded, bulkAnswer, bulkFile, diffLines, goneLines, renderMap, renderText } from '../src/render.js'
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

test('lines that are gone are named up to a few; the rest are counted', () => {
  const gone = (n: number) => Array.from({ length: n }, (_, i) => `row ${i}`)
  assert.deepEqual(goneLines(gone(3), 8), ['- row 0', '- row 1', '- row 2'])
  const many = goneLines(gone(30), 8)
  assert.equal(many.length, 9)
  assert.equal(many[8], '… 22 more gone')
})

test('no saved line is longer than save.lineChars: JSON splits into valid lines, text wraps at spaces', () => {
  const max = DEFAULTS['save.lineChars']
  const list = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, title: `item ${i} ${'x'.repeat(40)}` })))
  const text = Array.from({ length: 600 }, (_, i) => `word${i}`).join(' ')
  assert.ok(list.length > max && text.length > max)
  const out = bounded(`head\n${list}\n${text}\nshort`, max)
  assert.ok(out.split('\n').every(l => l.length <= max))
  assert.equal(out.split('\n')[0], 'head')
  assert.equal(out.split('\n').at(-1), 'short')
  assert.equal(out.replace(/\n/g, ' ').includes(text), true, 'wrapping only replaces a space with a newline')
  const start = out.split('\n').indexOf('[')
  const end = out.split('\n').indexOf(']')
  assert.deepEqual(JSON.parse(out.split('\n').slice(start, end + 1).join('\n')), JSON.parse(list))
})

test('a line within the bound, and a word longer than it, are left as they are', () => {
  assert.equal(bounded('a b c', 10), 'a b c')
  assert.equal(bounded(`x ${'y'.repeat(50)} z`, 10), `x\n${'y'.repeat(50)}\nz`)
})

test('a bulk file is bounded line by line, and the answer counts the file lines', () => {
  const text = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ')
  const page = { address: 'https://a.test/', status: 200, title: 'A', text }
  const file = bulkFile([page], 100)
  assert.ok(file.split('\n').every(l => l.length <= 100))
  const lines = file.trimEnd().split('\n').length
  assert.match(bulkAnswer('open', [page], 'f.txt', { ...DEFAULTS, 'save.lineChars': 100 }), new RegExp(`· ${lines - 1} lines,`))
})

test('a list whose first row shows nothing is sampled by the first row that does', () => {
  const row = (t: string): Node => ({ row: true, block: true, children: t ? [{ text: t }] : [] })
  const tree: Node = { block: true, children: [{ ref: 5, role: 'list', block: true, children: [row(''), row('First result'), row('Second')] }] }
  assert.match(renderMap(tree, 'https://x.test', { nameChars: 120, labelChars: 40 }, 8), /\[5\] list of 3: First result …/)
})
