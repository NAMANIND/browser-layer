// The floor site (docs/LONG-TASKS.md §2): generated, deterministic, local. Each part is a general shape of long web
// work, not a copy of a site: a list of 500 records reached five ways, a page per record, a chain of pages to read,
// and a form of twelve steps. Server state is kept for the checks.
import { createServer } from 'node:http'

const rand = (seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)(7)
const pick = list => list[Math.floor(rand() * list.length)]
export const PER_PAGE = 20
export const CATEGORIES = ['Tools', 'Garden', 'Kitchen', 'Office', 'Toys', 'Sports', 'Audio', 'Lighting']
export const ITEMS = Array.from({ length: 500 }, (_, i) => ({
  sku: `SKU-${10000 + i}`, name: `${pick(['Compact', 'Heavy', 'Quiet', 'Bright', 'Folding', 'Smart'])} ${pick(['Drill', 'Lamp', 'Kettle', 'Chair', 'Speaker', 'Rake'])} ${i + 1}`,
  price: (5 + Math.floor(rand() * 49500) / 100).toFixed(2), cat: pick(CATEGORIES), sale: rand() < 0.2,
  weight: `${(0.1 + rand() * 20).toFixed(1)} kg`, origin: pick(['Portugal', 'Vietnam', 'Mexico', 'Poland', 'Kenya']), warranty: `${1 + Math.floor(rand() * 5)} years`,
}))
export const ORGS = Array.from({ length: 20 }, () => ({ name: `${pick(['Northern', 'Harbour', 'Old Mill', 'Riverside', 'Upland'])} ${pick(['Rowing', 'Choral', 'Chess', 'Gardening', 'Cycling'])} Society ${1000 + Math.floor(rand() * 9000)}`, founded: 1900 + Math.floor(rand() * 120) }))
// What the form is to be filled with (the task's brief), and what the server must end up holding: the username is
// taken and the promo code has expired, which no one can know before the form says so.
export const BRIEF = { 'Full name': 'Asha Rao', Email: 'asha@example.test', Username: 'asha', Country: 'Japan', City: 'Osaka', 'Date of birth': '1994-03-15', Plan: 'Pro', 'Promo code': 'WELCOME', Seats: '4', Newsletter: true, Terms: true, Address: '12 Hill Road', Postcode: '530-0001' }
export const EXPECTED = { ...BRIEF, Username: 'asha_k', 'Promo code': '' }
const CITIES = { India: ['Pune', 'Kochi'], Japan: ['Osaka', 'Sendai'], Brazil: ['Recife', 'Manaus'] }
// One field or two per step. kind: text, date, number, select (options), radio (options), checkbox.
const STEPS = [
  [['Full name', 'text']], [['Email', 'text']], [['Username', 'text']], [['Country', 'select', Object.keys(CITIES)], ['City', 'select', []]],
  [['Date of birth', 'date']], [['Plan', 'radio', ['Basic', 'Pro', 'Team']]], [['Promo code', 'text']], [['Seats', 'number']],
  [['Newsletter', 'checkbox']], [['Terms', 'checkbox']], [['Address', 'text'], ['Postcode', 'text']], [],
]
// fetched: how many times each address was asked for, for the runs that count repeated work.
export const state = { wizard: null, fetched: {} }

const filler = 'It keeps regular hours and publishes its accounts each spring. Members meet in the main hall, and visitors are welcome on the first Monday of the month. '
const card = (it, pre) => `<li class="card"><div class="t"><a href="${pre}/item/${it.sku}">${it.name}</a></div><div class="sku">${it.sku}</div><div class="cat">${it.cat}</div>${it.sale ? '<div class="badge">Sale</div>' : ''}<div class="price">$${it.price}</div></li>`
const cards = (from, pre) => ITEMS.slice(from, from + PER_PAGE).map(it => card(it, pre)).join('')
const chrome = (title, main, pre = '') => `<!doctype html><meta charset="utf-8"><title>${title}</title>
  <header><nav aria-label="Site">${['Home', 'Catalogue', 'Stores', 'Help', 'Account'].map(n => `<a href="${pre}/${n.toLowerCase()}">${n}</a>`).join(' ')}</nav></header>
  <main>${main}</main><footer><a href="${pre}/terms">Terms</a> <a href="${pre}/privacy">Privacy</a> <a href="${pre}/contact">Contact</a></footer>`

