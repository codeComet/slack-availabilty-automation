const { botClient, getUserClient } = require('../lib/slackClients')

/**
 * Updates a user's Slack status using their personal user token.
 *
 * @param {string} userToken  OAuth user token (xoxp-...)
 * @param {{ statusText: string, emoji: string, expiresUnix: number }} status
 */
async function updateStatus(userToken, { statusText, emoji, expiresUnix }) {
  const client = getUserClient(userToken)
  await client.users.profile.set({
    profile: {
      status_text: statusText,
      status_emoji: emoji,
      status_expiration: expiresUnix,  // 0 = no expiry
    },
  })
}

/**
 * Clears a user's Slack status.
 *
 * @param {string} userToken
 */
async function clearStatus(userToken) {
  await updateStatus(userToken, { statusText: '', emoji: '', expiresUnix: 0 })
}

/**
 * Posts an availability message to the #availability channel.
 *
 * @param {{ displayName: string, statusText: string, humanReadable: string | null, action: string }} params
 * @returns {Promise<string>}  Slack message timestamp (ts)
 */
async function postAvailabilityMessage({ displayName, statusText, channelPhrase, humanReadable, action }) {
  let text
  const phrase = channelPhrase || `is ${statusText.toLowerCase()}`

  if (action === 'clear') {
    text = `${displayName} is available again.`
  } else if (humanReadable) {
    text = `${displayName} ${phrase}. Expected to be back at: ${humanReadable}.`
  } else {
    text = `${displayName} ${phrase}.`
  }

  const result = await botClient.chat.postMessage({
    channel: process.env.SLACK_AVAILABILITY_CHANNEL_ID,
    text,
  })

  return result.ts
}

/**
 * Sends an ephemeral DM to a user via the bot.
 * Used to prompt users to connect their account.
 *
 * @param {string} slackUserId
 * @param {string} text
 */
async function sendDirectMessage(slackUserId, text) {
  const dm = await botClient.conversations.open({ users: slackUserId })
  await botClient.chat.postMessage({ channel: dm.channel.id, text })
}

module.exports = { updateStatus, clearStatus, postAvailabilityMessage, sendDirectMessage }
