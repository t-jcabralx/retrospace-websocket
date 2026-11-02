// An end-to-end check of the realtime server together with the website and the bus. Usage: node scripts/sim-e2e.mjs <siteUrl>
// The website must have REALTIME_WS_URL set and RT_SECRET equal to this server's, and this server must be running with the same Upstash.
// Two guests join a board, connect to the realtime server the way a browser does, and the script checks what reaches whom and how fast.
import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
const generatePersona = () => ({ kind: 'custom', name: `Tester ${randomBytes(3).toString('hex')}`, avatar: { bg: 1, body: 2, eyes: 3, mouth: 4, extra: 5 } })

const SITE = (process.argv[2] ?? '').replace(/\/$/, '')
if (!SITE) { console.log('usage: node scripts/sim-e2e.mjs <siteUrl>'); process.exit(1) }
const IP = `10.${randomBytes(1)[0]}.${randomBytes(1)[0]}.${randomBytes(1)[0]}`
let n = 0
const check = (name, ok, detail) => { n++; if (!ok) { console.log(`FAIL ${String(n).padStart(2, '0')} ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); process.exit(1) } console.log(`PASS ${String(n).padStart(2, '0')} ${name}`) }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

class Jar {
  constructor() { this.m = new Map() }
  absorb(list) { for (const c of list) { const [pair] = c.split(';'); const eq = pair.indexOf('='); this.m.set(pair.slice(0, eq), pair.slice(eq + 1)) } }
  header() { return [...this.m].map(([k, v]) => `${k}=${v}`).join('; ') }
}
async function call(method, path, body, jar) {
  const res = await fetch(SITE + path, { method, headers: { 'x-forwarded-for': IP, origin: SITE, ...(body !== undefined && { 'content-type': 'application/json' }), ...(jar?.header() && { cookie: jar.header() }) }, body: body !== undefined ? JSON.stringify(body) : undefined })
  jar?.absorb(res.headers.getSetCookie())
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

const owner = new Jar()
check('the owner signs up', (await call('POST', '/api/auth/register', { email: `rt-${randomBytes(4).toString('hex')}@example.com`, name: 'Olive Owner', password: 'correct horse battery' }, owner)).status === 200)
const code = (await call('POST', '/api/boards', { type: 'workshop', template: 'blank', title: 'Realtime check' }, owner)).data.code
check('a board is created', Boolean(code))

async function guest(label) {
  const jar = new Jar()
  const snap = await call('GET', `/api/boards/${code}`, undefined, jar)
  await call('PUT', `/api/boards/${code}/persona`, { persona: generatePersona() }, jar)
  const join = await call('POST', '/api/rt/join', { code }, jar)
  return { label, jar, uid: snap.data.viewer.uid, tok: join.data.wsTok, ws: join.data.ws, cid: `c${randomBytes(6).toString('hex')}`, got: [] }
}
const a = await guest('ann')
const b = await guest('bob')
check('the website hands out the realtime server\'s address with a ticket made for it', typeof a.ws === 'string' && a.ws.startsWith('ws') && /^\d{13}\.[0-9a-f]{32}$/.test(a.tok ?? ''), a.ws)

function connect(g) {
  return new Promise((resolve, reject) => {
    const u = `${g.ws}${g.ws.includes('?') ? '&' : '?'}${new URLSearchParams({ code, uid: g.uid, tok: g.tok, cid: g.cid })}`
    const ws = new WebSocket(u, { headers: { Origin: SITE } })
    ws.on('message', (d) => g.got.push({ at: performance.now(), env: JSON.parse(d.toString()) }))
    ws.on('open', () => resolve(ws))
    ws.on('unexpected-response', (req, res) => reject(new Error(`refused ${res.statusCode}`)))
    ws.on('error', reject)
    g.socket = ws
  })
}
await connect(a); await connect(b)
check('both guests connect to the realtime server', a.socket.readyState === 1 && b.socket.readyState === 1)

const sendLive = (g, msg) => g.socket.send(JSON.stringify({ t: 'eph', msg }))
const since = (g, from) => g.got.filter((m) => m.at >= from)

// live messages: delivered to the other guest, named by the server
let t0 = performance.now()
sendLive(a, { t: 'cursor', x: 11, y: 22 })
await wait(400)
const cur = since(b, t0).find((m) => m.env.t === 'eph' && m.env.msg.t === 'cursor')
check('a cursor from ann reaches bob', Boolean(cur) && cur.env.msg.x === 11 && cur.env.from === a.uid, since(b, t0))
check('the server named the sender from the stored persona', typeof cur.env.msg.name === 'string' && cur.env.msg.name.length > 0 && !('uid' in cur.env.msg))
check('ann does not get her own cursor back', !since(a, t0).some((m) => m.env.t === 'eph' && m.env.msg.t === 'cursor'))

// latency of live messages between two connections of the same server
const lat = []
for (let i = 0; i < 40; i++) {
  const s = performance.now()
  sendLive(a, { t: 'cursor', x: i, y: i })
  const target = i
  const hit = await new Promise((resolve) => { const iv = setInterval(() => { const m = b.got.find((g) => g.at >= s && g.env.msg?.t === 'cursor' && g.env.msg.x === target); if (m) { clearInterval(iv); resolve(m) } }, 1) ; setTimeout(() => { clearInterval(iv); resolve(null) }, 2000) })
  if (hit) lat.push(hit.at - s)
  await wait(40)
}
lat.sort((x, y) => x - y)
const med = lat[Math.floor(lat.length / 2)]
const p95 = lat[Math.floor(lat.length * 0.95)]
check(`40 cursors delivered (median ${med?.toFixed(1)} ms, 95th percentile ${p95?.toFixed(1)} ms)`, lat.length >= 38 && p95 < 400, { delivered: lat.length })

// saved changes: written through the website's API, pushed to every connected guest through the bus
t0 = performance.now()
const add = await call('POST', `/api/boards/${code}/ops`, { cid: 'writer-cid', ops: [{ op: 'add', item: { id: 'n-rt-1', kind: 'note', x: 5, y: 6, w: 200, h: 140, data: { text: 'hello realtime' } } }] }, a.jar)
check('a note is saved through the API', add.status === 200 && add.data.applied?.length === 1, add.data)
await wait(600)
const pushed = (g) => since(g, t0).find((m) => m.env.t === 'ops' && JSON.stringify(m.env.ops).includes('n-rt-1'))
check('the saved note is pushed to bob over his connection', Boolean(pushed(b)))
check('and to ann (her connection is another tab from the writer\'s point of view)', Boolean(pushed(a)))

// rules are the same as the website's
t0 = performance.now()
sendLive(a, { t: 'cursor', x: 'left' })
sendLive(a, { t: 'throw', emoji: '🍌', x: 1, y: 1 })
await wait(300)
const errs = since(a, t0).filter((m) => m.env.t === 'err')
check('bad or not-allowed live messages are refused with a reason', errs.length === 2 && errs[0].env.status === 400 && errs[1].env.error === 'Throwing is off', errs.map((e) => e.env))

// a stolen or wrong ticket is refused
const bad = await new Promise((resolve) => { const ws = new WebSocket(`${a.ws}?${new URLSearchParams({ code, uid: a.uid, tok: b.tok })}`, { headers: { Origin: SITE } }); ws.on('open', () => resolve('opened')); ws.on('unexpected-response', (r, res) => resolve(res.statusCode)); ws.on('error', () => {}) })
check('a ticket that belongs to somebody else is refused', bad === 403, bad)
const foreign = await new Promise((resolve) => { const ws = new WebSocket(`${a.ws}?${new URLSearchParams({ code, uid: a.uid, tok: a.tok })}`, { headers: { Origin: 'https://evil.example' } }); ws.on('open', () => resolve('opened')); ws.on('unexpected-response', (r, res) => resolve(res.statusCode)); ws.on('error', () => {}) })
check('a connection from another website is refused', foreign === 403, foreign)

a.socket.close(); b.socket.close()
console.log('PASS (all)')
