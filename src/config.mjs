// Settings from the environment. A value pasted into a hosting dashboard often keeps its quotes or spaces (KEY="value"): they are removed.
export function envValue(name, env = process.env) {
  let v = String(env[name] ?? '').trim()
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1).trim()
  return v
}

const positive = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback)

// -> the settings, or throws one error that lists everything that is missing or wrong.
export function loadConfig(env = process.env) {
  const problems = []
  const need = (name) => { const v = envValue(name, env); if (!v) problems.push(`${name} is not set`); return v }
  const secret = need('RT_SECRET')
  const upstashUrl = need('UPSTASH_REDIS_REST_URL')
  const upstashToken = need('UPSTASH_REDIS_REST_TOKEN')
  const siteRaw = need('SITE_URL')
  let site = null
  try { if (siteRaw) site = new URL(siteRaw) } catch { problems.push('SITE_URL is not a valid address') }
  if (site && !/^https?:$/.test(site.protocol)) problems.push('SITE_URL must start with https:// (or http:// for local use)')
  if (problems.length) throw new Error(`Cannot start: ${problems.join('; ')}`)
  const origins = (envValue('ALLOWED_ORIGINS', env) || site.origin).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
  return {
    secret, upstash: { url: upstashUrl.replace(/\/$/, ''), token: upstashToken }, siteUrl: site.origin, allowedOrigins: origins,
    port: positive(env.PORT, 8080), maxConnections: positive(env.MAX_CONNECTIONS, 5000), maxLifetimeMs: positive(env.RT_WS_MAX_MS, 270_000), authCacheMs: positive(env.AUTH_CACHE_MS, 5000),
  }
}
