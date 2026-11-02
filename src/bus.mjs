// The bus that joins this server, its other copies and the website: one Redis pub/sub channel per board (the website publishes there when
// something is saved; this server publishes the live messages it receives). Only Upstash's REST interface is needed.
import { Redis } from '@upstash/redis'
import { channelOf } from './ids.mjs'

// Reads "message,<channel>,<payload>" frames from an Upstash SUBSCRIBE event stream and hands each payload to `onMessage`.
export function parseFrames(buffer, onPayload) {
  let buf = buffer
  let i
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, i)
    buf = buf.slice(i + 2)
    if (!frame.startsWith('data: ')) continue
    const p = frame.slice(6)
    const a = p.indexOf(',')
    const b = p.indexOf(',', a + 1)
    if (a < 0 || b < 0 || p.slice(0, a) !== 'message') continue // the "subscribe" acknowledgements
    onPayload(p.slice(b + 1))
  }
  return buf
}

export function createUpstashBus({ config, fetchImpl = fetch, redis = new Redis({ url: config.url, token: config.token }), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console }) {
  return {
    // -> unsubscribe(). Reconnects (1 s, doubling to 15 s) whenever the stream ends, until unsubscribed.
    subscribe(code, onMessage) {
      const ac = new AbortController()
      ;(async () => {
        let wait = 1000
        while (!ac.signal.aborted) {
          try {
            const res = await fetchImpl(`${config.url}/subscribe/${encodeURIComponent(channelOf(code))}`, { headers: { Authorization: `Bearer ${config.token}`, Accept: 'text/event-stream' }, signal: ac.signal, cache: 'no-store' })
            if (!res.ok || !res.body) throw new Error(`upstash ${res.status}`)
            wait = 1000
            const reader = res.body.getReader()
            const dec = new TextDecoder()
            let buf = ''
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              buf = parseFrames(buf + dec.decode(value, { stream: true }), onMessage)
            }
          } catch (e) {
            if (ac.signal.aborted) return
            log.error?.(`bus: subscription to ${code} failed: ${e.message}`)
          }
          if (ac.signal.aborted) return
          await sleep(wait)
          wait = Math.min(wait * 2, 15000)
        }
      })()
      return () => ac.abort()
    },
    async publish(code, envelope) {
      try { await redis.publish(channelOf(code), JSON.stringify(envelope)); return true } catch (e) { log.error?.(`bus: publish failed: ${e.message}`); return false }
    },
  }
}

// For tests and for running without Upstash on one machine: a bus inside this process only.
export function createMemoryBus() {
  const subs = new Map() // code -> Set<fn>
  return {
    subscribe(code, onMessage) {
      if (!subs.has(code)) subs.set(code, new Set())
      subs.get(code).add(onMessage)
      return () => subs.get(code)?.delete(onMessage)
    },
    async publish(code, envelope) {
      const text = JSON.stringify(envelope)
      for (const fn of subs.get(code) ?? []) queueMicrotask(() => fn(text))
      return true
    },
    subscribers: (code) => subs.get(code)?.size ?? 0,
  }
}
