// The lists of a page as records, for docs/LONG-TASKS.md C3: rows x columns, the share of blank cells, and the same
// for the columns that at least half the rows fill (the template), which is where the rest of the blanks come from.
import { records } from '../dist/data.js'
import { withRefs } from '../dist/reader.js'

const share = (rows, columns) => Math.round((100 * rows.flatMap(r => columns.map(c => r[c])).filter(v => !v).length) / (rows.length * columns.length))
export function lists(tree, origin, caps) {
  return withRefs(tree).filter(n => ['list', 'table', 'grid', 'treegrid'].includes(n.role)).map(n => records(n, origin, caps))
    .filter(r => r.rows.length >= 3 && r.columns.length >= 3)
    .map(r => {
      const all = r.columns.map((_, c) => c)
      const core = all.filter(c => r.rows.filter(row => row[c]).length * 2 >= r.rows.length)
      return { rows: r.rows.length, columns: r.columns.length, blank: share(r.rows, all), template: core.length, templateBlank: core.length ? share(r.rows, core) : 0 }
    })
    .sort((a, b) => b.rows - a.rows)
}
