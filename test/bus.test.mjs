import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFrames, createUpstashBus, createMemoryBus } from '../src/bus.mjs'

test('Upstash frames: only "message" frames are passed on, with the payload intact, and a half frame waits for its rest', () => {
  const got = []
  let rest = parseFrames('data: subscribe,kb:ABC234,1\n\ndata: message,kb:ABC234,{"t":"ops","a":"x,y"}\n\ndata: mess', (p) => got.push(p))
  assert.deepEqual(got, ['{"t":"ops","a":"x,y"}'])
  assert.equal(rest, 'data: mess')
  rest = parseFrames(`${rest}age,kb:ABC234,{"t":"board"}\n\n`, (p) => got.push(p))
  assert.deepEqual([got.length, got[1], rest], [2, '{"t":"board"}', ''])
})

test('the subscription reads a board\'s channel with the token, reconnects after the stream ends, and stops when asked', async () => {
  const urls = []
  const enc = new TextEncoder()
  const stream = (frames) => new ReadableStream({ start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close() } })
  const fetchImpl = async (url, o) => { urls.push([url, o.headers.Authorization]); return { ok: true, body: stream([`data: message,kb:ABC234,{"n":${urls.length}}\n\n`]) } }
  const bus = createUpstashBus({ config: { url: 'https://x.upstash.io', token: 'T' }, fetchImpl, redis: { publish: async () => 1 }, sleep: () => new Promise((r) => setTimeout(r, 5)), log: { error() {} } })
  const got = []
  const stop = bus.subscribe('ABC234', (p) => got.push(p))
  await new Promise((r) => setTimeout(r, 60))
  stop()
  const count = urls.length
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(count >= 2, 'reconnected')
  assert.equal(urls.length, count, 'no more after unsubscribing')
  assert.deepEqual(urls[0], ['https://x.upstash.io/subscribe/kb%3AABC234', 'Bearer T'])
  assert.deepEqual(got.slice(0, 2), ['{"n":1}', '{"n":2}'])
})

test('publish goes to the board\'s channel as JSON, and a failure is reported, not thrown', async () => {
  const sent = []
  const bus = createUpstashBus({ config: { url: 'u', token: 't' }, redis: { publish: async (c, m) => { sent.push([c, m]); return 1 } }, log: { error() {} } })
  assert.equal(await bus.publish('ABC234', { t: 'eph' }), true)
  assert.deepEqual(sent, [['kb:ABC234', '{"t":"eph"}']])
  const broken = createUpstashBus({ config: { url: 'u', token: 't' }, redis: { publish: async () => { throw new Error('down') } }, log: { error() {} } })
  assert.equal(await broken.publish('ABC234', {}), false)
})

test('the in-process bus delivers to subscribers and forgets them when they leave', async () => {
  const bus = createMemoryBus()
  const got = []
  const off = bus.subscribe('ABC234', (t) => got.push(t))
  await bus.publish('ABC234', { a: 1 })
  await new Promise((r) => setTimeout(r, 5))
  off()
  await bus.publish('ABC234', { a: 2 })
  await new Promise((r) => setTimeout(r, 5))
  assert.deepEqual(got, ['{"a":1}'])
  assert.equal(bus.subscribers('ABC234'), 0)
})
