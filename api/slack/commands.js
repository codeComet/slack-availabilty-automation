const crypto = require('crypto')
const { waitUntil } = require('@vercel/functions')
const { findOrCreateUser } = require('../../src/services/userService')
const { updateStatus, clearStatus, postAvailabilityMessage } = require('../../src/services/slackService')
const { createOOOEvent, deleteOOOEvent, isGoogleConnected } = require('../../src/services/calendarService')
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

  const { userToken, userEmail } = await resolveUserToken(slackUserId, slackWorkspaceId)

  if (!userToken) {
    const connectUrl = `${process.env.APP_URL}/api/slack/oauth/start?slack_user_id=${slackUserId}&team_id=${slackWorkspaceId}`
    return res.status(200).json({
      response_type: 'ephemeral',
      blocks: buildConnectBlocks(connectUrl),
    })
  }

  // Acknowledge Slack immediately — Slack requires a 200 within 3 seconds.
  // All slow work (Slack API, Google Calendar, DB writes) runs in waitUntil,
  // which keeps the Vercel function alive after the response is sent.
  // The final result is posted back to Slack via response_url.
  res.status(200).json({
    response_type: 'ephemeral',
    text: '⏳ Updating your availability…',
  })

  waitUntil(
    handleCommand({ commandText, slackUserId, slackWorkspaceId, userToken, userEmail })
      .then(result => postToResponseUrl(responseUrl, result))
      .catch(err => {
        console.error('Command processing failed:', err)
        return postToResponseUrl(responseUrl, 'Something went wrong updating your availability. Please try again.')
      })
  )
}

/**
 * Posts the final command result to Slack's response_url.
 * This replaces the "⏳ Updating…" acknowledgement with the real outcome.
 */
async function postToResponseUrl(responseUrl, result) {
  if (!responseUrl) return
  const body = typeof result === 'string'
    ? { response_type: 'ephemeral', replace_original: true, text: result }
    : { response_type: 'ephemeral', replace_original: true, ...result }
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    console.error('Failed to post to response_url:', err.message)
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
  let resolvedShouldPost = false
  let hasError = false
  let errorMessage = null
  let googleCalendarEventId = null
  let calendarResult = null  // { success, connectUrl?, errorMsg? }

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

    let shouldPost = parsed.shouldPost
    resolvedShouldPost = shouldPost

    // For 'clear': fetch the last log (should_post + calendar event ID) AND update
    // the Slack status at the same time — eliminates a sequential DB round trip.
    // For 'set': just update the status.
    let lastClearLog = null
    if (parsed.action === 'clear') {
      const [, lastLogResult] = await Promise.all([
        clearStatus(userToken),
        supabase
          .from('availability_logs')
          .select('should_post, google_calendar_event_id')
          .eq('user_id', user.id)
          .not('status_text', 'is', null)
          .eq('success', true)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      lastClearLog = lastLogResult.data
      if (!parsed.shouldPost) {
        shouldPost = lastClearLog?.should_post ?? false
        resolvedShouldPost = shouldPost
      }
    } else {
      await updateStatus(userToken, {
        statusText: parsed.statusText,
        emoji: parsed.emoji,
        expiresUnix: parsed.expiresUnix,
      })
    }

    // ── Run sync + calendar in parallel to stay within Slack's 3s timeout ────
    let syncResults = []
    let channelPostError = null

    const toSettle = [
      syncToOtherWorkspaces({ email: resolvedEmail, sourceWorkspaceId: slackWorkspaceId, parsed }),
      buildCalendarTask({ parsed, resolvedEmail, slackUserId, slackWorkspaceId, lastCalendarEventId: lastClearLog?.google_calendar_event_id }),
    ]
    if (shouldPost) {
      toSettle.push(
        postAvailabilityMessage({
          displayName: user.display_name || slackUserId,
          avatarUrl: user.avatar_url || null,
          statusText: parsed.statusText,
          channelPhrase: parsed.channelPhrase,
          humanReadable: parsed.humanReadable,
          action: parsed.action,
        })
      )
    }

    const settled = await Promise.allSettled(toSettle)
    const [syncSettled, calendarSettled, channelSettled] = settled

    if (syncSettled.status === 'fulfilled') {
      syncResults = syncSettled.value
    } else {
      console.error('Sync failed:', syncSettled.reason?.message)
    }

    if (calendarSettled.status === 'fulfilled' && calendarSettled.value) {
      calendarResult = calendarSettled.value.calendarResult
      googleCalendarEventId = calendarSettled.value.googleCalendarEventId ?? null
    } else if (calendarSettled.status === 'rejected') {
      console.error('Calendar task failed:', calendarSettled.reason?.message)
    }

    if (shouldPost) {
      if (channelSettled.status === 'fulfilled') {
        channelTs = channelSettled.value
      } else {
        channelPostError = channelSettled.reason
        console.error('Failed to post to #availability:', channelSettled.reason?.message)
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    return buildConfirmationMessage({ parsed, shouldPost, syncResults, channelPostError, calendarResult, userEmail: resolvedEmail })

  } catch (err) {
    hasError = true
    errorMessage = err.message
    console.error('Error handling /availability command:', err)

    // Slack's profile update API returned operation_timeout — retries are disabled
    // so we won't make it worse. Tell the user to try again.
    const slackError = err.data?.error || err.code
    if (slackError === 'operation_timeout' || err.message?.includes('operation_timeout')) {
      return "Slack's status API timed out. Please try your `/availability` command again in a moment."
    }

    // Slack API token errors — tell the user to reconnect rather than showing a generic error
    const slackTokenErrors = ['no_user_token', 'invalid_auth', 'token_revoked', 'account_inactive', 'token_expired']
    if (slackTokenErrors.includes(err.data?.error || err.message)) {
      // Clear the invalid token so the connect button appears on next command
      await supabase.from('users').update({ user_token: null, token_scope: null }).eq('slack_user_id', slackUserId)
      await supabase.from('workspace_connections').delete().eq('slack_user_id', slackUserId).eq('workspace_id', slackWorkspaceId)
      const connectUrl = `${process.env.APP_URL}/api/slack/oauth/start?slack_user_id=${slackUserId}&team_id=${slackWorkspaceId}`
      return {
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Your Slack token has expired or been revoked.*\nPlease reconnect your account to continue using \`/availability\`.\n\n<${connectUrl}|👉 Reconnect your account>`,
            },
          },
        ],
      }
    }

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
      shouldPost: resolvedShouldPost,
      googleCalendarEventId,
      success: !hasError,
      errorMessage,
    })
  }
}

