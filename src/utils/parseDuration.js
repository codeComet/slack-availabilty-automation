// Parses a duration string into minutes, an expiry Date, a Unix timestamp, and a human-readable time.
// All human-readable times use Asia/Dhaka timezone (GMT+6).

const TIMEZONE = 'Asia/Dhaka'

/**
 * @param {string} input  e.g. "1h", "30m", "today", "at 4pm", "until 4:30pm", ""
 * @returns {{
 *   durationMinutes: number | null,
 *   expiresAt: Date | null,
 *   expiresUnix: number,       // Unix timestamp; 0 means no expiry (Slack convention)
 *   humanReadable: string | null
 * }}
 */
function parseDuration(input) {
  const s = (input || '').trim().toLowerCase()

  // Xh
  const hoursMatch = s.match(/^(\d+)h$/)
  if (hoursMatch) {
    const minutes = parseInt(hoursMatch[1], 10) * 60
    return buildResult(minutes, null)
  }

  // Xm
  const minutesMatch = s.match(/^(\d+)m$/)
  if (minutesMatch) {
    const minutes = parseInt(minutesMatch[1], 10)
    return buildResult(minutes, null)
  }

  // today → end of today in Stockholm time
  if (s === 'today') {
    const expiresAt = endOfTodayInStockholm()
    return buildResult(null, expiresAt)
  }

  // "at X" or "until X" → parse as a time today in Stockholm
  const timeMatch = s.match(/^(?:at|until)\s+(.+)$/)
  if (timeMatch) {
    const expiresAt = parseTodayAtTime(timeMatch[1])
    if (expiresAt) return buildResult(null, expiresAt)
  }

  // No duration
  return { durationMinutes: null, expiresAt: null, expiresUnix: 0, humanReadable: null }
}

function buildResult(durationMinutes, explicitExpiry) {
  let expiresAt = explicitExpiry

  if (durationMinutes !== null && expiresAt === null) {
    expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000)
  }

  const expiresUnix = expiresAt ? Math.floor(expiresAt.getTime() / 1000) : 0

  const humanReadable = expiresAt
    ? expiresAt.toLocaleTimeString('sv-SE', {
        timeZone: TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
      })
    : null

  return { durationMinutes, expiresAt, expiresUnix, humanReadable }
}

function endOfTodayInStockholm() {
  // Get today's date string in Stockholm time, then set time to 23:59
  const nowInStockholm = new Date().toLocaleDateString('sv-SE', { timeZone: TIMEZONE })
  // nowInStockholm is "YYYY-MM-DD"
  return new Date(`${nowInStockholm}T23:59:00+06:00`)
}

function parseTodayAtTime(timeStr) {
  // Accepts formats like "4pm", "4:30pm", "16:00", "16"
  const todayInStockholm = new Date().toLocaleDateString('sv-SE', { timeZone: TIMEZONE })

  // Try 12-hour with optional minutes: "4pm", "4:30pm", "4:30 pm"
  const twelveHour = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (twelveHour) {
    let hours = parseInt(twelveHour[1], 10)
    const minutes = parseInt(twelveHour[2] || '0', 10)
    const meridiem = twelveHour[3]
    if (meridiem === 'pm' && hours < 12) hours += 12
    if (meridiem === 'am' && hours === 12) hours = 0
    return new Date(`${todayInStockholm}T${pad(hours)}:${pad(minutes)}:00+06:00`)
  }

  // Try 24-hour: "16:00", "16"
  const twentyFourHour = timeStr.match(/^(\d{1,2})(?::(\d{2}))?$/)
  if (twentyFourHour) {
    const hours = parseInt(twentyFourHour[1], 10)
    const minutes = parseInt(twentyFourHour[2] || '0', 10)
    return new Date(`${todayInStockholm}T${pad(hours)}:${pad(minutes)}:00+06:00`)
  }

  return null
}

function pad(n) {
  return String(n).padStart(2, '0')
}

module.exports = { parseDuration }
