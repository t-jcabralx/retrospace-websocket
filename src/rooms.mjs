// The sockets of each board, and the one subscription to that board's channel on the shared bus that feeds them. A board's channel is
// subscribed to while somebody is connected to it here, and dropped when the last one leaves.
export function createRooms({ bus, onBusMessage = () => {} } = {}) {
  const rooms = new Map() // code -> { sockets: Set, unsubscribe }

  const size = () => [...rooms.values()].reduce((n, r) => n + r.sockets.size, 0)

  function join(code, socket) {
    let room = rooms.get(code)
    if (!room) {
      room = { sockets: new Set(), unsubscribe: null }
      rooms.set(code, room)
      room.unsubscribe = bus.subscribe(code, (text) => onBusMessage(code, text))
    }
    room.sockets.add(socket)
  }

  function leave(code, socket) {
    const room = rooms.get(code)
    if (!room) return
    room.sockets.delete(socket)
    if (room.sockets.size === 0) {
      rooms.delete(code)
      try { room.unsubscribe?.() } catch { /* already gone */ }
    }
  }

  // Sends `text` to everybody in the room except `except`. A socket that is not open, or whose outgoing buffer is backed up and the
  // message is `droppable` (a cursor), is skipped: a slow phone must never grow this process's memory.
  function broadcast(code, text, { except = null, droppable = false, maxBuffer = 256 * 1024 } = {}) {
    const room = rooms.get(code)
    if (!room) return 0
    let sent = 0
    for (const s of room.sockets) {
      if (s === except || s.readyState !== 1) continue
      if (droppable && s.bufferedAmount > maxBuffer) continue
      try { s.send(text); sent++ } catch { /* the close handler removes it */ }
    }
    return sent
  }

  return { join, leave, broadcast, size, roomCount: () => rooms.size, sockets: (code) => [...(rooms.get(code)?.sockets ?? [])], closeAll(code, reason) { for (const s of [...(rooms.get(code)?.sockets ?? [])]) s.close(1001, reason) } }
}
