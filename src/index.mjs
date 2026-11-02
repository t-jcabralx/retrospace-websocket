// Starts the realtime server from the environment (see .env.example).
import { loadConfig } from './config.mjs'
import { createRealtimeServer } from './server.mjs'
import { createUpstashBus } from './bus.mjs'
import { createSiteAuth } from './siteAuth.mjs'

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e?.message ?? e))

let config
try { config = loadConfig() } catch (e) { console.error(e.message); process.exit(1) }

const rt = createRealtimeServer({
  secret: config.secret,
  facts: createSiteAuth({ siteUrl: config.siteUrl, secret: config.secret, ttlMs: config.authCacheMs }),
  bus: createUpstashBus({ config: config.upstash }),
  allowedOrigins: config.allowedOrigins,
  maxConnections: config.maxConnections,
  maxLifetimeMs: config.maxLifetimeMs,
})
const port = await rt.listen(config.port)
console.log(`realtime server ${rt.instance} listening on :${port}; website ${config.siteUrl}; allowed origins: ${config.allowedOrigins.join(', ')}`)

const stop = async (signal) => { console.log(`${signal}: telling clients to reconnect`); await rt.close(); process.exit(0) }
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
