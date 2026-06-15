// GET /api/slack/oauth/callback?code=...&state=<base64-encoded-json>
// Exchanges the OAuth code for a user token and stores the workspace connection.
//
// Email lookup strategy (no users.profile:read required):
//   1. If email is already in state (from /api/connect "add workspace" flow) → use it directly
//   2. Otherwise use the bot token to call users.info → works for the source workspace where the bot lives

const supabase = require('../../../src/lib/supabase')
const { botClient } = require('../../../src/lib/slackClients')

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed')
  }

  const code = req.query?.code
  const rawState = req.query?.state

  if (!code || !rawState) {
    return res.status(400).send('Missing code or state parameter')
  }

  // Decode state
  let stateData = {}
  try {
    stateData = JSON.parse(Buffer.from(rawState, 'base64').toString('utf8'))
  } catch {
    return res.status(400).send('Invalid state parameter')
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
  const slackUserIdInWorkspace = tokenData.authed_user?.id
  const workspaceId = tokenData.team?.id
  const workspaceName = tokenData.team?.name

  if (!userToken || !slackUserIdInWorkspace || !workspaceId) {
    return res.status(400).send('Incomplete token data from Slack. Please try again.')
  }

  // ── Resolve email ───────────────────────────────────────────────────────────
  // Strategy 1: email was passed in state (from /api/connect "add workspace" flow)
  let email = stateData.email || null

  // Strategy 2: use the bot token to call users.info
  // This works when the user is connecting the source workspace (where the bot lives).
  // Does NOT need users.profile:read on the user token.
  if (!email) {
    try {
      const info = await botClient.users.info({ user: slackUserIdInWorkspace })
      email = info.user?.profile?.email || null
    } catch (err) {
      console.warn('Bot users.info lookup failed:', err.message)
    }
  }

  if (!email) {
    return res.status(400).send(
      'Could not retrieve your email. Please contact your workspace admin or try reconnecting.'
    )
  }
  // ───────────────────────────────────────────────────────────────────────────

  // Upsert into workspace_connections keyed by (email, workspace_id)
  try {
    const { error } = await supabase
      .from('workspace_connections')
      .upsert(
        {
          user_email: email,
          workspace_id: workspaceId,
          workspace_name: workspaceName,
          slack_user_id: slackUserIdInWorkspace,
          access_token: userToken,
          token_scope: tokenScope,
          connected_at: new Date().toISOString(),
        },
        { onConflict: 'user_email,workspace_id' }
      )
    if (error) throw error
  } catch (err) {
    console.error('Failed to save workspace connection:', err)
    return res.status(500).send('Connected to Slack, but failed to save. Please try again.')
  }

  res.status(200).send(`
    <!DOCTYPE html>
    <html>
      <head><title>Workspace Connected!</title></head>
      <body style="font-family:sans-serif;max-width:420px;margin:80px auto;text-align:center;color:#1a1a1a">
        <h2>✅ ${workspaceName} connected!</h2>
        <p>Your status will now sync to <strong>${workspaceName}</strong> whenever you use <code>/availability</code>.</p>
        <p style="margin-top:32px">
          <a href="/api/connect?email=${encodeURIComponent(email)}" style="color:#4A154B">View all connected workspaces →</a>
        </p>
        <p><a href="slack://" style="color:#666">← Return to Slack</a></p>
      </body>
    </html>
  `)
}
