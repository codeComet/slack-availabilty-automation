const { PRESETS, PRESET_KEYS } = require('../config/presets')
const { parseDuration } = require('./parseDuration')

/**
 * Parses the raw text from a /availability slash command.
 *
 * Supports an optional trailing "post" keyword that controls whether the status
 * is announced in #availability. Without it, only the Slack status is updated.
 *
 * Examples:
 *   /availability lunch 1h        → updates status, no channel post
 *   /availability lunch 1h post   → updates status + posts to #availability
 *   /availability clear           → clears status (channel post based on prior entry)
 *   /availability clear post      → forces a channel post on clear
 *
 * @param {string} rawText  Everything after "/availability", e.g. "unavailable 1h post"
 * @returns {{
 *   action: 'set' | 'clear' | 'error',
 *   shouldPost: boolean,
 *   statusText?: string,
 *   emoji?: string,
 *   durationMinutes?: number | null,
 *   expiresAt?: Date | null,
 *   expiresUnix?: number,
 *   humanReadable?: string | null,
 *   errorMessage?: string
 * }}
 */
function parseCommand(rawText) {
  let input = (rawText || '').trim().toLowerCase()

  if (!input) {
    return {
      action: 'error',
      shouldPost: false,
      errorMessage: buildHelpText(),
    }
  }

  // Detect and strip the optional trailing 'post' flag
  const shouldPost = input === 'post' || input.endsWith(' post')
  if (shouldPost) {
    input = input.slice(0, -4).trim() // remove trailing 'post'
  }

  if (input === 'clear') {
    return { action: 'clear', shouldPost }
  }

  // Match against preset keywords (longest first, guaranteed by PRESET_KEYS order in presets.js)
  const matchedKey = PRESET_KEYS.find((key) => input.startsWith(key))

  if (!matchedKey) {
    return {
      action: 'error',
      shouldPost: false,
      errorMessage: buildHelpText(),
    }
  }

  const preset = PRESETS.get(matchedKey)
  const remainder = input.slice(matchedKey.length).trim()
  const duration = parseDuration(remainder)

  return {
    action: 'set',
    shouldPost,
    statusText: preset.text,
    emoji: preset.emoji,
    channelPhrase: preset.channelPhrase,
    ...duration,
  }
}

function buildHelpText() {
  return (
    'Unknown command. Try:\n' +
    '`/availability [sick|unavailable|focus|lunch|meeting|leaving early|clear] [duration]`\n\n' +
    'Examples:\n' +
    '  `/availability unavailable 1h`\n' +
    '  `/availability meeting 30m`\n' +
    '  `/availability sick today`\n' +
    '  `/availability leaving early at 4pm`\n' +
    '  `/availability clear`\n\n' +
    'Add `post` at the end to also announce in `#availability`:\n' +
    '  `/availability unavailable 1h post`'
  )
}

module.exports = { parseCommand }
