// A check of everything this server depends on, for anyone to read (it never returns a secret, only yes or no):
//   settings  which settings are present and valid
//   website   can the website be reached, and does it accept this server's signature (so REALTIME_SECRET matches there)?
//             Ask a signed question about a board that cannot exist: 404 = signature accepted, 403 = the secrets differ.
//   bus       does Upstash answer a ping?
import { authorizeSignature } from './siteAuth.mjs'

const PROBE = { code: 'ZZZZ22', uid: 'KM-2222-3333-4444' }

export async function diagnose({ config, configError = null, fetchImpl = fetch, redis = null, now = Date.now }) {
  const out = { settings: configError ? { ok: false, problem: configError } : { ok: true } }
  if (!config) return { ok: false, ...out }

  try {
    const ts = now()
    const res = await fetchImpl(`${config.siteUrl}/api/rt/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rt-ts': String(ts), 'x-rt-sig': authorizeSignature(config.secret, ts, PROBE.code, PROBE.uid) },
      body: JSON.stringify(PROBE),
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    })
    out.website = res.status === 404 ? { ok: true, note: 'the website accepted this server\'s signature' }
      : res.status === 403 ? { ok: false, problem: 'the website refused the signature: REALTIME_SECRET here is not the same value as on the website (or the website has none yet)' }
      : { ok: false, problem: `the website answered ${res.status}` }
  } catch (e) {
    out.website = { ok: false, problem: `the website could not be reached at ${config.siteUrl}: ${e.name === 'TimeoutError' ? 'timed out' : 'connection failed'}` }
  }

  try {
    if (!redis) throw new Error('not configured')
    await redis.ping()
    out.bus = { ok: true }
  } catch (e) {
    out.bus = { ok: false, problem: `Upstash did not answer: ${e.message}` }
  }
  return { ok: Object.values(out).every((c) => c.ok), ...out }
}
