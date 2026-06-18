/**
 * GET /api/google/oauth/start?slack_user_id=U...&team_id=T...
 *
 * Redirects the user to Google's consent screen.
 * State carries the Slack identifiers so the callback can map the account.
 */

const { google } = require('googleapis')

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.APP_URL}/api/google/oauth/callback`
  )
}

module.exports = async function handler(req, res) {
  const { slack_user_id, team_id } = req.query

  if (!slack_user_id || !team_id) {
    return res.status(400).send('<p>Missing <code>slack_user_id</code> or <code>team_id</code>.</p>')
  }

  const oauth2Client = makeOAuth2Client()

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    // offline = request refresh token; prompt=consent ensures we always get one
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state: JSON.stringify({ slack_user_id, team_id }),
  })

  return res.redirect(authUrl)
}
