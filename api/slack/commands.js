const crypto = require('crypto')
const { findOrCreateUser } = require('../../src/services/userService')
const { updateStatus, clearStatus, postAvailabilityMessage } = require('../../src/services/slackService')
const { parseCommand } = require('../../src/utils/parseCommand')
const supabase = require('../../src/lib/supabase')

// Tell Vercel NOT to parse the body — we need the raw bytes for signature verification.
module.exports.config = {
  api: {
    bodyParser: false,
  },
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Read raw body from stream
  const rawBody = await readRawBody(req)

  // Verify Slack signature
  const verifyError = verifySlackSignature(req.headers, rawBody)
  if (verifyError) {
    console.error('Signature verification failed:', verifyError)
    return res.status(403).json({ error: verifyError })
  }

  // Parse URL-encoded body
  const params = new URLSearchParams(rawBody)
  const commandText = params.get('text') || ''
  const slackUserId = params.get('user_id')
  const slackWorkspaceId = params.get('team_id')

  const result = await handleCommand({ commandText, slackUserId, slackWorkspaceId })

  const payload = typeof result === 'string'
    ? { response_type: 'ephemeral', text: result }
    : { response_type: 'ephemeral', ...result }

  return res.status(200).json(payload)
}

async function handleCommand({ commandText, slackUserId, slackWorkspaceId }) {
  let user = null
  let parsed = null
  let channelTs = null
  let hasError = false
  let errorMessage = null

  try {
    // 1. Find or create user in the source workspace
    user = await findOrCreateUser({ slackUserId, slackWorkspaceId })

    // 2. Check for user token (source workspace connection)
    if (!user.user_token) {
      const connectUrl = `${process.env.APP_URL}/api/slack/oauth/start?slack_user_id=${slackUserId}&team_id=${slackWorkspaceId}`
      await logAvailability({ userId: user.id, rawCommand: commandText, success: false, errorMessage: 'no_user_token' })
      return { blocks: buildConnectBlocks(connectUrl) }
    }

    // 3. Parse command
    parsed = parseCommand(commandText)

    if (parsed.action === 'error') {
      await logAvailability({ userId: user.id, rawCommand: commandText, success: false, errorMessage: 'parse_error' })
      return parsed.errorMessage
    }

    // 4. Update Slack status in the source workspace
    if (parsed.action === 'clear') {
      await clearStatus(user.user_token)
    } else {
      await updateStatus(user.user_token, {
        statusText: parsed.statusText,
        emoji: parsed.emoji,
        expiresUnix: parsed.expiresUnix,
      })
    }

    // 5. Sync to all other connected workspaces (Phase 2)
    const syncResults = await syncToOtherWorkspaces({
      email: user.email,
      sourceWorkspaceId: slackWorkspaceId,
      parsed,
    })

    // 6. Post to #availability channel (Strativ source of truth)
    let channelPostError = null
    try {
      channelTs = await postAvailabilityMessage({
        displayName: user.display_name || slackUserId,
        statusText: parsed.statusText,
        humanReadable: parsed.humanReadable,
        action: parsed.action,
      })
    } catch (err) {
      channelPostError = err
      console.error('Failed to post to #availability:', err.message)
    }

    // 7. Build confirmation message
    return buildConfirmationMessage({ parsed, syncResults, channelPostError, user, slackWorkspaceId })

  } catch (err) {
    hasError = true
    errorMessage = err.message
    console.error('Error handling /availability command:', err)
    return 'Something went wrong updating your availability. Please try again.'
  } finally {
    await logAvailability({
      userId: user?.id ?? null,
      rawCommand: commandText,
      statusText: parsed?.statusText ?? null,
      statusEmoji: parsed?.emoji ?? null,
      durationMinutes: parsed?.durationMinutes ?? null,
      expiresAt: parsed?.expiresAt ?? null,
      channelTs,
      success: !hasError,
      errorMessage,
    })
  }
}

/**
 * Looks up all workspace_connections for this user (by email),
 * excluding the workspace they just ran the command from,
 * and updates their status in each.
 *
 * @returns {{ workspaceName: string, success: boolean, error?: string }[]}
 */
