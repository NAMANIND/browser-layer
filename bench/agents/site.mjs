// Six small web apps built from common real-world patterns, each with an exact, checkable answer.
// Not shaped for any one tool: JS-built pages, unmarked product cards, autocomplete, menus built on
// open, client-side pagination, a multi-step form, a login. Server state is kept for the checks.
import { createServer } from 'node:http'

const inr = n => n.toLocaleString('en-IN')
const rand = (seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)(42)

export const LAPTOPS = Array.from({ length: 40 }, (_, i) => {
  const brands = ['Acer', 'HP', 'Lenovo', 'Dell', 'Asus', 'MSI']
  const ram = [8, 16, 32][Math.floor(rand() * 3)]
  // A model code makes each name unique, as real product names are.
  return { id: 1000 + i, name: `${brands[i % 6]} ${['Aspire', 'Pavilion', 'IdeaPad', 'Inspiron', 'Vivobook', 'Modern'][i % 6]} ${14 + (i % 3)} ${String.fromCharCode(65 + (i % 26))}${300 + i * 7}`, ram, ssd: [256, 512, 1024][Math.floor(rand() * 3)], rating: (3 + rand() * 2).toFixed(1), price: Math.round((30000 + rand() * 90000) / 10) * 10 }
})
export const FLIGHTS = Array.from({ length: 25 }, (_, i) => {
  const airlines = ['IndiGo', 'Air India', 'SpiceJet', 'Akasa Air', 'Vistara']
  const stops = i % 4 === 0 ? 1 : 0
  const dep = 300 + i * 50
  return { airline: airlines[i % 5], dep, arr: dep + 130 + stops * 95, stops, price: Math.round((4800 + rand() * 6000) / 5) * 5, best: i % 7 === 0 }
})
export const ORDERS = Array.from({ length: 120 }, (_, i) => ({ id: `ORD-${5000 + i}`, customer: `Customer ${i + 1}`, amount: Math.round(rand() * 9000 + 500), status: ['Paid', 'Shipped', 'Refunded', 'Pending', 'Paid'][Math.floor(rand() * 5)] }))
export const REPORT_TOTAL = 48213
export const state = { signups: [], settings: { email: true, sms: false } }
export function resetState() { state.signups = []; state.settings = { email: true, sms: false } }

