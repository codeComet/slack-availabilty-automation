// GET /api/connect?email=bishal@strativ.se
// Shows a user their connected workspaces and lets them add more.
// The "add workspace" link encodes the email in OAuth state so the callback
// doesn't need to fetch it from the user token (avoids scope issues).

const supabase = require('../src/lib/supabase')

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed')
  }

  const email = req.query?.email || ''

  let connections = []
  if (email) {
    const { data } = await supabase
      .from('workspace_connections')
      .select('workspace_name, workspace_id, connected_at')
      .eq('user_email', email)
      .order('connected_at', { ascending: true })

    connections = data || []
  }

  // Encode email in state so the OAuth callback can use it directly
  const addState = email
    ? Buffer.from(JSON.stringify({ email })).toString('base64')
    : ''
  const addUrl = email
    ? `${process.env.APP_URL}/api/slack/oauth/start?state=${addState}`
    : `${process.env.APP_URL}/api/slack/oauth/start?slack_user_id=connect`

  const connectionsHtml = connections.length === 0
    ? '<p style="color:#888">No workspaces connected yet.</p>'
    : connections.map(c => `
        <div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #eee">
          <span style="font-size:20px">✅</span>
          <div>
            <strong>${escapeHtml(c.workspace_name || c.workspace_id)}</strong>
            <div style="font-size:12px;color:#888">Connected ${new Date(c.connected_at).toLocaleDateString()}</div>
          </div>
        </div>
      `).join('')

  res.status(200).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Availability Sync — Connected Workspaces</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
      </head>
      <body style="font-family:sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#1a1a1a">
        <h2 style="margin-bottom:4px">Workspace Sync</h2>
        <p style="color:#666;margin-top:0">
          When you run <code>/availability</code>, your status is synced to all connected workspaces.
        </p>

        ${email ? `<p style="font-size:13px;color:#888">Showing connections for <strong>${escapeHtml(email)}</strong></p>` : ''}

        <div style="margin:24px 0">
          ${connectionsHtml}
        </div>

        <a
          href="${addUrl}"
          style="display:inline-block;background:#4A154B;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600"
        >
          + Connect another workspace
        </a>

        <p style="margin-top:32px;font-size:13px;color:#aaa">
          After clicking, sign in to the Slack workspace you want to add.
          Your status will sync there automatically on every <code>/availability</code> command.
        </p>
      </body>
    </html>
  `)
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
