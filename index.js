// Local development entry point.
// On Vercel, functions in api/ are invoked directly — this file is not used in production.

const express = require('express')
const commandsHandler = require('./api/slack/commands')
const oauthCallbackHandler = require('./api/slack/oauth/callback')
const oauthStartHandler = require('./api/slack/oauth/start')

const app = express()
const PORT = process.env.PORT || 3000

// Mount Vercel-style serverless handlers as Express routes.
// Vercel functions export a default function(req, res) — reuse them directly.
app.post('/api/slack/commands', (req, res) => commandsHandler(req, res))
app.get('/api/slack/oauth/callback', (req, res) => oauthCallbackHandler(req, res))
app.get('/api/slack/oauth/start', (req, res) => oauthStartHandler(req, res))

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
