// Par scripts (docs/LONG-TASKS.md §2): for each task, the best command sequence the tool allows today, written by hand.
// A script may use only what earlier answers showed it (a ref, a name, an address): it stands for a perfect agent, not
// for one that knows the site. `tool` uses only browser-layer; `shell`, where it is shorter, may also run a program.
// Each returns what it found; `check` says whether the task was done, reading only what was saved or answered.
import { BRIEF, CATEGORIES, EXPECTED, ITEMS, ORGS, PER_PAGE, state } from './site.mjs'

const PAGES = ITEMS.length / PER_PAGE
const ref = (out, what) => {
  const m = out.match(new RegExp(`\\[(\\d+)\\] ${what}`))
  if (!m) throw new Error(`no "[ref] ${what}" in the answer: ${out.slice(0, 200)}`)
  return m[1]
}
const skus = text => new Set(text.match(/SKU-\d+/g))
const everyRecordSaved = (_, t) => skus(t.saved()).size === ITEMS.length
const pagesOf = (t, kind, n = PAGES) => Array.from({ length: n }, (_, i) => `${t.base}/list/${kind}?page=${i + 1}`)
const times = (n, text) => Array(n).fill(text).join('; ')

// A1: every record of a list of 500, saved. One task per way a list gives more. `plain` is the one command the manual
// names for the job, with nothing an expert would add: what an agent that trusts the manual gets.
const getAll = (t, list) => t.bl('get', list, '--all', '--out', t.out('all.tsv'))
const collect = (kind, more, path = `list/${kind}`) => ({
  id: `A1 collect, ${kind}`,
  tool: async t => more(t, ref(await t.bl('tab', `${t.base}/${path}`), 'list of 20')),
  plain: async t => getAll(t, ref(await t.bl('tab', `${t.base}/${path}`), 'list of 20')),
  // Short of every record, an answer that says the end is not shown has not misled anyone.
  check: (answer, t) => everyRecordSaved(answer, t) || (/not shown to be complete/.test(answer ?? '') && 'says so'),
})
// Pages with addresses: once one answer shows the address of another page, all of them are read in one call.
const byAddress = kind => async t => {
  await t.bl('find', kind === 'pager' ? 'link "2"' : 'Next', '--urls')
  await t.bl('each', 'read', ...pagesOf(t, kind), '--out', t.out('all.txt'))
}

// A2: three fields from the own page of each of the first 60 records.
const enriched = (_, t) => {
  const blocks = t.saved().split(/^== /m)
  return ITEMS.slice(0, 60).every(it => blocks.some(b => b.startsWith(`${t.base}/item/${it.sku}`) && [it.weight, it.origin, it.warranty].every(v => b.includes(v))))
}
const itemAddresses = text => [...new Set(text.match(/http\S+\/item\/SKU-\d+/g))]

// A5: three questions over the 500 records. The arithmetic stands for the agent's own, done on what it was answered.
const reduced = rows => ({
  cheapGarden: rows.filter(r => r.cat === 'Garden' && r.price < 100).length,
  perCategory: Object.fromEntries(CATEGORIES.map(c => [c, rows.filter(r => r.cat === c).length])),
})
const top10 = [...ITEMS].sort((a, b) => b.price - a.price).slice(0, 10).map(it => it.name)
const reducedRight = found => JSON.stringify(found) === JSON.stringify({ ...reduced(ITEMS.map(it => ({ cat: it.cat, price: Number(it.price) }))), top10 })

// A4: one call per step of the form: what the last answer showed is filled in and sent.
const fill = {
  'Full name': v => `type "Full name" "${v}"`, Email: v => `type Email ${v}`, Username: v => `type Username ${v}`, Country: v => `pick Country ${v}`, City: v => `pick City ${v}`,
  'Date of birth': v => `type "Date of birth" ${v}`, Plan: v => `click ${v}`, 'Promo code': v => `type "Promo code" "${v}"`, Seats: v => `type Seats ${v}`,
  Newsletter: () => 'check Newsletter', Terms: () => 'check Terms', Address: v => `type Address "${v}"`, Postcode: v => `type Postcode ${v}`,
}

