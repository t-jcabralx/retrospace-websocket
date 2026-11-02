// What a live message may carry, and who may send what. These are the website's rules for live messages (its lib/ephemeral.js): a copy that
// is kept in step by hand, with tests on both sides that pin the behaviour. The sender is always the person the ticket was issued to; a
// name and avatar come from what the website says about them, never from the message.
const MAX_EMOJI_UNITS = 16 // UTF-16 units; the longest everyday sequences (family, couple with skin tones) fit

const EFFECTS = new Set(['confetti', 'balloons', 'fireworks']) // the celebration effects the board themes use
const MAX_COORD = 1e6
const MAX_SEL = 100
const MAX_ID = 40
const MAX_DRAG_ITEMS = 20

const isCoord = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD
const isDim = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_COORD
const isItemId = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID

// Consumers (presence, cursors) must read the sender from the envelope's `from`, never from `msg`: there is no uid in msg.
// What each message type may carry. Anything else in `msg` is dropped, so a client can never relay a `uid`, `from` or
// `name` of its own; a field that is present but malformed makes the whole message invalid (null). hello and cursor get
// the sender's stored name and avatar added after this, by the handler.
const CLEAN = {
  hello: () => ({ t: 'hello' }),
  typing: () => ({ t: 'typing' }),
  cursor: (m) => (isCoord(m.x) && isCoord(m.y) ? { t: 'cursor', x: m.x, y: m.y } : null),
  sel: (m) => (Array.isArray(m.ids) && m.ids.length <= MAX_SEL && m.ids.every((i) => typeof i === 'string' && i.length > 0 && i.length <= MAX_ID) ? { t: 'sel', ids: [...m.ids] } : null),
  // Live drag / resize steps: where the sender's items are right now. Relayed only, never stored (the drop is a normal write);
  // peers show them as a temporary position. `end` closes the gesture, `cancel` says the items go back where they were.
  drag: (m) => {
    if (m.end === true) {
      return Array.isArray(m.ids) && m.ids.length > 0 && m.ids.length <= MAX_DRAG_ITEMS && m.ids.every(isItemId)
        ? { t: 'drag', end: true, ...(m.cancel === true && { cancel: true }), ids: [...m.ids] } : null
    }
    if (!Array.isArray(m.items) || m.items.length === 0 || m.items.length > MAX_DRAG_ITEMS) return null
    if (m.q !== undefined && !(Number.isFinite(m.q) && m.q >= 0 && m.q <= 1e15)) return null
    const items = []
    for (const it of m.items) {
      if (it === null || typeof it !== 'object' || !isItemId(it.id) || !isCoord(it.x) || !isCoord(it.y)) return null
      if ((it.w !== undefined && !isDim(it.w)) || (it.h !== undefined && !isDim(it.h))) return null
      if (it.v !== undefined && !(Number.isFinite(it.v) && it.v >= 0 && it.v <= 1e15)) return null
      items.push({ id: it.id, x: it.x, y: it.y, ...(it.v !== undefined && { v: it.v }), ...(it.w !== undefined && { w: it.w }), ...(it.h !== undefined && { h: it.h }) })
    }
    return { t: 'drag', items, ...(m.q !== undefined && { q: m.q }) }
  },
  celebrate: (m) => (EFFECTS.has(m.effect) ? { t: 'celebrate', effect: m.effect } : null),
  // The board's own rules (is throwing on, is this emoji in its list) are checked by the handler.
  throw: (m) => {
    const emoji = typeof m.emoji === 'string' && m.emoji.length > 0 && m.emoji.length <= MAX_EMOJI_UNITS
    const item = m.itemId === undefined || (typeof m.itemId === 'string' && m.itemId.length > 0 && m.itemId.length <= MAX_ID)
    return emoji && item && isCoord(m.x) && isCoord(m.y) ? { t: 'throw', emoji: m.emoji, ...(m.itemId !== undefined && { itemId: m.itemId }), x: m.x, y: m.y } : null
  },
}

