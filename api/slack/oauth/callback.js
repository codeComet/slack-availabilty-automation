// GET /api/slack/oauth/callback?code=...&state=<slack_user_id>
// Exchanges the OAuth code for a user token and stores it.

const { saveUserToken } = require('../../../src/services/userService')

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed')
  }

  const code = req.query?.code
  const slackUserId = req.query?.state   // set in oauth/start.js

  if (!code || !slackUserId) {
    return res.status(400).send('Missing code or state parameter')
  }

  // Exchange code for token
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    client_secret: process.env.SLACK_CLIENT_SECRET,
    code,
    redirect_uri: `${process.env.APP_URL}/api/slack/oauth/callback`,
  })

  let tokenData
  try {
    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    tokenData = await response.json()
  } catch (err) {
    console.error('OAuth token exchange failed:', err)
    return res.status(500).send('Failed to exchange OAuth code. Please try again.')
  }

  if (!tokenData.ok) {
    console.error('Slack OAuth error:', tokenData.error)
    return res.status(400).send(`Slack OAuth error: ${tokenData.error}`)
  }

  const userToken = tokenData.authed_user?.access_token
  const tokenScope = tokenData.authed_user?.scope

  if (!userToken) {
    return res.status(400).send('No user token returned from Slack. Make sure user_scope is set.')
  }

  // Save token to Supabase
  try {
    await saveUserToken(slackUserId, userToken, tokenScope)
  } catch (err) {
    console.error('Failed to save user token:', err)
    return res.status(500).send('Connected to Slack, but failed to save your token. Please try again.')
  }

  // Success — send a simple HTML page
  res.status(200).send(`
    <!DOCTYPE html>
    <html>
      <head><title>Connected!</title></head>
      <body style="font-family:sans-serif;max-width:400px;margin:80px auto;text-align:center">
        <h2>You're connected!</h2>
        <p>Return to Slack and run <code>/availability</code> again.</p>
      </body>
    </html>
  `)
}
