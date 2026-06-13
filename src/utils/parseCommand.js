const { PRESETS, PRESET_KEYS } = require('../config/presets')
const { parseDuration } = require('./parseDuration')

/**
 * Parses the raw text from a /availability slash command.
 *
 * @param {string} rawText  Everything after "/availability", e.g. "unavailable 1h"
 * @returns {{
 *   action: 'set' | 'clear' | 'error',
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
  const input = (rawText || '').trim().toLowerCase()

  if (!input) {
    return {
      action: 'error',
      errorMessage: buildHelpText(),
    }
  }

  if (input === 'clear') {
    return { action: 'clear' }
  }

  // Match against preset keywords (longest first, guaranteed by PRESET_KEYS order in presets.js)
  const matchedKey = PRESET_KEYS.find((key) => input.startsWith(key))

  if (!matchedKey) {
    return {
      action: 'error',
      errorMessage: buildHelpText(),
    }
  }

  const preset = PRESETS.get(matchedKey)
  const remainder = input.slice(matchedKey.length).trim()
  const duration = parseDuration(remainder)

  return {
    action: 'set',
    statusText: preset.text,
    emoji: preset.emoji,
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
    '  `/availability clear`'
  )
}

module.exports = { parseCommand }
