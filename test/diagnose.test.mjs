import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { diagnose } from '../src/diagnose.mjs'
import { createStatusApp } from '../src/status.mjs'
import { createRealtimeServer } from '../src/server.mjs'
import { createMemoryBus } from '../src/bus.mjs'
import { authorizeSignature } from '../src/siteAuth.mjs'

const config = { secret: 'a-long-enough-secret', siteUrl: 'https://site.example', upstash: { url: 'u', token: 't' } }
const reply = (status) => ({ status, ok: status < 300 })
const redisOk = { ping: async () => 'PONG' }

test('everything right: the website accepts the signature (404 for a board that cannot exist) and Upstash answers', async () => {
  const seen = []
  const fetchImpl = async (url, o) => { seen.push({ url, headers: o.headers, body: JSON.parse(o.body) }); return reply(404) }
  const r = await diagnose({ config, fetchImpl, redis: redisOk, now: () => 1_700_000_000_000 })
  assert.equal(r.ok, true)
  assert.deepEqual([r.settings.ok, r.website.ok, r.bus.ok], [true, true, true])
  assert.equal(seen[0].url, 'https://site.example/api/rt/authorize')
  assert.equal(seen[0].headers['x-rt-sig'], authorizeSignature(config.secret, 1_700_000_000_000, 'ZZZZ22', 'KM-2222-3333-4444'))
  assert.ok(!JSON.stringify(r).includes(config.secret), 'a secret is never reported')
})

test('each wrong thing is named: a secret that differs (403), a website that errors or cannot be reached, Upstash down, a bad setting', async () => {
  assert.match((await diagnose({ config, fetchImpl: async () => reply(403), redis: redisOk })).website.problem, /not the same value as on the website/)
  assert.match((await diagnose({ config, fetchImpl: async () => reply(500), redis: redisOk })).website.problem, /answered 500/)
  assert.match((await diagnose({ config, fetchImpl: async () => { throw new Error('boom') }, redis: redisOk })).website.problem, /could not be reached at https:\/\/site\.example/)
  const down = await diagnose({ config, fetchImpl: async () => reply(404), redis: { ping: async () => { throw new Error('WRONGPASS') } } })
  assert.deepEqual([down.ok, down.bus.ok], [false, false])
  assert.match(down.bus.problem, /WRONGPASS/)
  const bad = await diagnose({ config: null, configError: 'Cannot start: REALTIME_SECRET is not set' })
  assert.deepEqual([bad.ok, bad.settings.ok], [false, false])
  assert.match(bad.settings.problem, /REALTIME_SECRET is not set/)
})

const get = (server, path) => new Promise((resolve, reject) => http.get({ port: server.address().port, host: '127.0.0.1', path }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(b || '{}') })) }).on('error', reject))

test('the serverless status app says plainly that it cannot take WebSocket connections, and still checks the settings', async () => {
  const app = createStatusApp({ config, redis: redisOk, runtime: 'vercel', fetchImpl: async () => reply(404) })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  try {
    const h = await get(server, '/health')
    assert.equal(h.status, 200)
    assert.deepEqual([h.body.websocket, h.body.runtime, h.body.ok], [false, 'vercel', true])
    assert.match(h.body.note, /cannot accept WebSocket connections/)
    const ws = await get(server, '/ws')
    assert.deepEqual([ws.status, ws.headers.upgrade, ws.body.websocket], [426, 'websocket', false])
    assert.equal((await get(server, '/nope')).status, 404)
  } finally { server.close() }
  const broken = createStatusApp({ config: null, configError: 'Cannot start: SITE_URL is not set', runtime: 'vercel' })
  const s2 = broken.listen(0, '127.0.0.1')
  await new Promise((r) => s2.once('listening', r))
  try {
    const h = await get(s2, '/health')
    assert.deepEqual([h.status, h.body.ok, h.body.settings.ok], [200, false, false], 'a deployment with missing settings still answers, and says why')
  } finally { s2.close() }
})

test('the real server\'s /health is cheap, and /health?check=1 adds the full check', async () => {
  const rt = createRealtimeServer({ secret: config.secret, facts: async () => ({ missing: true }), bus: createMemoryBus(), allowedOrigins: [], check: async () => ({ ok: true, settings: { ok: true } }), log: { error() {} } })
  const port = await rt.listen(0, '127.0.0.1')
  const server = { address: () => ({ port }) }
  try {
    const plain = await get(server, '/health')
    assert.deepEqual([plain.body.ok, plain.body.websocket, 'checks' in plain.body], [true, true, false])
    const deep = await get(server, '/health?check=1')
    assert.deepEqual(deep.body.checks, { ok: true, settings: { ok: true } })
  } finally { await rt.close() }
})