/**
 * Builds the Google Calendar task for this command invocation.
 * Returns { calendarResult, googleCalendarEventId } or null if not applicable.
 */
async function buildCalendarTask({ parsed, resolvedEmail, slackUserId, slackWorkspaceId, lastCalendarEventId }) {
  // Set: create OOO event for leave commands
  if (parsed.action === 'set' && parsed.calendarDates && resolvedEmail) {
    const connected = await isGoogleConnected(resolvedEmail)
    if (!connected) {
      const connectUrl = `${process.env.APP_URL}/api/google/oauth/start?slack_user_id=${slackUserId}&team_id=${slackWorkspaceId}`
      return { calendarResult: { success: false, connectUrl }, googleCalendarEventId: null }
    }
    try {
      const eventId = await createOOOEvent(
        resolvedEmail,
        parsed.calendarDates.startDate,
        parsed.calendarDates.endDate
      )
      return { calendarResult: { success: true }, googleCalendarEventId: eventId }
    } catch (err) {
      const detail = err?.response?.data?.error?.message || err.message || 'unknown error'
      console.error('Google Calendar OOO creation failed:', detail)
      return { calendarResult: { success: false, errorMsg: detail }, googleCalendarEventId: null }
    }
  }

  // Clear: delete the OOO event whose ID was passed in (already fetched alongside clearStatus)
  if (parsed.action === 'clear' && resolvedEmail && lastCalendarEventId) {
    try {
      await deleteOOOEvent(resolvedEmail, lastCalendarEventId)
    } catch (err) {
      console.error('Failed to delete Google Calendar OOO event:', err.message)
    }
  }

  return null
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

function buildConfirmationMessage({ parsed, shouldPost, syncResults, channelPostError, calendarResult, userEmail }) {
  const lines = []

  if (parsed.action === 'clear') {
    lines.push('Your Slack status has been cleared.')
  } else {
    lines.push('Your availability has been updated.')
    lines.push(`Status: ${parsed.statusText}${parsed.durationMinutes ? ` for ${formatDuration(parsed.durationMinutes)}` : ''}`)
    if (parsed.leaveDurationStr) {
      // For leave, show the human-friendly duration rather than a time
      lines.push(`Leave: ${parsed.leaveDurationStr}`)
    } else if (parsed.humanReadable) {
      lines.push(`Expected to be back at: ${parsed.humanReadable}`)
    }
  }

  // Google Calendar result
  if (calendarResult) {
    if (calendarResult.success) {
      lines.push('📅 Google Calendar set to Out of Office.')
    } else if (calendarResult.connectUrl) {
      lines.push(`📅 Google Calendar not connected. <${calendarResult.connectUrl}|Connect your Google account> to sync OOO automatically.`)
    } else {
      lines.push('📅 Could not update Google Calendar. Please try again.')
    }
  }

  if (syncResults.length > 0) {
    const succeeded = syncResults.filter(r => r.success).map(r => r.workspaceName)
    const failed = syncResults.filter(r => !r.success).map(r => r.workspaceName)
    if (succeeded.length) lines.push(`Synced to: ${succeeded.join(', ')}`)
    if (failed.length) {
      lines.push(`⚠️ Sync failed for: ${failed.join(', ')} — reconnect at ${process.env.APP_URL}/api/connect?email=${encodeURIComponent(userEmail || '')}`)
    }
  }

  if (shouldPost) {
    if (channelPostError) {
      lines.push('⚠️ Could not post to `#availability` — make sure the bot is invited to the channel.')
    } else {
      lines.push('Posted in: #availability')
    }
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
  durationMinutes, expiresAt, channelTs, shouldPost,
  googleCalendarEventId, success, errorMessage,
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
      should_post: shouldPost ?? false,
      google_calendar_event_id: googleCalendarEventId ?? null,
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
