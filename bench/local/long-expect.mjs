// Computes the expected answers of the long tasks in tasks.json from the pages themselves (plain HTTP, one request
// at a time with a pause, no browser). Run once per task; the printed values are what `expect` holds.
//   node bench/local/long-expect.mjs quotes|stock|categories|hockey|oscars|rfc|search|rfcsections|booklookups|search
const sleep = ms => new Promise(r => setTimeout(r, ms))
const get = async u => { await sleep(250); const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.text() }
const strip = s => s.replace(/<[^>]+>/g, '').replace(/&#39;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const all = (s, re) => [...s.matchAll(re)]
const books = 'https://books.toscrape.com/'

async function listing(url) { // every book on a category or catalogue listing, following Next
  const rows = []
  for (let u = url; u;) {
    const h = await get(u)
    for (const [, art] of all(h, /<article class="product_pod">([\s\S]*?)<\/article>/g))
      rows.push({
        title: art.match(/title="([^"]+)"/)[1], href: new URL(art.match(/href="([^"]+)"/)[1], u).href,
        price: +art.match(/£([\d.]+)/)[1], stars: ['One', 'Two', 'Three', 'Four', 'Five'].indexOf(art.match(/star-rating (\w+)/)[1]) + 1,
      })
    const next = h.match(/<li class="next"><a href="([^"]+)"/)
    u = next && new URL(next[1], u).href
  }
  return rows
}