// The list rendered by the server, one page per address. `rel` marks the next page as HTML does (rel=next); `pager`
// has only page numbers in a navigation landmark, the current one marked aria-current.
function listPage(kind, page, pre) {
  const pages = ITEMS.length / PER_PAGE
  const href = n => `${pre}/list/${kind}?page=${n}`
  const nav = kind === 'rel'
    ? `${page > 1 ? `<a rel="prev" href="${href(page - 1)}">Previous</a>` : ''} ${page < pages ? `<a rel="next" href="${href(page + 1)}">Next</a>` : ''}`
    : Array.from({ length: pages }, (_, i) => i + 1).filter(n => n === 1 || n === pages || Math.abs(n - page) <= 2)
      .map(n => (n === page ? `<a aria-current="page" href="${href(n)}">${n}</a>` : `<a href="${href(n)}">${n}</a>`)).join(' ')
  return chrome(`Catalogue, page ${page}`, `<h1>Catalogue</h1><p>${ITEMS.length} items, page ${page} of ${pages}</p><ul class="results">${cards((page - 1) * PER_PAGE, pre)}</ul>
    <nav aria-label="Pagination">${nav}</nav>`, pre)
}

// The list built in the page. `button`: a control named in German adds twenty. `scroll`: reaching the end adds twenty.
// `rerender`: Next replaces the whole list with new elements a moment later, as an app that re-renders does.
const listApp = (kind, pre) => chrome('Catalogue', `<h1>Catalogue</h1><p id="n"></p><ul class="results" id="l"></ul>
  ${kind === 'button' ? '<button id="more">Mehr laden</button>' : kind === 'scroll' ? '<div id="end" style="height:40px"></div>' : '<button id="next">Next</button>'}
  <script>
    let shown = 0
    const load = async () => (await fetch('${pre}/api/cards?from=' + shown)).text()
    const count = () => { n.textContent = ${kind === 'rerender' ? `'Page ' + (shown / ${PER_PAGE}) + ' of ${ITEMS.length / PER_PAGE}'` : `shown + ' von ${ITEMS.length}'`} }
    const add = async () => { if (shown >= ${ITEMS.length}) return; const html = await load(); shown += ${PER_PAGE}; l.insertAdjacentHTML('beforeend', html); count()
      ${kind === 'button' ? `if (shown >= ${ITEMS.length}) more.remove()` : ''} }
    ${kind === 'button' ? 'more.onclick = add; add()' : kind === 'scroll' ? 'add().then(() => new IntersectionObserver(e => e[0].isIntersecting && add()).observe(end))'
    : `const turn = async () => { const html = await load(); shown += ${PER_PAGE}; setTimeout(() => { const ul = document.createElement('ul'); ul.className = 'results'; ul.id = 'l'; ul.innerHTML = html; document.getElementById('l').replaceWith(ul); count(); next.disabled = shown >= ${ITEMS.length} }, 300) }
       next.onclick = turn; turn()`}
  </script>`, pre)

const item = (it, pre) => chrome(it.name, `<h1>${it.name}</h1><p>${it.sku} · ${it.cat} · $${it.price}</p>
  <dl><dt>Weight</dt><dd>${it.weight}</dd><dt>Origin</dt><dd>${it.origin}</dd><dt>Warranty</dt><dd>${it.warranty}</dd></dl><p>${filler.repeat(3)}</p>`, pre)

// A chain of pages: each one's fact is in its text, and its only way on is a link named after the next page, which
// no one can know before reading this one.
const org = (k, pre) => chrome(ORGS[k - 1].name, `<h1>${ORGS[k - 1].name}</h1><p>${filler.repeat(4)}</p><p>Founded in ${ORGS[k - 1].founded}, it has kept the same charter since.</p><p>${filler.repeat(5)}</p>
  ${k < ORGS.length ? `<a href="${pre}/org/${k + 1}">Next: ${ORGS[k].name}</a>` : '<p>End of the register.</p>'}`, pre)