export const MAX_MSG_BYTES = 1024
export const MAX_DRAG_BYTES = 3 * 1024
export const PER_SECOND = 30
export const CELEBRATE_GAP_MS = 3000 // one celebration per person per window
export const THROW_WINDOW_MS = 4500 // 3 throws per person per window
export const THROW_BURST = 3
export const messageTypes = Object.keys(CLEAN)

// Counters in this process, in fixed windows. A busy server holds many people, so old windows are swept as they pile up.
function createLimiter(now) {
  const hits = new Map()
  const MAX = 20_000
  return {
    // -> how many times `key` has been hit in the current window (this hit included)
    hit(key, windowMs) {
      const w = Math.floor(now() / windowMs)
      const k = `${key}:${w}`
      const n = (hits.get(k) ?? 0) + 1
      hits.set(k, n)
      if (hits.size > MAX) { for (const kk of hits.keys()) if (!kk.endsWith(`:${w}`)) hits.delete(kk); if (hits.size > MAX) hits.clear() }
      return n
    },
    refund(key, windowMs) {
      const k = `${key}:${Math.floor(now() / windowMs)}`
      const n = hits.get(k)
      if (n > 1) hits.set(k, n - 1); else hits.delete(k)
    },
  }
}

// `facts(code, uid)` -> { facts } | { missing: true } | { error } (see siteAuth.mjs).
// relay({ code, uid, cid, msg }) -> { status: 200, envelope } | { status, error, retryAfter? }
export function createRelay({ facts, now = Date.now }) {
  const limiter = createLimiter(now)
  return async function relay({ code, uid, cid, msg }) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || !Object.hasOwn(CLEAN, msg.t)) return { status: 400, error: 'invalid msg' }
    if (Buffer.byteLength(JSON.stringify(msg)) > (msg.t === 'drag' ? MAX_DRAG_BYTES : MAX_MSG_BYTES)) return { status: 413, error: 'message too large' }
    const clean = CLEAN[msg.t](msg)
    if (!clean) return { status: 400, error: 'invalid msg' }
    if (limiter.hit(`rt:${uid}`, 1000) > PER_SECOND) return { status: 429, error: 'slow down' }

    const answer = await facts(code, uid)
    if (answer.error) return { status: 503, error: 'try again' }
    if (answer.missing || !answer.facts?.persona) return { status: 403, error: 'not in room' }
    const f = answer.facts
    const throwing = msg.t === 'throw'
    if (!f.owner) {
      if (f.revoked) return { status: 403, error: 'This link was revoked' }
      if (f.banned) return { status: 403, error: 'You were removed from this board' }
      if ((msg.t === 'celebrate' || msg.t === 'drag' || throwing) && f.readOnly) return { status: 403, error: 'Board is read-only' }
    }
    if (throwing) {
      // Everyone's rules, the owner's included. These checks come before the rate limit, so a refused throw costs no budget.
      if (!f.throwables?.enabled) return { status: 403, error: 'Throwing is off' }
      if (!f.throwables.emojis?.includes(clean.emoji)) return { status: 403, error: 'That emoji is not on the list' }
      if (limiter.hit(`throw:${uid}`, THROW_WINDOW_MS) > THROW_BURST) {
        limiter.refund(`throw:${uid}`, THROW_WINDOW_MS) // a refused try is given back, so hammering the button cannot extend the wait
        return { status: 429, error: 'Slow down', retryAfter: Math.max(1, Math.ceil((THROW_WINDOW_MS - (now() % THROW_WINDOW_MS)) / 1000)) }
      }
    }
    if (msg.t === 'celebrate' && limiter.hit(`celebrate:${uid}`, CELEBRATE_GAP_MS) > 1) return { status: 429, error: 'Slow down' }
    const stamped = msg.t === 'hello' || msg.t === 'cursor' || throwing ? { ...clean, name: f.persona.name, avatar: f.persona.avatar } : clean
    return { status: 200, envelope: { t: 'eph', from: uid, ...(cid && { cid }), msg: stamped } }
  }
}
