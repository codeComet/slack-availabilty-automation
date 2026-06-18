/**
 * GET /api/google/oauth/callback?code=...&state=...
 *
 * Exchanges the authorization code for tokens and stores them in google_connections.
 * The user's company email is resolved from their existing Slack connection record.
 */

const { google } = require('googleapis')
const supabase = require('../../../src/lib/supabase')

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/api/google/oauth/callback`
  )
}

module.exports = async function handler(req, res) {
  const { code, state, error } = req.query

  if (error) {
    return res.status(400).send(`<p>Google authorization failed: <code>${error}</code></p>`)
  }

  if (!code || !state) {
    return res.status(400).send('<p>Missing authorization code or state.</p>')
  }

  // Parse state
  let slackUserId, teamId
  try {
    const parsed = JSON.parse(state)
    slackUserId = parsed.slack_user_id
    teamId = parsed.team_id
  } catch {
    return res.status(400).send('<p>Invalid state parameter.</p>')
  }

  // Exchange code → tokens
  const oauth2Client = makeOAuth2Client()
  let tokens
  try {
    const result = await oauth2Client.getToken(code)
    tokens = result.tokens
  } catch (err) {
    console.error('Google token exchange failed:', err.message)
    return res.status(500).send('<p>Failed to exchange authorization code. Please try again.</p>')
  }

  if (!tokens.refresh_token) {
    // This shouldn't happen with prompt=consent, but guard anyway
    return res.status(400).send(
      '<p>Google did not return a refresh token. Please try connecting again.</p>'
    )
  }

  // Resolve user email — look in workspace_connections first, then users table
  let userEmail = null

  const { data: conn } = await supabase
    .from('workspace_connections')
    .select('user_email')
    .eq('slack_user_id', slackUserId)
    .eq('workspace_id', teamId)
    .maybeSingle()

  userEmail = conn?.user_email

  if (!userEmail) {
    const { data: userRow } = await supabase
      .from('users')
      .select('email')
      .eq('slack_user_id', slackUserId)
      .eq('slack_workspace_id', teamId)
      .maybeSingle()
    userEmail = userRow?.email
  }

  if (!userEmail) {
    return res.status(400).send(
      '<p>Could not identify your Strativ account. ' +
      'Please make sure you have connected your Slack account first, then try again.</p>'
    )
  }

  // Persist tokens
  const { error: upsertError } = await supabase
    .from('google_connections')
    .upsert(
      {
        user_email: userEmail,
        access_token: tokens.access_token || null,
        refresh_token: tokens.refresh_token,
        token_expiry: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : null,
      },
      { onConflict: 'user_email' }
    )

  if (upsertError) {
    console.error('Failed to save Google tokens:', upsertError.message)
    return res.status(500).send('<p>Failed to save your Google connection. Please try again.</p>')
  }

  return res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Google Calendar connected</title></head>
      <body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center">
        <h2>✅ Google Calendar connected!</h2>
        <p>You can now use <code>/availability leave today</code> in Slack and it will
        automatically set your Google Calendar to Out of Office.</p>
        <p>You can close this window.</p>
      </body>
    </html>
  `)
}
