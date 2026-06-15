// GET /api/slack/oauth/start
//
// Two call patterns:
//   1. From /availability command (initial connection):
//      ?slack_user_id=U123&team_id=T456
//      State: { slack_user_id, team_id } — callback looks up email via bot token
//
//   2. From /api/connect page (adding another workspace):
//      ?state=<base64-encoded-json-with-email>
//      State: { email } — callback uses it directly, no scope needed for email

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed')
  }

  // If state is already provided (from /api/connect), use it as-is.
  // Otherwise build it from slack_user_id + team_id.
  let state = req.query?.state
  if (!state) {
    const slackUserId = req.query?.slack_user_id
    const teamId = req.query?.team_id
    if (!slackUserId) {
      return res.status(400).send('Missing slack_user_id or state parameter')
    }
    state = Buffer.from(JSON.stringify({ slack_user_id: slackUserId, team_id: teamId || '' })).toString('base64')
  }

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    // Only request write scope — email is resolved via bot token or state, not user token
    user_scope: 'users.profile:write',
    redirect_uri: `${process.env.APP_URL}/api/slack/oauth/callback`,
    state,
    // No `team` param — lets the user pick which workspace to connect
  })

  const redirectUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`
  res.writeHead(302, { Location: redirectUrl })
  res.end()
}
