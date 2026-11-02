import test from 'node:test'
import assert from 'node:assert/strict'
import { createRelay, THROW_BURST, CELEBRATE_GAP_MS, PER_SECOND, messageTypes } from '../src/rules.mjs'

const UID = 'KM-AAAA-BBBB-CCCC'
const AVATAR = { bg: 1, body: 2, eyes: 3, mouth: 4, extra: 5 }
const base = { persona: { name: 'Ann Otter', avatar: AVATAR }, owner: false, revoked: false, banned: false, readOnly: false, throwables: { enabled: false, emojis: [] } }
const relayWith = (facts = {}, clock = { t: 1_000_000 }) => ({ clock, relay: createRelay({ facts: async () => ({ facts: { ...base, ...facts } }), now: () => clock.t }) })
const send = (relay, msg, extra = {}) => relay({ code: 'ABC234', uid: UID, cid: 'tab-1', msg, ...extra })

test('the message types are the website\'s', () => {
  assert.deepEqual(messageTypes.sort(), ['celebrate', 'cursor', 'drag', 'hello', 'sel', 'throw', 'typing'])
})

test('a cursor is relayed with the sender from the ticket and the name and avatar from the website, never from the message', async () => {
  const { relay } = relayWith()
  const r = await send(relay, { t: 'cursor', x: 3, y: 4, name: 'FORGED', uid: 'KM-FORGED', from: 'x' })
  assert.deepEqual(r, { status: 200, envelope: { t: 'eph', from: UID, cid: 'tab-1', msg: { t: 'cursor', x: 3, y: 4, name: 'Ann Otter', avatar: AVATAR } } })
  assert.equal((await send(relay, { t: 'sel', ids: ['a'] }, { cid: undefined })).envelope.cid, undefined)
})

test('malformed, unknown, oversized and out-of-range messages are refused with a reason', async () => {
  const { relay } = relayWith()
  assert.deepEqual(await send(relay, { t: 'cursor', x: 'left', y: 1 }), { status: 400, error: 'invalid msg' })
  assert.deepEqual(await send(relay, { t: 'nope' }), { status: 400, error: 'invalid msg' })
  assert.deepEqual(await send(relay, null), { status: 400, error: 'invalid msg' })
  assert.deepEqual(await send(relay, ['cursor']), { status: 400, error: 'invalid msg' })
  assert.deepEqual(await send(relay, { t: 'cursor', x: 1e9, y: 1 }), { status: 400, error: 'invalid msg' })
  assert.equal((await send(relay, { t: 'sel', ids: Array.from({ length: 101 }, (_, i) => `i${i}`) })).status, 400, 'more than 100 ids')
  assert.deepEqual(await send(relay, { t: 'sel', ids: Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(40, 'x')) }), { status: 413, error: 'message too large' }, 'over 1 KB')
  assert.equal((await send(relay, { t: 'sel', ids: ['x'.repeat(41)] })).status, 400)
  const items = Array.from({ length: 21 }, (_, i) => ({ id: `n${i}`, x: 1, y: 1 }))
  assert.equal((await send(relay, { t: 'drag', items })).status, 400)
  assert.equal((await send(relay, { t: 'drag', items: [{ id: 'a', x: 1, y: 1, w: -5 }] })).status, 400)
})

test('a live drag keeps only its known fields', async () => {
  const { relay } = relayWith()
  const r = await send(relay, { t: 'drag', q: 5, items: [{ id: 'a', x: 1, y: 2, w: 3, h: 4, v: 9, evil: 'x' }], extra: 1 })
  assert.deepEqual(r.envelope.msg, { t: 'drag', items: [{ id: 'a', x: 1, y: 2, v: 9, w: 3, h: 4 }], q: 5 })
  assert.deepEqual((await send(relay, { t: 'drag', end: true, cancel: true, ids: ['a'] })).envelope.msg, { t: 'drag', end: true, cancel: true, ids: ['a'] })
})

