const express = require('express')
const { verifySlack } = require('../../src/middleware/verifySlack')
const { findOrCreateUser } = require('../../src/services/userService')
const { updateStatus, clearStatus, postAvailabilityMessage, sendDirectMessage } = require('../../src/services/slackService')
const { parseCommand } = require('../../src/utils/parseCommand')
const supabase = require('../../src/lib/supabase')

// Vercel serverless function.
// Handles POST /api/slack/commands
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Ensure raw body is available for signature verification
  // (On Vercel, req.body may already be a Buffer or string depending on Content-Type)
  const rawBody = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '')

  // Verify Slack signature synchronously before anything else
  const fakeReq = { headers: req.headers, body: rawBody }
  const fakeRes = {
    status: (code) => ({ json: (data) => res.status(code).json(data) }),
  }
  let verifyPassed = false
  await new Promise((resolve) => {
    verifySlack(fakeReq, fakeRes, () => {
      verifyPassed = true
      resolve()
    })
  })
  if (!verifyPassed) return  // verifySlack already sent the 403

  // Parse URL-encoded body
  const params = new URLSearchParams(rawBody.toString())
  const commandText = params.get('text') || ''
  const slackUserId = params.get('user_id')
  const slackWorkspaceId = params.get('team_id')
  const responseUrl = params.get('response_url')

  // Acknowledge immediately — Slack requires a 200 within 3 seconds
  res.status(200).send('')

  // All remaining work is async, after the 200 is sent
  handleCommand({ commandText, slackUserId, slackWorkspaceId, responseUrl }).catch((err) => {
    console.error('Unhandled error in handleCommand:', err)
  })
}

async function handleCommand({ commandText, slackUserId, slackWorkspaceId, responseUrl }) {
  let user = null
  let parsed = null
  let channelTs = null
  let hasError = false
  let errorMessage = null

  try {
    // 1. Find or create user
    user = await findOrCreateUser({ slackUserId, slackWorkspaceId })

    // 2. Check for user token
    if (!user.user_token) {
      const connectUrl = `${process.env.APP_URL}/api/slack/oauth/start?slack_user_id=${slackUserId}`
      await postEphemeral(responseUrl, {
        text: `You need to connect your Slack account before using \`/availability\`.\n<${connectUrl}|Click here to connect your account>.`,
      })
      await logAvailability({
        userId: user.id,
        rawCommand: commandText,
        success: false,
        errorMessage: 'no_user_token',
      })
      return
    }

    // 3. Parse command
    parsed = parseCommand(commandText)

    if (parsed.action === 'error') {
      await postEphemeral(responseUrl, { text: parsed.errorMessage })
      await logAvailability({
        userId: user.id,
        rawCommand: commandText,
        success: false,
        errorMessage: 'parse_error',
      })
      return
    }

    // 4. Update Slack status
    if (parsed.action === 'clear') {
      await clearStatus(user.user_token)
    } else {
      await updateStatus(user.user_token, {
        statusText: parsed.statusText,
        emoji: parsed.emoji,
        expiresUnix: parsed.expiresUnix,
      })
    }

    // 5. Post to #availability channel
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

    // 6. Confirm to user
    if (channelPostError) {
      await postEphemeral(responseUrl, {
        text:
          `Your Slack status was updated, but posting to \`#availability\` failed.\n` +
          `Make sure the bot is invited to \`#availability\` (type \`/invite @Availability Bot\` in the channel).`,
      })
    } else if (parsed.action === 'clear') {
      await postEphemeral(responseUrl, { text: 'Your Slack status has been cleared.' })
    } else {
      const lines = [
        'Your availability has been updated.',
        `Status: ${parsed.statusText}${parsed.durationMinutes ? ` for ${formatDuration(parsed.durationMinutes)}` : ''}`,
        parsed.humanReadable ? `Expected back: ${parsed.humanReadable}` : null,
        `Posted in: #availability`,
      ].filter(Boolean)
      await postEphemeral(responseUrl, { text: lines.join('\n') })
    }
  } catch (err) {
    hasError = true
    errorMessage = err.message
    console.error('Error handling /availability command:', err)
    try {
      await postEphemeral(responseUrl, {
        text: 'Something went wrong updating your availability. Please try again.',
      })
    } catch (_) {}
  }

  // 7. Log
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

async function postEphemeral(responseUrl, body) {
  const response = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', ...body }),
  })
  if (!response.ok) {
    throw new Error(`Failed to post to response_url: ${response.status}`)
  }
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