export const TASKS = [
  collect('rel', getAll),
  collect('scroll', getAll),
  collect('pager', byAddress('pager')),
  collect('button', (t, list) => t.bl('steps', `${times(PAGES - 1, 'click "Mehr laden"')}; get ${list} --out ${t.out('all.tsv')}`)),
  collect('rerender', (t, list) => t.bl('steps', Array.from({ length: PAGES }, (_, i) => `get ${list} --out ${t.out(`page${i + 1}.tsv`)}`).join('; click Next; '))),
  // The same list from a server that takes 400 ms a page: get --all is tried first, as on any list, and when it fails
  // the error's own advice is followed (close the tab), then the pages are read by address.
  collect('rel, slow server', async (t, list) => {
    if (!/^error:/m.test(await getAll(t, list))) return
    await t.bl('find', 'Next', '--urls')
    await t.bl('close')
    await t.bl('each', 'read', ...pagesOf(t, 'rel').map(u => u.replace('/list/', '/slow/list/')), '--out', t.out('all.txt'))
  }, 'slow/list/rel'),
  {
    id: 'A2 enrich 60',
    tool: async t => {
      await t.bl('tab', `${t.base}/list/rel`)
      await t.bl('find', 'Next', '--urls')
      const lines = await t.bl('each', 'find SKU- --urls', ...pagesOf(t, 'rel', 3))
      await t.bl('each', 'read', ...itemAddresses(lines), '--out', t.out('items.txt'))
    },
    shell: async t => {
      const list = ref(await t.bl('tab', `${t.base}/list/rel`), 'list of 20')
      await t.bl('get', list, '--all', '--urls', '--out', t.out('all.tsv'))
      await t.sh(`browser-layer each read $(sed -n 2,61p ${t.out('all.tsv')} | grep -o 'http[^[:space:]]*/item/SKU-[0-9]*' | sort -u) --out ${t.out('items.txt')}`)
    },
    check: enriched,
  },
  {
    id: 'A3 research 20',
    tool: async t => {
      const founded = []
      let out = await t.bl('steps', `tab ${t.base}/org/1; find Founded; find Next:`)
      for (;;) {
        founded.push(Number(out.match(/Founded in (\d+)/)?.[1]))
        const next = out.match(/link "(Next: [^"]+)"/)?.[1]
        if (!next) return founded
        out = await t.bl('steps', `click "${next}"; find Founded; find Next:`)
      }
    },
    check: found => JSON.stringify(found) === JSON.stringify(ORGS.map(o => o.founded)),
  },
  {
    id: 'A4 transact 12 steps',
    tool: async t => {
      const values = { ...BRIEF }
      let out = await t.bl('tab', `${t.base}/wizard`), last = []
      for (let call = 0; call < 40 && !/Account created/.test(out); call++) {
        // The form as it is now: not the lines an answer marks as gone, nor its echo of the commands.
        const answer = out
        out = out.split('\n').filter(l => !/^(- |\d+\. )/.test(l)).join('\n')
        // What the form said did not take is corrected as it asks: a name it offers is used, a field it wants empty is emptied.
        const offered = out.match(/taken\. (\S+) is free/)?.[1]
        if (offered) values.Username = offered
        if (/Leave the field empty/.test(out)) values['Promo code'] = ''
        // A name two controls share is an error that lists them with refs: the one of the kind the command acts on is used.
        const shared = /controls are named/.test(answer)
        if (shared) for (const [, n, label] of answer.matchAll(/\[(\d+)\] checkbox "([^"]+)"/g)) fill[label] = () => `check ${n}`
        const shown = shared ? last : Object.keys(fill).filter(label => new RegExp(`"${label}"`).test(out) || (label === 'Plan' && /radio "Pro"/.test(out)))
        const button = /"Create account"/.test(out) ? 'Create account' : 'Continue'
        last = shown
        out = await t.bl('steps', [...shown.filter(l => values[l] !== true || !new RegExp(`"${l}"\\s+checked`).test(out)).map(l => fill[l](values[l])), `click "${button}"`].join('; '))
      }
    },
    check: () => JSON.stringify(Object.entries(state.wizard ?? {}).sort()) === JSON.stringify(Object.entries(EXPECTED).sort()),
  },
  {
    id: 'A5 reduce 500',
    // The list is saved once and asked three questions, each answered by the tool: no row enters the conversation
    // but the ten that are the answer.
    tool: async t => {
      const file = t.out('all.tsv')
      await getAll(t, ref(await t.bl('tab', `${t.base}/list/rel`), 'list of 20'))
      const out = await t.bl('steps', `get ${file} --where c3=Garden --where "c4<100" --count; get ${file} --group c3; get ${file} --sort c4 --desc --limit 10 --cols c1`)
      return {
        cheapGarden: Number(out.match(/(\d+) of 500 records/)[1]),
        perCategory: Object.fromEntries(CATEGORIES.map(c => [c, Number(out.match(new RegExp(`^${c}\\t(\\d+)$`, 'm'))[1])])),
        top10: [...out.matchAll(/link "([^"]+)"/g)].map(m => m[1]),
      }
    },
    shell: async t => {
      const file = t.out('all.tsv')
      await getAll(t, ref(await t.bl('tab', `${t.base}/list/rel`), 'list of 20'))
      const out = await t.sh(`awk -F'\\t' 'NR>1 { p=substr($4,2)+0; n[$3]++; if ($3=="Garden" && p<100) g++; print p "\\t" $1 > "${file}.byprice" } END { print "cheapGarden " g; for (c in n) print "cat " c " " n[c] }' ${file}; sort -gr ${file}.byprice | head -10`)
      return {
        cheapGarden: Number(out.match(/cheapGarden (\d+)/)[1]),
        perCategory: Object.fromEntries(CATEGORIES.map(c => [c, Number(out.match(new RegExp(`cat ${c} (\\d+)`))[1])])),
        top10: [...out.matchAll(/link "([^"]+)"/g)].map(m => m[1]),
      }
    },
    check: reducedRight,
  },
  // A7: the browser dies six seconds into collecting. What it costs to end with the same file.
  {
    id: 'A7 recover: browser dies while collecting',
    tool: async t => {
      const open = async () => ref(await t.bl('tab', `${t.base}/list/rel`), 'list of 20')
      t.killBrowserIn(6000)
      const out = await getAll(t, await open())
      if (!/500 records/.test(out)) await getAll(t, await open())
    },
    check: everyRecordSaved,
  },
]
