// Asks the website about one person on one board. The question is signed with REALTIME_SECRET (HMAC of 'rtauth:<ts>:<code>:<uid>', in the header
// x-rt-sig, with the time in x-rt-ts), so only this server can ask; it must stay identical to the website's lib/rtAuthorize.js.
// Answers are kept for a few seconds so a busy board does not become a stream of questions.
import { createHmac } from 'node:crypto'

export const authorizeSignature = (secret, ts, code, uid) => createHmac('sha256', secret).update(`rtauth:${ts}:${code}:${uid}`).digest('hex')

export function createSiteAuth({ siteUrl, secret, fetchImpl = fetch, now = Date.now, ttlMs = 5000, maxEntries = 5000, timeoutMs = 5000 }) {
  const cache = new Map() // `${code}:${uid}` -> { at, value }
  const inflight = new Map()

  async function ask(code, uid) {
    const ts = now()
    try {
      const res = await fetchImpl(`${siteUrl}/api/rt/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rt-ts': String(ts), 'x-rt-sig': authorizeSignature(secret, ts, code, uid) },
        body: JSON.stringify({ code, uid }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      })
      if (res.status === 404) return { missing: true }
      if (!res.ok) return { error: res.status }
      return { facts: await res.json() }
    } catch (e) {
      return { error: e.name === 'TimeoutError' ? 'timeout' : 'unreachable' }
    }
  }

  // -> { facts } | { missing: true } | { error }. Errors are never kept: the next call asks again.
  return async function facts(code, uid) {
    const key = `${code}:${uid}`
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.value
    if (!inflight.has(key)) {
      inflight.set(key, ask(code, uid).then((value) => {
        inflight.delete(key)
        if (!value.error) {
          cache.delete(key)
          cache.set(key, { at: now(), value })
          if (cache.size > maxEntries) for (const k of cache.keys()) { cache.delete(k); if (cache.size <= maxEntries) break }
        }
        return value
      }))
    }
    return inflight.get(key)
  }
}
