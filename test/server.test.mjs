import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createRealtimeServer, CLOSE_RECONNECT } from '../src/wsServer.mjs'
import { createMemoryBus } from '../src/bus.mjs'
import { signTicket } from '../src/ticket.mjs'

const SECRET = 'test-secret'
const ORIGIN = 'https://retrospace.example'
const CODE = 'ABC234'
const ANN = 'KM-AAAA-BBBB-CCCC'
const BOB = 'KM-DDDD-EEEE-FFFF'
const AVATAR = { bg: 1, body: 2, eyes: 3, mouth: 4, extra: 5 }
const person = (name, extra = {}) => ({ persona: { name, avatar: AVATAR }, owner: false, revoked: false, banned: false, readOnly: false, throwables: { enabled: false, emojis: [] }, ...extra })

// The website, as far as this server is concerned: it answers "who is this?" for the people it knows.
function website(people = {}) {
  const table = { [`${CODE}:${ANN}`]: person('Ann Otter'), [`${CODE}:${BOB}`]: person('Bob Heron'), ...people }
  const calls = []
  const facts = async (code, uid) => { calls.push(`${code}:${uid}`); return table[`${code}:${uid}`] ? { facts: table[`${code}:${uid}`] } : { missing: true } }
  return { facts, calls, table }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function boot({ site = website(), ...extra } = {}) {
  const bus = extra.bus ?? createMemoryBus()
  const rt = createRealtimeServer({ secret: SECRET, facts: site.facts, bus, allowedOrigins: [ORIGIN], log: { error() {} }, ...extra })
  const port = await rt.listen(0, '127.0.0.1')
  return { rt, bus, port, site, url: (q) => `ws://127.0.0.1:${port}/ws?${new URLSearchParams(q)}` }
}
function open(url, { origin = ORIGIN } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: origin ? { Origin: origin } : {} })
    const got = []
    ws.on('message', (d) => got.push(JSON.parse(d.toString())))
    ws.on('open', () => resolve({ ws, got }))
    ws.on('unexpected-response', (req, res) => resolve({ refused: res.statusCode }))
    ws.on('error', () => {})
  })
}
const q = (uid, extra = {}) => ({ code: CODE, uid, tok: signTicket(SECRET, CODE, uid), ...extra })

test('a person with a valid ticket connects; refused without one, with somebody else\'s, from a foreign site, or to a board that does not exist', async () => {
  const { rt, url, port } = await boot()
  try {
    const good = await open(url(q(ANN)))
    assert.ok(good.ws)
    good.ws.close()
    assert.equal((await open(url({ code: CODE, uid: ANN, tok: 'nope' }))).refused, 403)
    assert.equal((await open(url({ code: CODE, uid: ANN, tok: signTicket(SECRET, CODE, BOB) }))).refused, 403, 'a ticket is for one person')
    assert.equal((await open(url({ code: CODE, uid: ANN, tok: signTicket('another-secret', CODE, ANN) }))).refused, 403)
    assert.equal((await open(url({ code: CODE, uid: ANN, tok: signTicket(SECRET, CODE, ANN, Date.now() - 3_600_000) }))).refused, 403, 'expired')
    assert.equal((await open(url(q(ANN)), { origin: 'https://evil.example' })).refused, 403)
    assert.equal((await open(url(q(ANN)), { origin: null })).refused, 403, 'a browser always sends its origin')
    assert.equal((await open(url({ code: 'ZZZZ22', uid: ANN, tok: signTicket(SECRET, 'ZZZZ22', ANN) }))).refused, 404)
    assert.equal((await open(`ws://127.0.0.1:${port}/elsewhere`)).refused, 404)
    assert.equal((await open(url({ ...q(ANN), cid: 'has space' }))).refused, 403)
  } finally { await rt.close() }
})

test('a revoked link, a removed person and a person who never chose a name cannot connect; the owner can', async () => {
  const OWNER = 'KM-GGGG-HHHH-JJJJ'
  const site = website({
    [`${CODE}:${ANN}`]: person('Ann', { revoked: true }),
    [`${CODE}:${BOB}`]: person('Bob', { banned: true }),
    [`${CODE}:KM-2222-3333-4444`]: { ...person('x'), persona: null },
    [`${CODE}:${OWNER}`]: person('Olive', { owner: true, revoked: true }),
  })
  const { rt, url } = await boot({ site })
  try {
    assert.equal((await open(url(q(ANN)))).refused, 403)
    assert.equal((await open(url(q(BOB)))).refused, 403)
    assert.equal((await open(url(q('KM-2222-3333-4444')))).refused, 403)
    const owner = await open(url(q(OWNER)))
    assert.ok(owner.ws)
    owner.ws.close()
  } finally { await rt.close() }
})

test('if the website cannot be reached, the connection is refused with 503 (the browser falls back to the plain stream)', async () => {
  const { rt, url } = await boot({ site: { facts: async () => ({ error: 'unreachable' }), calls: [] } })
  try { assert.equal((await open(url(q(ANN)))).refused, 503) } finally { await rt.close() }
})