const hhmm = m => `${Math.floor(m / 60) % 12 || 12}:${String(m % 60).padStart(2, '0')} ${Math.floor(m / 60) % 24 < 12 ? 'AM' : 'PM'}`
const page = (res, title, body) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font-family:sans-serif} .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px} .card{border:1px solid #ccc;padding:8px}</style>${body}`) }

const APPS = {
  '/shop': res => page(res, 'LapStore — Laptops', `<header><a href="/shop">LapStore</a> <input placeholder="Search laptops"></header>
    <main><h1>Laptops</h1><div id="grid" class="grid"></div></main>
    <script>const items = ${JSON.stringify(LAPTOPS)}
      grid.innerHTML = items.map(p => '<div class="card c-' + p.id + '"><div class="t">' + p.name + '</div><div class="spec">' + p.ram + ' GB RAM · ' + p.ssd + ' GB SSD</div><div class="r">★ ' + p.rating + '</div><div class="p">₹' + p.price.toLocaleString('en-IN') + '</div><button>Add to cart</button></div>').join('')</script>`),
  '/flights': res => page(res, 'SkyFind — Flights', `<main><h1>Find flights</h1>
    <div role="radiogroup" aria-label="Trip type"><label><input type="radio" name="trip" checked> Round trip</label><label><input type="radio" name="trip" id="ow"> One way</label></div>
    <label for="from">From</label><input id="from" role="combobox" aria-expanded="false" aria-controls="sf" autocomplete="off"><ul id="sf" role="listbox"></ul>
    <label for="to">To</label><input id="to" role="combobox" aria-expanded="false" aria-controls="st" autocomplete="off"><ul id="st" role="listbox"></ul>
    <label for="date">Date</label><input id="date" type="date"><button id="go">Search</button><p id="msg"></p><ul id="results"></ul></main>
    <script>const CITIES = ['Mumbai (BOM)', 'Delhi (DEL)', 'Bengaluru (BLR)', 'Dehradun (DED)', 'Madurai (IXM)']
      const flights = ${JSON.stringify(FLIGHTS)}; const hhmm = ${hhmm.toString()}
      for (const [input, list] of [[from, sf], [to, st]]) input.addEventListener('input', () => {
        list.innerHTML = ''; const q = input.value.toLowerCase(); if (q.length < 2) return input.setAttribute('aria-expanded', 'false')
        for (const c of CITIES.filter(c => c.toLowerCase().includes(q))) { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = c; li.onclick = () => { input.value = c; list.innerHTML = ''; input.setAttribute('aria-expanded', 'false') }; list.append(li) }
        input.setAttribute('aria-expanded', 'true') })
      go.onclick = () => { results.innerHTML = ''
        if (!from.value.includes('BOM') || !to.value.includes('DEL')) return msg.textContent = 'Pick both cities from the suggestions.'
        if (!date.value) return msg.textContent = 'Choose a date.'
        msg.textContent = flights.length + ' flights'
        results.innerHTML = flights.map(f => '<li><div class="tm"><span>' + hhmm(f.dep) + '</span> – <span>' + hhmm(f.arr) + '</span></div><div class="al">' + f.airline + '</div>' + (f.best ? '<span class="badge">Best</span>' : '') + '<div class="st">' + (f.stops ? '1 stop' : 'Nonstop') + '</div><div class="pr">₹' + f.price.toLocaleString('en-IN') + '</div></li>').join('') }</script>`),
  '/reports': res => page(res, 'Ledger — Q3 report', `<div role="menubar" aria-label="App menu"><button aria-haspopup="menu" aria-expanded="false" data-m="file">File</button><button aria-haspopup="menu" aria-expanded="false" data-m="view">View</button><button aria-haspopup="menu" aria-expanded="false" data-m="help">Help</button></div>
    <main><h1>Q3 report</h1><canvas id="chart" width="500" height="200" aria-label="Revenue chart"></canvas><p>The chart shows revenue by month. Figures are in the export.</p></main>
    <script>const g = chart.getContext('2d'); [80, 120, 95].forEach((h, i) => g.fillRect(40 + i * 120, 180 - h, 60, h))
      const MENUS = { file: [['New report'], ['Export', 'export'], ['Print']], export: [['CSV', '/reports/q3.csv'], ['PDF', '/reports/q3.pdf']], view: [['Zoom in'], ['Zoom out']], help: [['About']] }
      const open = []
      function show(key, by) { by.setAttribute('aria-expanded', 'true'); const m = document.createElement('div'); m.setAttribute('role', 'menu')
        for (const [name, next] of MENUS[key]) { const b = document.createElement('button'); b.setAttribute('role', 'menuitem'); b.textContent = name
          if (next && !next.startsWith('/')) { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); b.onclick = () => show(next, b) }
          else b.onclick = () => { if (next) location.href = next; while (open.length) close() }
          m.append(b) }
        document.body.append(m); open.push([m, by]) }
      function close() { const [m, by] = open.pop(); m.remove(); by.setAttribute('aria-expanded', 'false') }
      document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => show(b.dataset.m, b))
      addEventListener('keydown', e => { if (e.key === 'Escape' && open.length) close() })</script>`),
  '/orders': res => page(res, 'Shopdesk — Orders', `<main><h1>Orders</h1><table><thead><tr><th>Order</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead><tbody id="rows"></tbody></table>
    <button id="prev">Previous</button> <span id="pg"></span> <button id="next">Next</button></main>
    <script>const orders = ${JSON.stringify(ORDERS)}; let p = 0; const per = 20
      function draw() { rows.innerHTML = orders.slice(p * per, p * per + per).map(o => '<tr><td>' + o.id + '</td><td>' + o.customer + '</td><td>₹' + o.amount + '</td><td>' + o.status + '</td></tr>').join(''); pg.textContent = 'Page ' + (p + 1) + ' of ' + Math.ceil(orders.length / per); prev.disabled = p === 0; next.disabled = (p + 1) * per >= orders.length }
      prev.onclick = () => { p--; draw() }; next.onclick = () => { p++; draw() }; draw()</script>`),
  '/signup': res => page(res, 'Teamly — Sign up', `<main><h1>Create your account</h1><div id="step"></div></main>
    <script>const data = {}; let s = 1
      function draw() {
        if (s === 1) step.innerHTML = '<h2>Step 1 of 3: About you</h2><label for="n">Full name</label><input id="n"><label for="e">Email</label><input id="e" type="email"><button id="nx">Next</button>'
        if (s === 2) step.innerHTML = '<h2>Step 2 of 3: Plan</h2><div role="radiogroup" aria-label="Plan">' + ['Basic', 'Pro', 'Team'].map(p => '<div role="radio" tabindex="0" aria-checked="false" class="plan" style="padding:12px;border:1px solid">' + p + '</div>').join('') + '</div><button id="nx">Next</button>'
        if (s === 3) step.innerHTML = '<h2>Step 3 of 3: Confirm</h2><label><input type="checkbox" id="ok"> I agree to the terms</label><button id="nx">Create account</button><p id="m"></p>'
        if (s === 4) step.innerHTML = '<h2>Welcome, ' + data.name + '!</h2><p>Your account is ready.</p>'
        document.querySelectorAll('.plan').forEach(el => el.onclick = () => { document.querySelectorAll('.plan').forEach(o => o.setAttribute('aria-checked', 'false')); el.setAttribute('aria-checked', 'true'); data.plan = el.textContent })
        const nx = document.getElementById('nx'); if (nx) nx.onclick = async () => {
          if (s === 1) { data.name = n.value; data.email = e.value; if (!data.name || !data.email) return }
          if (s === 2 && !data.plan) return
          if (s === 3) { if (!ok.checked) return m.textContent = 'Please accept the terms.'; await fetch('/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) }
          s++; draw() } }
      draw()</script>`),
  '/login': res => page(res, 'Acme — Sign in', `<main><h1>Sign in</h1><form method="post" action="/login"><label for="u">Username</label><input id="u" name="u"><label for="p">Password</label><input id="p" name="p" type="password"><button>Sign in</button></form></main>`),
}

export function startSite(port = 0) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && APPS[url.pathname]) return APPS[url.pathname](res)
    if (url.pathname === '/reports/q3.csv') { res.setHeader('content-type', 'text/csv'); res.setHeader('content-disposition', 'attachment; filename="q3-report.csv"'); return res.end(`Month,Revenue\nJuly,15200\nAugust,17488\nSeptember,15525\nTotal,${REPORT_TOTAL}\n`) }
    if (url.pathname === '/api/signup' && req.method === 'POST') { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { state.signups.push(JSON.parse(b)); res.end('{}') }); return }
    if (url.pathname === '/login' && req.method === 'POST') {
      let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
        const f = new URLSearchParams(b)
        if (f.get('u') === 'demo' && f.get('p') === 'demo123') { res.statusCode = 303; res.setHeader('set-cookie', 'sess=ok; Path=/'); res.setHeader('location', '/settings') } else { res.statusCode = 303; res.setHeader('location', '/login?error=1') }
        res.end() })
      return
    }
    if (url.pathname === '/settings') {
      if (!/sess=ok/.test(req.headers.cookie ?? '')) { res.statusCode = 303; res.setHeader('location', '/login'); return res.end() }
      return page(res, 'Acme — Settings', `<main><h1>Notification settings</h1>${[['email', 'Email notifications'], ['sms', 'SMS alerts']].map(([k, label]) => `<div><span id="l-${k}">${label}</span> <button role="switch" aria-labelledby="l-${k}" aria-checked="${state.settings[k]}" data-k="${k}"></button></div>`).join('')}<p id="saved"></p></main>
        <script>document.querySelectorAll('[role=switch]').forEach(b => { b.textContent = b.getAttribute('aria-checked') === 'true' ? 'On' : 'Off'; b.onclick = async () => { const on = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', on); b.textContent = on ? 'On' : 'Off'; await fetch('/api/settings', { method: 'POST', body: JSON.stringify({ [b.dataset.k]: on }) }); saved.textContent = 'Saved' } })</script>`)
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { Object.assign(state.settings, JSON.parse(b)); res.end('{}') }); return }
    res.statusCode = 404; res.end('not found')
  })
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })))
}
