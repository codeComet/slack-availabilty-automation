const { PRESETS, PRESET_KEYS } = require('../config/presets')
const { parseDuration } = require('./parseDuration')

// Timezone used for calendar date calculations — must match parseDuration.js
const TIMEZONE = 'Asia/Dhaka'

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

  // For 'leave', default to 'today' if no duration was given
  const durationInput = (matchedKey === 'leave' && !remainder) ? 'today' : remainder
  const duration = parseDuration(durationInput)

  const result = {
    action: 'set',
    shouldPost,
    statusText: preset.text,
    emoji: preset.emoji,
    channelPhrase: preset.channelPhrase,
    ...duration,
  }

  // Attach Google Calendar date range for the 'leave' preset
  if (matchedKey === 'leave') {
    result.calendarDates = parseCalendarDates(durationInput)
    result.leaveDurationStr = durationInput  // used in confirmation message
  }

  return result
}

function buildHelpText() {
  return (
    'Unknown command. Try:\n' +
    '`/availability [sick|unavailable|focus|lunch|meeting|leaving early|leave|clear] [duration]`\n\n' +
    'Examples:\n' +
    '  `/availability unavailable 1h`\n' +
    '  `/availability meeting 30m`\n' +
    '  `/availability sick today`\n' +
    '  `/availability leaving early at 4pm`\n' +
    '  `/availability leave today` _(sets Slack status + Google Calendar OOO)_\n' +
    '  `/availability leave tomorrow`\n' +
    '  `/availability leave 3 days`\n' +
    '  `/availability clear`\n\n' +
    'Add `post` at the end to also announce in `#availability`:\n' +
    '  `/availability unavailable 1h post`'
  )
}

/**
 * Computes the Google Calendar OOO date range for a leave command.
 * Google Calendar uses an *exclusive* end date for all-day events.
 *
 * @param {string} input  The duration part of the leave command, e.g. "today", "tomorrow", "3 days"
 * @returns {{ startDate: string, endDate: string }}  Dates as "YYYY-MM-DD"
 */
function parseCalendarDates(input) {
  const s = (input || 'today').trim().toLowerCase()

  const todayStr = todayInTimezone(TIMEZONE)

  if (s === 'today') {
    return { startDate: todayStr, endDate: addDays(todayStr, 1) }
  }

  if (s === 'tomorrow') {
    const tomorrowStr = addDays(todayStr, 1)
    return { startDate: tomorrowStr, endDate: addDays(todayStr, 2) }
  }

  const daysMatch = s.match(/^(\d+)\s*days?$/)
  if (daysMatch) {
    const n = parseInt(daysMatch[1], 10)
    return { startDate: todayStr, endDate: addDays(todayStr, n) }
  }

  // Fallback
  return { startDate: todayStr, endDate: addDays(todayStr, 1) }
}

/** Returns today's date as "YYYY-MM-DD" in the given timezone. */
function todayInTimezone(tz) {
  return new Date().toLocaleDateString('sv-SE', { timeZone: tz })
}

/** Adds `n` days to a "YYYY-MM-DD" string and returns the result as "YYYY-MM-DD". */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

module.exports = { parseCommand }
