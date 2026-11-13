import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromTsv, group, records, toTsv, where, type Records } from '../src/data.js'
import { SEGMENT, type Node } from '../src/reader.js'

const data: Records = {
  columns: ['c1', 'c2', 'c3'], names: ['Name', 'Category', 'Price'],
  rows: [['Lamp', 'Garden', '$39.11'], ['Rake', 'Garden', '$108.76'], ['Drill', 'Tools', '$1,250.00'], ['Chair', 'Garden', '']],
}
const names = (r: Records) => r.rows.map(row => row[0])

test('--where keeps rows by a column: equal and contains whatever the case, < and > as numbers', () => {
  assert.deepEqual(names(where(data, ['c2=garden'])), ['Lamp', 'Rake', 'Chair'])
  assert.deepEqual(names(where(data, ['Name~A'])), ['Lamp', 'Rake', 'Chair'])
  // The number in the cell is compared ("$1,250.00" is 1250); a cell with none is neither under nor over.
  assert.deepEqual(names(where(data, ['c3<100'])), ['Lamp'])
  assert.deepEqual(names(where(data, ['Price>1000'])), ['Drill'])
  assert.deepEqual(names(where(data, ['c2=Garden', 'c3>100'])), ['Rake'])
  assert.throws(() => where(data, ['c9=1']), /no column "c9"; columns are c1 \(Name\)/)
  assert.throws(() => where(data, ['cheap']), /--where takes <column><op><value>/)
})

test('--where takes any of several values with |, and compares dates as dates', () => {
  assert.deepEqual(names(where(data, ['c2=garden|tools'])), ['Lamp', 'Rake', 'Drill', 'Chair'])
  assert.deepEqual(names(where(data, ['Name~lam|dri'])), ['Lamp', 'Drill'])
  const dated: Records = { columns: ['c1', 'c2'], names: ['Name', 'Received'], rows: [['A', '06/16/2026'], ['B', '6/2/2026'], ['C', '2026-05-30'], ['D', '10/01/2025'], ['E', 'n/a']] }
  // ISO 8601 and month/day/year are read as dates: 10/01/2025 is before 6/2/2026, which a number compare would get wrong.
  assert.deepEqual(names(where(dated, ['Received>06/01/2026'])), ['A', 'B'])
  assert.deepEqual(names(where(dated, ['Received<2026-06-01'])), ['C', 'D'])
  assert.deepEqual(names(where(dated, ['Received>2026-06-01', 'Received<06/16/2026'])), ['B'])
})

test('--group counts the rows for each value of a column, the most first', () => {
  assert.deepEqual(group(data, 'Category'), { columns: ['c2', 'count'], names: ['Category', ''], rows: [['Garden', '3'], ['Tools', '1']] })
})

test('a records file reads back as the records that were written', () => {
  assert.deepEqual(fromTsv(`${toTsv(data)}\n`), data)
  assert.throws(() => fromTsv('just some text\nmore text\n'), /not a records file/)
})

// A list of rows built by hand: each field is [element, text, label the page gives it].
const list = (...rows: [string, string, string?][][]): Node => ({
  ref: 1, role: 'list', block: true,
  children: rows.map(fields => ({ row: true, block: true, children: fields.map(([tag, text, label]) => ({ block: true, key: `${SEGMENT}${tag}`, label, children: [{ text }] })) })),
})
const caps = { nameChars: 120, labelChars: 40 }
const named = (l: Node) => records(l, 'https://x.test', caps).names

test('a column takes the name the page gives its field, when every row gives the same', () => {
  const l = list([['h3', 'Lamp'], ['dd', '5 kg', 'Weight'], ['dd', 'Kerala', 'Origin']], [['h3', 'Desk'], ['dd', '9 kg', 'Weight'], ['dd', 'Goa', 'Origin']])
  assert.deepEqual(named(l), ['', 'Weight', 'Origin'])
})

test('a label that differs from row to row is content, and a field some row gives none is not named', () => {
  assert.deepEqual(named(list([['h3', 'Lamp'], ['span', '4.5', '4.5 out of 5 stars']], [['h3', 'Desk'], ['span', '3', '3 out of 5 stars']])), ['', ''])
  assert.deepEqual(named(list([['h3', 'Lamp'], ['span', '4.5', 'Rating']], [['h3', 'Desk'], ['span', '3']])), ['', ''])
})