async function syncToOtherWorkspaces({ email, sourceWorkspaceId, parsed }) {
  if (!email) {
    console.warn('No email for user — cannot sync to other workspaces')
    return []
  }

  const { data: connections, error } = await supabase
    .from('workspace_connections')
    .select('workspace_id, workspace_name, access_token')
    .eq('user_email', email)
    .neq('workspace_id', sourceWorkspaceId)   // skip the workspace the command came from

  if (error) {
    console.error('Failed to fetch workspace connections:', error.message)
    return []
  }

  if (!connections || connections.length === 0) return []

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      if (parsed.action === 'clear') {
        await clearStatus(conn.access_token)
      } else {
        await updateStatus(conn.access_token, {
          statusText: parsed.statusText,
          emoji: parsed.emoji,
          expiresUnix: parsed.expiresUnix,
        })
      }
      return conn.workspace_name || conn.workspace_id
    })
  )

  return results.map((result, i) => {
    const conn = connections[i]
    if (result.status === 'fulfilled') {
      return { workspaceName: conn.workspace_name || conn.workspace_id, success: true }
    } else {
      console.error(`Failed to sync to ${conn.workspace_name}:`, result.reason?.message)
      return { workspaceName: conn.workspace_name || conn.workspace_id, success: false, error: result.reason?.message }
    }
  })
}

function buildConfirmationMessage({ parsed, syncResults, channelPostError, user, slackWorkspaceId }) {
  const lines = []

  if (parsed.action === 'clear') {
    lines.push('Your Slack status has been cleared.')
  } else {
    lines.push('Your availability has been updated.')
    lines.push(`Status: ${parsed.statusText}${parsed.durationMinutes ? ` for ${formatDuration(parsed.durationMinutes)}` : ''}`)
    if (parsed.humanReadable) lines.push(`Expected back: ${parsed.humanReadable}`)
  }

  // Sync results
  if (syncResults.length > 0) {
    const succeeded = syncResults.filter(r => r.success).map(r => r.workspaceName)
    const failed = syncResults.filter(r => !r.success).map(r => r.workspaceName)

    if (succeeded.length > 0) {
      lines.push(`Synced to: ${succeeded.join(', ')}`)
    }
    if (failed.length > 0) {
      lines.push(`⚠️ Sync failed for: ${failed.join(', ')} — reconnect at ${process.env.APP_URL}/api/connect`)
    }
  } else if (!syncResults.length && user.email) {
    // User has email but no other workspaces connected
    lines.push(`💡 Connect more workspaces at ${process.env.APP_URL}/api/connect`)
  }

  if (channelPostError) {
    lines.push('⚠️ Could not post to `#availability` — make sure the bot is invited.')
  } else if (parsed.action !== 'clear') {
    lines.push('Posted in: #availability')
  }

  return lines.join('\n')
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function verifySlackSignature(headers, rawBody) {
  const timestamp = headers['x-slack-request-timestamp']
  const signature = headers['x-slack-signature']

  if (!timestamp || !signature) return 'Missing Slack signature headers'

  const nowSeconds = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSeconds - parseInt(timestamp, 10)) > 300) return 'Request timestamp too old'

  const baseString = `v0:${timestamp}:${rawBody}`
  const hmac = crypto
    .createHmac('sha256', process.env.SLACK_SIGNING_SECRET)
    .update(baseString)
    .digest('hex')
  const expected = `v0=${hmac}`

  try {
    const a = Buffer.from(signature)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'Invalid Slack signature'
  } catch {
    return 'Signature verification failed'
  }

  return null
}

async function logAvailability({
  userId, rawCommand, statusText, statusEmoji,
  durationMinutes, expiresAt, channelTs, success, errorMessage,
}) {
  try {
    await supabase.from('availability_logs').insert({
      user_id: userId ?? null,
      raw_command: rawCommand,
      status_text: statusText ?? null,
      status_emoji: statusEmoji ?? null,
      duration_minutes: durationMinutes ?? null,
      expires_at: expiresAt ? expiresAt.toISOString() : null,
      channel_message_ts: channelTs ?? null,
      success: !!success,
      error_message: errorMessage ?? null,
    })
  } catch (err) {
    console.error('Failed to write availability log:', err.message)
  }
}

function formatDuration(minutes) {
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hour${minutes / 60 !== 1 ? 's' : ''}`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${minutes} minute${minutes !== 1 ? 's' : ''}`
}

function buildConnectBlocks(connectUrl) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*One-time setup required*\nTo use \`/availability\`, you need to connect your Slack account so the app can update your status.\n\n<${connectUrl}|👉 Connect your account>`,
      },
    },
  ]
}