test('a live message goes to everybody else in the room at once, named by the website\'s facts, and not back to the sender', async () => {
  const { rt, url } = await boot()
  try {
    const a = await open(url(q(ANN, { cid: 'tab-a' })))
    const b = await open(url(q(BOB, { cid: 'tab-b' })))
    a.ws.send(JSON.stringify({ t: 'eph', msg: { t: 'cursor', x: 10, y: 20, name: 'FORGED', uid: 'KM-FORGED' } }))
    await wait(150)
    assert.equal(a.got.length, 0)
    assert.equal(b.got.length, 1)
    const env = b.got[0]
    assert.deepEqual([env.t, env.from, env.cid, env.msg], ['eph', ANN, 'tab-a', { t: 'cursor', x: 10, y: 20, name: 'Ann Otter', avatar: AVATAR }])
    a.ws.close(); b.ws.close()
  } finally { await rt.close() }
})

test('bad or not-allowed messages are refused with a reason, and a flood is throttled to 30 a second per person', async () => {
  const { rt, url } = await boot()
  try {
    const a = await open(url(q(ANN)))
    a.ws.send(JSON.stringify({ t: 'eph', msg: { t: 'cursor', x: 'left', y: 1 } }))
    a.ws.send(JSON.stringify({ t: 'eph', msg: { t: 'throw', emoji: '🍌', x: 1, y: 1 } }))
    a.ws.send('not json at all')
    await wait(200)
    assert.deepEqual(a.got.map((m) => [m.t, m.status, m.error]), [['err', 400, 'invalid msg'], ['err', 403, 'Throwing is off']])
    const listener = await open(url(q(BOB)))
    for (let i = 0; i < 80; i++) a.ws.send(JSON.stringify({ t: 'eph', msg: { t: 'cursor', x: i, y: i } }))
    await wait(400)
    const delivered = listener.got.filter((m) => m.t === 'eph').length
    assert.ok(delivered >= 25 && delivered <= 30, `delivered ${delivered}`)
    a.ws.close(); listener.ws.close()
  } finally { await rt.close() }
})

test('a frame over 4 KB closes the connection, a binary frame too', async () => {
  const { rt, url } = await boot()
  try {
    const big = await open(url(q(ANN)))
    const closed = new Promise((r) => big.ws.on('close', (c) => r(c)))
    big.ws.send('x'.repeat(5000))
    assert.equal(await closed, 1009)
    const bin = await open(url(q(ANN)))
    const closedBin = new Promise((r) => bin.ws.on('close', (c) => r(c)))
    bin.ws.send(Buffer.from([1, 2, 3]))
    assert.equal(await closedBin, 1003)
  } finally { await rt.close() }
})

test('what the website publishes on the bus (saved changes, settings, removals) reaches every connected person, on every copy of the server', async () => {
  const bus = createMemoryBus()
  const one = await boot({ bus })
  const two = await boot({ bus })
  try {
    const a = await open(one.url(q(ANN)))
    const b = await open(two.url(q(BOB)))
    await wait(50)
    assert.equal(bus.subscribers(CODE), 2, 'one subscription per copy that has somebody connected')
    await bus.publish(CODE, { t: 'ops', from: 'KM-SOMEONE-ELSE', ops: [{ id: 'n1', kind: 'note' }] })
    await wait(100)
    assert.equal(a.got.at(-1).t, 'ops')
    assert.equal(b.got.at(-1).t, 'ops')
    a.ws.send(JSON.stringify({ t: 'eph', msg: { t: 'cursor', x: 1, y: 2 } }))
    await wait(150)
    assert.equal(b.got.filter((m) => m.t === 'eph').length, 1, 'reaches the other copy, once')
    assert.equal(a.got.filter((m) => m.t === 'eph').length, 0)
    a.ws.close(); b.ws.close()
    await wait(100)
    assert.equal(bus.subscribers(CODE), 0, 'the channel is dropped when the last person leaves')
  } finally { await one.rt.close(); await two.rt.close() }
})

test('a connection is closed with "reconnect" at its age limit or its ticket\'s expiry, and /health says how many are connected', async () => {
  const { rt, port, url } = await boot({ maxLifetimeMs: 200 })
  try {
    const a = await open(url(q(ANN)))
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    assert.deepEqual([h.ok, h.connections, h.rooms], [true, 1, 1])
    assert.equal(await new Promise((r) => a.ws.on('close', (c) => r(c))), CLOSE_RECONNECT)
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).connections, 0)
  } finally { await rt.close() }
  const short = await boot()
  try {
    const t = await open(short.url({ code: CODE, uid: ANN, tok: signTicket(SECRET, CODE, ANN, Date.now(), 300) }))
    assert.equal(await new Promise((r) => t.ws.on('close', (c) => r(c))), CLOSE_RECONNECT, 'never past the ticket')
  } finally { await short.rt.close() }
})

test('the server stops accepting at its connection limit', async () => {
  const { rt, url } = await boot({ maxConnections: 2 })
  try {
    const a = await open(url(q(ANN)))
    const b = await open(url(q(BOB)))
    assert.equal((await open(url(q(ANN)))).refused, 503)
    a.ws.close(); b.ws.close()
  } finally { await rt.close() }
})
