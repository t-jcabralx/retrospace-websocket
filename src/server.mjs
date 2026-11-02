// The entry point Vercel's Express support looks for (src/server.*). Where this runs as a serverless function it exports an Express app that
// serves the status app (src/status.mjs): a deployment's settings can be checked, and it says plainly that WebSocket connections are not possible there.
// Everywhere else the real server starts from src/index.mjs (npm start, the Dockerfile) and this file is not used.
import express from 'express'
import status from './index.mjs'

const app = express()
if (status) app.use(status)
export default app
