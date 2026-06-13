const { WebClient } = require('@slack/web-api')

// Bot client — used for chat.postMessage to #availability.
// Created once and reused (safe to share across requests on Vercel).
const botClient = new WebClient(process.env.SLACK_BOT_TOKEN)

// User client factory — each user has their own OAuth token.
function getUserClient(userToken) {
  return new WebClient(userToken)
}

module.exports = { botClient, getUserClient }
