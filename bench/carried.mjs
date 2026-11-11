// The cost of a run in characters carried: every command's output stays in the model's context for every
// later command, so an output of N characters followed by K more commands costs N × K. Prints, per run and
// in total, the commands, the characters returned, the characters carried, and the commands that were not
// browser-layer (the agent looking again at a file we saved, or scripting over it).
// Usage: node bench/carried.mjs <events.jsonl…>   (a run's events: item.completed / command_execution)
import { readFileSync } from 'node:fs'

// A run's row from its completed command items.
export function carriedRow(done) {
  const row = { commands: done.length, shell: done.filter(i => !/^(?:\/bin\/\w+ -lc )?['"]?(?:cd [^;&]+(?:&&|;) *)?browser-layer\b/.test(i.command)).length, chars: 0, carried: 0 }
  done.forEach((item, k) => {
    const size = (item.aggregated_output ?? '').length
    row.chars += size
    row.carried += size * (done.length - 1 - k)
  })
  return row
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const total = { runs: 0, commands: 0, shell: 0, chars: 0, carried: 0 }
  for (const file of process.argv.slice(2)) {
    const done = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(e => e.type === 'item.completed' && e.item.type === 'command_execution').map(e => e.item)
    const row = carriedRow(done)
    console.log(`${file}: ${row.commands} commands (${row.shell} shell), ${row.chars} chars returned, ${row.carried} carried`)
    total.runs++
    for (const k of ['commands', 'shell', 'chars', 'carried']) total[k] += row[k]
  }
  console.log(`total: ${total.runs} runs, ${total.commands} commands (${total.shell} shell), ${total.chars} chars returned, ${total.carried} carried`)
}
