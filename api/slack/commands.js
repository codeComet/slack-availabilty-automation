const crypto = require('crypto')
const { findOrCreateUser } = require('../../src/services/userService')
const { updateStatus, clearStatus, postAvailabilityMessage } = require('../../src/services/slackService')
const { parseCommand } = require('../../src/utils/parseCommand')
const supabase = require('../../src/lib/supabase')

module.exports.config = {
  api: {
    bodyParser: false,
  },
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const rawBody = await readRawBody(req)

  const verifyError = verifySlackSignature(req.headers, rawBody)
  if (verifyError) {
    console.error('Signature verification failed:', verifyError)
    return res.status(403).json({ error: verifyError })
  }

  const params = new URLSearchParams(rawBody)
  const commandText = params.get('text') || ''
  const slackUserId = params.get('user_id')
  const slackWorkspaceId = params.get('team_id')
  const responseUrl = params.get('response_url')

  // ── Fast token lookup (must happen before we respond, so we can show
  //    the connect button synchronously if needed) ────────────────────
  const { userToken, userEmail } = await resolveUserToken(slackUserId, slackWorkspaceId)

  if (!userToken) {
    const connectUrl = `${process.env.APP_URL}/api/slack/oauth/start?slack_user_id=${slackUserId}&team_id=${slackWorkspaceId}`
    return res.status(200).json({
      response_type: 'ephemeral',
      blocks: buildConnectBlocks(connectUrl),
    })
  }

  // ── Acknowledge Slack immediately (within 3-second window) ─────────
  // Status 200 with a placeholder so Slack doesn't show "operation_timeout".
  // The real result is sent via response_url after the heavy work completes.
  res.status(200).json({ response_type: 'ephemeral', text: '⏳ Updating your availability...' })

  // ── Process asynchronously ─────────────────────────────────────────
  // Vercel keeps the function alive until all awaited work completes
  // (up to the maxDuration in vercel.json).
  try {
    const result = await handleCommand({
      commandText,
      slackUserId,
      slackWorkspaceId,
      userToken,
      userEmail,
    })

    if (responseUrl) {
      const payload = typeof result === 'string'
        ? { response_type: 'ephemeral', replace_original: true, text: result }
        : { response_type: 'ephemeral', replace_original: true, ...result }

      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(err => console.error('Failed to POST to response_url:', err.message))
    }
  } catch (err) {
    console.error('Async command processing failed:', err)
    if (responseUrl) {
      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response_type: 'ephemeral',
          replace_original: true,
          text: 'Something went wrong updating your availability. Please try again.',
        }),
      }).catch(() => {})
    }
  }
}

/**
 * Resolve the user's OAuth token for the source workspace.
 *
 * Strategy:
 *   1. workspace_connections table (Phase 2 — preferred)
 *   2. users.user_token (Phase 1 / pre-Phase2 connections — fallback)
 *
 * Returns { userToken, userEmail } — both may be null if not connected.
 */
async function resolveUserToken(slackUserId, slackWorkspaceId) {
  // Phase 2: look up by (workspace_id, slack_user_id)
  const { data: conn } = await supabase
    .from('workspace_connections')
    .select('access_token, user_email')
    .eq('workspace_id', slackWorkspaceId)
    .eq('slack_user_id', slackUserId)
    .maybeSingle()

  if (conn?.access_token) {
    return { userToken: conn.access_token, userEmail: conn.user_email }
  }

  // Phase 1 fallback: old users table
  const { data: userRow } = await supabase
    .from('users')
    .select('user_token, email')
    .eq('slack_user_id', slackUserId)
    .eq('slack_workspace_id', slackWorkspaceId)
    .maybeSingle()

  return {
    userToken: userRow?.user_token || null,
    userEmail: userRow?.email || null,
  }
}

async function handleCommand({ commandText, slackUserId, slackWorkspaceId, userToken, userEmail }) {
  let user = null
  let parsed = null
  let channelTs = null
  let hasError = false
  let errorMessage = null

  try {
    // Get display name (and email if not already known)
    user = await findOrCreateUser({ slackUserId, slackWorkspaceId })
    const resolvedEmail = userEmail || user.email

    // Parse command
    parsed = parseCommand(commandText)
    if (parsed.action === 'error') {
      await logAvailability({ userId: user.id, rawCommand: commandText, success: false, errorMessage: 'parse_error' })
      return parsed.errorMessage
    }

    // Update status in source workspace
    if (parsed.action === 'clear') {
      await clearStatus(userToken)
    } else {
      await updateStatus(userToken, {
        statusText: parsed.statusText,
        emoji: parsed.emoji,
        expiresUnix: parsed.expiresUnix,
      })
    }

    // Sync to other connected workspaces
    const syncResults = await syncToOtherWorkspaces({
      email: resolvedEmail,
      sourceWorkspaceId: slackWorkspaceId,
      parsed,
    })

    // Post to #availability
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

    return buildConfirmationMessage({ parsed, syncResults, channelPostError, userEmail: resolvedEmail })

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

async function syncToOtherWorkspaces({ email, sourceWorkspaceId, parsed }) {
  if (!email) return []

  const { data: connections, error } = await supabase
    .from('workspace_connections')
    .select('workspace_id, workspace_name, access_token')
    .eq('user_email', email)
    .neq('workspace_id', sourceWorkspaceId)

  if (error) {
    console.error('Failed to fetch workspace connections:', error.message)
    return []
  }
  if (!connections?.length) return []

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
    }
    console.error(`Sync failed for ${conn.workspace_name}:`, result.reason?.message)
    return { workspaceName: conn.workspace_name || conn.workspace_id, success: false }
  })
}

function buildConfirmationMessage({ parsed, syncResults, channelPostError, userEmail }) {
  const lines = []

  if (parsed.action === 'clear') {
    lines.push('Your Slack status has been cleared.')
  } else {
    lines.push('Your availability has been updated.')
    lines.push(`Status: ${parsed.statusText}${parsed.durationMinutes ? ` for ${formatDuration(parsed.durationMinutes)}` : ''}`)
    if (parsed.humanReadable) lines.push(`Expected back: ${parsed.humanReadable}`)
  }

  if (syncResults.length > 0) {
    const succeeded = syncResults.filter(r => r.success).map(r => r.workspaceName)
    const failed = syncResults.filter(r => !r.success).map(r => r.workspaceName)
    if (succeeded.length) lines.push(`Synced to: ${succeeded.join(', ')}`)
    if (failed.length) {
      lines.push(`⚠️ Sync failed for: ${failed.join(', ')} — reconnect at ${process.env.APP_URL}/api/connect?email=${encodeURIComponent(userEmail || '')}`)
    }
  }

  if (channelPostError) {
    lines.push('⚠️ Could not post to `#availability` — make sure the bot is invited to the channel.')
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