test('30 messages a second per person, then it opens again in the next second', async () => {
  const { relay, clock } = relayWith()
  const results = []
  for (let i = 0; i < PER_SECOND + 5; i++) results.push((await send(relay, { t: 'cursor', x: i, y: i })).status)
  assert.equal(results.filter((s) => s === 200).length, PER_SECOND)
  assert.equal(results.filter((s) => s === 429).length, 5)
  clock.t += 1000
  assert.equal((await send(relay, { t: 'cursor', x: 1, y: 1 })).status, 200)
})

test('people who are not allowed: nobody unknown, removed, on a revoked link, or (for celebrate, drag and throw) on a read-only board; the owner is exempt', async () => {
  const none = createRelay({ facts: async () => ({ missing: true }) })
  assert.deepEqual(await send(none, { t: 'hello' }), { status: 403, error: 'not in room' })
  const nobody = relayWith({ persona: null })
  assert.equal((await send(nobody.relay, { t: 'hello' })).status, 403)
  const down = createRelay({ facts: async () => ({ error: 'unreachable' }) })
  assert.deepEqual(await send(down, { t: 'hello' }), { status: 503, error: 'try again' })
  assert.deepEqual(await send(relayWith({ banned: true }).relay, { t: 'hello' }), { status: 403, error: 'You were removed from this board' })
  assert.deepEqual(await send(relayWith({ revoked: true }).relay, { t: 'hello' }), { status: 403, error: 'This link was revoked' })
  const ro = relayWith({ readOnly: true }).relay
  assert.equal((await send(ro, { t: 'cursor', x: 1, y: 1 })).status, 200, 'looking is fine')
  assert.deepEqual(await send(ro, { t: 'drag', items: [{ id: 'a', x: 1, y: 1 }] }), { status: 403, error: 'Board is read-only' })
  assert.deepEqual(await send(ro, { t: 'celebrate', effect: 'confetti' }), { status: 403, error: 'Board is read-only' })
  const boss = relayWith({ owner: true, readOnly: true, revoked: true, banned: true }).relay
  assert.equal((await send(boss, { t: 'drag', items: [{ id: 'a', x: 1, y: 1 }] })).status, 200)
})

test('throwing: off by default, only listed emoji, 3 per 4.5 s with refused tries given back, and the sender is told how long to wait', async () => {
  const off = relayWith().relay
  assert.deepEqual(await send(off, { t: 'throw', emoji: '🍌', x: 1, y: 1 }), { status: 403, error: 'Throwing is off' })
  const { relay, clock } = relayWith({ throwables: { enabled: true, emojis: ['🍌', '🎉'] } })
  assert.deepEqual(await send(relay, { t: 'throw', emoji: '💣', x: 1, y: 1 }), { status: 403, error: 'That emoji is not on the list' })
  const ok = await send(relay, { t: 'throw', emoji: '🍌', itemId: 'n1', x: 5, y: 6 })
  assert.deepEqual(ok.envelope.msg, { t: 'throw', emoji: '🍌', itemId: 'n1', x: 5, y: 6, name: 'Ann Otter', avatar: AVATAR })
  for (let i = 1; i < THROW_BURST; i++) assert.equal((await send(relay, { t: 'throw', emoji: '🍌', x: 1, y: 1 })).status, 200)
  const refused = await send(relay, { t: 'throw', emoji: '🍌', x: 1, y: 1 })
  assert.deepEqual([refused.status, refused.error], [429, 'Slow down'])
  assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 5)
  for (let i = 0; i < 10; i++) await send(relay, { t: 'throw', emoji: '🍌', x: 1, y: 1 }) // hammering the button
  clock.t += 4500
  assert.equal((await send(relay, { t: 'throw', emoji: '🍌', x: 1, y: 1 })).status, 200, 'the wait did not grow')
})

test('a celebration: one per person per 3 s', async () => {
  const { relay, clock } = relayWith()
  assert.equal((await send(relay, { t: 'celebrate', effect: 'confetti' })).status, 200)
  assert.deepEqual(await send(relay, { t: 'celebrate', effect: 'confetti' }), { status: 429, error: 'Slow down' })
  assert.equal((await send(relay, { t: 'celebrate', effect: 'rainbow' })).status, 400)
  clock.t += CELEBRATE_GAP_MS
  assert.equal((await send(relay, { t: 'celebrate', effect: 'fireworks' })).status, 200)
})