const jobs = {
  async booklookups() { // ten separate lookups on books.toscrape.com
    const cat = c => listing(`${books}catalogue/category/books/${c}/index.html`)
    const poetry = await cat('poetry_23'), travel = await cat('travel_2'), humor = await cat('humor_30')
    const sharp = await get(`${books}catalogue/sharp-objects_997/index.html`)
    const requiem = await get(`${books}catalogue/the-requiem-red_995/index.html`)
    const velvet = await get(`${books}catalogue/tipping-the-velvet_999/index.html`)
    const all = await listing(`${books}catalogue/page-1.html`)
    const perPage = 20, at = 537 // the book asked about
    console.log({
      sharpUPC: sharp.match(/UPC<\/th>\s*<td>([^<]+)/)[1], poetryOneStar: poetry.filter(b => b.stars === 1).length,
      priciestTravel: travel.sort((a, b) => b.price - a.price)[0], requiemStock: requiem.match(/In stock \((\d+)/)[1],
      humorUnder20: humor.filter(b => b.price < 20).length, velvetTax: velvet.match(/Price \(incl\. tax\)<\/th>\s*<td>([^<]+)/)[1],
      pageOf537: [all[at].title, Math.floor(at / perPage) + 1], total: all.length, classics: (await cat('classics_6')).length,
      cheapestPoetry: poetry.sort((a, b) => a.price - b.price)[0],
    })
  },
  async rfcsections() { // section titles and counts read from the numbered headings of the RFC texts
    const heads = async n => (await get(`https://www.rfc-editor.org/rfc/rfc${n}.txt`)).split('\n').flatMap(l => { const m = l.match(/^(\d+(?:\.\d+)*)\.\s{2}(\S.*)$/); return m ? [[m[1], m[2]]] : [] })
    const [h10, h11, h12, h13] = await Promise.all([9110, 9111, 9112, 9113].map(heads))
    const title = (h, num) => h.find(x => x[0] === num)?.[1]
    const number = (h, name) => h.filter(x => x[1] === name).map(x => x[0])
    const sub = (h, num) => h.filter(x => x[0].startsWith(num + '.') && x[0].split('.').length === num.split('.').length + 1).length
    console.log({ t15_5_19: title(h10, '15.5.19'), t15_4_6: title(h10, '15.4.6'), sub9_3: sub(h10, '9.3'), sub15_4: sub(h10, '15.4'), sec15: h10.filter(x => x[0].startsWith('15.')).length,
      wildcard: number(h10, 'Wildcard Values'), t12_7_1: title(h12, '7.1'), fresh: number(h11, 'Calculating Freshness Lifetime'), t13_6_9: title(h13, '6.9'), top13: h13.filter(x => !x[0].includes('.')).length })
  },
  async search() { // search.aspx offers an author's own tags after the author is chosen
    const tags = {}
    for (let p = 1; p <= 10; p++)
      for (const q of (await get(`https://quotes.toscrape.com/page/${p}/`)).split('<div class="quote"').slice(1)) {
        const set = tags[q.match(/class="author"[^>]*>([^<]+)</)[1]] ??= new Set()
        for (const t of q.matchAll(/class="tag" href="[^"]+">([^<]+)</g)) set.add(t[1])
      }
    const n = Object.entries(tags).map(([a, s]) => [a, s.size, s.has('life')]).sort((a, b) => b[1] - a[1])
    console.log({ authors: n.length, offerLife: n.filter(x => x[2]).length, most: n[0], pairs: n.reduce((s, x) => s + x[1], 0) })
  },
  async quotes() {
    const quotes = []
    for (let p = 1; ; p++) {
      const h = await get(`https://quotes.toscrape.com/page/${p}/`)
      const found = all(h, /<small class="author"[^>]*>([^<]+)<\/small>\s*<a href="([^"]+)"/g).map(m => [m[1], m[2]])
      if (!found.length) break
      quotes.push(...found)
    }
    const born = {}
    for (const [a, href] of new Map(quotes)) born[a] = +(await get(`https://quotes.toscrape.com${href}`)).match(/author-born-date">[^<]*?(\d{4})</)[1]
    const old = quotes.map(q => q[0]).filter(a => born[a] >= 1800 && born[a] < 1900)
    const n = a => old.filter(x => x === a).length
    const top = [...new Set(old)].sort((a, b) => n(b) - n(a))
    console.log({ quotes: quotes.length, authors: Object.keys(born).length, bornIn1800s: old.length, top: top.slice(0, 3).map(a => [a, n(a)]) })
  },
  async stock() {
    let sum = 0, count = 0
    for (const cat of ['mystery_3', 'travel_2', 'science_22']) {
      for (const b of await listing(`${books}catalogue/category/books/${cat}/index.html`)) {
        if (b.price <= 30 || b.stars < 4) continue
        count++
        sum += +(await get(b.href)).match(/In stock \((\d+) available\)/)[1]
      }
    }
    console.log({ count, sum })
  },
  async categories() {
    const home = await get(books)
    const cats = all(home, /<a href="(catalogue\/category\/books\/[^"]+)">\s*([^<]+?)\s*<\/a>/g).filter(m => !m[1].includes('books_1')).map(m => [m[2], m[1]])
    const counts = []
    for (const [name, href] of cats) counts.push([name, +(await get(books + href)).match(/<strong>(\d+)<\/strong>\s+results?/)[1]])
    counts.sort((a, b) => b[1] - a[1])
    console.log({ categories: counts.length, fewerThan10: counts.filter(c => c[1] < 10).length, top: counts.slice(0, 3), total: counts.reduce((s, c) => s + c[1], 0) })
  },
  async hockey() {
    const rows = []
    for (let p = 1; ; p++) {
      const h = await get(`https://www.scrapethissite.com/pages/forms/?page_num=${p}`)
      const r = all(h, /<tr class="team">([\s\S]*?)<\/tr>/g).map(m => all(m[1], /<td[^>]*>([\s\S]*?)<\/td>/g).map(c => strip(c[1])))
      if (!r.length) break
      rows.push(...r)
    }
    const y = year => rows.filter(r => +r[1] === year)
    const years = [...new Set(rows.map(r => +r[1]))].sort()
    console.log('wins per year 1990-1999', years.filter(yr => yr < 2000).map(yr => y(yr).reduce((s, r) => s + +r[2], 0)).join(' '))
    const best = [...y(1990)].sort((a, b) => b[2] - a[2])
    console.log({ rows: rows.length, wins2000: y(2000).reduce((s, r) => s + +r[2], 0), best1990: best.slice(0, 3).map(r => [r[0], r[2]]), })
  },
  async oscars() {
    let nominated = 0
    for (let year = 2010; year <= 2015; year++) {
      const films = JSON.parse(await get(`https://www.scrapethissite.com/pages/ajax-javascript/?ajax=true&year=${year}`))
      nominated += films.length
      console.log(year, films.length, films.filter(f => f.best_picture).map(f => f.title))
    }
    console.log({ nominated })
  },
  async rfc() {
    for (const n of [9110, 9111, 9112, 9113, 9114]) {
      const t = await get(`https://www.rfc-editor.org/rfc/rfc${n}.txt`)
      console.log(n, all(t, /\bMUST\s+NOT\b/g).length, all(t, /\bSHOULD\s+NOT\b/g).length)
    }
  },
}
await jobs[process.argv[2]]()
