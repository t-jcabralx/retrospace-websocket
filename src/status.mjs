// What this project answers where it cannot run as a server (a Vercel deployment: functions there are short-lived and cannot hold a
// WebSocket open). It tells the truth: websocket is false, and it checks the settings, the website link and the shared secret, so a
// deployment's settings can be verified before the real server is started on a host that keeps a process running.
import express from 'express'
import { diagnose } from './diagnose.mjs'

export function createStatusApp({ config, configError, redis, runtime = 'serverless', fetchImpl = fetch }) {
  const app = express()
  app.disable('x-powered-by')
  const status = async () => ({
    service: 'retrospace-realtime',
    runtime,
    websocket: false,
    note: 'This is a serverless deployment: it cannot accept WebSocket connections. Run the server (npm start, or the Dockerfile) on a host that keeps a process running, and point REALTIME_WS_URL at that.',
    ...(await diagnose({ config, configError, redis, fetchImpl })),
  })
  app.get(['/health', '/'], async (req, res) => res.set('Cache-Control', 'no-store').json(await status()))
  app.all('/ws', (req, res) => res.status(426).set('Upgrade', 'websocket').json({ error: 'This deployment cannot accept WebSocket connections', websocket: false }))
  app.use((req, res) => res.status(404).json({ error: 'Not found' }))
  return app
}
