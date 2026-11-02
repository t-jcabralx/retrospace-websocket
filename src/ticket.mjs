// The WebSocket ticket the website gives a browser after it has checked the person's access (`wsTok` from /api/rt/join):
// '<expiresAtMs>.<32 hex>', an HMAC of 'wstok:<code>:<uid>:<exp>' with REALTIME_SECRET (not the website's RT_SECRET). Must stay identical to
// the website's lib/rt.js signWsTicket (test/vectors.test.mjs holds a known answer).
import { createHmac, timingSafeEqual } from 'node:crypto'

const mac = (secret, code, uid, exp) => createHmac('sha256', secret).update(`wstok:${code}:${uid}:${exp}`).digest('hex').slice(0, 32)

export const signTicket = (secret, code, uid, now = Date.now(), ttlMs = 30 * 60 * 1000) => {
  const exp = now + ttlMs
  return `${exp}.${mac(secret, code, uid, exp)}`
}

// -> the expiry (ms) when the ticket is genuine, for this person and board, and not expired; else null.
export function verifyTicket(secret, code, uid, tok, now = Date.now()) {
  if (typeof tok !== 'string') return null
  const m = /^(\d{1,16})\.([0-9a-f]{32})$/.exec(tok)
  if (!m) return null
  const exp = Number(m[1])
  if (!Number.isSafeInteger(exp) || exp <= now) return null
  const a = Buffer.from(mac(secret, code, uid, exp))
  const b = Buffer.from(m[2])
  return a.length === b.length && timingSafeEqual(a, b) ? exp : null
}
