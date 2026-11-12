import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromTsv, group, toTsv, where, type Records } from '../src/data.js'

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

test('--group counts the rows for each value of a column, the most first', () => {
  assert.deepEqual(group(data, 'Category'), { columns: ['c2', 'count'], names: ['Category', ''], rows: [['Garden', '3'], ['Tools', '1']] })
})

test('a records file reads back as the records that were written', () => {
  assert.deepEqual(fromTsv(`${toTsv(data)}\n`), data)
  assert.throws(() => fromTsv('just some text\nmore text\n'), /not a records file/)
})
