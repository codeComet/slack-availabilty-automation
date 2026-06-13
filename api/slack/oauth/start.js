// GET /api/slack/oauth/start?slack_user_id=U12345&team_id=T12345
// Redirects the user to Slack's OAuth authorization page.
// No `team` param is forced, so the user can pick ANY workspace they belong to.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed')
  }

  const slackUserId = req.query?.slack_user_id
  const teamId = req.query?.team_id   // source workspace — passed through state so callback can link back

  if (!slackUserId) {
    return res.status(400).send('Missing slack_user_id parameter')
  }

  // Encode both IDs in state so the callback knows who initiated and from where
  const state = JSON.stringify({ slack_user_id: slackUserId, team_id: teamId || '' })
  const encodedState = Buffer.from(state).toString('base64')

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    // users.profile:write  — update status in the connected workspace
    // users.profile:read   — read email to link the user across workspaces
    user_scope: 'users.profile:write,users.profile:read',
    redirect_uri: `${process.env.APP_URL}/api/slack/oauth/callback`,
    state: encodedState,
    // NOTE: No `team` param here — lets the user choose which workspace to connect
  })

  const redirectUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`
  res.writeHead(302, { Location: redirectUrl })
  res.end()
}
