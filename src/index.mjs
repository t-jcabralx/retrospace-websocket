// Starts the realtime server from the environment (see .env.example).
import { loadConfig } from './config.mjs'
import { createRealtimeServer } from './wsServer.mjs'
import { createUpstashBus } from './bus.mjs'
import { createSiteAuth } from './siteAuth.mjs'
import { createStatusApp } from './status.mjs'
import { diagnose } from './diagnose.mjs'
import { Redis } from '@upstash/redis'

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.message ?? e))

// On Vercel (serverless) there is no process to keep: the file only exports a small status app (see status.mjs). Anywhere else it starts the server.
const onVercel = Boolean(process.env.VERCEL)
let config
let configError = null
try { config = loadConfig() } catch (e) { if (!onVercel) { console.error(e.message); process.exit(1) } configError = e.message }

export default onVercel
  ? createStatusApp({ config, configError, runtime: 'vercel', redis: config ? new Redis({ url: config.upstash.url, token: config.upstash.token }) : null })
  : undefined

// No top-level await: it would make this an async module, which a serverless runtime cannot load.
if (!onVercel) start().catch((e) => { console.error(e); process.exit(1) })

async function start() {
  const rt = createRealtimeServer({
    secret: config.secret,
    facts: createSiteAuth({ siteUrl: config.siteUrl, secret: config.secret, ttlMs: config.authCacheMs }),
    bus: createUpstashBus({ config: config.upstash }),
    allowedOrigins: config.allowedOrigins,
    maxConnections: config.maxConnections,
    maxLifetimeMs: config.maxLifetimeMs,
    check: () => diagnose({ config, redis: new Redis({ url: config.upstash.url, token: config.upstash.token }) }), // GET /health?check=1
  })
  const port = await rt.listen(config.port)
  console.log(`realtime server ${rt.instance} listening on :${port}; website ${config.siteUrl}; allowed origins: ${config.allowedOrigins.join(', ')}`)

  const stop = async (signal) => { console.log(`${signal}: telling clients to reconnect`); await rt.close(); process.exit(0) }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}
