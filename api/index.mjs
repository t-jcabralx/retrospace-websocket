// The one serverless function Vercel runs for this project: the status app (see src/status.mjs). It reports the settings and says plainly that a
// serverless deployment cannot take WebSocket connections. The real server runs elsewhere (src/index.mjs, the Dockerfile).
import app from '../src/index.mjs'

export default app
