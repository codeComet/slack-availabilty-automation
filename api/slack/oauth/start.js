// GET /api/slack/oauth/start?slack_user_id=U12345
// Redirects the user to Slack's OAuth authorization page.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed')
  }

  const slackUserId = req.query?.slack_user_id
  if (!slackUserId) {
    return res.status(400).send('Missing slack_user_id parameter')
  }

  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    user_scope: 'users.profile:write',
    redirect_uri: `${process.env.APP_URL}/api/slack/oauth/callback`,
    // Pass slack_user_id as state so we can match it after the callback.
    // Phase 3: replace with a signed short-lived token.
    state: slackUserId,
  })

  res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`)
}