const wizard = pre => chrome('Create an account', `<h1>Create an account</h1><div id="w"></div><p id="err" role="alert"></p>
  <script>
    const STEPS = ${JSON.stringify(STEPS)}, CITIES = ${JSON.stringify(CITIES)}, values = {}
    let at = 0
    const field = ([label, kind, options]) => {
      const id = label.replace(/\\W/g, '')
      if (kind === 'select') return '<label for="' + id + '">' + label + '</label><select id="' + id + '" data-l="' + label + '"><option value="">Choose</option>' + options.map(o => '<option>' + o + '</option>').join('') + '</select>'
      if (kind === 'radio') return '<fieldset><legend>' + label + '</legend>' + options.map(o => '<label><input type="radio" name="' + id + '" data-l="' + label + '" value="' + o + '"> ' + o + '</label>').join('') + '</fieldset>'
      if (kind === 'checkbox') return '<label><input type="checkbox" id="' + id + '" data-l="' + label + '"> ' + label + '</label>'
      return '<label for="' + id + '">' + label + '</label><input id="' + id + '" data-l="' + label + '" type="' + kind + '">'
    }
    const show = () => {
      err.textContent = ''
      w.innerHTML = '<h2>Step ' + (at + 1) + ' of ' + STEPS.length + '</h2>' + (STEPS[at].length ? STEPS[at].map(field).join('') : '<p>Review your details, then create the account.</p>')
        + '<button id="go">' + (at === STEPS.length - 1 ? 'Create account' : 'Continue') + '</button>'
      const country = document.getElementById('Country')
      if (country) country.onchange = () => setTimeout(() => { City.innerHTML = '<option value="">Choose</option>' + (CITIES[country.value] || []).map(c => '<option>' + c + '</option>').join('') }, 200)
      go.onclick = async () => {
        for (const e of w.querySelectorAll('[data-l]')) { if (e.type === 'radio') { if (e.checked) values[e.dataset.l] = e.value } else values[e.dataset.l] = e.type === 'checkbox' ? e.checked : e.value }
        const r = await (await fetch('${pre}/wizard/check', { method: 'POST', body: JSON.stringify({ at, values }) })).json()
        if (r.error) { err.textContent = r.error; return }
        if (++at === STEPS.length) { w.innerHTML = '<h2>Account created</h2>'; return }
        show()
      }
    }
    show()
  </script>`, pre)

function check({ at, values }) {
  for (const [label, kind] of STEPS[at]) if (kind !== 'checkbox' && label !== 'Promo code' && !values[label]) return { error: `${label} is required.` }
  if (at === 2 && values.Username === 'asha') return { error: 'The username asha is taken. asha_k is free.' }
  if (at === 6 && values['Promo code']) return { error: `The promo code ${values['Promo code']} has expired. Leave the field empty to continue.` }
  if (at === 9 && !values.Terms) return { error: 'Accept the terms to continue.' }
  if (at === STEPS.length - 1) state.wizard = values
  return {}
}

// Addresses under /slow answer 400 ms late, for the fault runs: a list that takes long enough to be interrupted.
export function start() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const pre = url.pathname.startsWith('/slow') ? '/slow' : ''
    const path = url.pathname.slice(pre.length)
    state.fetched[url.pathname] = (state.fetched[url.pathname] ?? 0) + 1
    if (pre) await new Promise(r => setTimeout(r, 400))
    const html = body => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(body) }
    const [, a, b] = path.split('/')
    if (a === 'list' && (b === 'rel' || b === 'pager')) return html(listPage(b, Number(url.searchParams.get('page') ?? 1), pre))
    if (a === 'list' && ['button', 'scroll', 'rerender'].includes(b)) return html(listApp(b, pre))
    if (a === 'api' && b === 'cards') return html(cards(Number(url.searchParams.get('from')), pre))
    if (a === 'item' && ITEMS.some(it => it.sku === b)) return html(item(ITEMS.find(it => it.sku === b), pre))
    if (a === 'org' && ORGS[b - 1]) return setTimeout(() => html(org(Number(b), pre)), b === '7' || b === '14' ? 2000 : 0)
    if (a === 'wizard' && b === 'check') { let body = ''; for await (const c of req) body += c; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(check(JSON.parse(body)))) }
    if (a === 'wizard') return html(wizard(pre))
    res.statusCode = 404
    html(chrome('Not found', '<h1>Not found</h1>', pre))
  })
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ base: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close() } })))
}

if (import.meta.url === `file://${process.argv[1]}`) console.log((await start()).base)
