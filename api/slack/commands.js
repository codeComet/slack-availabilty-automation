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

  // Process the command and respond — all within Slack's 3-second window.
  // handleCommand returns either a string (plain text) or { blocks: [...] }
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
    // 1. Find or create user
    user = await findOrCreateUser({ slackUserId, slackWorkspaceId })

    // 2. Check for user token
    if (!user.user_token) {
      const connectUrl = `${process.env.APP_URL}/api/slack/oauth/start?slack_user_id=${slackUserId}`
      await logAvailability({ userId: user.id, rawCommand: commandText, success: false, errorMessage: 'no_user_token' })
      return { blocks: buildConnectBlocks(connectUrl) }
    }

    // 3. Parse command
    parsed = parseCommand(commandText)

    if (parsed.action === 'error') {
      await logAvailability({ userId: user.id, rawCommand: commandText, success: false, errorMessage: 'parse_error' })
      return parsed.errorMessage
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

    // 6. Build confirmation message
    if (channelPostError) {
      return (
        'Your Slack status was updated, but posting to `#availability` failed.\n' +
        'Make sure the bot is invited to `#availability`.'
      )
    }

    if (parsed.action === 'clear') {
      return 'Your Slack status has been cleared.'
    }

    return [
      'Your availability has been updated.',
      `Status: ${parsed.statusText}${parsed.durationMinutes ? ` for ${formatDuration(parsed.durationMinutes)}` : ''}`,
      parsed.humanReadable ? `Expected back: ${parsed.humanReadable}` : null,
      'Posted in: #availability',
    ].filter(Boolean).join('\n')

  } catch (err) {
    hasError = true
    errorMessage = err.message
    console.error('Error handling /availability command:', err)
    return 'Something went wrong updating your availability. Please try again.'
  } finally {
    // Always log, regardless of outcome
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
