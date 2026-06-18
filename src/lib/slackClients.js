const { WebClient } = require('@slack/web-api')

// Bot client — used for chat.postMessage to #availability.
// Created once and reused (safe to share across requests on Vercel).
const botClient = new WebClient(process.env.SLACK_BOT_TOKEN)

// User client factory — each user has their own OAuth token.
// retryConfig.retries: 0  →  no automatic retries on the user-token calls.
//   The slash command handler must respond within Slack's 3-second window.
//   Retrying a failed users.profile.set (e.g. operation_timeout) with
//   exponential backoff burns that window and causes Slack to show an error
//   to the user before we've even had a chance to reply.
// timeout: 5000  →  hard cap per request so the function never hangs longer
//   than Slack's deadline even if the API stalls.
function getUserClient(userToken) {
  return new WebClient(userToken, {
    retryConfig: { retries: 0 },
    timeout: 5000,
  })
}

module.exports = { botClient, getUserClient }
