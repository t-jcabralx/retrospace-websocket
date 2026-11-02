import test from 'node:test'
import assert from 'node:assert/strict'
import { createSiteAuth, authorizeSignature } from '../src/siteAuth.mjs'

const SECRET = 'test-secret'
const CODE = 'ABC234'
const UID = 'KM-AAAA-BBBB-CCCC'
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

function make(handler, { ttlMs = 5000 } = {}) {
  const clock = { t: 1_700_000_000_000 }
  const calls = []
  const fetchImpl = async (url, o) => { calls.push({ url, headers: o.headers, body: JSON.parse(o.body) }); return handler(calls.length) }
  return { clock, calls, facts: createSiteAuth({ siteUrl: 'https://site.example', secret: SECRET, fetchImpl, now: () => clock.t, ttlMs }) }
}

test('the question goes to the website\'s authorize address, signed for exactly this person and board and moment', async () => {
  const { facts, calls, clock } = make(() => reply(200, { persona: { name: 'Ann' }, owner: false }))
  const r = await facts(CODE, UID)
  assert.deepEqual(r, { facts: { persona: { name: 'Ann' }, owner: false } })
  assert.equal(calls[0].url, 'https://site.example/api/rt/authorize')
  assert.deepEqual(calls[0].body, { code: CODE, uid: UID })
  assert.equal(calls[0].headers['x-rt-ts'], String(clock.t))
  assert.equal(calls[0].headers['x-rt-sig'], authorizeSignature(SECRET, clock.t, CODE, UID))
})

test('an answer is kept for a few seconds, then asked again; a missing board is kept too, errors never are', async () => {
  const a = make(() => reply(200, { persona: { name: 'Ann' } }))
  await a.facts(CODE, UID); await a.facts(CODE, UID)
  assert.equal(a.calls.length, 1)
  a.clock.t += 5000
  await a.facts(CODE, UID)
  assert.equal(a.calls.length, 2)

  const missing = make(() => reply(404, { error: 'Board not found' }))
  assert.deepEqual(await missing.facts(CODE, UID), { missing: true })
  await missing.facts(CODE, UID)
  assert.equal(missing.calls.length, 1)

  const flaky = make((n) => (n === 1 ? reply(500, {}) : reply(200, { persona: { name: 'Ann' } })))
  assert.deepEqual(await flaky.facts(CODE, UID), { error: 500 })
  assert.ok((await flaky.facts(CODE, UID)).facts, 'the next call asks again')
  const down = make(() => { throw new Error('ECONNREFUSED') })
  assert.deepEqual(await down.facts(CODE, UID), { error: 'unreachable' })
})

test('many people asking at once cause one question; different people each get their own', async () => {
  const { facts, calls } = make(async () => { await new Promise((r) => setTimeout(r, 20)); return reply(200, { persona: { name: 'x' } }) })
  await Promise.all(Array.from({ length: 25 }, () => facts(CODE, UID)))
  assert.equal(calls.length, 1)
  await facts(CODE, 'KM-2222-3333-4444')
  assert.equal(calls.length, 2)
})
