// The realtime (WebSocket) server. It carries the live, throwaway messages of a board (cursors, selections, live drags, hello, celebrate,
// throw) over one open connection per person, and pushes everything else the website publishes (saved changes, settings, removals) down
// the same connection. It has no database: for each person it asks the website (siteAuth.mjs) who they are and what they may do, and it
// reaches the website and its other copies through the shared bus (bus.mjs).
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { WebSocketServer } from 'ws'
import { isCode, isUid, isCid } from './ids.mjs'
import { verifyTicket } from './ticket.mjs'
import { createRelay } from './rules.mjs'
import { createRooms } from './rooms.mjs'

export const CLOSE_RECONNECT = 4001 // "ask the website for a fresh ticket and connect again": the connection reached its age limit
export const MAX_PAYLOAD = 4096 // bytes

export function createRealtimeServer({ secret, facts, bus, allowedOrigins = [], maxConnections = 5000, maxLifetimeMs = 270_000, heartbeatMs = 25_000, instance = randomUUID().slice(0, 8), now = Date.now, log = console }) {
  const app = express()
  app.disable('x-powered-by')
  const startedAt = now()
  app.get('/health', (req, res) => res.json({ ok: true, instance, connections: rooms.size(), rooms: rooms.roomCount(), uptimeSeconds: Math.round((now() - startedAt) / 1000) }))
  app.get('/', (req, res) => res.type('text/plain').send('Retrospace realtime server\n'))
  app.use((req, res) => res.status(404).end())

  const server = http.createServer(app)
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false })
  const relay = createRelay({ facts, now })

  // Messages from the bus: everything the website publishes, and what other copies of this server relay. Ours are skipped (already sent).
  const mine = `"via":"${instance}"`
  const rooms = createRooms({
    bus,
    onBusMessage(code, text) {
      if (text.includes(mine)) return
      rooms.broadcast(code, text, { droppable: text.includes('"t":"cursor"') || text.includes('"t":"drag"') })
    },
  })

  const originAllowed = (origin) => allowedOrigins.includes('*') || (typeof origin === 'string' && allowedOrigins.includes(origin))

  function onConnection(ws, { code, uid, cid, exp }) {
    rooms.join(code, ws)
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })
    const lifetime = setTimeout(() => ws.close(CLOSE_RECONNECT, 'reconnect'), Math.max(0, Math.min(maxLifetimeMs, exp - now())))
    const beat = setInterval(() => {
      if (!ws.isAlive) return ws.terminate()
      ws.isAlive = false
      try { ws.ping() } catch { /* closing */ }
    }, heartbeatMs)
    ws.on('close', () => { clearTimeout(lifetime); clearInterval(beat); rooms.leave(code, ws) })
    ws.on('error', () => {}) // a reset or an oversized frame: the close event follows

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'text only')
      let frame
      try { frame = JSON.parse(data.toString('utf8')) } catch { return }
      if (frame?.t !== 'eph') return
      let r
      try { r = await relay({ code, uid, cid, msg: frame.msg }) } catch (e) { log.error?.(`relay failed: ${e.message}`); return }
      if (r.error) {
        try { ws.send(JSON.stringify({ t: 'err', status: r.status, error: r.error, ...(r.retryAfter && { retryAfter: r.retryAfter }) })) } catch { /* closed */ }
        return
      }
      const out = { ...r.envelope, via: instance }
      rooms.broadcast(code, JSON.stringify(out), { except: ws, droppable: out.msg.t === 'cursor' || out.msg.t === 'drag' })
      bus.publish(code, out).catch(() => {})
    })
  }

  server.on('upgrade', async (req, socket, head) => {
    const reject = (status, text) => { try { socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) } catch { /* gone */ } socket.destroy() }
    socket.on('error', () => {})
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname !== '/ws') return reject(404, 'Not Found')
      if (!originAllowed(req.headers.origin)) return reject(403, 'Forbidden')
      if (rooms.size() >= maxConnections) return reject(503, 'Service Unavailable')
      const code = url.searchParams.get('code')
      const uid = url.searchParams.get('uid')
      const cidParam = url.searchParams.get('cid')
      if (!isCode(code) || !isUid(uid) || (cidParam !== null && !isCid(cidParam))) return reject(403, 'Forbidden')
      const exp = verifyTicket(secret, code, uid, url.searchParams.get('tok'), now())
      if (exp === null) return reject(403, 'Forbidden')
      // The ticket proves the website admitted this person; the website is asked what they may do now (revoked, removed, owner).
      const answer = await facts(code, uid)
      if (answer.error) return reject(503, 'Service Unavailable')
      if (answer.missing) return reject(404, 'Not Found')
      const f = answer.facts
      if (!f?.persona || (!f.owner && (f.revoked || f.banned))) return reject(403, 'Forbidden')
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, { code, uid, cid: cidParam ?? undefined, exp }))
    } catch (e) {
      log.error?.(`upgrade failed: ${e.message}`)
      reject(500, 'Internal Server Error')
    }
  })

  return {
    app, server, wss, rooms, instance,
    listen: (port = 0, host = '0.0.0.0') => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    // Tells every client to connect again (they ask the website for a new ticket), then stops.
    async close() {
      for (const ws of wss.clients) ws.close(1001, 'restarting')
      await new Promise((resolve) => wss.close(() => resolve()))
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
